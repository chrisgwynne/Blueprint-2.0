---
title: "UptimeRobot"
section: "Connectors"
order: 14
---

# UptimeRobot

The UptimeRobot connector pulls the status, uptime ratios, and response times for all monitors in your UptimeRobot account. It syncs every 15 minutes — the most frequent polling interval of any Blueprint connector — so downtime is detected and signalled quickly.

---

## Setup

### 1. Get your UptimeRobot API key

1. Log in to your UptimeRobot dashboard.
2. Go to **My Settings** (top-right menu).
3. Scroll to **API Settings**.
4. Use the **Main API Key** or click **Create Read-Only API Key** if you prefer to limit access to read operations. A read-only key is sufficient for Blueprint.
5. Copy the key.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → UptimeRobot** and paste the API key. Click **Connect**. Blueprint immediately verifies the key and returns a summary of your account's monitor counts.

---

## Data pulled

Each sync fetches the account summary and all monitors, including recent response time readings and status logs.

| Data | Description |
|---|---|
| Monitors | All monitors: name, URL, type, current status |
| Uptime ratios | 1-day, 7-day, and 30-day uptime percentages per monitor |
| Response times | Last 24 response time readings per monitor |
| Status logs | Last 10 log entries per monitor |
| Account summary | Total monitors, how many are up, how many are down |

**Monitor status codes:**

| Code | Meaning |
|---|---|
| 0 | Paused |
| 1 | Not checked yet |
| 2 | Up |
| 8 | Seems down (UptimeRobot rechecking) |
| 9 | Down (confirmed) |

**Update frequency:** every 15 minutes.

---

## Metrics written to the database

`extractMetrics()` writes these rows after each sync:

| Metric name | Value |
|---|---|
| `uptimerobot.monitors_total` | Total monitor count |
| `uptimerobot.monitors_up` | Count of monitors with status 2 (up) |
| `uptimerobot.monitors_down` | Count of monitors with status 9 (down) |
| `uptimerobot.monitors_seems_down` | Count of monitors with status 8 (seems down) |
| `uptimerobot.monitors_paused` | Count of paused monitors |
| `uptimerobot.overall_uptime` | Average 30-day uptime ratio across all monitors |
| `uptimerobot.monitors_data` | Rich data — full monitor list with response times and logs |
| `uptimerobot.down_monitors_data` | Rich data — only monitors that are down or seems down |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `monitor_down` | critical | Any monitor has status 9 (confirmed down) |
| `monitor_seems_down` | alert | Any monitor has status 8 (UptimeRobot is rechecking) |
| `uptime_below_threshold` | warning | Any monitor's 30-day uptime ratio falls below 99.5% |
| `response_time_spike` | warning | Any monitor's latest response time is >50% higher than previous sync and exceeds 500ms |

The `monitor_down` signal has `critical` severity — the highest level — and is created with 100% confidence. It fires on every sync where a confirmed-down monitor exists and no identical open signal is already present for that connector.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Sentinel | Infrastructure health monitoring (if installed) |
| Conductor | Reviews critical signals and decides on escalation |

Sentinel has a minimum of 1 hour between runs, reflecting the time-sensitive nature of uptime data.

---

## Troubleshooting

**`stat: "fail"` — `message: "api_key_not_found"`**

The API key is invalid. Double-check the key in UptimeRobot under My Settings → API Settings. Make sure you copied the full key including any prefix characters.

**No monitors listed**

Your UptimeRobot account has no monitors configured, or all monitors are in a workspace the API key cannot access. Main API keys have access to all monitors; read-only keys created per monitor have limited scope.

**Signals not firing despite a monitor being down**

Blueprint deduplicates signals — it will not create a second `monitor_down` signal if one is already open for this connector. Check the Signals view to see if the signal already exists in an open or acknowledged state.

**Response time spike fires too frequently**

The `response_time_spike` rule requires the response time to be both >50% higher than the previous reading and exceed 500ms in absolute terms. If you are seeing frequent noise, this usually indicates genuine latency variability on the monitored endpoint rather than a configuration issue.
