import { createServer } from "node:net";
import { createApp } from "./app";
import { Neo4jGraphClient } from "./graph/client";
import { OpenRouterClient } from "./llm/openrouter";
import { GeminiClient } from "./llm/gemini";

/**
 * Entry point. The OpenRouterClient constructor throws at startup when
 * OPENROUTER_API_KEY is missing — fail fast beats 502ing every request.
 *
 * Split-brain guard: Bun allows two processes to bind the same port
 * (SO_REUSEPORT-style sharing), which silently splits the in-memory
 * ConversationStore across processes (chat → extract 404s). Refuse to start
 * if the port is already taken, and only then hand it to Elysia.
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[jarvis] FATAL: port ${port} is already in use — another backend instance is running. Kill it first (e.g. 'fuser -k ${port}/tcp').`);
        process.exit(1);
      }
      reject(err);
    });
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve()));
  });
}

const port = Number(process.env.PORT ?? 3000);

await assertPortFree(port);

const provider = (process.env.LLM_PROVIDER ?? "openrouter").toLowerCase();
const llm = provider === "gemini" ? new GeminiClient() : new OpenRouterClient();
console.log(`[jarvis] LLM provider: ${provider}`);

// Phase 3 §3 — the neo4j compose service is reached by its service name
// (bolt://neo4j:7687), not localhost. Credentials come from NEO4J_AUTH
// (the same env var the compose file hands to the neo4j service) or the
// NEO4J_USER/NEO4J_PASSWORD pair. No fail-fast here: dev mode without a graph
// must keep chat/extract/diary working — the graph route 502s until reachable.
const graph = new Neo4jGraphClient({
  uri: process.env.NEO4J_URI ?? "bolt://neo4j:7687",
  ...neo4jCredentialsFromEnv(),
});

// Connect-with-retry in the background (§3): `depends_on` only starts the
// container; Neo4j takes longer to become queryable than this process takes
// to boot. A bounded retry loop logs progress and, on exhaustion, leaves the
// backend up with /api/graph/link returning 502 until Neo4j is reachable.
void graph
  .connect()
  .then(() => console.log("[jarvis] graph layer ready"))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jarvis] ${message}`);
    console.error("[jarvis] /api/graph/link will return 502 until Neo4j is reachable.");
  });

const app = createApp({ llm, graph });

app.listen(port, () => {
  console.log(`[jarvis] API + frontend listening on http://0.0.0.0:${port}`);
  console.log(`[jarvis] data dir: ${process.env.DATA_DIR ?? "repo ./data"}`);
});

/**
 * Parse credentials from `NEO4J_AUTH`, the single source of truth the compose
 * file also hands to the neo4j service (form: `user/password`). Falls back to
 * NEO4J_USER/NEO4J_PASSWORD or the defaults.
 */
function neo4jCredentialsFromEnv(): { user: string; password: string } {
  const auth = process.env.NEO4J_AUTH;
  if (auth) {
    const slash = auth.indexOf("/");
    if (slash > 0) {
      return { user: auth.slice(0, slash), password: auth.slice(slash + 1) };
    }
  }
  return { user: process.env.NEO4J_USER ?? "neo4j", password: process.env.NEO4J_PASSWORD ?? "" };
}