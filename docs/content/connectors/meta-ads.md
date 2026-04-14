---
title: "Meta Ads"
description: "Connect Facebook and Instagram Ads to track spend, ROAS, and campaign performance in Blueprint."
section: "Connectors"
order: 19
---

# Meta Ads

The Meta Ads connector pulls campaign spend, impression data, reach, click-through rates, and pixel-based conversion data from the Meta Marketing API. It syncs every 6 hours and feeds the Conductor and Trend Spotter agents with paid social intelligence.

---

## Setup

### 1. Create a Facebook App with Marketing API access

1. Go to [developers.facebook.com](https://developers.facebook.com) and click **My Apps → Create App**.
2. Choose **Business** as the app type.
3. Fill in the app name (e.g. "Blueprint") and your business email.
4. Once the app is created, go to **App Dashboard → Add a Product** and add **Marketing API**.
5. Navigate to **Marketing API → Tools** and confirm the API is active.

### 2. Create a System User and generate a long-lived token

> [!WARNING]
> Do not use a regular user access token for production. User tokens expire after 60 days and will silently fail until re-authorised. **System user tokens do not expire** and are the correct credential type for server-side integrations like Blueprint.

1. In [Meta Business Suite](https://business.facebook.com), go to **Settings → Users → System Users**.
2. Click **Add** and create a new system user. Set the role to **Admin** (needed to read ad account data).
3. Click **Generate New Token** next to the system user.
4. Select your app (created in step 1) and grant the following permissions:
   - `ads_read`
   - `ads_management` (needed to read campaign-level stats)
   - `business_management`
5. Copy the token. It will not expire as long as the system user and app remain active.

### 3. Get your Ad Account ID

1. In Meta Business Suite, go to **Ad Accounts**.
2. Copy the account ID(s) you want Blueprint to monitor. The ID is a numeric string (e.g. `1234567890`). You can monitor multiple ad accounts.

### 4. Add the connector in Blueprint

Go to **Connectors → Add → Meta Ads** and enter:

- **App ID** and **App Secret** — from your Facebook App dashboard.
- **System User Token** — the long-lived token generated in step 2.
- **Ad Account IDs** — one or more account IDs, comma-separated, each prefixed with `act_` (e.g. `act_1234567890`).

Click **Connect**. Blueprint verifies the token and enumerates the configured ad accounts.

---

## Data pulled

Each sync fetches account-level and campaign-level performance for the last 30 days.

| Data | Description |
|---|---|
| Account totals | Spend, impressions, reach, clicks, CTR, CPM, CPC (rolled up across campaigns) |
| Campaign breakdown | Per-campaign spend, impressions, and performance metrics |
| Conversions | Pixel-based conversion events and ROAS (if Meta Pixel is configured) |
| Frequency | Average number of times a unique user has seen your ads |

**Update frequency:** every 6 hours.

> [!NOTE]
> Conversion data and ROAS require that the Meta Pixel is installed on your website and that conversion events are configured in Meta Events Manager. Without a pixel, Blueprint will report click and impression data but conversion and ROAS metrics will be null.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `meta_ads.spend` | Total spend across all configured ad accounts (last 30 days) |
| `meta_ads.impressions` | Total impressions |
| `meta_ads.reach` | Total unique reach |
| `meta_ads.clicks` | Total link clicks |
| `meta_ads.ctr` | Click-through rate (clicks / impressions) |
| `meta_ads.cpm` | Cost per thousand impressions |
| `meta_ads.cpc` | Average cost per click |
| `meta_ads.conversions` | Total pixel conversion events |
| `meta_ads.roas` | Return on ad spend from pixel attribution |
| `meta_ads.campaigns_data` | Rich data — per-campaign performance breakdown |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `meta_ads_spend_spike` | warning | Spend is >30% above the 7-day rolling average |
| `meta_ads_roas_drop` | alert | ROAS drops >20% vs the previous sync period |
| `meta_ads_ctr_drop` | warning | CTR drops >30% vs the previous sync period |

> [!TIP]
> `meta_ads_ctr_drop` often precedes a ROAS drop by 1–2 days and is a leading indicator of creative fatigue. When this signal fires, it is a good time for the Quill agent to generate fresh ad copy or suggest new creative concepts.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Conductor | Reviews spend and ROAS signals, surfaces tasks for attention |
| Trend Spotter | Correlates paid social traffic changes with organic and revenue data |

---

## Troubleshooting

**`Invalid OAuth access token` or `Token expired`**

If you used a regular user token instead of a system user token, it has expired after 60 days. Regenerate a system user token following step 2 above, and update the connector in Blueprint.

**Ad account not found**

Ensure the account ID is prefixed with `act_`. The format must be `act_1234567890`, not just `1234567890`. Also confirm the system user has been granted access to the ad account in Meta Business Suite under **Ad Accounts → Assigned People**.

**ROAS is null even though pixel is installed**

The pixel must have conversion events configured (e.g. `Purchase`). Go to **Meta Events Manager → Data Sources → your pixel → Event Setup** and confirm purchase events are firing. ROAS is calculated only from events with an associated value.

**Spend spike signal fires on campaign launch days**

New campaigns or budget increases will naturally spike spend. You can add spend spike suppression windows in **Connectors → Meta Ads → Signal Settings** to temporarily silence `meta_ads_spend_spike` during known campaign launch periods.
