---
title: "Brevo"
section: "Connectors"
order: 8
---

# Brevo

The Brevo connector (formerly Sendinblue) pulls email campaign statistics, contact list sizes, and transactional email health data from the Brevo API. It syncs every 6 hours and feeds the Outreach and Quill agents.

---

## Setup

### 1. Generate a Brevo API key

1. Log in to your Brevo dashboard.
2. Go to **Account → SMTP & API** (or navigate to [app.brevo.com/settings/keys/api](https://app.brevo.com/settings/keys/api)).
3. Under **API Keys**, click **Generate a new API key**.
4. Give it a name (e.g. "Blueprint") and click **Generate**.
5. Copy the key immediately — it is shown in full only once.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → Brevo** and paste the API key into the **API Key** field. Click **Connect**. Blueprint verifies the key and shows the account email on success.

---

## Data pulled

Each sync fetches the most recent 50 email campaigns, contact counts across all lists, and 7-day transactional stats (if available on your plan).

| Data | Description |
|---|---|
| Campaigns | Up to 50 campaigns, sorted newest first, with full statistics |
| Total contacts | Total count across all contacts |
| Contact lists | Up to 20 lists with subscriber counts |
| SMTP stats (7-day) | Transactional email delivered, hard bounces, soft bounces (if plan includes transactional) |

Campaign statistics available per campaign: delivered count, unique opens, clicks, unsubscriptions, hard bounces, soft bounces, spam reports.

**Update frequency:** every 6 hours.

---

## Metrics written to the database

`extractMetrics()` computes averages across campaigns sent in the last 30 days and writes these rows:

| Metric name | Value |
|---|---|
| `brevo.total_contacts` | Total contact count |
| `brevo.campaigns_sent_30d` | Number of campaigns sent in the last 30 days |
| `brevo.avg_open_rate` | Average unique open rate (%) across recent campaigns |
| `brevo.avg_click_rate` | Average click rate (%) |
| `brevo.avg_unsubscribe_rate` | Average unsubscribe rate (%) |
| `brevo.avg_bounce_rate` | Average combined bounce rate (%) |
| `brevo.transactional_delivered_7d` | Transactional emails delivered in last 7 days |
| `brevo.transactional_bounce_rate_7d` | Transactional bounce rate over last 7 days |
| `brevo.campaigns_data` | Rich data — up to 50 campaigns with full stats |
| `brevo.lists_data` | Rich data — contact lists |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `open_rate_drop` | warning | Average open rate drops ≥5 percentage points vs previous sync |
| `unsubscribe_spike` | alert | Average unsubscribe rate exceeds 0.5% |
| `bounce_rate_high` | alert | Average bounce rate exceeds 2% |

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Outreach | Analyses campaign performance and email deliverability health |
| Quill | Uses campaign data to inform email content recommendations |

Outreach and Quill have a minimum of 12 hours between runs.

---

## Troubleshooting

**`401 Unauthorized` on connection**

The API key is wrong or has been revoked. Regenerate a new key in Brevo (Account → SMTP & API → API Keys) and update the connector config.

**No campaign stats visible**

Brevo only includes statistics for campaigns with `status: 'sent'`. Draft and scheduled campaigns appear in the list but have no statistics. If all your campaigns are in draft, the metrics averages will be zero.

**Transactional stats not appearing**

Transactional email statistics (`brevo.transactional_*` metrics) are only available on Brevo plans that include transactional email. The connector handles this gracefully — if the SMTP stats endpoint returns an error, it is silently skipped and the transactional metrics are omitted.
