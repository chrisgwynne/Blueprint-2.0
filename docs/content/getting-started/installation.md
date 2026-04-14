---
title: "Quick Start"
description: "Get Blueprint running in under 5 minutes"
section: "Getting Started"
order: 1
---

# Quick Start

Blueprint is a self-hosted business operating system. You connect data sources, it detects signals, and AI agents propose and take actions. This guide gets you from zero to a running instance as fast as possible.

## Prerequisites

You need one of the following runtime environments:

| Option | Requirement |
|--------|-------------|
| Docker (recommended) | Docker Desktop or Docker Engine + Compose plugin |
| Local dev | Bun 1.x **or** Node.js 20+ |

You also need at least one LLM provider. Ollama is the easiest choice because it runs locally and requires no API key or account.

### LLM options at a glance

| Provider | Cost | Privacy | Setup |
|----------|------|---------|-------|
| Ollama (recommended) | Free | Fully local | Install + pull a model |
| Anthropic Claude | Pay-per-token | API (data leaves your server) | API key |
| OpenAI | Pay-per-token | API (data leaves your server) | API key |
| Google Gemini | Pay-per-token | API (data leaves your server) | API key |

---

## Option A: Docker Quick Start

The fastest path. Four commands and you are running.

```bash
git clone https://github.com/your-org/blueprint.git
cd blueprint
cp .env.example .env
docker compose up -d
```

Then open [http://localhost:4000](http://localhost:4000) in your browser.

> [!TIP]
> Before running `docker compose up -d`, open `.env` and set `ENCRYPTION_KEY` and `SESSION_SECRET` to unique values. Run `openssl rand -hex 32` twice — once for each. The defaults in `.env.example` are placeholders and must be replaced before production use.

The first startup initialises the SQLite database automatically via the Docker entrypoint. You will see the Blueprint login screen within a few seconds.

---

## Option B: Local Development Setup

Use this if you want to modify Blueprint or run the client dev server with hot reload.

### Automated setup (recommended)

```bash
git clone https://github.com/your-org/blueprint.git
cd blueprint
cp .env.example .env
bun run setup
```

`bun run setup` handles dependency installation, `.env` generation (including random keys), and database initialisation in one step.

### Manual setup

```bash
git clone https://github.com/your-org/blueprint.git
cd blueprint
cp .env.example .env

# Install server dependencies
cd server && bun install && cd ..

# Install client dependencies
cd client && bun install && cd ..

# Initialise the database
bun run db:init

# Start both server and client dev servers
bun run dev
```

The server listens on port 4000 and the client dev server on port 5173. Open [http://localhost:5173](http://localhost:5173) for the hot-reload client, or [http://localhost:4000](http://localhost:4000) to access the API directly.

---

## Setting Up Ollama (Free, Local LLM)

If you are using Ollama, install it from [ollama.ai](https://ollama.ai) and pull a model before starting Blueprint:

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model — llama3 is a solid general-purpose choice
ollama pull llama3
```

Ollama runs on `http://localhost:11434` by default. In Docker, Blueprint reaches your host machine's Ollama via `http://host.docker.internal:11434` (already set as the default in `.env.example`).

No `.env` changes are needed if you are using Ollama on the same machine.

### Using an API provider instead

If you prefer Anthropic, OpenAI, or Gemini, add the relevant key to `.env`:

```bash
# Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-proj-...

# Google Gemini
GOOGLE_GEMINI_API_KEY=...
```

Then configure which provider agents use via **Settings → LLM Providers** in the app.

---

## First Login

Open Blueprint in your browser. The login prompt asks for a username and password.

The defaults from `.env.example` are:

| Setting | Default |
|---------|---------|
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | `changeme` |

> [!TIP]
> Change `ADMIN_PASSWORD` in your `.env` file immediately and restart Blueprint. The default password is intentionally obvious and should never be used in production.

---

## What to Do Next

Once you are logged in:

1. **Connect a data source** — Go to **Connectors → Add Connector**. Google Analytics 4 and Shopify are good first choices. See [Your First Connector](./first-connector) for a walkthrough.

2. **Hire your first agent** — After a connector syncs, Conductor will recommend relevant agents. Go to **Agents → Available → Hire**. See [Your First Agent](./first-agent) for what happens next.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port 4000 already in use | Change the left-hand port in `docker-compose.yml` to e.g. `4001:4000` |
| Database not initialising | Check `DATABASE_PATH` in `.env` points to a writable directory |
| Ollama not reachable in Docker | Use `http://host.docker.internal:11434` not `http://localhost:11434` |
| Login rejected | Confirm `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` match what you are typing |
