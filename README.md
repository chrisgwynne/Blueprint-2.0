# Blueprint

A personal business operating system. Connects to your business data sources, detects signals, proposes AI-driven tasks, and maintains a full audit trail of everything.

**Stack:** Node.js / Bun · Express · SQLite · React 18 · Vite · Tailwind CSS · Claude (Anthropic)

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (install: `npm install -g bun`)
- Node.js 20+
- An Anthropic API key (for agent runs)

### Local Development

```bash
git clone <repo>
cd blueprint

# 1. Configure environment
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# 2. Install dependencies
cd server && bun install
cd ../client && bun install
cd ..

# 3. Initialise database
cd server && bun db/init.js

# 4. Run (two terminals)
# Terminal 1:
cd server && bun index.js

# Terminal 2:
cd client && bun run dev
```

Open **http://localhost:5173** · Login: `admin` / `changeme` (set in `.env`)

### Docker

```bash
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY, SESSION_SECRET, ANTHROPIC_API_KEY
docker compose up -d
```

Open **http://localhost:4000**

---

## First Steps After Install

1. Open **Settings → Business Profile** — rename "My Business" to your business name
2. Go to **Connectors** → connect PageSpeed (no auth needed — just add your site URL)
3. Go to **Agents** → click "Run Now" on SEO Sentinel for your first scan
4. Check **Signals** for first detections
5. Go to **Tasks** → review and approve any proposed tasks

---

## Connecting Google (GA4 + GSC)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project
2. Enable these APIs:
   - Google Search Console API
   - Google Analytics Data API
3. Create OAuth 2.0 credentials → **Web Application**
4. Add authorised redirect URI: `http://localhost:4000/api/auth/google/callback`
5. Copy Client ID + Secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
6. In Blueprint → Connectors → Add GSC or GA4 → "Connect with Google"

---

## Telegram Notifications

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`
2. Copy the bot token to `.env` as `TELEGRAM_BOT_TOKEN`
3. Start a chat with your new bot
4. Get your chat ID:
   ```
   curl https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
5. Copy the `chat.id` value to `.env` as `TELEGRAM_CHAT_ID`
6. In Blueprint → Settings → Notifications → paste token + chat ID → Test Connection

---

## Agent System

Agent profiles live in `/agents/profiles/` as YAML files. Three are included:

| Agent | Role | Schedule |
|-------|------|----------|
| `conductor` | Orchestration & Strategy | Daily 06:00 |
| `seo-sentinel` | SEO & Search Intelligence | Daily 07:00 |
| `trend-spotter` | Traffic & Conversion | Monday 08:00 |

Add a new `.yaml` profile following the same format and restart Blueprint — it's picked up automatically.

Trust tiers control approval flow:
- 🟢 **green** — auto-approved and executed immediately
- 🟡 **yellow** — requires your approval (default)
- 🔴 **red** — always requires approval + written reason

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 4000) |
| `DATABASE_PATH` | No | Absolute path to SQLite file |
| `ENCRYPTION_KEY` | **Yes** | 64-char hex string for credential encryption |
| `SESSION_SECRET` | **Yes** | Random string for session signing |
| `ADMIN_USERNAME` | No | Login username (default: admin) |
| `ADMIN_PASSWORD` | **Yes** | Login password — change from default |
| `ANTHROPIC_API_KEY` | **Yes** | For agent runs |
| `GOOGLE_CLIENT_ID` | No | For GSC + GA4 connectors |
| `GOOGLE_CLIENT_SECRET` | No | For GSC + GA4 connectors |
| `TELEGRAM_BOT_TOKEN` | No | For Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Your Telegram chat ID |
| `PAGESPEED_API_KEY` | No | Higher rate limits for PageSpeed |

Generate secure keys:
```bash
openssl rand -hex 32   # use for ENCRYPTION_KEY
openssl rand -hex 32   # use for SESSION_SECRET
```

---

## Architecture

```
/server          Express API + business logic
  /db            SQLite schema + helpers (bun:sqlite)
  /connectors    Data source adapters (PageSpeed, GSC, GA4)
  /agents        Claude-powered agent runner + YAML profiles
  /signals       Deterministic rule engine (8 rules)
  /tasks         Task queue + approval workflow
  /notifications Telegram + dashboard dispatcher
  /kb            File-based knowledge base (git-backed)
  /jobs          node-cron scheduler

/client          React 18 + Vite + Tailwind CSS
  /src/pages     Dashboard, Signals, Tasks, Agents, Connectors, KB, Settings
  /src/components Reusable UI components

/agents/profiles  YAML agent dossiers
/kb               Markdown knowledge base files
/data             SQLite database
```

---

## Development Notes

- **Ports:** API server on `:4000`, Vite dev server on `:5173`
- **Database:** WAL mode SQLite — safe for concurrent reads
- **Credentials:** All connector credentials are AES-256-GCM encrypted before storage
- **Audit log:** Every state change writes an immutable audit_log entry
- **No internet required** for core features — only LLM calls and connector syncs need network access

---

*Blueprint v0.1 — personal use, single user, local-first.*
