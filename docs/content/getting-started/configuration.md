---
title: "Configuration"
description: "Configuring Blueprint via environment variables and the settings UI"
section: "Getting Started"
order: 3
---

# Configuration

Blueprint has two configuration surfaces: the `.env` file on the host, which is read at startup, and the **Settings UI** inside the app, which persists values to the database and takes effect without a restart. Most connector credentials are managed through the UI. Security-critical values must be set in `.env`.

---

## Two Ways to Configure

| Method | What it controls | When changes take effect |
|--------|-----------------|--------------------------|
| `.env` file | Security keys, admin credentials, ports, database path, LLM API keys, Google OAuth app credentials, Telegram tokens | Restart required (`docker compose restart blueprint`) |
| Settings UI | LLM provider selection, Google OAuth connection, notification preferences, per-agent LLM assignments | Immediate — no restart needed |

---

## Critical Variables (Set These First)

These three variables must be set before Blueprint is used for the first time. They cannot be changed safely after data has been written to the database.

### ENCRYPTION_KEY

All connector credentials (API keys, OAuth tokens, SSH keys) are encrypted at rest in SQLite using AES-256-GCM. `ENCRYPTION_KEY` is the 32-byte key, expressed as a 64-character hex string.

```bash
# Generate a secure key
openssl rand -hex 32
```

Paste the output into `.env`:

```bash
ENCRYPTION_KEY=a1b2c3d4e5f6...  # 64 hex characters
```

> [!TIP]
> If you change `ENCRYPTION_KEY` after connector credentials have been saved, Blueprint will be unable to decrypt them and all connectors will fail. Treat this value as permanent. Back it up securely alongside your `./data` volume.

### SESSION_SECRET

Used to sign and verify HTTP session cookies. Generate separately from `ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

```bash
SESSION_SECRET=f7e8d9c0b1a2...  # 64 hex characters
```

Changing this after deployment invalidates all existing sessions and logs every user out.

### ADMIN_PASSWORD

Blueprint is a single-user system. The admin account credentials are set in `.env`:

```bash
ADMIN_USERNAME=admin          # Can be any string
ADMIN_PASSWORD=changeme       # Change this immediately
```

> [!TIP]
> The default password `changeme` is intentional and obvious. Change it to something strong before exposing Blueprint to any network. There is no password reset flow — if you forget it, update `ADMIN_PASSWORD` in `.env` and restart.

---

## LLM Providers

Blueprint can use any combination of Ollama (local), Anthropic Claude, OpenAI, and Google Gemini. You configure which provider each agent uses via **Settings → LLM Providers**.

### Ollama (default, free, local)

Ollama requires no API key. Install it from [ollama.ai](https://ollama.ai) and pull a model:

```bash
ollama pull llama3
```

Set the base URL in `.env` (the default works for most setups):

```bash
# Local development
OLLAMA_BASE_URL=http://localhost:11434

# Docker — reach the host machine's Ollama from inside the container
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

Ollama is the default provider. If `OLLAMA_BASE_URL` is reachable and a model is available, Blueprint works out of the box with no further LLM configuration.

### Anthropic Claude

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Get a key at [console.anthropic.com](https://console.anthropic.com). Recommended model: `claude-3-5-haiku-20241022` for a balance of speed and quality, or `claude-opus-4-5` for maximum reasoning capability.

### OpenAI

```bash
OPENAI_API_KEY=sk-proj-...
```

Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Recommended model: `gpt-4o-mini` for speed, `gpt-4o` for complex analysis.

### Google Gemini

```bash
GOOGLE_GEMINI_API_KEY=AIzaSy...
```

Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Recommended model: `gemini-1.5-flash` for speed, `gemini-1.5-pro` for quality.

### Assigning providers to agents

After adding API keys to `.env` and restarting, go to **Settings → LLM Providers** in the app. You can set a global default provider and override it per agent. This lets you run, for example, Conductor on Claude Opus while keeping cheaper agents on Ollama.

---

## Google OAuth

A single Google OAuth application covers four connectors: Google Analytics 4, Google Search Console, Google Ads, and Google Business Profile. You create the OAuth app once and use it for all of them.

### Step 1 — Create the OAuth application

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project (or use an existing one).
2. Navigate to **APIs & Services → Credentials**.
3. Click **Create Credentials → OAuth client ID**.
4. Set the application type to **Web application**.
5. Add the authorised redirect URI. For local development:
   ```
   http://localhost:4000/api/oauth/google/callback
   ```
   For production replace with your domain:
   ```
   https://blueprint.yourdomain.com/api/oauth/google/callback
   ```
6. Click **Create**. Copy the **Client ID** and **Client Secret**.

### Step 2 — Enable the required APIs

In the same Google Cloud project, go to **APIs & Services → Library** and enable:

- Google Analytics Data API
- Google Search Console API
- Google Ads API (if using the Google Ads connector)

### Step 3 — Set variables in .env

```bash
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:4000/api/oauth/google/callback
```

> [!TIP]
> `GOOGLE_REDIRECT_URI` must exactly match the URI you registered in Google Cloud Console, including the scheme (`http` vs `https`) and port. A mismatch causes OAuth to fail with a `redirect_uri_mismatch` error.

After restarting Blueprint, go to **Settings → Google OAuth** in the app to complete the OAuth flow. Once authorised, the token is stored encrypted in the database and shared across all Google connectors.

---

## Telegram Notifications

Blueprint can send task proposals, agent run summaries, and signal alerts to a Telegram chat. This is optional but recommended — it means you see proposals in real time without logging into the UI.

### Step 1 — Create a bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to name your bot.
3. BotFather replies with a bot token in the format `1234567890:AAF...`. Copy it.

### Step 2 — Get your chat ID

1. Add your new bot to the Telegram chat where you want notifications (a private chat with yourself, or a group).
2. Send any message to the chat.
3. Open this URL in your browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Find the `"chat"` object in the JSON response. The `"id"` field is your chat ID (negative numbers are group chats).

### Step 3 — Set variables in .env

```bash
TELEGRAM_BOT_TOKEN=1234567890:AAF...
TELEGRAM_CHAT_ID=987654321
```

After restarting, Blueprint sends a test message to confirm the connection. Notification settings (which event types trigger a message) are configurable via **Settings → Notifications** in the app.

---

## Settings UI Reference

Once Blueprint is running, most day-to-day configuration is done through **Settings** in the left sidebar.

| Settings page | What you configure |
|---|---|
| **LLM Providers** | Add/remove LLM providers, set the global default, assign providers per agent |
| **Google OAuth** | Connect and disconnect the shared Google OAuth token |
| **Notifications** | Toggle Telegram notifications per event type (task proposed, agent run complete, signal created, etc.) |
| **Connectors** | View all connected connectors, their status, and last sync time |
| **About** | Blueprint version, database path, uptime |

Changes made in the Settings UI are written to the database immediately. They do not require a restart and take effect on the next relevant action (e.g., the next agent run picks up a newly assigned LLM provider).
