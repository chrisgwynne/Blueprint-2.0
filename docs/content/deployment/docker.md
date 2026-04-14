---
title: "Docker Deployment"
description: "Complete Docker setup guide for production"
section: "Deployment"
order: 1
---

# Docker Deployment

The recommended way to run Blueprint in production is with Docker. The container bundles the Express/Bun server, the built React client, and the SQLite database in a single image. There is no separate database server to manage.

---

## docker-compose.yml

Blueprint ships with a ready-to-use `docker-compose.yml`. Here's what it does:

```yaml
services:
  blueprint:
    build: .
    restart: unless-stopped
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data          # SQLite database and persistent app state
      - ./kb:/app/kb              # Knowledge base Markdown files
      - ./server/agents:/app/server/agents   # Agent soul files and profiles
    env_file:
      - .env
```

**Three volumes explained:**

- `./data` — the SQLite database (`blueprint.db`), connector sync state, and task history. This is the most important volume to back up.
- `./kb` — the knowledge base: Markdown files that agents read and write. These accumulate over time and contain business context that improves agent quality.
- `./server/agents` — agent soul files (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `AGENTS.md`), `profile.yaml` configs, and `memory.json` files. Mounting this volume means your agent customisations survive container rebuilds.

---

## Pre-Flight Checklist

Before running `docker compose up -d` in production, verify these four things:

**1. ENCRYPTION_KEY is set and is 64 hex characters.**

```bash
openssl rand -hex 32
# example output: a3f8d2e1c7b094f5e638a12d904c5b78f1e02394a78d3b5c6e19204f7d3a1b8c
```

Copy the output into your `.env` file as `ENCRYPTION_KEY`. This key encrypts connector credentials at rest. If you lose it, your connector tokens are unrecoverable.

**2. SESSION_SECRET is set and is different from ENCRYPTION_KEY.**

```bash
openssl rand -hex 32
```

Run this again (different value) and set it as `SESSION_SECRET`. Do not reuse the same value.

**3. ADMIN_PASSWORD is changed from the default.**

The default `changeme` is accepted on the first run but should be replaced immediately. Set `ADMIN_PASSWORD` in `.env` to a strong password.

**4. At least one LLM provider is configured.**

Set one of: `OLLAMA_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GEMINI_API_KEY`. Without an LLM provider, agents cannot run.

---

## Starting

```bash
git clone https://github.com/your-org/blueprint.git
cd blueprint
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD, and at least one LLM provider
docker compose up -d
```

Blueprint is available at [http://localhost:4000](http://localhost:4000).

The first startup initialises the SQLite database automatically via the Docker entrypoint. You will see the Blueprint login screen within a few seconds of the container starting.

---

## Nginx Reverse Proxy

For production with a custom domain and HTTPS, put Nginx in front of Blueprint. Blueprint uses Server-Sent Events (SSE) for real-time task and signal updates — the proxy config must support this.

```nginx
server {
    listen 80;
    server_name blueprint.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name blueprint.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/blueprint.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blueprint.yourdomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://localhost:4000;
        proxy_http_version 1.1;

        # Standard proxy headers
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # WebSocket / SSE support
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";

        # SSE requires disabling buffering
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 86400s;
    }
}
```

The critical settings for SSE are `proxy_buffering off` and `proxy_read_timeout 86400s`. Without these, SSE connections will be interrupted by Nginx's default 60-second read timeout, causing the real-time UI to disconnect repeatedly.

Set `CLIENT_URL` in your `.env` to your production URL (e.g., `https://blueprint.yourdomain.com`) so OAuth redirect URIs resolve correctly.

---

## Caddy Config

If you use Caddy, the configuration is two lines:

```caddy
blueprint.yourdomain.com {
    reverse_proxy localhost:4000
}
```

Caddy handles SSL automatically via Let's Encrypt and does not buffer SSE connections by default.

---

## Ports

Blueprint listens on port **4000** by default. To change it, set `PORT` in your `.env`:

```bash
PORT=8080
```

And update your `docker-compose.yml` port mapping:

```yaml
ports:
  - "8080:8080"
```

---

## Updating

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Blueprint runs database migrations automatically on startup. You do not need to run migrations manually.

> [!TIP]
> `--no-cache` ensures the image is rebuilt from the latest source. Without it, Docker may use cached layers that don't reflect your latest `git pull`.

---

## Backup

Blueprint's state lives in three directories. Back them up:

```bash
# Back up everything that matters
tar -czf blueprint-backup-$(date +%Y%m%d).tar.gz ./data ./kb ./server/agents
```

- `./data` — SQLite database, task history, signal history, connector sync state. **Critical.**
- `./kb` — knowledge base Markdown files built up over time. Important but recoverable.
- `./server/agents` — customised soul files and agent memory. Important if you have customised agents.

The container image and source code do not need to be backed up — they can be re-cloned and rebuilt at any time.

---

## Health Check

To verify Blueprint is running:

```bash
curl http://localhost:4000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "db": "connected",
  "scheduler": "running",
  "uptime": 3847
}
```

If `scheduler` is `disabled`, the `DISABLE_SCHEDULER` environment variable is set — agents will not run automatically until you remove it.
