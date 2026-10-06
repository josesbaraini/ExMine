/**
 * Phase 3 §2/§4 — `GraphClient`: raw Neo4j driver wrapper. THIS is the only
 * module allowed to import the Neo4j driver — nothing else may know it exists,
 * same swappable-seam philosophy as `LLMClient` (spec §2: "nothing outside
 * this module imports the Neo4j driver directly").
 *
 * Responsibilities, deliberately narrow:
 * - connect (with bounded retry — §3: `depends_on` only starts the container,
 *   it does not make Neo4j queryable)
 * - run parameterized Cypher and return plain-JS rows (driver-specific value
 *   types like Integer / temporals unwrapped)
 * - report readiness
 *
 * It has NO business logic and NO knowledge of nodes/edges/extraction as
 * concepts. Test seams (§9): inject a `driver` (fake driver) and rely on the
 * structural `GraphDriverLike` view instead of driver types.
 */

import neo4j, { type Driver } from "neo4j-driver";

/** Plain-JS parameter bag passed to every statement. */
export type GraphParams = Record<string, unknown>;

/** Plain-JS rows returned from `run` — never driver-specific types. */
export interface GraphResult {
  records: Record<string, unknown>[];
}

/** Failures of the graph dependency. Both map to 502 in the API (§5). */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** The driver exists but Neo4j can't be reached (not started / not connected). */
export class GraphUnavailableError extends GraphError {
  constructor(message: string) {
    super(message);
    this.name = "GraphUnavailableError";
  }
}

/** Neo4j is reachable but rejected a statement (syntax/constraint/etc). */
export class GraphQueryError extends GraphError {
  constructor(message: string) {
    super(message);
    this.name = "GraphQueryError";
  }
}

/**
 * Minimal structural view of the pieces GraphClient uses from the driver, kept
 * driver-agnostic so tests can inject a fake (§9). The real driver conforms to
 * this (Session.run → QueryResult with Record[] having toObject/get/forEach).
 */
export interface GraphRecordLike {
  toObject(): Record<string, unknown>;
  get(key: string): unknown;
}

export interface GraphRunResultLike {
  records: GraphRecordLike[];
}

export interface GraphSessionLike {
  run(query: string, params?: GraphParams): Promise<GraphRunResultLike>;
  close(): Promise<void>;
}

export interface GraphDriverLike {
  session(): GraphSessionLike;
  close(): Promise<void>;
  verifyConnectivity(): Promise<void>;
  /** Human-readable target, for logs/errors. */
  address?: string;
}

/** The seam everything else depends on (§4). Implemented by Neo4jGraphClient; fakes in tests. */
export interface GraphClient {
  run(query: string, params?: GraphParams): Promise<GraphResult>;
  isReady(): boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface Neo4jGraphClientOptions {
  /** Defaults to NEO4J_URI then `bolt://neo4j:7687` (§3: service name, not localhost). */
  uri?: string;
  /** Defaults to NEO4J_USER then `neo4j`. */
  user?: string;
  /** Defaults to NEO4J_PASSWORD — empty lets connect() fail fast instead of hanging. */
  password?: string;
  /** Connect-with-retry: max attempts (default 60) at `connectDelayMs` (default 2000ms). */
  maxConnectAttempts?: number;
  connectDelayMs?: number;
  /** Test seam: an already-constructed driver (fake or verified-driver). */
  driver?: GraphDriverLike;
}

export class Neo4jGraphClient implements GraphClient {
  private driver: GraphDriverLike | null = null;
  private ready = false;
  private readonly options: Neo4jGraphClientOptions;

  constructor(options: Neo4jGraphClientOptions = {}) {
    this.options = options;
    if (options.driver) {
      this.driver = options.driver;
      this.ready = false; // readiness is proven by connect(), even for injected drivers
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Connect-with-retry (§3). Bounded so a misconfigured / absent Neo4j cannot
   * retry forever and fill the logs: after exhausting the attempts it throws
   * GraphUnavailableError (the caller logs; /api/graph/link 502s until ready).
   */
  async connect(): Promise<void> {
    const maxAttempts = this.options.maxConnectAttempts ?? 60;
    const delayMs = this.options.connectDelayMs ?? 2_000;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const driver = this.ensureDriver();
        await driver.verifyConnectivity();
        this.ready = true;
        console.log(`[graph] connected to ${this.target()}`);
        return;
      } catch (err) {
        this.ready = false;
        const detail = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) {
          throw new GraphUnavailableError(
            `Neo4j unreachable at ${this.target()} after ${attempt} attempts: ${detail}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Run one parameterized statement. Creates a session per call (each call is
   * an independent query — context search runs several, the compiler one per
   * write). Throws GraphUnavailableError when not connected and GraphQueryError
   * when the server rejects the statement.
   */
  async run(query: string, params: GraphParams = {}): Promise<GraphResult> {
    let driver: GraphDriverLike;
    try {
      driver = this.ensureDriver();
    } catch (err) {
      throw new GraphUnavailableError((err as Error).message);
    }

    const session = driver.session();
    try {
      // Integer-valued params → neo4j.int(): the driver serializes plain JS
      // numbers as floats, and Neo4j requires the Integer type for integer
      // inputs (e.g. `LIMIT $n` rejects 5.0). Query authors always pass plain
      // numbers; the conversion happens at this single driver-aware boundary (§4).
      const result = await session.run(query, normalizeParams(params));
      return {
        records: result.records.map((record) => objectToPlain(record.toObject())),
      };
    } catch (err) {
      this.ready = false;
      throw mapDriverError(err, this.target());
    } finally {
      // A failed session.close() is a resource leak, not a query failure.
      await session.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.driver?.close().catch(() => {});
    this.driver = null;
    this.ready = false;
  }

  private ensureDriver(): GraphDriverLike {
    if (this.driver) return this.driver;
    const uri = this.uri();
    const user = this.user();
    const password = this.options.password ?? process.env.NEO4J_PASSWORD ?? "";
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password)) as unknown as GraphDriverLike;
    return this.driver;
  }

  private uri(): string {
    return this.options.uri ?? process.env.NEO4J_URI ?? "bolt://neo4j:7687";
  }

  private user(): string {
    return this.options.user ?? process.env.NEO4J_USER ?? "neo4j";
  }

  private target(): string {
    return `${this.uri()} (user ${this.user()})`;
  }
}

/**
 * The driver serializes plain JS numbers as floats; Neo4j requires the Integer
 * type for integer-typed statement inputs (e.g. `LIMIT $n` rejects 5.0). Convert
 * top-level integer-valued numbers to `neo4j.int()` here — the single place that
 * knows the driver — so query authors always pass plain `5`. Non-integer numbers
 * (confidences, attributes) must stay floats and are left untouched.
 */
function normalizeParams(params: GraphParams): GraphParams {
  let hasInt = false;
  for (const value of Object.values(params)) {
    if (typeof value === "number" && Number.isInteger(value)) {
      hasInt = true;
      break;
    }
  }
  if (!hasInt) return params;

  const out: GraphParams = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === "number" && Number.isInteger(value) ? neo4j.int(value) : value;
  }
  return out;
}

function mapDriverError(err: unknown, target: string): GraphError {
  const detail = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  const isConnectivity =
    code === "ServiceUnavailable" ||
    code === "SessionExpired" ||
    /failed to connect|connection.*(refused|closed|timed|reset)|could not connect/i.test(detail);
  if (isConnectivity) {
    return new GraphUnavailableError(`Neo4j unreachable at ${target}: ${detail}`);
  }
  return new GraphQueryError(`Cypher statement failed: ${detail}`);
}

/** Unwrap driver-specific value types into plain JSON-able JS. */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (neo4j.isInt(value)) return value.toNumber();
  if (neo4j.isNode(value)) {
    return {
      node_id: value.elementId,
      labels: [...value.labels],
      properties: objectToPlain(value.properties),
    };
  }
  if (neo4j.isRelationship(value)) {
    return {
      relationship_id: value.elementId,
      type: value.type,
      properties: objectToPlain(value.properties),
    };
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (isPlainObject(value)) return objectToPlain(value);
  // Anything else (temporal types, points, paths, driver wrappers) becomes its
  // closest human/JSON-readable form.
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  return value;
}

function objectToPlain(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = toPlain(value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}