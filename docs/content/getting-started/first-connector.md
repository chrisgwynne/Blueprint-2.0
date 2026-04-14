---
title: "Your First Connector"
description: "Connect your first data source and understand what happens next"
section: "Getting Started"
order: 4
---

# Your First Connector

Connectors are the foundation of Blueprint. They pull data from external services on a schedule, write metrics to the database, and feed the signal engine that creates alerts for agents to act on. Until at least one connector is set up, agents have nothing to analyse.

---

## Adding a Connector

1. In the left sidebar, click **Connectors**.
2. Click **Add Connector** in the top-right corner.
3. Select a connector from the list. The list shows all available connectors with their authentication method and polling interval.
4. Fill in the required credentials (API key, OAuth flow, or configuration values depending on the connector).
5. Click **Save and Connect**. Blueprint immediately runs a first sync to verify the credentials and fetch initial data.

---

## Recommended First Connectors

Two connectors give you the most signal value immediately:

### Google Analytics 4

**Best for:** websites, SaaS products, e-commerce — anywhere you are already tracking traffic.

What you need: a Google account with access to a GA4 property. Blueprint uses OAuth, so no API key is required — you just authorise access.

Signals produced within the first few syncs:

| Signal | What it means |
|--------|---------------|
| `traffic_drop_7day` | Sessions are down more than 20% week-over-week |
| `organic_traffic_drop` | Organic search traffic specifically is declining |
| `conversion_drop` | Goal conversion rate has fallen |
| `bounce_rate_spike` | Bounce rate has risen significantly |
| `top_page_traffic_drop` | A previously high-traffic page has lost visitors |

Before setting up GA4, make sure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are set in `.env` and Blueprint has been restarted. See [Configuration → Google OAuth](./configuration#google-oauth).

### Shopify

**Best for:** e-commerce stores running on Shopify.

What you need: a Shopify store API key. Generate one in your Shopify admin under **Apps → Develop apps → Create an app** (or use an existing private app with `read_orders`, `read_products`, `read_analytics` permissions).

Signals produced within the first few syncs:

| Signal | What it means |
|--------|---------------|
| `shopify_revenue_drop` | Daily revenue is down more than 15% vs the previous period |
| `shopify_aov_drop` | Average order value has fallen |
| `shopify_order_spike` | Order volume has spiked — may need fulfilment attention |
| `shopify_no_orders` | No orders in the last 24 hours (for stores that normally have daily volume) |

---

## What Happens After You Connect

The moment a connector is saved and the first sync succeeds, the following pipeline runs automatically:

### 1. Immediate sync

Blueprint calls the connector's `fetch()` function with your credentials and pulls the most recent data from the external API. For GA4 this means the last 30 days of session and conversion data. For Shopify it means orders and revenue from the last 90 days.

### 2. Metrics written to the database

The `extractMetrics()` function processes the raw API response and writes named metric rows to the `metrics` table. For example, a GA4 sync writes rows like:

```
ga4.sessions              → 12,450
ga4.organic_sessions      → 4,820
ga4.conversions           → 87
ga4.conversion_rate       → 0.70
```

These named metrics are what the signal engine evaluates and what agents read during their analysis runs.

### 3. Signal engine runs

Blueprint's signal engine compares new metric values against historical baselines and evaluates every registered rule for this connector type. If a rule fires, a signal row is written to the `signals` table with:

- `signal_type` — e.g. `traffic_drop_7day`
- `severity` — `info`, `warning`, or `critical`
- `value` — the raw metric value that triggered it
- `threshold` — the threshold it crossed
- `details` — a human-readable summary

Active signals appear in the **Signals** section of the dashboard and on the connector's detail page.

### 4. Conductor analyses connector readiness

After a successful sync, Blueprint's orchestration layer calls Conductor (if hired) and notifies it that a new connector has data. Conductor checks which specialist agents are relevant to this connector type and whether the conditions are right to recommend hiring them.

---

## The Hire Recommendation Flow

Conductor runs on an hourly schedule. When it sees that a connector has completed at least one successful sync, it evaluates:

1. **Is this connector type mapped to any specialist agents?** Each connector type has a default set of agents that benefit from its data. GA4 maps to SEO Sentinel and Trend Spotter. Shopify maps to Trend Spotter.
2. **Are those agents already hired?** If yes, Conductor skips the recommendation.
3. **Is there enough signal data to justify hiring?** Conductor checks for at least one sync with extractable metrics.

If the conditions are met, Conductor creates a task in the task queue with `action_type: hire_agent`, proposing that you hire the relevant specialist. You see this in **Tasks** as a hire recommendation with Conductor listed as `proposed_by`.

---

## What You Will See in the Dashboard

After a successful first sync, the main dashboard shows:

| Element | What it displays |
|---------|-----------------|
| Connector health badge | Green `connected` status with the last sync timestamp |
| Signal count | Number of active signals from this connector, broken down by severity |
| Metric summary cards | Key metrics from the most recent sync (sessions, revenue, etc.) |
| Last synced | Relative time of the most recent successful sync (e.g. "3 minutes ago") |

The connector's own detail page (click the connector name in the Connectors list) shows a deeper view: full metric history, active and resolved signals, sync history with per-run status and duration, and raw JSON blobs for individual sync runs.

---

## Connector Health States

| State | What it means |
|-------|---------------|
| `connected` | Last sync completed successfully |
| `error` | Last sync failed — the error message is shown on the connector detail page |
| `stale` | No successful sync within the expected window — credentials may have expired |
| `disconnected` | Manually disconnected — excluded from the poll schedule |

If a connector enters `error` state, Blueprint logs the error in the sync history and continues attempting to sync on the normal schedule. Most errors are credential expiry (re-authorise via the connector's settings page) or temporary API rate limits (Blueprint retries automatically).

---

## Next Step

Once your connector has completed its first sync and you can see signals or metrics in the dashboard, you are ready to hire your first agent. See [Your First Agent](./first-agent).
