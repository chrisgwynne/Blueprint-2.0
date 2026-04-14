---
title: "Google Search Console"
section: "Connectors"
order: 3
---

# Google Search Console

The GSC connector pulls keyword rankings, click and impression data, CTR analysis, and position movement data from the Search Console API. It syncs every 12 hours and feeds the SEO Sentinel, Trend Spotter, Quill, and Conductor agents.

---

## Setup

### 1. Create or reuse a Google Cloud OAuth app

The GSC connector uses the same Google OAuth app as GA4, Google Ads, and GBP. If you have already configured **Settings → Google OAuth** in Blueprint, skip to step 3.

Go to [console.cloud.google.com](https://console.cloud.google.com).

- Select your project.
- Navigate to **APIs & Services → Library** and enable the **Google Search Console API**.
- Navigate to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
- Select **Web application**.
- Under **Authorised redirect URIs** add exactly: `http://localhost:4000/api/oauth/google/callback`
- Click **Create**. Copy the **Client ID** and **Client Secret**.

If you are adding GSC to a project already used for GA4, you only need to enable the **Google Search Console API** — the credentials and redirect URI are already set.

### 2. Enter credentials in Blueprint

Go to **Settings → Google OAuth** and paste the Client ID and Client Secret. Blueprint stores these in the database — no `.env` changes are needed.

### 3. Connect the connector

Go to **Connectors → Add → Google Search Console**. Click **Connect with Google** to start the OAuth flow. Authorise access to your Search Console data.

### 4. Select your site

After OAuth completes, Blueprint fetches the list of sites verified in your Search Console account and presents them in a dropdown. Select the exact URL variant that matches your verified property.

This step matters. Search Console treats the following as separate properties:

- `https://example.com` and `http://example.com`
- `https://www.example.com` and `https://example.com`
- `https://example.com/` (trailing slash) and `https://example.com`

Select from the dropdown rather than typing the URL to avoid mismatches. If your site has a **Domain property** (e.g. `sc-domain:example.com`), prefer that — it covers all URL variants automatically.

---

## Data pulled

Each sync fetches the top 50 keywords by clicks for a 7-day window (ending 3 days ago to account for GSC's inherent data delay) and the equivalent previous 7-day window.

| Data | Description |
|---|---|
| Keywords (current) | Up to 50 queries: clicks, impressions, CTR, average position |
| Keywords (previous) | Same query set, previous 7-day window, for comparison |
| Total clicks | Sum across all returned keywords |
| Total impressions | Sum across all returned keywords |
| Average CTR | Clicks / impressions across all keywords |
| Average position | Mean position across all keywords |
| Keyword movers (up) | Keywords that improved >3 positions vs previous period |
| Keyword movers (down) | Keywords that dropped >3 positions vs previous period |
| Low-CTR opportunities | Keywords with >1,000 impressions and <2% CTR |

**Update frequency:** every 12 hours. GSC data has a ~3-day inherent delay from Google, so Blueprint always queries ending 3 days before today.

---

## Metrics written to the database

`extractMetrics()` writes these named rows after each sync:

| Metric name | Value |
|---|---|
| `gsc.total_clicks` | Total clicks across all returned keywords |
| `gsc.total_impressions` | Total impressions |
| `gsc.avg_ctr` | Average CTR (decimal, e.g. 0.0312 = 3.12%) |
| `gsc.avg_position` | Average position across all keywords |
| `gsc.keyword_count` | Number of keywords returned |
| `gsc.keywords` | Rich data — top 100 keywords with full stats |
| `gsc.keywords_up` | Rich data — keywords that improved >3 positions |
| `gsc.keywords_down` | Rich data — keywords that dropped >3 positions |
| `gsc.opportunities` | Rich data — high-impression, low-CTR keywords |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `ranking_drop_keyword` | warning | Any keyword drops ≥5 positions vs previous period |
| `keyword_surge` | info | A keyword improves significantly in ranking or clicks |
| `crawl_error_spike` | warning | ≥3 zero-click queries lost ≥30% impressions (proxy for crawl/indexing issues) |
| `ctr_below_threshold` | info | Any keyword has ≥1,000 impressions and <2% CTR |

The `top_page_traffic_drop` signal (from the GA4 connector) also uses GSC data — it evaluates click drops on the top 10 queries from the previous period.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| SEO Sentinel | Primary consumer — analyses keyword movements and ranking health |
| Trend Spotter | Correlates GSC ranking changes with GA4 traffic data |
| Quill | Uses keyword opportunity data to prioritise content briefs |
| Conductor | Reviews signals and routes to specialist agents |

Agent runs are throttled: SEO Sentinel minimum 6 hours between runs, Trend Spotter 12 hours, Quill 12 hours.

---

## Troubleshooting

**"User does not have sufficient permission for site"**

This is almost always a URL variant mismatch. The account you authorised in Blueprint is verified for a different variant of the site in Search Console (for example, you have `https://example.com` verified but the connector is configured with `http://example.com`, or the apex domain vs `www`).

Fix: open the connector config in Blueprint and use the site picker dropdown. It shows only the properties your account has access to. If the correct URL variant is missing, add it to Search Console and verify it.

Alternatively, add a **Domain property** in Search Console (`sc-domain:example.com`). A Domain property covers all URL variants and protocols.

**Token expired — re-authorise**

OAuth access tokens expire and are refreshed automatically using the stored refresh token. If the refresh token itself has expired or been revoked (for example, you removed Blueprint from your Google account's authorised apps), you will need to reconnect the connector. Go to Connectors → your GSC connector → **Reconnect** to restart the OAuth flow.

**No keywords returned**

If the site has very little Search Console data (new site, not yet indexed, or very low traffic) the API will return an empty result. This is not an error — Blueprint will show zero keywords and the signals will not fire. Check Search Console directly to confirm the site has data.
