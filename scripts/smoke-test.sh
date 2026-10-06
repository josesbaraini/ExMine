#!/usr/bin/env bash
# Docker quality gate smoke test (Phase 1 §8/§9 + Phase 2 §9/§10 + Phase 3 §9).
# MUST pass for the phase to be done.
#
#   1. Ensure ./data/neo4j/{data,logs} exist and are host-user-owned (§3) —
#      the image fails to start when they're missing, and runs as root-owner
#      otherwise.
#   2. docker compose up -d --build (backend + Neo4j in one command)
#   3. Poll GET /api/health AND /api/graph/ready (proves the backend reached
#      bolt://neo4j:7687 — `depends_on` alone doesn't)
#   4. With OPENROUTER_API_KEY in .env: run a real chat + extract, write 3
#      diary entries, restart the container, and verify the diary entries
#      survived (proves file-based storage, not in-memory).
#   5. Check files written into ./data are owned by the HOST user, not root —
#      including the Neo4j data/logs written by the neo4j container.
#   6. docker compose down
#
# Without OPENROUTER_API_KEY the LLM/diary steps are skipped (health +
# ownership still run) — the ownership check is the point of the permissions
# gotcha (§3).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Identical source of truth to `docker compose up`: compose interpolates
# USER_ID/GROUP_ID from .env, falling back to 1000. Read them the SAME way so
# the smoke test can never diverge from the plain-`up` codepath (a past gap:
# the smoke exported $(id -u) while plain up used defaults).
env_user="$(grep -E '^USER_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
env_group="$(grep -E '^GROUP_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
export USER_ID="${env_user:-1000}"
export GROUP_ID="${env_group:-1000}"
COMPOSE="${COMPOSE:-docker compose}"
BASE="http://127.0.0.1:3000"

cleanup() { $COMPOSE down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -f .env ] && grep -qE '^OPENROUTER_API_KEY=.+' .env; then
  SKIP_LLM=0
else
  echo "NOTE: OPENROUTER_API_KEY not set in .env — skipping the real chat/extract/diary steps." >&2
  echo "      Health + ownership checks still run." >&2
  SKIP_LLM=1
fi

echo "==> 0. ensure ./data/neo4j/{data,logs} exist and are host-user-owned (§3, §10)"
for sub in data logs; do
  dir="data/neo4j/$sub"
  mkdir -p "$dir"
  owner="$(stat -c '%u:%g' "$dir")"
  if [ "$owner" != "$USER_ID:$GROUP_ID" ]; then
    echo "FAIL: $dir owned by $owner (expected $USER_ID:$GROUP_ID) — run with the host user or chown it first."
    exit 1
  fi
done
echo "OK: neo4j bind-mount dirs present and owned by $(id -un)"

wait_health() {
  local ok=0
  for i in $(seq 1 90); do
    if curl -fsS "$BASE/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
      ok=1
      break
    fi
    sleep 1
  done
  [ "$ok" = "1" ] || {
    echo "FAIL: $BASE/api/health never returned ok"
    $COMPOSE logs --tail 40 || true
    exit 1
  }
}

wait_graph_ready() {
  local ok=0
  for i in $(seq 1 150); do
    if curl -fsS "$BASE/api/graph/ready" 2>/dev/null | grep -q '"graph":"ready"'; then
      ok=1
      break
    fi
    sleep 1
  done
  [ "$ok" = "1" ] || {
    echo "FAIL: $BASE/api/graph/ready never reported \"ready\" (backend could not reach bolt://neo4j:7687)"
    $COMPOSE logs --tail 60 || true
    exit 1
  }
}

echo "==> 1. docker compose up -d --build (whole stack, one command)"
$COMPOSE up -d --build

echo "==> 1b. host ports must actually be published (a past regression left nothing testable)"
for svc_port in "jarvis 3000" "neo4j 7687" "neo4j 7474"; do
  svc="${svc_port% *}"
  port="${svc_port#* }"
  if ! $COMPOSE port "$svc" "$port" >/dev/null 2>&1; then
    echo "FAIL: no published host port for $svc:$port — expected 'docker compose port $svc $port' to resolve"
    $COMPOSE ps
    exit 1
  fi
done
echo "OK: jarvis:3000, neo4j:7687 (Bolt), neo4j:7474 (Browser) are published on the host"

echo "==> 2. polling GET /api/health"
wait_health
echo "OK: /api/health is 200 ok"

echo "==> 3. polling GET /api/graph/ready (backend → Neo4j, not just container start)"
wait_graph_ready
echo "OK: graph layer is ready"

if [ "$SKIP_LLM" = "0" ]; then
  echo "==> 4a. test chat + extract"
  chat_body="$(curl -fsS -X POST "$BASE/api/chat" \
    -H 'content-type: application/json' \
    -d '{"conversation_id":null,"message":"Remind me to fix the garage door and call Ana next week."}')"
  cid="$(printf '%s' "$chat_body" | grep -oE '"conversation_id":"[^"]+"' | head -1 | cut -d'"' -f4)"
  if [ -z "$cid" ]; then
    echo "FAIL: no conversation_id returned from /api/chat: $chat_body"
    exit 1
  fi
  curl -fsS -X POST "$BASE/api/conversations/${cid}/extract" >/dev/null
  echo "OK: extract ran for ${cid}"

  echo "==> 4b. diary round-trip: write 3 entries through the API"
  for i in 1 2 3; do
    curl -fsS -X POST "$BASE/api/diary/entries" \
      -H 'content-type: application/json' \
      -d "{\"text\":\"Diary smoke entry number $i — written before the restart check.\"}" >/dev/null
  done
  if [ ! -f data/diary-entries.jsonl ]; then
    echo "FAIL: data/diary-entries.jsonl was not created by POST /api/diary/entries"
    exit 1
  fi
  echo "OK: data/diary-entries.jsonl exists"

  echo "==> 4c. restart the container; entries must survive (file storage, not memory)"
  $COMPOSE restart >/dev/null
  wait_health
  diary_body="$(curl -fsS "$BASE/api/diary/entries")"
  count="$(printf '%s' "$diary_body" | grep -o '"id"' | wc -l)"
  if [ "$count" -lt 3 ]; then
    echo "FAIL: expected >=3 diary entries after restart, got $count: $diary_body"
    exit 1
  fi
  echo "OK: $count diary entries survived the container restart"
else
  echo "==> 4a/4b/4c. skipped (no OPENROUTER_API_KEY)"
fi

echo "==> 5. ./data files AND dirs are owned by the host user ($USER_ID:$GROUP_ID), not root"
bad=0
while IFS= read -r f; do
  owner="$(stat -c '%u:%g' "$f")"
  if [ "$owner" != "$USER_ID:$GROUP_ID" ]; then
    echo "FAIL: $f owned by $owner (expected $USER_ID:$GROUP_ID)"
    bad=1
  fi
done < <(find data \( -type f -o -type d \) 2>/dev/null | sort)
if [ "$bad" != "0" ]; then
  echo "FAIL: root-owned files in ./data — check the USER_ID/GROUP_ID build args, the neo4j user: line, and the neo4j dir pre-creation (§3)."
  exit 1
fi
echo "OK: data files owned by $(id -un)"

$COMPOSE down --remove-orphans >/dev/null 2>&1 || true
trap - EXIT
echo "SMOKE TEST PASSED"