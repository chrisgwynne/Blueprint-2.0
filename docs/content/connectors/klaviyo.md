---
title: "Klaviyo"
description: "Connect Klaviyo to track email open rates, list health, and flow performance in Blueprint."
section: "Connectors"
order: 17
---

# Klaviyo

The Klaviyo connector pulls campaign performance statistics, list sizes, flow analytics, and deliverability data from the Klaviyo API. It syncs every 6 hours and feeds the Outreach and Quill agents with email marketing intelligence.

---

## Setup

### 1. Generate a Klaviyo private API key

1. Log in to your Klaviyo account.
2. Click your account name in the bottom-left corner and go to **Settings → API Keys**.
3. Click **Create Private API Key**.
4. Give it a descriptive name such as "Blueprint".
5. Under **Select Access Level**, choose **Full Access** or at minimum enable read access for:
   - **Lists**
   - **Campaigns**
   - **Flows**
   - **Metrics**
   - **Profiles** (for list size data)
6. Click **Create** and copy the key immediately. It starts with `pk_`.

> [!NOTE]
> Klaviyo private API keys grant access to your account's email data. Store the key securely. Blueprint saves it encrypted in the local SQLite database using your `ENCRYPTION_KEY` environment variable.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → Klaviyo** and paste the private API key. Click **Connect**. Blueprint verifies access and returns a summary of your list count and recent campaign count.

---

## Data pulled

Each sync fetches list sizes, campaign statistics for the last 30 days, and performance data for key automated flows.

| Data | Description |
|---|---|
| Lists | All lists with subscriber counts and growth |
| Campaigns | Campaigns sent in the last 30 days with open, click, and unsubscribe stats |
| Flows | Welcome series and abandoned cart flow performance |
| Deliverability | Bounce and spam complaint rates from recent sends |

Campaign statistics are pulled from Klaviyo's campaign detail endpoints and reflect all-time stats for each campaign, filtered to campaigns sent within the last 30 days.

**Update frequency:** every 6 hours.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `klaviyo.total_list_size` | Combined subscriber count across all lists |
| `klaviyo.open_rate_30d` | Average unique open rate across campaigns sent in the last 30 days |
| `klaviyo.click_rate_30d` | Average click rate across recent campaigns |
| `klaviyo.unsubscribe_rate_30d` | Average unsubscribe rate across recent campaigns |
| `klaviyo.campaigns_sent_30d` | Number of campaigns sent in the last 30 days |
| `klaviyo.flow_welcome_open_rate` | Open rate for the welcome series flow |
| `klaviyo.flow_abandoned_cart_open_rate` | Open rate for the abandoned cart flow |
| `klaviyo.flow_abandoned_cart_revenue` | Revenue attributed to the abandoned cart flow |
| `klaviyo.lists_data` | Rich data — all lists with subscriber counts |
| `klaviyo.campaigns_data` | Rich data — campaign list with full stats |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `klaviyo_open_rate_drop` | warning | Average open rate drops >15% vs the previous 30-day average |
| `klaviyo_list_churn` | alert | Unsubscribe rate exceeds 0.5% on any recent campaign |

> [!TIP]
> A `klaviyo_open_rate_drop` signal in isolation often indicates a deliverability issue or a subject line quality drop rather than a list problem. Check whether the drop correlates with a new sending domain, recent IP warm-up activity, or a change in send frequency before acting on it.

---

## Flow tracking

Blueprint specifically tracks the **welcome series** and **abandoned cart** flows because these are the two highest-ROI automations for most e-commerce businesses.

Flow performance is pulled from Klaviyo's flow analytics endpoint and includes:

- Open rate
- Click rate
- Revenue attributed (where Klaviyo attribution is configured)
- Recipient count (last 30 days)

If you have not set up these flows in Klaviyo, the corresponding metrics are written as null and no signal fires.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Outreach | Analyses campaign and flow performance, identifies list health issues |
| Quill | Uses campaign content themes and performance data to inform email copy |

---

## Troubleshooting

**`403 Forbidden` on connection**

Your private API key does not have the required scopes. Return to **Settings → API Keys** in Klaviyo, revoke the key, and create a new one with the scopes listed above.

**Open rate metrics are unexpectedly low**

Apple Mail Privacy Protection (MPP) inflates open rates on iOS/macOS devices, and some analytics filters may attempt to exclude MPP opens. Blueprint uses the raw Klaviyo-reported open rate. If Klaviyo's own dashboard shows a different figure, check whether you have MPP filtering enabled in Klaviyo settings — Blueprint reads the same numbers Klaviyo exposes via API.

**Flow data not appearing**

Blueprint searches for flows with names containing "welcome" and "abandoned cart" (case-insensitive). If your flows are named differently (e.g. "Cart Recovery"), update the flow name pattern in **Connectors → Klaviyo → Advanced Settings → Flow Name Patterns**.

**`klaviyo_list_churn` firing on a cold outreach campaign**

Cold outreach and re-engagement campaigns naturally have higher unsubscribe rates. If you send to a purchased or aged list, this signal may fire repeatedly. You can tune the unsubscribe rate threshold in **Connectors → Klaviyo → Signal Settings**.
