# syntax=docker/dockerfile:1

# Jarvis Phase 3 — single multi-stage image for the backend+static-serving side.
# Stage 1 builds the Vite frontend; Stage 2 runs the Bun/Elysia backend PLUS
# the built frontend from one process. No separate nginx service.

# ---------- Stage 1: build ----------
FROM oven/bun:1 AS build
WORKDIR /app

# Install backend deps (cache layer — only invalidated when the lockfile changes)
COPY backend/package.json backend/bun.lock* ./backend/
RUN cd backend && bun install --frozen-lockfile

# Install frontend deps (cache layer)
COPY frontend/package.json frontend/bun.lock* ./frontend/
RUN cd frontend && bun install --frozen-lockfile

# Copy sources (deps above stay cached when only source changes)
COPY backend ./backend
COPY frontend ./frontend

# Build the Vite frontend. The backend runs straight from TS — no build step.
RUN cd frontend && bun run build

# ---------- Stage 2: runtime ----------
FROM oven/bun:1 AS runtime

# Build args for the host user's UID/GID (Fedora Linux hosts: 1000/1000 default).
# The container process runs as this non-root user so files written into the
# ./data bind mount are owned by the host user, not root (§3 gotcha).
ARG USER_ID=1000
ARG GROUP_ID=1000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

WORKDIR /app

# The oven/bun images already ship a user with UID 1000/GID 1000 ("bun"), so
# *create* the app uid/gid only when they don't exist yet — blindly running
# groupadd/useradd fails with "UID 1000 is not unique". Setting the numeric
# USER 1000:1000 works in both cases. chown the tree so bun can write the data
# dir and a cache if needed.
RUN set -eux; \
    if ! getent group "${GROUP_ID}" >/dev/null 2>&1; then groupadd -g "${GROUP_ID}" app; fi; \
    if ! getent passwd "${USER_ID}" >/dev/null 2>&1; then useradd -u "${USER_ID}" -g "${GROUP_ID}" -m -s /bin/bash app; fi; \
    mkdir -p /app/data/conversations /app/data/extractions /app/data/resolutions; \
    chown -R "${USER_ID}:${GROUP_ID}" /app

COPY --from=build /app/backend ./backend
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/frontend/dist ./frontend/dist

USER ${USER_ID}:${GROUP_ID}
WORKDIR /app/backend
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "run", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>{if(!t.includes('status'))process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]