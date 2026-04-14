---
title: "Buffer"
description: "Connect Buffer to track social media scheduling activity and post engagement in Blueprint."
section: "Connectors"
order: 20
---

# Buffer

The Buffer connector pulls post scheduling activity, publishing history, and per-channel engagement metrics from the Buffer API. It syncs every 6 hours and gives Blueprint visibility into social media output cadence and content performance.

---

## Setup

### 1. Connect via Buffer OAuth

Buffer uses OAuth 2.0 for authentication. Blueprint handles the OAuth flow for you.

1. Go to **Connectors → Add → Buffer** in Blueprint.
2. Click **Authorise with Buffer**.
3. You will be redirected to Buffer's authorisation page. Log in and click **Allow Access**.
4. Blueprint completes the OAuth flow and retrieves an access token automatically.

> [!NOTE]
> Buffer's free plan has limited API access. The connector requires a **Buffer Pro** or **Team** plan to retrieve engagement statistics (likes, comments, shares, clicks). On the free plan, Blueprint can only pull post counts and scheduling data.

### 2. Select channels

After authorisation, Blueprint lists all connected social profiles (Twitter/X, LinkedIn, Facebook, Instagram, Pinterest). You can choose which channels to monitor. By default, all connected profiles are tracked.

---

## Data pulled

Each sync fetches scheduled and published post data, plus engagement statistics for posts sent in the last 30 days.

| Data | Description |
|---|---|
| Scheduled posts | Count of posts currently in the Buffer queue, per channel |
| Published posts (7d) | Posts published in the last 7 days |
| Published posts (30d) | Posts published in the last 30 days |
| Post engagement | Likes, comments, shares, and link clicks per post |
| Best performing posts | Top 5 posts by engagement rate in the last 30 days |
| Channel breakdown | Per-profile post counts and average engagement |

**Update frequency:** every 6 hours.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `buffer.scheduled_posts_total` | Total posts currently queued across all channels |
| `buffer.published_7d` | Posts published in the last 7 days |
| `buffer.published_30d` | Posts published in the last 30 days |
| `buffer.avg_engagement_rate_30d` | Average engagement rate across posts in the last 30 days |
| `buffer.likes_30d` | Total likes across all published posts (30 days) |
| `buffer.comments_30d` | Total comments (30 days) |
| `buffer.shares_30d` | Total shares (30 days) |
| `buffer.link_clicks_30d` | Total link clicks from posts (30 days) |
| `buffer.best_posts_data` | Rich data — top 5 posts by engagement |
| `buffer.channel_breakdown_data` | Rich data — per-channel posting and engagement summary |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `buffer_engagement_drop` | warning | Average engagement rate drops >25% vs the 30-day rolling average |

> [!TIP]
> A drop in Buffer engagement rate is often a content quality signal rather than a platform issue. When `buffer_engagement_drop` fires, compare it against `klaviyo_open_rate_drop` and organic traffic data — if all three drop together, the issue may be broader audience fatigue or a seasonal effect rather than a content problem.

---

## Engagement rate calculation

Blueprint calculates engagement rate as:

```
engagement_rate = (likes + comments + shares) / impressions
```

Where impressions are available from the Buffer API (available for most platforms on Pro/Team plans). If impressions are not available for a given platform, engagement rate is calculated against follower count at the time of posting as a fallback.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Quill | Reviews content performance data and recommends post topics and formats |
| Conductor | Monitors posting cadence and flags if the queue runs dry |

---

## Troubleshooting

**Engagement data is missing for some channels**

Engagement statistics (likes, comments, shares, clicks) require a Buffer Pro or Team plan. On the free plan, these fields return null and Blueprint omits them from metric calculations. Upgrade your Buffer plan to enable full engagement tracking.

**OAuth token has expired**

Buffer access tokens can expire if the connection is inactive for an extended period. If Blueprint logs `401 Unauthorized` errors, go to **Connectors → Buffer** and click **Reconnect** to re-authorise via OAuth.

**Scheduled post count is zero despite items in queue**

Blueprint reads the scheduled queue from the Buffer `/updates/pending.json` endpoint. If Buffer reports zero queued posts but your dashboard shows items, confirm the connected profile has the correct permissions in your Buffer account and try re-syncing manually.

**Instagram engagement not tracking**

Instagram engagement data via the Buffer API depends on your Instagram account being connected as a Business or Creator profile. Personal Instagram accounts connected to Buffer do not expose engagement data through the API.
