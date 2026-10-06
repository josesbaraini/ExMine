#!/usr/bin/env bash
# Phase 3.5 end-to-end integration test — the exact scenarios that looked
# broken in the web app:
#
#   * a NO-CONTEXT question whose only answerable source is the graph
#     ("Who is the person Ana is hiring?") — the model must decide on its own
#     to call search_graph, read the DB, and ground its reply in it;
#   * NAME-BASED questions ("Who is Ana?", "Tell me about Jev.") where the
#     model typically sends the name as a TAG ({tags:["Ana"]}) — which used to
#     return zero matches and made the assistant claim the graph had no notes
#     about Ana while Ana was right there.
#
# Steps:
#   1. fresh stack build (rebuild so the image has Phase 3.5)
#   2. reset + seed the graph (Ana → is_hiring → Jev, ...)
#   3. prove the read route returns the seed by BOTH tags and name_query
#   4. no-context chat: every reply must be grounded (name the target) and
#      must NOT shrug "I couldn't find..." — the old misleading failure mode.
#
# Needs a real OPENROUTER_API_KEY in .env (a genuine LLM call is the point).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BASE="http://127.0.0.1:3000"

if ! grep -qE '^OPENROUTER_API_KEY=.+' .env; then
  echo "ERROR: OPENROUTER_API_KEY must be set in .env for this test." >&2
  exit 1
fi

echo "==> 1. fresh stack (rebuild so the backend image includes Phase 3.5)"
docker compose up -d --build >/dev/null
for i in $(seq 1 90); do curl -fsS "$BASE/api/health" 2>/dev/null | grep -q '"status":"ok"' && break; sleep 1; done
for i in $(seq 1 150); do curl -fsS "$BASE/api/graph/ready" 2>/dev/null | grep -q '"graph":"ready"' && break; sleep 1; done
echo "$(curl -fsS "$BASE/api/graph/ready")"

echo ""
echo "==> 2. reset + seed the graph"
./scripts/graph-seed.sh

echo ""
echo "==> 3. the read route sees the seed by BOTH tags and name_query"
search_tags="$(curl -fsS -X POST "$BASE/api/graph/search" -H 'content-type: application/json' -d '{"tags":["hiring"]}')"
if ! echo "$search_tags" | grep -q '"name":"Jev"'; then
  echo "FAIL: tag search (hiring) did not return Jev: $search_tags"
  exit 1
fi
search_name="$(curl -fsS -X POST "$BASE/api/graph/search" -H 'content-type: application/json' -d '{"name_query":"Ana"}')"
if ! echo "$search_name" | grep -q '"name":"Ana"'; then
  echo "FAIL: name_query search did not return Ana: $search_name"
  exit 1
fi
echo "OK: tag search finds Jev, name_query finds Ana"

echo ""
echo "==> 4. THE test — no-context questions; grounded answers or FAIL"
IGNORANCE="don'?t (know|have)|no information|nothing stored|can't say|couldn't find|no existing notes|don'?t recall"

# check_grounded <label> <question> <required keywords...>
check_grounded() {
  local label="$1"; shift
  local question="$1"; shift
  local reply
  reply="$(curl -fsS -X POST "$BASE/api/chat" -H 'content-type: application/json' \
    -d "{\"conversation_id\":null,\"message\":\"$question\"}" \
    | bun -e 'try { const d = await Bun.stdin.json(); process.stdout.write(d.reply ?? "(no reply field)") } catch { process.stdout.write("(non-JSON/error response)") }')"
  echo "    user   : $question"
  echo "    model  : $reply"
  if [ "$reply" = "(non-JSON/error response)" ]; then
    echo "    FAIL: $label — the API returned a non-JSON/error response"
    return 1
  fi
  local kw
  for kw in "$@"; do
    if ! echo "$reply" | grep -qi "$kw"; then
      echo "    FAIL: $label — reply misses keyword \"$kw\""
      return 1
    fi
  done
  if echo "$reply" | grep -qiE "$IGNORANCE"; then
    echo "    FAIL: $label — reply claims ignorance/empty search — the tool did not fire or returned nothing"
    return 1
  fi
  echo "    OK: grounded in the graph"
}

pass=1
check_grounded "tag-path Q&A" "Who is the person Ana is hiring? I cannot remember anything about them." "jev" || pass=0
check_grounded "name-in-tags Q&A" "Who is Ana?" "ana" "jev" || pass=0
check_grounded "name-only Q&A" "Tell me about Jev." "jev" || pass=0
check_grounded "relation Q&A" "What is the relationship between Ana and Jev?" "hir" || pass=0
check_grounded "neighborhood Q&A" "What projects is Ana working on?" "ana" "renovation" || pass=0
echo ""
[ "$pass" = 1 ] && echo "PASS: the model read the graph on its own for tag AND name questions." || {
  echo "FAIL: one or more no-context answers were not grounded — see above."
  exit 1
}