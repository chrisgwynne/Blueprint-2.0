---
title: "Connectors Overview"
section: "Connectors"
order: 1
---

# Connectors Overview

Connectors pull data from external services on a recurring schedule, write metrics to Blueprint's SQLite database, and feed the signal engine that creates alerts for AI agents.

---

## Connector catalogue

| Connector | Category | Auth | Polling interval | Signal rules |
|---|---|---|---|---|
| Google Analytics 4 | Analytics | OAuth2 | 6 hours | traffic_drop_7day, traffic_spike, conversion_drop, organic_traffic_drop, top_page_traffic_drop, bounce_rate_spike |
| Google Search Console | SEO | OAuth2 | 12 hours | ranking_drop_keyword, keyword_surge, crawl_error_spike, ctr_below_threshold |
| Google PageSpeed Insights | SEO | API key (optional) | 24 hours | pagespeed_regression, cwv_lcp_failing, cwv_cls_failing, cwv_fid_failing, score_drop_mobile, opportunities_detected |
| Google Ads | Advertising | OAuth2 | 6 hours | google_ads_roas_drop, google_ads_spend_spike, google_ads_cpa_increase, google_ads_impression_share_drop, google_ads_low_quality_scores |
| Shopify | E-commerce | API key | 6 hours | shopify_revenue_drop, shopify_aov_drop, shopify_order_spike, shopify_no_orders, shopify_refund_spike |
| Stripe | Payments | API key | 6 hours | stripe_mrr_drop, stripe_failed_payments, stripe_refund_spike, stripe_revenue_drop |
| Brevo | Email | API key | 6 hours | open_rate_drop, unsubscribe_spike, bounce_rate_high |
| Klaviyo | Email | API key | 6 hours | klaviyo_open_rate_drop, klaviyo_unsubscribe_spike, klaviyo_abandoned_cart_opportunity, klaviyo_revenue_drop, klaviyo_list_growth_stalled |
| SEMrush | SEO | API key | 6 hours | semrush_rankings_drop, semrush_traffic_value_drop, semrush_competitor_surge, semrush_keyword_opportunity, semrush_backlink_growth |
| Meta Ads | Advertising | OAuth2 | 6 hours | meta_roas_drop, meta_cpm_spike, meta_cpc_spike, meta_spend_spike, meta_reach_drop |
| Buffer | Social | API key | 6 hours | buffer_queue_empty, buffer_posting_gap, buffer_low_engagement, buffer_content_opportunity, buffer_schedule_ahead |
| Todoist | Tasks | OAuth2 | 60 minutes | high_priority_overdue, overdue_tasks_spike, tasks_completed_drop |
| UptimeRobot | Infrastructure | API key | 15 minutes | monitor_down, monitor_seems_down, uptime_below_threshold, response_time_spike |
| WordPress | CMS | App password | 6 hours | wp_plugin_update_available, wp_posts_published_drop, wp_comments_spam_spike, wp_drafts_piling_up |
| GitHub | Code | API key | 6 hours | github_open_prs_growing, github_stale_prs, github_failing_checks, github_blueprint_pr_pending |
| Wix | CMS | API key | 6 hours | wix_seo_issues, wix_pages_noindexed, wix_blog_inactive, wix_seo_score_drop, wix_seo_opportunity |
| Stannp | Direct mail | API key | 12 hours | low_campaign_balance, stannp_campaign_failed, stannp_delivery_rate_drop |
| Server Access | Infrastructure | SSH key | 24 hours | — |

---

## How the sync pipeline works

Every connector sync follows the same five-step path:

```
Poll check (every 15 min)
  └─ isDue? → fetch() → extractMetrics() → signal engine → post-sync orchestration
```

**1. Poll check** — The scheduler runs every 15 minutes and compares each connector's `last_sync` timestamp against its polling interval. If the connector is due, `syncConnector()` fires.

**2. `fetch()`** — The connector implementation calls its external API and returns a normalised data object. Credentials are decrypted from SQLite before being passed in. Config values (property ID, site URL, URL to test, etc.) are read from the connector's `config` column and merged into `fetchParams`.

**3. `extractMetrics()`** — If the connector exports this function, the scheduler calls it with the raw fetch result and writes individual named metric rows to the `metrics` table (e.g. `ga4.sessions`, `gsc.total_clicks`, `pagespeed.mobile.performance_score`). Whether or not `extractMetrics` exists, a full blob summary row is always written as `{type}_sync`.

**4. Signal engine** — The scheduler passes the new data blob and the previous blob to `runSignalEngine()`, which evaluates every registered signal rule for this connector type. Rules that trigger create or update rows in the `signals` table. For PageSpeed, the `mobile` sub-object is passed directly rather than the full fetch result, to match the field paths the rules expect.

**5. Post-sync orchestration** — After a successful sync, `onConnectorSyncSuccess()` fires as fire-and-forget (never slows the sync path):
- Promotes any `pending` agents whose required connectors are now connected.
- Queues data-ready runs for agents registered in `CONNECTOR_AGENT_MAP` in `post-sync.js`, throttled by per-agent minimum hours between runs.
- Asks Conductor whether new specialist agents are worth hiring based on the now-connected data sources.

A forced full sync of all connectors also runs every day at 06:00, followed immediately by a Conductor pass. An hourly Conductor pass runs at :05 past every hour.

---

## Polling intervals

The scheduler reads `pollingIntervalMinutes` from the connector's `config` JSON first. If not set, it falls back to these defaults defined in `server/jobs/scheduler.js`:

| Connector | Default interval | Rationale |
|---|---|---|
| UptimeRobot | 15 minutes | Near-real-time uptime monitoring |
| Todoist | 60 minutes | Task changes need reasonably fresh data |
| Shopify | 6 hours | Orders and revenue |
| Stripe | 6 hours | Payments and MRR |
| Google Analytics 4 | 6 hours | Traffic and conversion data |
| Google Ads | 6 hours | Campaign performance |
| Brevo | 6 hours | Email campaign stats |
| WordPress | 6 hours | Content changes |
| Stannp | 12 hours | Direct mail campaigns |
| Google Search Console | 12 hours | GSC data has a ~3-day inherent delay |
| Google PageSpeed Insights | 24 hours | Scores change slowly; reduces API quota use |

Connectors not listed above default to 360 minutes (6 hours). Any connector-specific `pollingIntervalMinutes` set in the connector's config overrides the system default.

---

## How to manually sync

On any connector's detail page, click **Sync Now**. This triggers an immediate on-demand sync outside the normal schedule. The page refreshes automatically when the sync completes and shows the updated **Last synced** timestamp.

---

## Viewing raw data

Open a connector's detail page (Connectors → click a connected connector). The page shows:

- **Summary cards** — key metrics from the most recent sync.
- **Tabs** — detailed data (orders, keywords, monitors, etc.) depending on connector type.
- **Signals** — active and resolved signals produced by this connector.
- **Sync history** — every sync run: status (complete / failed), duration, and timestamp.

The raw JSON blob for any sync run can be inspected from the sync history table.

---

## Connector health states

| State | Meaning |
|---|---|
| `connected` | Last sync completed successfully. |
| `error` | Last sync failed. The error message is stored in `last_error` and shown in the UI. The connector continues attempting to sync on its normal schedule. |
| `stale` | The connector has not synced successfully within its expected window. A `connector_stale` signal is created. Investigate whether credentials have expired. |
| `disconnected` | The connector has been manually disconnected. It is excluded from the poll schedule until reconnected. |

Stale thresholds (checked hourly): UptimeRobot 2 hours, GA4 12 hours, Shopify 12 hours, GSC 24 hours, PageSpeed 48 hours, all others 24 hours. The stale signal severity escalates to `alert` if the connector has been unresponsive for more than twice its threshold.
