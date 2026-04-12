# Blueprint

> A personal business operating system. Connect your data sources, detect signals, and let AI agents take action — with a full audit trail of everything.

## What it does

Blueprint connects to your business tools (Shopify, Google Analytics, Search Console, Stripe, GitHub, and more), detects signals in your data, and uses AI agents to propose and execute improvements — with your approval at every step.

- **14 connectors** — GA4, GSC, PageSpeed, GBP, Shopify, Stripe, GitHub, Brevo, Todoist, UptimeRobot, WordPress, Kirby, Google Ads, Stannp
- **61 signal rules** — anomaly detection, opportunity surfacing, risk alerts across every connector
- **AI agents** — specialist agents (SEO, copywriting, strategy, performance) with soul files that define their identity and working style
- **Compounding knowledge base** — Karpathy LLM wiki pattern, file-based, git-backed, works with Obsidian vaults
- **Task execution engine** — approved tasks auto-execute (create GitHub issues, update Shopify products, write KB pages)
- **Full audit trail** — every agent action, every task, every approval logged
- **External agent protocol (BAP)** — connect any agent on any machine via HTTP
- **Telegram notifications** — signals, task approvals, and agent briefings with inline buttons

## Quick start

### Requirements

- Node.js 20+ or Bun 1.0+
- Docker + Docker Compose (recommended)
- Claude Code CLI installed and authenticated (or Anthropic API key, or Ollama for local LLMs)

### Docker (recommended)

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD at minimum
docker compose up -d
```

Open http://localhost:3000

### Local development

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint

# Install dependencies
cd server && bun install
cd ../client && bun install

# Set up environment
cd ..
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD

# Initialise database
cd server && bun run db/init.js

# Start API server
bun run index.js          # API on :4000

# In another terminal — start frontend dev server
cd client && bun run dev  # UI on :5173
```

## First steps after install

1. Log in with the credentials from your `.env` (default: admin / changeme)
2. The onboarding wizard guides you through creating your first business
3. Connect PageSpeed first (no auth needed — just your URL)
4. Connect Google (GA4 + GSC via OAuth) for search and traffic data
5. Enable agents — Conductor is always on, add SEO Sentinel and Quill for content
6. Watch signals appear within minutes of the first connector sync

## Connecting Google (GA4 + GSC + GBP)

1. [Google Cloud Console](https://console.cloud.google.com) → New project → Enable APIs:
   - Google Search Console API
   - Google Analytics Data API
   - My Business Account Management API (for GBP)
2. OAuth consent screen → External → Add your Google account as test user
3. Credentials → OAuth 2.0 Client ID → Web application
4. Authorised redirect URI: `http://localhost:4000/api/oauth/google/callback`
5. Add Client ID + Secret to `.env`

## Connecting Telegram

1. Message [@BotFather](https://t.me/botfather) → `/newbot`
2. Copy token to `TELEGRAM_BOT_TOKEN` in `.env`
3. Start a chat with your bot, send any message
4. Get chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. Copy chat ID to `TELEGRAM_CHAT_ID` in `.env`

Task approval requests arrive as Telegram messages with inline Approve/Reject buttons.

## External agents (BAP)

Any agent that can make HTTP requests can connect to Blueprint:

```bash
# Register
curl -X POST http://localhost:4000/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAgent","requested_permissions":["signals:read","tasks:propose","kb:read"],"business_access":["*"]}'

# Use the returned API key
curl http://localhost:4000/api/bap/v1/businesses/YOUR_BIZ_ID/health \
  -H "BAP-Key: bap_your_key_here"
```

See [server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md) for the full protocol documentation with Node.js and Python SDK examples.

## Architecture

| Layer | Tech |
|---|---|
| Backend | Bun + Express + SQLite (better-sqlite3, WAL mode) |
| Frontend | React 18 + Vite 5 + Tailwind CSS |
| LLM | Claude Code CLI (default), Anthropic API, OpenAI, Google Gemini, Ollama, LM Studio |
| KB | File-based markdown, isomorphic-git, Obsidian-compatible |
| Deploy | Docker Compose, single container |

## Connectors

| Connector | Auth | Category | Signal rules |
|---|---|---|---|
| Google Analytics 4 | OAuth2 | Analytics | 5 |
| Google Search Console | OAuth2 | SEO | 5 |
| PageSpeed Insights | API key (optional) | Performance | 6 |
| Google Business Profile | OAuth2 | Local | 8 |
| Shopify | API key | Ecommerce | 4 |
| Stripe | API key | Payments | 4 |
| GitHub | PAT | Code | 4 |
| Brevo | API key | Email | 3 |
| Todoist | OAuth2 | Productivity | 3 |
| UptimeRobot | API key | Infrastructure | 4 |
| WordPress | App password | CMS | 4 |
| Kirby | Basic auth | CMS | 3 |
| Google Ads | OAuth2 | Advertising | 5 |
| Stannp | API key | Direct mail | 3 |

## Agents

| Agent | Role | Default status |
|---|---|---|
| Conductor | Strategy & orchestration — the central brain | Active |
| SEO Sentinel | Search intelligence — rankings, keywords, CWV | Active (paused) |
| Quill | Content & copy strategy | Active (paused) |
| Trend Spotter | Growth opportunities & market patterns | Active (paused) |
| Merchant | Ecommerce operations (Shopify focus) | Template |
| Velocity | Performance & speed | Template |
| Ledger | Revenue & financial signals | Template |
| Researcher | Competitive intelligence | Template |
| Reporter | Weekly/monthly summaries | Template |
| Dev | Technical tasks & GitHub integration | Template |
| Outreach | Marketing & communications | Template |
| Sentinel | Infrastructure monitoring | Template |

## Environment variables

See [.env.example](.env.example) for full documentation of all variables.

## License

MIT
