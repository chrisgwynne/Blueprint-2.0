---
title: "Common Issues"
description: "Solutions to the most common Blueprint problems"
section: "Troubleshooting"
order: 1
---

# Common Issues

---

## White Screen on Load

**Symptom:** The browser shows a blank white page at `http://localhost:4000`. No error message, no login screen.

**Cause:** The React client has not been built, or Blueprint is serving the client from a path that doesn't match the built output location.

**Fix:**

```bash
cd client
bun run build
```

Then restart the server. The production server serves the built React files from `client/dist`. If `dist` doesn't exist, there is nothing to serve.

If you're running Blueprint directly (not Docker), also check that `PORT` in your `.env` matches the port you're accessing. Blueprint defaults to port 4000. If you set `PORT=8080`, access `http://localhost:8080`.

---

## Agents Running but Proposing No Tasks

**Symptom:** The agent status page shows recent runs (green timestamp), but the task queue is empty and has been for several days.

**Cause A — Connector not synced.** The agent has a required connector that hasn't successfully synced. Without fresh data, the agent runs but finds nothing to analyse. It records a `skipped` run rather than proposing guesses from stale data.

**Diagnosis:** Go to **Connectors** and check the "Last synced" timestamp for each connector. If it shows "Never" or a date older than 48 hours, that's the problem.

**Fix:** Click **Sync now** on the connector. If the sync fails, check the connector's error message and consult [Connector Errors](/troubleshooting/connector-errors).

**Cause B — Readiness check failing.** Each agent has a readiness check that verifies it has sufficient data before running. SEO Sentinel requires at least one successful GSC sync. Trend Spotter requires at least one GA4 sync.

**Diagnosis:** Go to **Agents → [agent name] → Run History** and look for runs with status `skipped`. The skip reason is logged and will name the missing data source.

**Fix:** Connect and sync the required connector. Once it syncs successfully, the next scheduled run will proceed normally. You can also trigger a manual run from the agent page.

---

## Google OAuth "invalid_client"

**Symptom:** When authorising a Google connector (GA4, GSC, Google Ads), the Google consent screen shows "Error 401: invalid_client" or "The OAuth client was not found."

**Cause:** The Google OAuth client ID and secret in Blueprint's settings are wrong, missing, or don't match what's configured in Google Cloud Console.

**Fix:**

1. Go to **Settings → Google OAuth**.
2. Verify the **Client ID** starts with a long number followed by `.apps.googleusercontent.com`.
3. Verify the **Client Secret** is present and matches the value in Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 client.
4. Save and try the OAuth flow again.

If you haven't created OAuth credentials yet, go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.

---

## Google OAuth "redirect_uri_mismatch"

**Symptom:** Google shows "Error 400: redirect_uri_mismatch" during the OAuth consent flow.

**Cause:** The redirect URI Blueprint sends to Google does not exactly match any of the Authorised Redirect URIs listed in Google Cloud Console for your OAuth client. Google requires an exact match — different protocol (http vs https), different port, different path, or a trailing slash all count as mismatches.

**Fix:**

1. Visit `http://localhost:4000/api/oauth/google?debug=1` (replace with your Blueprint URL). This page shows the exact redirect URI Blueprint is currently configured to use.
2. Copy that URI verbatim.
3. Go to Google Cloud Console → APIs & Services → Credentials → your OAuth client → Authorised Redirect URIs.
4. Add the exact URI you copied. Do not modify it.
5. Save. Wait 5 minutes for Google's changes to propagate.
6. Try the OAuth flow again.

Common causes: Blueprint is running behind a reverse proxy with HTTPS but `GOOGLE_REDIRECT_URI` is still set to `http://`. Or `CLIENT_URL` doesn't match the actual URL you're accessing Blueprint from.

---

## Telegram Notifications Not Arriving

**Symptom:** Telegram is configured as a notification channel, but messages are not arriving.

**Cause A — Wrong bot token.** The token is invalid or belongs to a different bot.

**Diagnosis:**
```bash
curl https://api.telegram.org/bot{YOUR_BOT_TOKEN}/getMe
```
Replace `{YOUR_BOT_TOKEN}` with your token (including the `bot` prefix). If you get `{"ok":false,"error_code":401}`, the token is wrong. A valid token returns the bot's details.

**Fix:** Get a new token from [@BotFather](https://t.me/BotFather) → `/myBots` → select your bot → API Token.

**Cause B — Wrong chat ID.** The chat ID is for a different chat, or the bot has not been added to the target chat.

**Diagnosis:** Message your bot (or send a message in the group where the bot is a member), then check:
```bash
curl https://api.telegram.org/bot{YOUR_BOT_TOKEN}/getUpdates
```
Find the `"chat":{"id":...}` value in the response. That is the correct chat ID to use.

**Fix:** Update `TELEGRAM_CHAT_ID` in your `.env` with the correct value, restart Blueprint.

---

## Docker Container Exits Immediately

**Symptom:** `docker compose up -d` starts, but `docker compose ps` shows the container as `exited (1)` within a few seconds.

**Cause:** A required environment variable is missing or invalid. The most common cause is `ENCRYPTION_KEY` not being set, or being set to a value that isn't a valid 64-character hex string.

**Diagnosis:**
```bash
docker compose logs blueprint
```
Look for an error message near the bottom. Blueprint logs the specific missing or invalid variable on startup.

**Fix:**

```bash
# Generate a valid ENCRYPTION_KEY
openssl rand -hex 32
```

Copy the output (64 hex characters) into your `.env` file as `ENCRYPTION_KEY`. Do the same for `SESSION_SECRET`. Then:

```bash
docker compose up -d
```

---

## KB Not Growing

**Symptom:** Agents are running successfully and proposing tasks, but the Knowledge Base section remains empty or hasn't had new entries in weeks.

**Cause A — KB_PATH is not writable.** Blueprint cannot write to the KB directory.

**Fix:**
```bash
ls -la ./kb
```
Check that the directory exists and is writable by the process running Blueprint (or the Docker container user).

**Cause B — Agents have no connected data to write about.** Agents only write to the KB when they have substantive findings based on real connector data. An agent running with no connectors will run successfully but will have nothing worth writing to the KB.

**Fix:** Connect at least one data source (GSC, GA4, Shopify). Once agents have data, they begin accumulating KB entries automatically over the following weeks.

---

## "no such table" Errors on Startup

**Symptom:** Blueprint starts but immediately logs errors like `SqliteError: no such table: signals` or similar.

**Cause:** The database has not been initialised. This happens if `./data/blueprint.db` doesn't exist yet and the automatic initialisation step was skipped or failed.

**Fix:**
```bash
bun run db:init
```

Or, if using Docker:
```bash
docker compose run --rm blueprint bun run db:init
```

This creates all required tables. The Docker entrypoint normally runs this automatically — if you're hitting this error in Docker, check that the `./data` volume is mounted correctly.

---

## Scheduler Not Running

**Symptom:** Agents are not running on their schedules. The `/api/health` endpoint returns `"scheduler": "disabled"`.

**Cause:** `DISABLE_SCHEDULER=true` is set in your environment or `.env` file.

**Fix:** Remove or comment out `DISABLE_SCHEDULER` from your `.env` file:

```bash
# DISABLE_SCHEDULER=true   ← comment this out or delete it
```

Then restart Blueprint. The scheduler starts automatically on startup when this variable is not set.
