---
title: "Connector Errors"
description: "Diagnosing and fixing connector sync failures"
section: "Troubleshooting"
order: 2
---

# Connector Errors

When a connector fails to sync, Blueprint logs an error message on the connector's detail page (**Connectors → [connector name]**). This guide covers the most common errors for each connector type and how to fix them.

---

## Google Connectors (GA4, GSC, Google Ads)

All Google connectors use the same OAuth 2.0 flow. Most errors are OAuth configuration issues.

### "invalid_client" or Error 401

**What it means:** The OAuth client ID or secret Blueprint is using doesn't match a valid client in Google Cloud Console.

**Fix:**
1. Go to **Settings → Google OAuth** and verify the Client ID and Client Secret are present.
2. Cross-check both values against Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Web Application client.
3. Client IDs look like `123456789-abcdefg.apps.googleusercontent.com`. Client secrets are shorter alphanumeric strings.
4. Save and retry the OAuth flow.

---

### "redirect_uri_mismatch" or Error 400

**What it means:** The redirect URI Blueprint sent to Google during the OAuth flow is not listed as an Authorised Redirect URI in your Google Cloud Console project.

**Fix:**
1. Visit `/api/oauth/google?debug=1` on your Blueprint instance to see the exact redirect URI in use.
2. In Google Cloud Console → APIs & Services → Credentials → your OAuth client → Authorised Redirect URIs, add that exact URI.
3. Google changes take up to 5 minutes to propagate. Wait, then try again.

Common cause: Blueprint is accessed via HTTPS (e.g., through a reverse proxy) but `GOOGLE_REDIRECT_URI` in `.env` still says `http://`. The URI must match the actual protocol.

---

### "insufficient_permission" on GSC

**What it means:** The authenticated Google account does not have access to the GSC property you've configured, or the property URL in Blueprint doesn't match the exact verified property in GSC.

**Fix:**
1. In Google Search Console, verify which exact URL format is used for your property: `https://www.yourdomain.com/`, `https://yourdomain.com/`, or domain property format `sc-domain:yourdomain.com`.
2. Go to **Connectors → GSC → Settings** in Blueprint and ensure the property URL matches exactly — including `www` vs apex, `http` vs `https`, and trailing slash.
3. If the mismatch persists, remove the connector and re-add it with the correct property URL.

---

### "token expired, no refresh token" or "invalid_grant"

**What it means:** Blueprint's stored OAuth token has expired and there is no valid refresh token to renew it automatically. This can happen if the authorisation was granted with limited scopes, or if the Google account revoked Blueprint's access.

**Fix:**
1. Go to **Connectors → [connector name]** and click **Reconnect**.
2. Complete the OAuth flow again. Blueprint will store a fresh access token and refresh token.
3. If you see this error repeatedly after reconnecting, check that you are granting the full requested scopes during the consent screen — do not uncheck any of the listed permissions.

---

## Shopify

### 401 Unauthorized

**What it means:** The Shopify API token Blueprint is using is wrong, has been deleted, or has expired.

**Fix:**
1. In your Shopify admin, go to **Apps → Develop Apps** (or **Settings → Apps and sales channels → Develop apps** depending on your Shopify plan).
2. Find the app connected to Blueprint. Check whether the API access token exists and is active.
3. If the token was regenerated or revoked, create a new one with the required scopes (see below).
4. Update the token in Blueprint: **Connectors → Shopify → Edit → API Token**.

---

### 403 Forbidden

**What it means:** The Shopify app exists and the token is valid, but it doesn't have the API scopes Blueprint needs.

**Required scopes:**
- `read_orders` — for revenue and order data
- `read_products` — for product catalogue data

**Fix:**
1. In Shopify, go to your app's configuration → API Scopes.
2. Enable `read_orders` and `read_products` (at minimum).
3. Reinstall or update the app to apply the new scopes.
4. Blueprint may require re-authorisation after scope changes — use the **Reconnect** button.

---

## PageSpeed Insights

### 500 from Google / Internal Server Error

**What it means:** Google's Lighthouse infrastructure returned an error while running the audit. This is a transient server-side issue on Google's end — not a configuration problem.

**Fix:** No action needed. Blueprint retries PageSpeed calls on the next scheduled poll. If the error persists for more than 24 hours, check the [Google PageSpeed Insights status page](https://status.developers.google.com/) for known outages.

---

### 429 Too Many Requests

**What it means:** Blueprint is hitting Google's PageSpeed API rate limit. The unauthenticated rate limit is very low (a few requests per 100 seconds). If you're checking multiple URLs frequently, you will hit this without an API key.

**Fix:**
1. Get a free PageSpeed API key from [developers.google.com/speed/docs/insights/v5/get-started](https://developers.google.com/speed/docs/insights/v5/get-started).
2. Set `PAGESPEED_API_KEY` in your `.env` file.
3. Restart Blueprint.

The authenticated rate limit is significantly higher and sufficient for all standard Blueprint usage.

---

## UptimeRobot

### 401 Unauthorized

**What it means:** The UptimeRobot API key is wrong or has been revoked.

**Important:** UptimeRobot has two types of API keys — a **Main API Key** (access to all monitors) and per-monitor API keys (access to one monitor). Blueprint requires the **Main API Key**.

**Fix:**
1. Log into UptimeRobot, go to **My Settings → API Settings**.
2. Copy the **Main API Key** (not a monitor-specific key).
3. Update the key in Blueprint: **Connectors → UptimeRobot → Edit → API Key**.

If you've been using a monitor-specific key, that's why it's failing — it doesn't have the permissions Blueprint needs to list all monitors.
