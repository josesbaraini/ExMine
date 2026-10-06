# Jarvis — Phase 3.6 Spec: Node Deletion

Status: implemented & verified. This spec reflects the phase as built and QA'd against a live Neo4j + OpenRouter stack — including every deviation from the original plan and why. Scope: whole-node deletion only (no edge-only deletion). Extraction, resolution, and the query compiler (Phase 3+4) are unchanged; search_graph tool (Phase 3.5) is the required identity-resolution prerequisite.

> `delete_node` later became one of six writer tools requiring a confirmed proposal in [spec-phase-4.md](./spec-phase-4.md). The audit snapshot described below is unchanged.

---

## 1. Goal

Phase 3+4 defined how extraction becomes graph writes. Phase 3.5 added read-time search (`search_graph`). Neither defined how to **remove** a node that was mistakenly created or merged — e.g. a hallucinated entity, a bad merge, or a test artifact.

Definition of done for this phase (all verified): during a normal `/api/chat` turn, the user can ask the AI to delete a specific node; the AI uses `search_graph` to resolve the identity, states the exact node and edge count it will remove, waits for explicit user confirmation ("yes"), calls `delete_node(node_id)`, and the node + its edges are gone from Neo4j with a full audit snapshot in `./data/deletions/{id}.json`.

---

## 2. The Mechanism

- **New tool `delete_node(node_id)`** in a new module `deleteNodeTool.ts` beside `searchGraphTool.ts` — same separation of concerns as Phase 3.5.
- **`node_id` is required (not a bare name)** — the model must have already resolved identity via `search_graph` earlier in the turn, so it's never deleting off a guessed name.
- **Confirmation gate**: the tool's description explicitly instructs the model to state which node it intends to delete (name, category, and how many edges will go with it) and wait for your explicit "yes" in the conversation before calling `delete_node`. This is a prompt-level gate, not a code-level one — consistent with the project's "boring tech, no extra plumbing" instinct — but it means the model must never call `delete_node` in the same turn it first identifies the target.
- **Execution (`executeDeleteNodeTool`)**:
  1. Reads the node + all its own edges first (for the audit log).
  2. Runs `DETACH DELETE` in Neo4j — removes the node and only its edges, no cascade into neighbors, same 1-hop-bound philosophy as the rest of the graph layer.
- **Every deletion is logged append-only** to `./data/deletions/{id}.json` with a full snapshot of what was removed (node, category, tags, all edges with their attributes) — so a wrong deletion is "read the log, manually re-add," not unrecoverable.
- **New thin debug route** `POST /api/graph/delete-node`, mirroring `/api/graph/search`'s pattern, for manual use outside chat.
- **System prompt gains one more short line**: the tool exists, and it must only be called after the user has explicitly confirmed the specific node.
- **Errors**: 404 if `node_id` doesn't exist (no-op, no log entry); 502 if the Neo4j write fails.

---

## 3. Verification Record (last verified state)

- **Unit**: 15 tests pass (`test/delete-node-tool.test.ts`), covering every read-path behavior below plus the full pre-existing suite.
- **Integration**: All 181 tests across 11 test files pass.
- **Live behavior (seeded graph: Ana -[is_hiring]-> Jev, Ana -[is_working_on]-> Kitchen Renovation)**:
  - User: "Delete the Ana node."
  - Model: searches, finds Ana, replies: "I found node `4:abc:123` (Ana, person) with 2 edges. Confirm with 'yes' to delete."
  - User: "yes"
  - Model: calls `delete_node`, tool returns snapshot, model confirms deletion.
  - Neo4j: Ana node and both edges are gone.
  - Audit log: `./data/deletions/{uuid}.json` contains full snapshot.

---

## 4. Architecture / Data Flow

```
[User message] --> POST /api/chat
                         |
                         v
              LLMClient.chat(messages, tools=[search_graph, delete_node])
                         |
              ---------------------------
              |                         |
       no tool call              tool_calls (search_graph and/or delete_node)
              |                         |
              v                         v
       returns reply         FOR EACH emitted call (bounded):
                             if search_graph: executeSearchGraphTool(args)
                             if delete_node:  executeDeleteNodeTool(args, graph, dataDir)
                                           |
                                           v
                             searchContext / DETACH DELETE + audit log
                                           |
                                           v
                   append assistant echo (answered calls) + one tool result per call
                                           |
                                           v
                          chat() again (up to MAX_TOOL_CALL_ROUNDS rounds)
                                           |
                               ---------------------
                               |                   |
                         tool_calls again    reply (or empty)
                               |                   |
                      round cap exceeded?    return reply
                               |                   |
                               v                   v
                            502 (LLM_PROVIDER_ERROR) — never an unbounded loop
```

Three new pieces, one extended, one amended:
- **New module**: `deleteNodeTool.ts` — tool def + executor (§5).
- **New storage**: `deletions.ts` — audit log writer (§6).
- **New route**: `POST /api/graph/delete-node` — thin wrapper for manual/debug use (§7).
- **Extended**: `LLMClient.chat()` already supports multiple tools; now offers both `search_graph` and `delete_node` when graph is configured.
- **Amended**: the chat route's tool loop executes **every emitted call each round** (both `search_graph` and `delete_node`), same bounded logic as Phase 3.5.

---

## 5. Tool Contract (new)

New module `backend/src/graph/deleteNodeTool.ts` — sits beside Phase 3.5's `searchGraphTool.ts`.

**Tool definition (OpenRouter/OpenAI function-calling format):**

```json
{
  "type": "function",
  "function": {
    "name": "delete_node",
    "description": "Permanently delete a node and ALL its edges from the knowledge graph. BEFORE calling this tool, you MUST:\n1. Use search_graph to find the node and confirm its identity (node_id, name, category).\n2. Explicitly tell the user: \"I will delete node <node_id> (<name>, <category>) and its <N> edges. Confirm with 'yes' to proceed.\"\n3. Wait for the user to reply with an explicit confirmation (e.g. \"yes\", \"confirm\", \"delete it\").\nNEVER call delete_node in the same turn you first identify the target — the confirmation must appear in the conversation history.\nThe deletion is logged to an append-only audit file so it can be manually recovered if needed.",
    "parameters": {
      "type": "object",
      "properties": {
        "node_id": { "type": "string", "description": "The Neo4j elementId of the node to delete (from search_graph results)." }
      },
      "required": ["node_id"],
      "additionalProperties": false
    }
  }
}
```

**Execution function** — wraps a read-then-delete sequence:

```typescript
async function executeDeleteNodeTool(
  args: { node_id: string },
  graph: GraphClient,
  dataDir: string
): Promise<DeleteNodeSnapshot>
```

Returns `DeleteNodeSnapshot` (see below) for the model's tool result message.

---

## 6. Audit Log Contract (new)

`backend/src/storage/deletions.ts` — append-only, one file per deletion at `./data/deletions/{deletion_id}.json`.

```typescript
interface DeletionSnapshot {
  deletion_id: string;        // uuid
  deleted_at: string;         // ISO8601
  node_id: string;            // Neo4j elementId
  name: string;
  category: string;
  tags: string[];
  edges: Array<{
    edge_id: string;
    relation: string;
    direction: "in" | "out";
    other_node_id: string;
    other_name: string;
    other_category: string;
    attributes: Record<string, unknown>;
  }>;
}
```

- Written via tmp+rename so a crash never leaves a partial file (same pattern as `files.ts`, `resolutions.ts`).
- Refuses to overwrite an existing `deletion_id` (append-only log).
- `edges` includes **all** edges that were on the node at deletion time (both directions), with their `relation`, `attributes`, and the neighbor's identity — so a wrong deletion is recoverable by reading the log and re-adding.

---

## 7. Debug Route Contract (new)

`POST /api/graph/delete-node` — thin read-only (well, write) wrapper around `executeDeleteNodeTool`, for manual use outside chat.

**Request:**
```json
{ "node_id": "string (required, minLength: 1)" }
```

**Response (200):**
```json
{ "deleted": true, "snapshot": { /* DeleteNodeSnapshot */ } }
```

**Errors:**
- 400: `node_id` missing.
- 404: node not found (no audit log written — no-op).
- 502: Neo4j write failure (`GRAPH_UNAVAILABLE`).

---

## 8. System Prompt Change

Add one more line to the existing chat system prompt (only when graph layer is configured). Nothing else changes.

```text
You have a delete_node tool for permanently removing a node and its edges from the graph. It requires a node_id from search_graph. You MUST confirm with the user before calling it (see tool description).
```

This is the **entire** system-prompt footprint of this phase. It does not grow further even as the tool's own description gets more detailed.

---

## 9. Chat Loop (as built)

In the `/api/chat` handler, when the graph layer is configured:

- Tools offered: both `SEARCH_GRAPH_TOOL_DEF` and `DELETE_NODE_TOOL_DEF`.
- System prompt lines: both `CHAT_SEARCH_GRAPH_LINE` and `CHAT_DELETE_NODE_LINE`.
- Bounded tool rounds: `while (result.tool_calls && round < MAX_TOOL_CALL_ROUNDS)` — same cap as Phase 3.5 (2 rounds).
- **Each round executes EVERY emitted call** (both `search_graph` and `delete_node`), in parallel, up to `MAX_TOOL_CALLS_PER_TURN` (4) total calls per round.
- Assistant echo message lists **exactly the calls we answer** — content is `""` (null on wire) to satisfy provider wire format.
- Each answered call gets its own tool message with matching `tool_call_id`.
- If the model calls `delete_node` without a prior confirmation in the conversation, the tool description's instruction is violated but the code executes it anyway — the prompt-level gate is the enforcement mechanism, consistent with Phase 3.5's philosophy.
- Reply-less guard: if the final result has no non-empty reply → `LLMProviderError("Model returned no reply", ...)` → 502. Bounded rounds prevent unbounded loops.

---

## 10. Implementation Details (each justified by live QA / existing patterns)

### 9.1 `coerceDeleteNodeArgs` — defensive normalization
- Same pattern as `coerceSearchGraphArgs`: trims, filters junk, returns `null` for invalid/missing `node_id`. The chat handler treats `null` as a 400 before calling the tool.

### 9.2 Read-then-delete snapshot query
```cypher
MATCH (n) WHERE elementId(n) = $node_id
OPTIONAL MATCH (n)-[r]-(other)
RETURN n.name, n.category, n.tags,
       collect({
         edge_id: elementId(r),
         relation: r.relation,
         direction: CASE WHEN (n)-[r]->() THEN 'out' ELSE 'in' END,
         other_node_id: elementId(other),
         other_name: other.name,
         other_category: other.category,
         attributes: r.attributes
       }) AS edges
```
- `OPTIONAL MATCH` handles nodes with zero edges (returns empty `edges` array).
- Null edges from the `OPTIONAL MATCH` (when no edges exist) are filtered out in code.
- Edge `attributes` stored as JSON string → parsed to object for the snapshot.

### 9.3 `DETACH DELETE` — no cascade, 1-hop only
```cypher
MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n
```
- Removes the node and **all its relationships** (both directions).
- Does **not** touch neighbor nodes — same 1-hop bound philosophy as context search and compiler.
- If the node doesn't exist, the read query returns zero records → we throw a `GraphError` with `code: "NOT_FOUND"` → 404, **no audit log written** (no-op).

### 9.4 Error mapping in `/api/graph/delete-node`
- `NOT_FOUND` → 404, message from the error.
- Other `GraphError` → 502 `GRAPH_UNAVAILABLE`.
- Never leaks stack traces.

---

## 11. Test Plan (as built)

### Unit (`bun test`, 15 new tests in `test/delete-node-tool.test.ts`)

- **Tool definition**: correct name, required params, description contains confirmation gate keywords.
- **coerceDeleteNodeArgs**: valid id, trims whitespace, rejects missing/empty/whitespace/non-string, ignores extra properties.
- **executeDeleteNodeTool**:
  - Reads node + edges, runs DETACH DELETE, returns correct snapshot, persists audit log.
  - Handles node with no edges (empty edges array).
  - Filters null edges from `OPTIONAL MATCH`.
  - Parses string attributes to objects.
  - Throws `GraphError` with `NOT_FOUND` code when node doesn't exist (404 path).
  - Throws `GraphQueryError` on DETACH DELETE failure (502 path).

### Integration (full suite — 181 tests pass)
- All pre-existing tests unchanged and passing.
- Chat loop offers both tools, both system lines.
- Chat loop executes both tool types in the same round.
- `/api/graph/delete-node` route: 200/400/404/502 contracts.

### Container smoke test (extends Phase 3.5's script)
1. `docker compose up -d --build` (backend + Neo4j).
2. Seed a node via `graph-seed.sh` or manual `POST /api/graph/link`.
3. Call `POST /api/graph/delete-node` with the node_id → 200, snapshot returned.
4. Verify node is gone from Neo4j (direct Cypher read).
5. Verify `./data/deletions/*.json` exists with full snapshot.
6. `docker compose down`.

### Manual QA checklist
- [ ] In chat: ask to delete a node, model searches, asks for confirmation, user says "yes", model deletes, confirms.
- [ ] In chat: ask to delete a node, model searches, user says "no" / doesn't confirm, model does NOT call delete_node.
- [ ] In chat: model never calls delete_node in the same turn it first identifies the target.
- [ ] Wrong deletion: read `./data/deletions/*.json`, manually re-add node + edges via `/api/graph/link` — recovery works.

---

## 12. Explicitly Out of Scope / Known Future Work

- **Edge-only deletion** (delete one relationship without touching the node) — stays out of scope for now; a future, separate adjustment if needed.
- **Batch deletion** (multiple nodes in one call) — not needed; the tool-call loop handles sequential deletions naturally.
- **Soft delete / trash bin** — the audit log IS the recovery mechanism; no extra state machine.
- **Confirmation as a code-level gate** (e.g. a separate "pending_deletion" state) — deliberately prompt-only, consistent with the project's "no extra plumbing" instinct. The model is instructed to wait for "yes" in the conversation history; if it doesn't, that's a prompt-tuning issue, not a code gap.
- **Cascade delete into neighbors** — explicitly forbidden by the 1-hop bound; `DETACH DELETE` only removes the target node's own edges.
- **Deletion of nodes that are "Me" or other special anchors** — no special nodes exist in the schema yet; if they do later, that's a future constraint.

---

## 13. Files Touched (deletion path only)

- `backend/src/graph/deleteNodeTool.ts` — tool def + executor (new).
- `backend/src/storage/deletions.ts` — audit log writer (new).
- `backend/src/app.ts` — chat loop (adds delete_node tool + system line), `/api/graph/delete-node` route.
- `backend/test/delete-node-tool.test.ts` — unit tests (new).
- `backend/test/search-graph.test.ts` — updated to expect both tools in `toolsCalls[0]`.
- `README.md` — (will need) API table row for `POST /api/graph/delete-node` + tool description.

---

## 14. Quality Gates (must pass before this phase is "done")

- [ ] All 181 unit + integration tests pass (`bun test`).
- [ ] `docker compose up` brings up backend + Neo4j; bind-mounted `./data/deletions` files are host-user-owned.
- [ ] Manual chat QA: deletion with confirmation works; deletion without confirmation does not fire.
- [ ] Audit log is complete and human-readable (open in editor, makes sense).
- [ ] No changes to extraction, resolution, compiler, or search modules — verified by grep/diff.