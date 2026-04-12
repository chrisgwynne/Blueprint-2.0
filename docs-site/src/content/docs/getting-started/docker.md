---
title: Docker Setup
description: Running Blueprint with Docker Compose
---

## Quick start

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD, ANTHROPIC_API_KEY
docker compose up -d
```

## What Docker Compose does

- Builds a single container from the `Dockerfile`
- Mounts three volumes for persistent data:
  - `./data` → SQLite database
  - `./server/agents` → agent soul files, memory, run logs
  - `./kb` → knowledge base files
- Exposes port 3000 (configurable via PORT env var)
- Runs a health check every 30 seconds

## Updating

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Your data is preserved in the mounted volumes.

## Logs

```bash
docker compose logs -f blueprint
```

## Stopping

```bash
docker compose down
```

Data persists in `./data`, `./kb`, and `./server/agents`.
