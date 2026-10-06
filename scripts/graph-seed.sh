#!/usr/bin/env bash
# Phase 3.5 QA fixture: clear Neo4j and seed a small, human-readable graph the
# SAME way the Phase 3+4 write pipeline would (Entity nodes, RELATED edges with
# a `relation` property — see backend/src/graph/compiler.ts), so the read path
# (searchContext) finds it realistically. Tags are realistic per-node search
# hooks — note "hiring" lives on Jev (what a write-time extraction would tag)
# and ALSO on the edge's relation property.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

auth="$(grep -E '^NEO4J_AUTH=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
auth="${auth:-neo4j/jarvis-dev-password}"
user="${auth%%/*}"
pass="${auth#*/}"

if ! docker compose ps --status running 2>/dev/null | grep -q neo4j; then
  echo "ERROR: Neo4j is not running — start the stack first: docker compose up -d --build" >&2
  exit 1
fi

docker compose exec -T neo4j cypher-shell -u "$user" -p "$pass" --format plain >/dev/null <<'EOF'
MATCH (n) DETACH DELETE n;
CREATE (ana:Entity { name: 'Ana', category: 'person', tags: ['colleague','friend','car-repair'] })
CREATE (jev:Entity { name: 'Jev', category: 'person', tags: ['designer','hiring','colleague','new-hire'] })
CREATE (proj:Entity { name: 'Kitchen Renovation', category: 'project', tags: ['home','renovation','budget'] })
CREATE (ana)-[:RELATED { relation: 'is_hiring', attributes: '{"status":"confirmed"}' }]->(jev)
CREATE (ana)-[:RELATED { relation: 'is_working_on', attributes: '{"status":"ongoing"}' }]->(proj);
EOF

echo "OK: graph reset. Seeded:"
docker compose exec -T neo4j cypher-shell -u "$user" -p "$pass" --format plain \
  "MATCH (n)-[r]->(m) RETURN n.name AS from, r.relation AS relation, m.name AS to ORDER BY from;"