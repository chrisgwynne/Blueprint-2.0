---
title: "Wix"
description: "Connect Wix to pull website analytics and site health data into Blueprint."
section: "Connectors"
order: 24
---

# Wix

The Wix connector pulls traffic analytics, visitor data, and site health metrics from the Wix Analytics API. It syncs every 6 hours and provides Blueprint with basic website performance data for Wix-hosted sites.

---

## Setup

### 1. Generate a Wix API key

1. Log in to your Wix account and go to your site's dashboard.
2. Navigate to **Settings → API Keys** (or go to [manage.wix.com/account/api-keys](https://manage.wix.com/account/api-keys)).
3. Click **Generate API Key**.
4. Give the key a name (e.g. "Blueprint") and set the permissions:
   - Enable **Analytics** under the site-level permissions.
   - Enable **Site** read access.
5. Click **Generate** and copy the API key.

> [!NOTE]
> Wix API keys are account-scoped and may grant access to multiple sites in your Wix account. Blueprint uses the **Site ID** to scope all requests to a specific site, so only the configured site's data is pulled.

### 2. Find your Site ID

1. In your Wix dashboard, go to **Settings → General Info**.
2. Scroll to the bottom of the page. The **Site ID** is displayed there.
3. Alternatively, it appears in your Wix dashboard URL: `manage.wix.com/dashboard/<SITE_ID>/...`.

### 3. Add the connector in Blueprint

Go to **Connectors → Add → Wix** and enter:

- **API Key** — the key generated in step 1.
- **Site ID** — the site ID from step 2.

Click **Connect**. Blueprint verifies access and runs an initial analytics pull.

---

## Data pulled

Each sync fetches visitor and traffic data from the Wix Analytics API v2.

| Data | Description |
|---|---|
| Page views | Total page views for the last 30 days |
| Unique visitors | Unique visitor count for the last 30 days |
| Sessions | Total session count |
| Session duration | Average session duration in seconds |
| Bounce rate | Percentage of single-page sessions |
| Top pages | Up to 10 pages ranked by page view count |

**Update frequency:** every 6 hours.

> [!WARNING]
> Wix has a significantly more limited analytics API surface compared to GA4. Some metrics available in the Wix dashboard (traffic sources, device breakdown, geographic data) are not available via the API at this time. Blueprint uses Wix Analytics API v2 endpoints where available, but coverage is incomplete. See the recommendation below for more complete analytics coverage.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `wix.page_views_30d` | Total page views in the last 30 days |
| `wix.unique_visitors_30d` | Unique visitors in the last 30 days |
| `wix.sessions_30d` | Total sessions in the last 30 days |
| `wix.avg_session_duration` | Average session duration (seconds) |
| `wix.bounce_rate` | Bounce rate percentage |
| `wix.top_pages_data` | Rich data — top 10 pages by page views |

---

## Signals produced

The Wix connector does not produce signals by default. Traffic anomaly detection for Wix sites is handled by correlating Wix metrics with other connected data sources via the Conductor agent.

---

## Recommended: use GA4 alongside Wix

If you have Google Analytics 4 installed on your Wix site, Blueprint strongly recommends connecting **both** the Wix and GA4 connectors:

> [!TIP]
> GA4 provides significantly richer traffic data than the Wix Analytics API — including traffic source attribution, device categories, geographic breakdown, user behaviour flows, and conversion tracking. Use GA4 as the primary source for traffic intelligence, and use the Wix connector for site health monitoring only.

To install GA4 on a Wix site:

1. In Wix, go to **Marketing & SEO → Marketing Integrations → Google Analytics**.
2. Enter your GA4 Measurement ID (format: `G-XXXXXXXXXX`).
3. Publish your site changes.
4. Connect both the GA4 connector and the Wix connector in Blueprint.

When both connectors are active, Blueprint's agents will prefer GA4 data for traffic analysis.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Trend Spotter | Correlates Wix visitor data with conversion and revenue signals |
| SEO Sentinel | Uses page view data to identify low-traffic content on Wix-hosted pages |

---

## Troubleshooting

**`403 Forbidden` on connection**

The API key does not have analytics permissions for the specified site. Regenerate the key with Analytics read access enabled, or check that the Site ID matches the site the key was created for.

**Page view data does not match Wix dashboard**

The Wix Analytics API can have a lag of up to 48 hours for fully processed data. Blueprint marks analytics data with the timestamp of when it was pulled, not when the visits occurred. Fresh data from the last 24–48 hours may be understated compared to the dashboard, which may display real-time estimates.

**API returns empty data for a new site**

Wix Analytics requires at least 10 visits before the API begins returning data. If your site is new, wait until it has received traffic before connecting this connector.

**Site ID format**

Site IDs are UUIDs in the format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Entering a site slug (the name in your Wix URL) instead of the UUID will cause a `site not found` error.
