# Stage 1: Build shell (Vite React app)
FROM oven/bun:1 AS shell-build

WORKDIR /app/shell
COPY shell/package.json ./
RUN bun install --ignore-scripts
COPY shell/ ./
COPY tsconfig.json /app/tsconfig.json
RUN bunx vite build

# Stage 2: Build node-pty + install AI CLI tools with Node.js
FROM node:20-slim AS node-build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app/core
COPY core/package.json ./
RUN npm install

# Install AI CLI tools globally (while npm works natively)
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli

# Stage 3: Runtime (bun + node)
FROM oven/bun:1

RUN apt-get update && apt-get install -y git ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy entire Node.js installation (node, npm, npx, global packages)
COPY --from=node-build /usr/local /usr/local

COPY tsconfig.json ./

# Copy pre-built core node_modules (includes compiled node-pty)
COPY --from=node-build /app/core/node_modules core/node_modules
COPY core/ core/

# Copy built shell assets
COPY --from=shell-build /app/shell/dist /app/shell-dist

EXPOSE 3000

ENTRYPOINT ["bun", "run", "core/src/index.ts", "/workspace"]
