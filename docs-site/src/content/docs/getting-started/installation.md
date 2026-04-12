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

Open `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Start Blueprint:

```bash
docker compose up -d
```

Open **http://localhost:4000** — the onboarding wizard guides you through connecting your first data source and enabling agents.

:::tip
Blueprint runs fully offline using Ollama. Skip the Anthropic API key if you prefer local models — configure Ollama in Settings → LLM Providers after setup.
:::

## Local development

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
bash scripts/setup.sh

# Add your API key
nano .env  # Add ANTHROPIC_API_KEY=sk-ant-...

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
| LLM | Ollama (free) | Claude Sonnet |

## What's next

1. [Connect your first data source](/connectors/overview/)
2. [Enable agents](/agents/overview/)
3. [Set up Telegram notifications](/integrations/telegram/)
