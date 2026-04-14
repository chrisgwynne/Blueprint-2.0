---
title: "Google Analytics 4"
section: "Connectors"
order: 2
---

# Google Analytics 4

The GA4 connector pulls session data, user activity, conversion metrics, top pages, and traffic sources from the Google Analytics Data API. It syncs every 6 hours and feeds the Trend Spotter, SEO Sentinel, Quill, and Conductor agents.

---

## Setup

### 1. Create or reuse a Google Cloud OAuth app

Go to [console.cloud.google.com](https://console.cloud.google.com).

- Select your project (or create one).
- Navigate to **APIs & Services → Library** and enable the **Google Analytics Data API**.
- Navigate to **APIs & Services → OAuth consent screen**. Set user type to **External** if this is a personal account, fill in the app name and your email, then save.
- Navigate to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
- Select **Web application**.
- Under **Authorised redirect URIs** add exactly: `http://localhost:4000/api/oauth/google/callback`
- Click **Create**. Copy the **Client ID** and **Client secret**.

If you have already set up the OAuth app for Google Search Console or another Google connector, skip this step — the credentials are shared. You only need to ensure the **Google Analytics Data API** is enabled on the same project.

### 2. Enter credentials in Blueprint

Go to **Settings → Google OAuth** in Blueprint. Paste the Client ID and Client Secret. Blueprint stores these in the database — no `.env` file changes are needed.

### 3. Connect the connector

Go to **Connectors → Add → Google Analytics 4**. Click **Connect with Google** to start the OAuth flow. You will be redirected to Google, asked to authorise access to your Analytics data, then redirected back to Blueprint.

### 4. Enter your GA4 Property ID

After OAuth completes, Blueprint will prompt for your **GA4 Property ID**.

To find it: open [analytics.google.com](https://analytics.google.com) → select your property → **Admin** (gear icon) → **Property Settings**. The Property ID is a numeric value (e.g. `123456789`). It does not include the `properties/` prefix.

---

## Data pulled

Each sync covers the current 14-day window and the equivalent previous 14-day window for comparison.

| Metric | Description |
|---|---|
| Sessions | Total sessions, current and previous period |
| Active users | Unique users, current and previous period |
| Bounce rate | Average across all sessions |
| Conversions | Total conversion events, current and previous period |
| Top pages | Up to 10 pages by sessions, with per-page bounce rate |
| Traffic sources | Sessions by channel group (Organic Search, Direct, Referral, etc.) |

**Update frequency:** every 6 hours.

---

## Metrics written to the database

`extractMetrics()` writes these named rows after each sync:

| Metric name | Value |
|---|---|
| `ga4.sessions` | Total sessions (current period) |
| `ga4.sessions_prev` | Total sessions (previous period) |
| `ga4.users` | Active users (current period) |
| `ga4.users_prev` | Active users (previous period) |
| `ga4.bounce_rate` | Average bounce rate |
| `ga4.conversions` | Total conversions (current period) |
| `ga4.conversions_prev` | Total conversions (previous period) |
| `ga4.top_pages` | Rich data — array of `{path, sessions, bounceRate}` |
| `ga4.traffic_sources` | Rich data — array of `{channel, sessions}` |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `traffic_drop_7day` | warning | Sessions drop ≥20% vs previous period |
| `traffic_spike` | info | Sessions grow ≥50% vs previous period |
| `conversion_drop` | alert | Conversions drop ≥25% vs previous period |
| `organic_traffic_drop` | warning | Organic Search channel sessions drop ≥20% |
| `top_page_traffic_drop` | warning | Any top-10 page loses ≥20% of clicks |
| `bounce_rate_spike` | warning | Bounce rate increases ≥15 percentage points |

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Trend Spotter | Analyses traffic patterns and surfaces emerging trends |
| SEO Sentinel | Correlates GA4 traffic drops with GSC keyword data |
| Quill | Uses traffic and conversion data to prioritise content recommendations |
| Conductor | Reviews all signals and decides whether specialist agents should act |

Agent runs are throttled by minimum hours between runs: Trend Spotter 12 hours, SEO Sentinel 6 hours, Quill 12 hours.

---

## Troubleshooting

**Token refresh failed / `invalid_client` error**

This means Blueprint tried to refresh the access token but Google rejected the OAuth credentials. Go to **Settings → Google OAuth** and verify the Client ID and Client Secret are correct. The most common cause is pasting credentials from the wrong Cloud project, or the OAuth client having been deleted and recreated.

**404 from Analytics API — "Property not found"**

The Property ID is wrong or the authorised Google account does not have access to that property. Open Analytics Admin and confirm the Property ID shown under Property Settings. Make sure you authorised Blueprint using the same Google account that has access to the property.

**No data returned after first sync**

GA4 typically takes 24–48 hours after first data collection before the Data API returns complete results for a new property. If the property is established and you still see no data, verify the Property ID and check that the Google Analytics Data API is enabled in your Cloud project.

**`GA4 propertyId is not configured`**

The connector was saved without a Property ID. Open the connector config in Blueprint and enter the numeric Property ID.
