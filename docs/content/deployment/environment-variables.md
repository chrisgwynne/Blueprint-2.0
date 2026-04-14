---
title: "Environment Variables"
description: "Complete reference for all Blueprint environment variables"
section: "Deployment"
order: 2
---

# Environment Variables

Blueprint is configured through environment variables. Copy `.env.example` to `.env` and edit it before first run. Variables marked **YES** in the Required column must be set for Blueprint to start correctly.

---

## Complete Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4000` | HTTP port Blueprint listens on |
| `NODE_ENV` | No | `development` | Set to `production` in production deployments |
| `DATABASE_PATH` | No | `./data/blueprint.db` | Absolute or relative path to the SQLite database file |
| `KB_PATH` | No | `./kb` | Root directory for knowledge base Markdown files |
| `ENCRYPTION_KEY` | **YES** | — | 64-character hex string. Encrypts connector credentials at rest. Generate with `openssl rand -hex 32`. **Never change this after first run — existing encrypted data will be unreadable.** |
| `SESSION_SECRET` | **YES** | — | 64-character hex string. Signs session cookies. Generate with `openssl rand -hex 32`. Must be different from `ENCRYPTION_KEY`. |
| `ADMIN_USERNAME` | No | `admin` | Username for the Blueprint login screen |
| `ADMIN_PASSWORD` | **YES** | `changeme` | Password for the Blueprint login screen. The default is accepted but must be changed before any internet-facing deployment. |

---

## LLM Providers

At least one LLM provider is required for agents to run.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Base URL for a running Ollama instance. No API key needed. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key. Starts with `sk-ant-`. Get it from [console.anthropic.com](https://console.anthropic.com). |
| `OPENAI_API_KEY` | No | — | OpenAI API key. Starts with `sk-proj-`. Get it from [platform.openai.com](https://platform.openai.com). |
| `GOOGLE_GEMINI_API_KEY` | No | — | Google Gemini API key. Get it from [aistudio.google.com](https://aistudio.google.com). |

---

## Google OAuth (Required for GA4, GSC, Google Ads)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | No | — | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | No | — | OAuth 2.0 client secret from Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | No | `http://localhost:4000/api/oauth/google/callback` | Must match the Authorized Redirect URI in Google Cloud Console exactly — including protocol, port, and path. |

---

## Integrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAGESPEED_API_KEY` | No | — | Google PageSpeed Insights API key. Free from [developers.google.com/speed/docs/insights/v5/get-started](https://developers.google.com/speed/docs/insights/v5/get-started). Without a key, PageSpeed is rate-limited to a small number of anonymous requests per day. |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token from [@BotFather](https://t.me/BotFather). Required for Telegram notifications. |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat ID to send notifications to. Get it by messaging your bot and calling `https://api.telegram.org/bot{TOKEN}/getUpdates`. |
| `TODOIST_CLIENT_ID` | No | — | Todoist OAuth client ID from [developer.todoist.com](https://developer.todoist.com). |
| `TODOIST_CLIENT_SECRET` | No | — | Todoist OAuth client secret. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | No | — | Google Ads API developer token. Required for Google Ads connector. Get it from your Google Ads Manager account under API Center. |
| `META_APP_ID` | No | — | Meta (Facebook) App ID from [developers.facebook.com](https://developers.facebook.com). Required for Meta Ads connector. |
| `META_APP_SECRET` | No | — | Meta App Secret. |

---

## CORS and URLs

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLIENT_URL` | No | `http://localhost:5173` | Frontend URL used for OAuth redirect construction and CORS. In production, set this to your public URL (e.g., `https://blueprint.yourdomain.com`). |
| `CORS_ORIGINS` | No | auto | Comma-separated list of allowed CORS origins. Defaults to `CLIENT_URL` plus `localhost` variants. Set explicitly if you have additional allowed origins. |

---

## Scheduler

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISABLE_SCHEDULER` | No | `false` | Set to `true` to prevent all cron jobs from running. Useful during development, data migrations, or debugging. Agents can still be triggered manually. The `/api/health` endpoint reports `"scheduler": "disabled"` when this is set. |

---

## Generating Secure Values

For `ENCRYPTION_KEY` and `SESSION_SECRET`, use `openssl` to generate cryptographically random values:

```bash
# Generate ENCRYPTION_KEY
openssl rand -hex 32

# Generate SESSION_SECRET (run again to get a different value)
openssl rand -hex 32
```

Both commands output a 64-character hex string. They must be different values. Copy each directly into `.env` — do not add quotes.

> [!WARNING]
> Never change `ENCRYPTION_KEY` after Blueprint has been running. All connector credentials (API keys, OAuth tokens) are encrypted with this key. If you change it, Blueprint cannot decrypt existing credentials and all connectors will need to be re-authorised.
