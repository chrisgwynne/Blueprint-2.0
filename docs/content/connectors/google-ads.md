---
title: "Google Ads"
description: "Connect Google Ads to track spend, ROAS, and campaign performance signals in Blueprint."
section: "Connectors"
order: 15
---

# Google Ads

The Google Ads connector pulls campaign spend, impression data, conversion metrics, and quality scores from the Google Ads API. It syncs every 4 hours and feeds the Conductor and Trend Spotter agents with paid acquisition intelligence.

---

## Setup

### 1. Enable the Google Ads API and prepare credentials

Blueprint reuses the same Google Cloud OAuth client as GA4 and Google Search Console if you have already configured those connectors. Before proceeding, ensure the **Google Ads API** is enabled on your project.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and select your project.
2. Navigate to **APIs & Services → Library** and search for **Google Ads API**.
3. Click **Enable**.
4. If you have not yet created an OAuth client, follow the same steps as for GA4: create a **Web application** client and add `http://localhost:4000/api/oauth/google/callback` as an authorised redirect URI.

### 2. Obtain a Google Ads developer token

The Google Ads API requires a developer token in addition to OAuth credentials.

1. Sign in to your [Google Ads manager account (MCC)](https://ads.google.com) or a direct account.
2. Go to **Tools & Settings → API Center**.
3. If you have not applied for a developer token before, click **Apply for access**. For basic access (test and most production use), apply for the **Basic** access level.
4. Once approved (or if you already have one), copy the developer token from this page.

> [!NOTE]
> If you are connecting a single direct account rather than an MCC, you can still obtain a developer token from that account's API Center. MCC accounts give you access to all sub-accounts with one connector configuration.

### 3. Add the connector in Blueprint

Go to **Connectors → Add → Google Ads** and enter:

- **Client ID** and **Client Secret** — from your Google Cloud OAuth credentials.
- **Developer Token** — from Google Ads API Center.
- **Customer ID** — your Google Ads account ID in `123-456-7890` format. For MCC accounts, use the MCC customer ID; Blueprint will enumerate sub-accounts automatically.

Click **Authorise** to complete the OAuth flow, then **Connect**.

---

## Data pulled

Each sync fetches campaign-level performance for the last 30 days, plus keyword quality scores for active campaigns.

| Data | Description |
|---|---|
| Campaign performance | Spend, impressions, clicks, conversions, cost-per-conversion, ROAS per campaign |
| Account totals | Rolled-up spend, clicks, and conversions across all active campaigns |
| Quality scores | Average quality score per campaign (keyword-level, aggregated) |
| Average CPC | Average cost-per-click across all active campaigns |

**Update frequency:** every 4 hours.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `google_ads.spend` | Total spend across all active campaigns (last 30 days) |
| `google_ads.impressions` | Total impressions |
| `google_ads.clicks` | Total clicks |
| `google_ads.conversions` | Total conversions |
| `google_ads.cost_per_conversion` | Spend divided by conversions |
| `google_ads.roas` | Return on ad spend (conversion value / spend) |
| `google_ads.average_cpc` | Average cost per click |
| `google_ads.quality_score_avg` | Average quality score across tracked keywords |
| `google_ads.campaigns_data` | Rich data — per-campaign breakdown |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `google_ads_spend_spike` | warning | Spend is >30% above the 7-day rolling average |
| `google_ads_roas_drop` | alert | ROAS drops >20% vs previous sync period |
| `google_ads_quality_score_low` | warning | Average quality score falls below 5 |

> [!TIP]
> The `google_ads_spend_spike` signal is most useful for catching runaway campaigns or budget misconfiguration. Pair it with the `meta_ads_spend_spike` signal to get a cross-channel view of unusual paid spend.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Conductor | Reviews spend signals and decides whether to surface a task |
| Trend Spotter | Correlates paid traffic changes with organic and revenue data |

---

## Troubleshooting

**`DEVELOPER_TOKEN_NOT_APPROVED` error**

Your developer token is in test mode and can only access test accounts. Apply for basic access in **Tools & Settings → API Center** in your Google Ads account. Approval usually takes 1–2 business days.

**`CUSTOMER_NOT_FOUND` or wrong account ID format**

Customer IDs must be entered without hyphens in some API contexts, but Blueprint accepts the dashed format (`123-456-7890`) and strips hyphens internally. Double-check the ID against your account dashboard URL.

**No conversions showing despite confirmed purchases**

Conversion data depends on your Google Ads conversion tracking setup. If conversions are imported from GA4 or tracked via the global site tag, they may have a lag of up to 24 hours before appearing. Blueprint reports conversions as returned by the API and does not model-fill missing conversion data.

**OAuth token refresh failures**

If Blueprint logs `invalid_grant` errors, your refresh token has expired or been revoked. Re-authorise the connector by clicking **Reconnect** in Connectors → Google Ads.
