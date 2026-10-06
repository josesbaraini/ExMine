#!/usr/bin/env bash
# Dev mode: backend (:3000) + Vite frontend (:5173) side by side.
# Frontend proxies /api to the backend; the container instead serves both.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — add your OPENROUTER_API_KEY before chatting." >&2
fi

# Real precaution: dev mode needs :3000, which the docker stack also publishes.
# If something is already serving there, refusing loudly beats silently booting
# a backend that dies on the port guard and leaving a broken Vite tab behind
# (seen in practice: "Firefox can't establish a connection to ws://:5173").
if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "ERROR: something already serves http://localhost:3000." >&2
  echo "  If the docker stack is up (check: docker compose ps), use it at http://localhost:3000" >&2
  echo "  or stop it first:  docker compose down   — then re-run ./scripts/dev.sh for dev mode (:5173)." >&2
  exit 1
fi

bun run --cwd backend dev &
backend_pid=$!
trap 'kill "$backend_pid" 2>/dev/null || true' EXIT

echo "Backend on http://localhost:3000 | Frontend on http://localhost:5173"

# The live provider gate (scripts/test-gemini-live.ts). It replays the exact
# request sequences the app makes — including the SECOND turn of a tool round
# trip, where Gemini rejects a missing thought_signature — so run it alongside
# `bun test` while developing. Failures here are real defects, not flakes;
# 429/503 exits 2 as provider weather. Skips without an API key.
if [ -n "${GEMINISTUDIO_API_KEY:-}" ] || grep -qE '^GEMINISTUDIO_API_KEY=.+' .env 2>/dev/null; then
  echo "Running live provider gate (bun run test:live)..."
  (set -a; . ./.env; set +a; bun scripts/test-gemini-live.ts) || echo "live gate exit=$? — see above" >&2
else
  echo "No GEMINISTUDIO_API_KEY — skipping the live provider gate." >&2
fi

bun run --cwd frontend dev