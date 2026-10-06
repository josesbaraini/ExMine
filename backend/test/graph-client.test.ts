import { describe, expect, it } from "bun:test";
import neo4j from "neo4j-driver";
import {
  GraphError,
  GraphQueryError,
  GraphUnavailableError,
  Neo4jGraphClient,
  type GraphDriverLike,
  type GraphParams,
  type GraphRunResultLike,
  type GraphSessionLike,
} from "../src/graph/client";

/**
 * Phase 3 §9 — GraphClient tested against a fake driver: query/params
 * pass-through, plain-JS value unwrapping, and the error mapping (connectivity
 * → GraphUnavailableError / 502, statement rejection → GraphQueryError). No
 * real Neo4j anywhere in this file.
 */

/** Minimal driver double conforming to the structural GraphDriverLike view. */
class FakeDriver implements GraphDriverLike {
  address = "bolt://fake:7687";
  closed = false;
  sessions = 0;
  /** How many verifyConnectivity calls should throw (retry-loop tests). */
  verifyFails = 0;
  runResult: GraphRunResultLike = { records: [] };
  runError: Error | null = null;
  runCalls: { query: string; params: GraphParams }[] = [];

  session(): GraphSessionLike {
    this.sessions++;
    return {
      run: async (query: string, params?: GraphParams) => {
        this.runCalls.push({ query, params: params ?? {} });
        if (this.runError) throw this.runError;
        return this.runResult;
      },
      close: async () => {},
    };
  }

  async verifyConnectivity(): Promise<void> {
    if (this.verifyFails > 0) {
      this.verifyFails--;
      throw new Error("connection refused");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Build a driver-shaped record from a plain object. */
function record(obj: Record<string, unknown>): GraphRunResultLike["records"][number] {
  return {
    toObject: () => obj,
    get: (key: string) => obj[key],
  };
}

function connectivityError(): Error {
  return Object.assign(new Error("Failed to connect to any Neo4j host"), { code: "ServiceUnavailable" });
}

describe("Neo4jGraphClient", () => {
  it("starts unready, becomes ready after a successful connect()", async () => {
    const driver = new FakeDriver();
    const client = new Neo4jGraphClient({ driver });
    expect(client.isReady()).toBe(false);
    await client.connect();
    expect(client.isReady()).toBe(true);
  });

  it("retries connect() per attempt budget, then succeeds", async () => {
    const driver = new FakeDriver();
    driver.verifyFails = 2;
    const client = new Neo4jGraphClient({ driver, maxConnectAttempts: 5, connectDelayMs: 5 });
    await client.connect();
    expect(client.isReady()).toBe(true);
  });

  it("gives up with GraphUnavailableError (bounded retry, no infinite loop)", async () => {
    const driver = new FakeDriver();
    driver.verifyFails = 99;
    const client = new Neo4jGraphClient({ driver, maxConnectAttempts: 3, connectDelayMs: 2 });
    await expect(client.connect()).rejects.toThrow(GraphUnavailableError);
    expect(client.isReady()).toBe(false);
  });

  it("passes query + params through to the session", async () => {
    const driver = new FakeDriver();
    const client = new Neo4jGraphClient({ driver });
    await client.connect();
    await client.run("MATCH (n) RETURN n", { name: "Ana" });
    expect(driver.runCalls).toEqual([{ query: "MATCH (n) RETURN n", params: { name: "Ana" } }]);
  });

  it("sends integer-valued params as Neo4j Integers, not floats (LIMIT rejects 5.0)", async () => {
    const driver = new FakeDriver();
    const client = new Neo4jGraphClient({ driver });
    await client.connect();
    await client.run("WITH n LIMIT $max_candidates", {
      max_candidates: 5,
      confidence: 0.8, // floats must survive untouched
      tags: ["a"], // non-numbers pass through untouched
    });
    const params = driver.runCalls[0].params;
    expect(neo4j.isInt(params.max_candidates)).toBe(true);
    expect(neo4j.int(params.max_candidates as number).toNumber()).toBe(5);
    expect(params.confidence).toBe(0.8);
    expect(params.tags).toEqual(["a"]);
  });

  it("unwraps driver Integer values into plain JS numbers", async () => {
    const driver = new FakeDriver();
    driver.runResult = { records: [record({ count: neo4j.int(3), name: "Ana" })] };
    const client = new Neo4jGraphClient({ driver });
    const result = await client.run("RETURN 1");
    expect(result.records).toEqual([{ count: 3, name: "Ana" }]);
    expect(typeof result.records[0].count).toBe("number");
  });

  it("unwraps driver Nodes into { node_id, labels, properties }", async () => {
    const driver = new FakeDriver();
    const node = new neo4j.types.Node(neo4j.int(1), ["Entity"], { name: "Ana", tags: ["work"] });
    driver.runResult = { records: [record({ n: node })] };
    const client = new Neo4jGraphClient({ driver });
    const result = await client.run("MATCH (n) RETURN n");
    expect(result.records[0]).toEqual({
      n: { node_id: node.elementId, labels: ["Entity"], properties: { name: "Ana", tags: ["work"] } },
    });
  });

  it("unwraps driver Relationships into { relationship_id, type, properties }", async () => {
    const driver = new FakeDriver();
    const rel = new neo4j.types.Relationship(
      neo4j.int(7),
      neo4j.int(1),
      neo4j.int(2),
      "RELATED",
      { relation: "mentions" },
    );
    driver.runResult = { records: [record({ r: rel })] };
    const client = new Neo4jGraphClient({ driver });
    const result = await client.run("MATCH ()-[r]->() RETURN r");
    expect(result.records[0]).toEqual({
      r: { relationship_id: rel.elementId, type: "RELATED", properties: { relation: "mentions" } },
    });
  });

  it("maps driver connectivity failures to GraphUnavailableError", async () => {
    const driver = new FakeDriver();
    driver.runError = connectivityError();
    const client = new Neo4jGraphClient({ driver });
    await client.connect();
    await expect(client.run("MATCH (n) RETURN n")).rejects.toBeInstanceOf(GraphUnavailableError);
    expect(client.isReady()).toBe(false);
  });

  it("maps statement rejections to GraphQueryError", async () => {
    const driver = new FakeDriver();
    driver.runError = Object.assign(new Error("Invalid input 'x'"), { code: "Neo.ClientError.Statement.SyntaxError" });
    const client = new Neo4jGraphClient({ driver });
    await client.connect();
    await expect(client.run("BROKEN")).rejects.toBeInstanceOf(GraphQueryError);
  });

  it("run() maps connectivity errors even when connect() never succeeded", async () => {
    const driver = new FakeDriver();
    driver.verifyFails = 1; // connect() can never succeed this run
    driver.runError = connectivityError();
    const client = new Neo4jGraphClient({ driver, maxConnectAttempts: 1, connectDelayMs: 0 });
    await expect(client.connect()).rejects.toThrow(GraphUnavailableError);
    await expect(client.run("MATCH (n) RETURN n")).rejects.toThrow(GraphUnavailableError);
  });

  it("close() closes the driver and flips readiness off", async () => {
    const driver = new FakeDriver();
    const client = new Neo4jGraphClient({ driver });
    await client.connect();
    await client.close();
    expect(driver.closed).toBe(true);
    expect(client.isReady()).toBe(false);
  });

  it("exposes the reachable target for error messages", async () => {
    const driver = new FakeDriver();
    const client = new Neo4jGraphClient({ driver, uri: "bolt://custom:7687", user: "me" });
    driver.runError = connectivityError();
    await client.connect();
    await expect(client.run("x")).rejects.toThrow(/bolt:\/\/custom:7687/);
  });
});