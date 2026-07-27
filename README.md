<div align="center">
  <h1>Blueprint</h1>
  <p><strong>A personal business operating system powered by AI agents</strong></p>

  <p>
    <a href="#quick-start">Quick Start</a> ·
    <a href="#installation">Installation</a> ·
    <a href="#connectors">Connectors</a> ·
    <a href="#agents">Agents</a> ·
    <a href="#knowledge-base">Knowledge Base</a> ·
    <a href="#external-agents-bap">BAP Protocol</a> ·
    <a href="http://localhost:4000/docs">Documentation</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/bun-1.1%2B-black" alt="Bun">
    <img src="https://img.shields.io/badge/platform-win%20%7C%20macOS%20%7C%20linux-lightgrey" alt="Platform">
    <img src="https://img.shields.io/badge/connectors-14-orange" alt="Connectors">
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

The fastest path on any OS is Docker:

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
docker compose up -d
```

Open **http://localhost:4000** — the onboarding wizard guides you through choosing your LLM provider and connecting your first data source. No API key required if you use [Ollama](https://ollama.ai) (free, local).

For native development, see the platform-specific instructions below.

## Installation

Blueprint runs on **Windows, macOS, and Linux**. The setup script (`bun scripts/setup.js`) is cross-platform — it handles `.env` bootstrap, key generation, dependency installs, DB initialisation, and the frontend build with no shell dependency.

### Prerequisites (all platforms)

| Tool | Minimum | How to check |
|------|---------|--------------|
| **Git** | any | `git --version` |
| **Bun** | 1.1+ | `bun --version` |
| **Node.js** *(optional fallback)* | 20.0+ | `node --version` |

Bun is required. Node is only used if you want to run the raw `scripts/setup.js` without Bun — everything else uses Bun.

---

### Windows

#### Option A — PowerShell (recommended)

Open **PowerShell** (not Command Prompt) and run:

```powershell
# 1. Install Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. Close PowerShell, open a fresh window so $PATH picks up bun

# 3. Clone and set up
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
.\scripts\setup.ps1

# 4. Run
bun run dev
```

Then open **http://localhost:4000**.

#### Option B — WSL 2 (if you prefer a Linux environment)

If you already use WSL 2, follow the Linux instructions below inside your WSL shell. Everything works identically — Blueprint stores its database and KB inside your WSL filesystem.

#### Windows notes

- **Git Bash works too** — you can run `bash scripts/setup.sh` from Git Bash if you prefer POSIX tooling. The `.sh` script is kept for Linux/macOS parity.
- **Native modules**: Blueprint uses Bun's built-in SQLite — no C++ build tools needed on Windows.
- **Antivirus**: Windows Defender occasionally slows `bun install`. Add the `blueprint` folder to exclusions if install takes over 2 minutes.
- **Line endings**: the repo has a `.gitattributes` enforcing LF. If you see "CRLF will be replaced" warnings during clone, that's expected.
- **Long paths**: enable Windows long path support if `bun install` errors with `ENAMETOOLONG`:
  ```powershell
  # Run as Administrator
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
  ```

---

### macOS

Open **Terminal** and run:

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Reload your shell (or close and reopen Terminal)
source ~/.zshrc   # or ~/.bash_profile

# 3. Clone and set up
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
bun run setup

# 4. Run
bun run dev
```

Then open **http://localhost:4000**.

#### macOS notes

- **Apple Silicon (M1/M2/M3)**: fully supported. Bun ships native arm64 binaries.
- **Homebrew alternative**: `brew install oven-sh/bun/bun`.
- **Command Line Tools**: if `git` is missing, macOS will prompt to install Xcode CLI — accept.

---

### Linux (Ubuntu, Debian, Fedora, Arch, Raspberry Pi OS)

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Reload your shell
source ~/.bashrc   # or ~/.zshrc

# 3. Clone and set up
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
bun run setup

# 4. Run
bun run dev
```

Then open **http://localhost:4000**.

#### Linux notes

- **Raspberry Pi**: works on Pi 4 / Pi 5 (64-bit OS required for Bun). Use Ollama locally for zero-cost AI.
- **Headless server / VPS**: Blueprint listens on `0.0.0.0:4000` by default. Point a reverse proxy (Caddy, Nginx, Traefik) at it.
- **systemd service**: see [CONTRIBUTING.md](CONTRIBUTING.md) for a sample unit file.

---

### Docker (any OS)

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
docker compose up -d
```

The container runs Linux internally, so it behaves identically on Windows, macOS, and Linux hosts. Data is persisted via a bind-mount to `./data`.

---

## After Installation

### 1. Configure your LLM provider

Edit `.env`:

```bash
# Free, fully local — no API key needed
LLM_DEFAULT_PROVIDER=ollama

# Or paid cloud
# LLM_DEFAULT_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-...
```

See `.env.example` for all supported providers (Anthropic, OpenAI, Google, Ollama, LM Studio, Custom).

### 2. Install Ollama (if using local)

- **Windows**: https://ollama.ai/download/windows
- **macOS**: `brew install ollama` or download the native app
- **Linux**: `curl -fsSL https://ollama.ai/install.sh | sh`

Then pull a model:

```bash
ollama pull llama3
```

### 3. Start Blueprint

```bash
bun run dev       # development (hot reload, Vite dev server)
bun run start     # production (requires `bun run build` first)
```

Open **http://localhost:4000** → the onboarding wizard handles the rest.

---

## Common Commands

| Command | What it does | Cross-platform |
|---------|--------------|----------------|
| `bun run setup` | First-time install: deps, DB, client build | ✅ |
| `bun run dev` | Start server + Vite dev server with hot reload | ✅ |
| `bun run build` | Build frontend for production | ✅ |
| `bun run start` | Start production server | ✅ |
| `bun run db:init` | Re-initialise the SQLite database | ✅ |

---

## Troubleshooting

### "bun: command not found" after install
Close and reopen your terminal. Bun adds itself to `$PATH` but the current shell won't pick it up until restart. On Windows, the installer modifies `%USERPROFILE%\.bun\bin` — open a fresh PowerShell window.

### Port 4000 already in use
Change `PORT` in `.env`, or find and stop the conflicting process:
- **Windows**: `netstat -ano | findstr :4000` then `taskkill /PID <pid> /F`
- **macOS/Linux**: `lsof -i :4000` then `kill -9 <pid>`

### Database is locked
Another Blueprint instance is running, or a previous process crashed without releasing the WAL. Close all Blueprint windows, then:
- **Windows**: delete `data\blueprint.db-shm` and `data\blueprint.db-wal`
- **macOS/Linux**: `rm data/blueprint.db-shm data/blueprint.db-wal`

### Git hooks fail on Windows
If you see `error: cannot spawn .husky/pre-commit: No such file or directory`, the hook file needs Unix line endings. Run:
```bash
git config core.autocrlf input
```
Then re-clone.

### Permission denied on scripts/setup.sh (macOS/Linux)
```bash
chmod +x scripts/setup.sh
```
Or just use `bun run setup` — it doesn't need the executable bit.

### `bun install` is slow on Windows
Windows Defender real-time scanning inspects every file Bun writes. Exclude the `blueprint` folder from real-time protection, or run install inside WSL.

---

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
| **Marketing** | Stannp, Meta Ads |

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

## Intelligence Layer

On top of the data-collection pipeline, Blueprint adds nine intelligence features that let agents reason strategically:

- **Goal Reasoning** — every goal gets a strategic plan (feasibility, paths, milestones, agent briefings)
- **Scenario Planning** — ask "what if?" and get 3-4 modelled scenarios side-by-side
- **Conflict Detection** — goals, tasks, and actions that contradict each other are flagged before they damage attribution
- **Retrospectives** — monthly self-assessment that tunes agents and files learnings to the KB
- **Signal Attribution** — probability-weighted causes on every signal with ACT/WAIT/MONITOR recommendation
- **Agent Calibration** — each agent's stated vs actual confidence is tracked and displayed; overconfident agents are auto-elevated to yellow tier
- **Proactive Goal Suggestions** — Blueprint scans connector data for quantified opportunities and suggests goals with £/month estimates
- **Shared KB** — cross-business tactics, patterns, and do-not-do entries readable by every agent
- **Constraint-aware Scheduling** — delays agent runs when data is stale or measurement windows are active
- **"Why is this happening?"** — one-click deep investigation with plain-English explanation

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

## Using Blueprint from an AI agent

If you're connecting an AI agent (Claude Code, OpenClaw, Hermes, or any LLM agent), install the skill file:

```bash
# macOS/Linux
cp SKILL.md /path/to/your/agent/skills/blueprint.md
```

```powershell
# Windows
Copy-Item SKILL.md C:\path\to\your\agent\skills\blueprint.md
```

Or reference the raw URL in your agent config:
```
https://raw.githubusercontent.com/chrisgwynne/blueprint/main/SKILL.md
```

The skill file ([SKILL.md](SKILL.md)) tells the agent what Blueprint is, what tools are available, when to use each one, and how to operate.

For the technical API reference, see [server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md).

## External Agents (BAP)

Any agent that speaks HTTP can connect via the Blueprint Agent Protocol.
Registration requires a logged-in dashboard session or an operator-issued
`BAP_REGISTRATION_SECRET` (see `.env.example`) — self-service, unauthenticated
registration is not permitted, and wildcard permissions/business access are
never granted automatically:

```bash
curl -X POST http://localhost:4000/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -H "X-Registration-Secret: $BAP_REGISTRATION_SECRET" \
  -d '{"name":"MyAgent","requested_permissions":["signals:read","tasks:propose","kb:read"],"business_access":["biz_xxxxxxxx"]}'
```

See [SKILL.md](SKILL.md) for the complete tool reference.

## Architecture

| Layer | Tech |
|---|---|
| Backend | TypeScript + Bun + Express + SQLite (bun:sqlite, WAL mode) |
| Frontend | TypeScript + React 18 + Vite 5 |
| LLM | Any provider — Ollama (free/local), Anthropic, OpenAI, Gemini, LM Studio |
| KB | File-based markdown, isomorphic-git, Obsidian-compatible |
| Deploy | Docker Compose, single container |

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10, macOS 12, Linux (any modern distro) | Windows 11, macOS 14+, Ubuntu 22+ |
| Bun | 1.1 | Latest |
| Node.js *(fallback only)* | 20.0 | 22.0 LTS |
| RAM | 512 MB | 2 GB |
| Disk | 1 GB | 10 GB |
| LLM | Ollama (free, local) | Any cloud provider |

## Environment Variables

See [.env.example](.env.example) for full documentation of all variables.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and connector building guide.

## License

[MIT](LICENSE) — use it, modify it, ship it.
