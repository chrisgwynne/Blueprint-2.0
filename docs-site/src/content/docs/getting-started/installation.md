---
title: Quick Start
description: Get Blueprint running in under 5 minutes
---

## Docker (recommended)

The fastest way to run Blueprint:

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
cp .env.example .env
```

Start Blueprint:

```bash
docker compose up -d
```

Open **http://localhost:4000** — the onboarding wizard guides you through choosing your LLM provider and connecting your first data source.

:::tip
No API key needed with Ollama (free, local). Install from [ollama.ai](https://ollama.ai), run `ollama pull llama3`, and Blueprint auto-detects it.
:::

## Local development

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
bash scripts/setup.sh

# Configure your LLM in .env (Ollama works with no API key)

# Start the server
cd server && bun index.js

# In another terminal — start the frontend dev server
cd client && bun run dev
```

Open http://localhost:5173 (dev server with hot reload).

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Node.js | 20.0 | 22.0 LTS |
| RAM | 512MB | 2GB |
| Disk | 1GB | 10GB |
| LLM | Ollama (free, local) | Any cloud provider |

## What's next

1. [Connect your first data source](/connectors/overview/)
2. [Enable agents](/agents/overview/)
3. [Set up Telegram notifications](/integrations/telegram/)
