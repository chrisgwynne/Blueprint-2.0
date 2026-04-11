FROM node:22-alpine AS base
WORKDIR /app

# Install bun
RUN npm install -g bun

# Install build deps for native modules (better-sqlite3, node-pty)
RUN apk add --no-cache python3 make g++ linux-headers

# Copy workspace config
COPY package.json bun.lockb* ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install deps
RUN bun install

# Build client
COPY client/ ./client/
RUN bun run --cwd client build

# Copy server
COPY server/ ./server/
COPY agents/ ./agents/

# Init DB on first run via entrypoint
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "--cwd", "server", "start"]
