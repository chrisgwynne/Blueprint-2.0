---
title: "Signal Types"
description: "All signal types Blueprint can detect"
section: "Signals"
order: 2
---

# Signal Types

Blueprint ships with signal rules for every supported connector. Each rule has a fixed ID, severity, and evaluation logic. Rules run after every sync of their connector type.

## GA4

| Signal ID | Severity | Description | Trigger condition |
|-----------|----------|-------------|-------------------|
| `traffic_drop_7day` | warning | Sessions dropped significantly week-over-week | Sessions down ≥20% vs prior 7-day period |
| `traffic_spike` | info | Unusual traffic increase detected | Sessions up significantly vs prior period |
| `conversion_drop` | alert | Conversion rate has fallen meaningfully | Conversion rate down ≥20% vs prior period |
| `organic_traffic_drop` | warning | Organic channel sessions declining | Organic sessions down vs prior period |
| `top_page_traffic_drop` | warning | A top-performing page is losing traffic | Traffic to a previously high-traffic page drops |
| `bounce_rate_spike` | warning | Bounce rate has increased significantly | Bounce rate increase above threshold |

GA4 signals focus on session volume, channel health, and conversion performance. They are most useful when combined with GSC signals — a traffic drop alongside a ranking drop indicates an SEO root cause, while a traffic drop without ranking changes points elsewhere (paid, direct, referral, or on-site issues).

## Google Search Console

| Signal ID | Severity | Description | Trigger condition |
|-----------|----------|-------------|-------------------|
| `ranking_drop_keyword` | warning | One or more keywords have dropped in position | Any keyword drops >3 positions vs prior period |
| `keyword_surge` | info | A keyword is gaining positions | Keyword improving meaningfully in rankings |
| `ctr_below_threshold` | info | High-impression keywords with poor click-through | >500 impressions with <2% CTR |
| `crawl_error_spike` | warning | Increase in crawl errors detected | Crawl error count increases above threshold |

GSC signals are typically the earliest indicator of SEO health issues. A `ranking_drop_keyword` signal often precedes a `traffic_drop_7day` by several days, giving you a window to act before traffic is affected.

The `ctr_below_threshold` signal is an opportunity signal: it identifies keywords where you rank well enough to receive impressions but your title/meta is not compelling enough to earn clicks. These are candidates for meta optimisation tasks.

## PageSpeed

| Signal ID | Severity | Description | Trigger condition |
|-----------|----------|-------------|-------------------|
| `pagespeed_regression` | alert | Overall PageSpeed score has dropped | Score drops >10 points vs prior measurement |
| `cwv_lcp_failing` | alert | Largest Contentful Paint is failing | LCP >4,000ms |
| `cwv_cls_failing` | alert | Cumulative Layout Shift is failing | CLS >0.25 |
| `cwv_fid_failing` | warning | First Input Delay is failing | FID above threshold |
| `score_drop_mobile` | alert | Mobile PageSpeed score is critically low | Mobile score <50 |
| `opportunities_detected` | info | PageSpeed audit identified actionable improvements | Audit returns opportunities with savings >threshold |

PageSpeed signals use the alert severity more than other connectors because Core Web Vitals failures directly affect Google rankings and user experience. A failing CWV is not something to defer — it has measurable SEO and conversion consequences.

The `opportunities_detected` signal is informational: it surfaces when a PageSpeed audit finds specific optimisations (image compression, render-blocking resources, unused CSS) that could improve your score. The associated agent task will include the specific recommendations from the audit.

## Shopify

| Signal ID | Severity | Description | Trigger condition |
|-----------|----------|-------------|-------------------|
| `shopify_revenue_drop` | alert | Revenue has dropped significantly | Revenue down vs comparable prior period |
| `shopify_aov_drop` | warning | Average order value is declining | AOV drops below threshold vs prior period |
| `shopify_order_spike` | info | Order volume is unusually high | Orders significantly above prior period average |
| `shopify_no_orders` | alert | No orders received when orders were expected | Zero orders in period where prior data shows normal activity |

Shopify signals are business-critical. The `shopify_no_orders` signal is particularly high-priority: it detects when a store that normally has order activity goes silent — which could indicate a checkout problem, payment gateway failure, or a broken campaign. It fires as an alert to ensure it is not missed.

The `shopify_order_spike` signal is a positive event that still warrants attention: unusually high order volume may strain fulfilment, indicate a viral moment worth capitalising on, or signal a pricing/inventory error.

## How severity maps to urgency

| Severity | Typical response | Auto-assigns agent? |
|----------|-----------------|---------------------|
| alert | Act today | Yes — highest priority routing |
| warning | Review this week | Yes — normal priority routing |
| info | When relevant | Yes — if a matching agent is configured |

All open signals are visible in the Signals view regardless of severity. Severity affects how agents prioritise their work and how prominently signals are displayed in the UI.

## Adding custom rules

Signal rules live in `server/signals/rules.js`. Each rule follows this structure:

```js
{
  id: 'your_rule_id',
  connectorType: 'ga4',        // which connector triggers this rule
  type: 'your_signal_type',   // used for deduplication and agent matching
  severity: 'warning',         // 'info' | 'warning' | 'alert'
  name: 'Human-readable name',

  evaluate(current, previous) {
    // Return { triggered, confidence, data, title, description }
  }
}
```

The `evaluate` function receives the current and previous data snapshots for the connector and returns whether the rule triggered, a confidence score (0–1), the signal title and description, and any additional data to store with the signal.
