# Multi-stage build for the LangChain gateway.
# The server uses tsx as a TypeScript loader (tsc has noEmit: true).
# Runtime entry: tsx src/index.ts
# Base is Debian ("-slim"), NOT Alpine: better-sqlite3 and
# better-sqlite3-multiple-ciphers ship glibc prebuilt bindings, and Alpine
# (musl) cannot load them (ERR_DLOPEN_FAILED / missing ld-linux-x86-64.so.2).

# ---- Builder stage: install npm dependencies ----
FROM node:22-slim AS builder
WORKDIR /app

# Install ALL deps (including tsx from devDependencies — needed at runtime)
COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server .

# ---- Production stage ----
FROM node:22-slim

# CONFIG_DIR drives skills/agents/mcp catalog paths (see src/catalog/index.ts)
ENV NODE_ENV=production
ENV CONFIG_DIR=/config

WORKDIR /app

# Persistent state: SQLite databases + the plugin store live under /app/data.
# Mount a volume here so conversations, ledger, checkpoints, and installed
# plugins survive container recreation (immutable-image model).
ENV DB_PATH=/app/data/gateway.db
ENV LEDGER_DB_PATH=/app/data/ledger.db
ENV CHECKPOINT_DB_PATH=/app/data/checkpoints.db
ENV PLUGINS_STORE_PATH=/app/data/plugins.json
RUN mkdir -p /app/data
VOLUME ["/app/data"]

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./

# Pre-built seed default agent manifest (mirrors agent-default.ts shape)
RUN mkdir -p /defaults/agents && \
    echo '{"id":"default","version":"1.0.0","schemaVersion":1,"type":"agent","name":"Default","description":"General-purpose assistant with your selected model and enabled tools.","systemPrompt":"You are a helpful voice and text assistant. Decide whether to call a tool or answer directly based on the user\u0027s request. Never invent tool output.","skills":[],"tools":[]}' > /defaults/agents/default.json

COPY server/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 17600

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]