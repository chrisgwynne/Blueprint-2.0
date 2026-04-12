<div align="center">
  <h1>Blueprint</h1>
  <p><strong>A personal business operating system powered by AI agents</strong></p>

  <p>
    <a href="#quick-start">Quick Start</a> ·
    <a href="#connectors">Connectors</a> ·
    <a href="#agents">Agents</a> ·
    <a href="#knowledge-base">Knowledge Base</a> ·
    <a href="#external-agents-bap">BAP Protocol</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
    <img src="https://img.shields.io/badge/node-20%2B-green" alt="Node">
    <img src="https://img.shields.io/badge/docker-ready-blue" alt="Docker">
    <img src="https://img.shields.io/badge/connectors-14-orange" alt="Connectors">
    <img src="https://img.shields.io/badge/signal%20rules-61-yellow" alt="Signals">
  </p>
</div>

---

## What is Blueprint?

Blueprint connects to your business tools, detects signals in your data, and uses AI agents to propose and execute improvements — with your approval at every step.

**The loop:**

1. **Connectors** pull data from your tools every few hours
2. **Signal rules** detect anomalies, drops, and opportunities
3. **AI agents** analyse the data and propose specific tasks
4. **You approve** tasks via dashboard or Telegram
5. **Blueprint executes** — creates GitHub issues, updates Shopify products, writes content
6. **Outcome tracking** checks whether the change actually worked, 2 and 4 weeks later
7. A **compounding knowledge base** grows smarter with every cycle

Everything is logged. Every action has a paper trail. You can roll back any change.

## Quick Start

**Docker (recommended — runs in 2 minutes):**

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY at minimum
docker compose up -d
```

Open **http://localhost:4000** — the onboarding wizard guides you through the rest.

**Local development:**

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
bash scripts/setup.sh
# Add ANTHROPIC_API_KEY to .env
cd server && bun index.js
```

## Connectors

14 connectors out of the box:

| Category | Connectors |
|----------|-----------|
| **Search & SEO** | Google Analytics 4, Google Search Console, PageSpeed, Google Business Profile, Google Ads |
| **Commerce** | Shopify, Stripe |
| **Email** | Brevo |
| **Productivity** | Todoist |
| **Infrastructure** | UptimeRobot |
| **Code** | GitHub |
| **CMS** | WordPress, Kirby |
| **Marketing** | Stannp |

Building your own connector takes about 2 hours — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Agents

12 specialist agents, each with an identity, values, and operating principles defined in editable markdown soul files:

| Agent | Role |
|-------|------|
| **Conductor** | Strategy & orchestration — the central brain |
| **SEO Sentinel** | Search rankings, keywords, Core Web Vitals |
| **Quill** | Copywriting and content strategy |
| **Trend Spotter** | Growth opportunities and market patterns |
| **Reporter** | Weekly briefings and monthly reports |
| **Merchant** | Shopify and ecommerce operations |
| **Velocity** | Performance and speed |
| **Ledger** | Revenue intelligence |
| **Sentinel** | Infrastructure monitoring |
| **Researcher** | Competitive intelligence |
| **Dev** | GitHub PRs and issues |
| **Outreach** | Campaign intelligence |

Agents use any LLM: Claude, GPT-4, Gemini, or local models via Ollama.

## Knowledge Base

A compounding knowledge base following the [Karpathy LLM wiki pattern](https://karpathy.ai) — a persistent, file-based, git-backed wiki that grows smarter with every agent run, every signal, and every insight.

- **Three layers**: raw sources (immutable) → wiki pages (LLM-maintained) → schema (co-evolved)
- **Wikilinks**: `[[cross-references]]` with backlink tracking
- **Contradiction detection**: flags conflicts instead of silently overwriting
- **Obsidian compatible**: point Blueprint at an existing vault

## Write-Back Actions

Approved tasks don't just create reports — they execute real changes:

- **GitHub**: create issues, open draft PRs
- **Shopify**: create products (draft), update descriptions, manage tags, edit collections
- **Knowledge Base**: write research pages, file query results

Every write-back creates rollback data. Every action can be undone.

## External Agents (BAP)

Any agent that speaks HTTP can connect via the Blueprint Agent Protocol:

```bash
# Register
curl -X POST http://localhost:4000/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAgent","requested_permissions":["signals:read","tasks:propose"],"business_access":["*"]}'

# Get business health
curl http://localhost:4000/api/bap/v1/businesses/BIZ_ID/health \
  -H "BAP-Key: bap_your_key_here"
```

See [AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md) for Node.js and Python SDKs.

## Architecture

| Layer | Tech |
|---|---|
| Backend | Bun + Express + SQLite (better-sqlite3, WAL mode) |
| Frontend | React 18 + Vite 5 + Tailwind CSS |
| LLM | Claude Code CLI (default), Anthropic API, OpenAI, Gemini, Ollama, LM Studio |
| KB | File-based markdown, isomorphic-git, Obsidian-compatible |
| Deploy | Docker Compose, single container |

## Self-Hosting

Blueprint is designed for self-hosted deployment:

- **Docker Compose** — `docker compose up -d`
- **Coolify** — one-click deploy from this repo
- **Bare metal** — `bash scripts/setup.sh`
- **Raspberry Pi** — use Ollama-only mode (no API costs)

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Node.js | 20.0 | 22.0 LTS |
| RAM | 512MB | 2GB |
| Disk | 1GB | 10GB |
| LLM | Ollama (free) | Claude Sonnet |

## Environment Variables

See [.env.example](.env.example) for full documentation of all variables.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and connector building guide.

## License

[MIT](LICENSE) — use it, modify it, ship it.
