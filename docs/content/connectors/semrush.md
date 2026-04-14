---
title: "SEMrush"
description: "Connect SEMrush to track domain authority, keyword rankings, and backlink health in Blueprint."
section: "Connectors"
order: 18
---

# SEMrush

The SEMrush connector pulls domain authority scores, organic traffic estimates, keyword ranking positions, and backlink data from the SEMrush API. It syncs once per day to stay within API unit quotas and feeds the SEO Sentinel and Trend Spotter agents with competitive intelligence.

---

## Setup

### 1. Get your SEMrush API key

1. Log in to your [SEMrush account](https://www.semrush.com).
2. Go to **Profile → Subscription info** or navigate to [semrush.com/api-analytics](https://www.semrush.com/api-analytics).
3. Your API key is displayed on the API Access page. Copy it.

> [!NOTE]
> SEMrush API access requires a **Guru** plan or higher. The Pro plan does not include API access. Check your plan before attempting to connect.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → SEMrush** and enter:

- **API Key** — the key from the SEMrush API access page.
- **Domain** — the root domain you want to track (e.g. `example.com`, without `https://`).
- **Tracked keywords** — a comma-separated list of keywords to monitor positions for (up to 50).
- **Competitor domains** — optional, up to 5 domains for competitor gap analysis.

Click **Connect**. Blueprint verifies the key and runs an initial domain overview pull.

---

## Data pulled

Each daily sync fetches a domain overview, keyword ranking positions, and backlink summary.

| Data | Description |
|---|---|
| Domain authority score | SEMrush's authority score (0–100) for the tracked domain |
| Organic traffic estimate | Estimated monthly organic visitors |
| Keyword rankings | Position data for each tracked keyword (Google, desktop, target country) |
| Backlink count | Total referring backlinks |
| Referring domains | Count of unique domains linking to the tracked domain |
| Competitor gap | Top keywords where competitors rank but the tracked domain does not |

**Update frequency:** every 24 hours.

> [!WARNING]
> SEMrush API calls consume **units** from your monthly quota. Blueprint caches all responses and will not re-fetch data that was successfully retrieved within the same sync window. The typical daily sync consumes approximately 20–80 units depending on how many tracked keywords and competitor domains are configured. Monitor your unit balance at **Profile → Subscription info → API units**.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `semrush.authority_score` | Domain authority score (0–100) |
| `semrush.organic_traffic_estimate` | Estimated monthly organic visitors |
| `semrush.backlinks` | Total backlink count |
| `semrush.referring_domains` | Unique referring domain count |
| `semrush.tracked_keywords_avg_position` | Average position across all tracked keywords |
| `semrush.keywords_top3` | Count of tracked keywords ranking in positions 1–3 |
| `semrush.keywords_top10` | Count of tracked keywords ranking in positions 1–10 |
| `semrush.keyword_rankings_data` | Rich data — position per tracked keyword |
| `semrush.competitor_gap_data` | Rich data — gap keyword opportunities |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `semrush_authority_drop` | warning | Authority score drops >5 points vs previous reading |
| `semrush_ranking_loss` | warning | Tracked keywords lose an average of >5 positions vs previous reading |

> [!TIP]
> Authority score changes are slow-moving and a 5-point drop is significant. When `semrush_authority_drop` fires, check whether it correlates with a sudden loss of referring domains — this can indicate a lost backlink from a high-authority source, or a manual action.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| SEO Sentinel | Primary consumer — analyses ranking changes, authority trends, and gap opportunities |
| Trend Spotter | Correlates organic traffic estimates with GA4 session data |

---

## API unit budgeting

Blueprint minimises unit consumption through two mechanisms:

1. **Response caching** — all API responses are cached in the Blueprint database and not re-requested until the 24-hour sync window elapses.
2. **Incremental keyword fetching** — if a previous sync was successful, only the keyword position endpoint is called on subsequent syncs unless authority or backlink data is older than 48 hours.

Estimated daily unit consumption by configuration:

| Configuration | Approx. units/day |
|---|---|
| Domain overview only | ~10 |
| + 20 tracked keywords | ~30 |
| + 50 tracked keywords | ~60 |
| + 5 competitor domains | ~80 |

---

## Troubleshooting

**`INVALID_KEY` or `403` on connection**

Your API key is invalid or your plan does not include API access. Verify the key at **Profile → Subscription info** and confirm you are on Guru or higher.

**Keyword rankings show `0` or `not in top 100`**

SEMrush only returns ranking data for keywords where the domain appears in the top 100 results. If a tracked keyword returns no position data, Blueprint records it as unranked rather than zero. This is expected behaviour.

**Unit quota exceeded mid-month**

If Blueprint exhausts your monthly unit quota, subsequent syncs will fail with a `Too Many Requests` error. Blueprint will log this and pause the connector until the first of the following month. You can increase your quota in your SEMrush subscription settings.

**Competitor gap data is empty**

Competitor gap analysis requires at least one competitor domain to be configured. Go to **Connectors → SEMrush → Settings** and add competitor domains.
