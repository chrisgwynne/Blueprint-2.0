---
title: "Docker Setup"
description: "Running Blueprint with Docker Compose"
section: "Getting Started"
order: 2
---

# Docker Setup

Docker is the recommended way to run Blueprint in production. It bundles the server, client build, and all dependencies into a single container, and uses mounted volumes so your data survives restarts and upgrades.

---

## The docker-compose.yml File

Blueprint ships with a `docker-compose.yml` at the repository root. Here is the full file with annotations:

```yaml
version: '3.8'
services:
  blueprint:
    build: .
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data
      - ./kb:/app/kb
      - ./server/agents:/app/server/agents
    environment:
      - NODE_ENV=production
      - PORT=4000
      - DATABASE_PATH=/app/data/blueprint.db
      - KB_PATH=/app/kb
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - SESSION_SECRET=${SESSION_SECRET}
      - ADMIN_USERNAME=${ADMIN_USERNAME}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI}
      - PAGESPEED_API_KEY=${PAGESPEED_API_KEY}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Volume breakdown

| Volume mount | What it stores | Why it matters |
|---|---|---|
| `./data:/app/data` | `blueprint.db` — the entire SQLite database | All connectors, metrics, signals, tasks, and agent run history live here. Without this mount the database is lost on container restart. |
| `./kb:/app/kb` | Knowledge base files — markdown documents you add to give agents business context | Persists the knowledge base across upgrades. |
| `./server/agents:/app/server/agents` | Per-agent state: `memory.json`, `run-log.jsonl`, `inbox.jsonl`, and soul file overrides | Agents accumulate memory and run history over time. Losing this mount resets agent memory completely. |

> [!TIP]
> The `./data`, `./kb`, and `./server/agents` directories are created automatically on first run. You do not need to create them manually. If you are moving an existing installation, copy these three directories to the new host before starting the container.

### Port mapping

The default port mapping is `4000:4000` — host port 4000 forwards to container port 4000. To change the host-side port (for example if 4000 is already in use), edit only the left-hand number:

```yaml
ports:
  - "8080:4000"   # Blueprint is now at http://yourserver:8080
```

---

## Configuring .env Before Starting

Blueprint reads configuration from environment variables injected via the `environment:` block in `docker-compose.yml`, which in turn reads from your `.env` file on the host.

Copy the example file and edit it before the first `docker compose up`:

```bash
cp .env.example .env
```

The minimum required variables to set:

```bash
# Generate both of these with: openssl rand -hex 32
ENCRYPTION_KEY=<64-char hex string>
SESSION_SECRET=<64-char hex string>

# Change the default admin password
ADMIN_PASSWORD=a-strong-password-here
```

All other variables can be left at their defaults for an initial run using Ollama as the LLM provider.

> [!TIP]
> Never commit your `.env` file to version control. It contains your encryption key, session secret, and all API credentials. The `.gitignore` in the Blueprint repository already excludes `.env`.

---

## Reverse Proxy Setup

In production you should put Blueprint behind a reverse proxy that handles SSL termination. Blueprint listens on HTTP only; TLS is the proxy's responsibility.

### Nginx

Full server block for proxying to Blueprint:

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

    # Increase buffer sizes for large API responses (agent runs, sync blobs)
    proxy_buffer_size          128k;
    proxy_buffers              4 256k;
    proxy_busy_buffers_size    256k;

    # Required for Server-Sent Events (live agent run streaming)
    proxy_read_timeout         300s;
    proxy_send_timeout         300s;

    location / {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

After adding this config, test and reload Nginx:

```bash
nginx -t && systemctl reload nginx
```

Obtain a certificate with Certbot:

```bash
certbot --nginx -d blueprint.yourdomain.com
```

### Caddy

Caddy handles HTTPS automatically. Add this single block to your `Caddyfile`:

```
blueprint.yourdomain.com {
    reverse_proxy 127.0.0.1:4000
}
```

Caddy provisions and renews a Let's Encrypt certificate automatically. No further TLS configuration is needed.

### SSL/TLS Notes

- Blueprint sets `GOOGLE_REDIRECT_URI` and other OAuth callback URLs. These must match the scheme (`https://`) you configure in Google Cloud Console once you are behind a TLS proxy.
- Update `GOOGLE_REDIRECT_URI` (and any other `*_REDIRECT_URI` variables) in `.env` to use `https://` before connecting OAuth-based connectors in production.
- The `CLIENT_URL` variable is used for CORS and should also be set to your `https://` domain.

---

## Starting, Stopping, and Restarting

```bash
# Start Blueprint in the background
docker compose up -d

# Stop Blueprint (data is preserved in mounted volumes)
docker compose down

# Restart the container (e.g. after editing .env)
docker compose restart blueprint

# Stop and remove the container + network (data still preserved in volumes)
docker compose down
```

---

## Viewing Logs

```bash
# Tail logs in real time
docker compose logs -f blueprint

# Show the last 100 lines
docker compose logs --tail=100 blueprint

# Show logs with timestamps
docker compose logs -f -t blueprint
```

Log output includes scheduler events, connector sync results, agent run summaries, and HTTP access logs.

---

## Updating Blueprint

```bash
# Pull the latest code
git pull

# Rebuild the image without using cached layers
docker compose build --no-cache

# Restart with the new image
docker compose up -d
```

> [!TIP]
> The database schema is migrated automatically on startup. You do not need to run any migration commands manually. If a migration fails, Blueprint logs the error and exits — check `docker compose logs blueprint` to diagnose.

---

## Health Check

Blueprint exposes a health endpoint at `/api/health`. Docker uses this in the `healthcheck` block defined in `docker-compose.yml`. You can also query it directly:

```bash
curl http://localhost:4000/api/health
```

A healthy response:

```json
{ "status": "ok", "db": "ok", "uptime": 3600 }
```

If the database is unreachable or the process is still initialising, the response will be `503 Service Unavailable`.

---

## Preserving Data When Removing the Container

The `docker compose down` command stops and removes the container and its network but leaves the bind-mounted directories on the host (`./data`, `./kb`, `./server/agents`) untouched. Your data is safe.

To fully wipe everything including data (destructive — cannot be undone):

```bash
docker compose down
rm -rf ./data ./kb ./server/agents
```

Only do this if you intend to start fresh.
