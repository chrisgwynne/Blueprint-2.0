---
title: "Signal Clustering"
description: "How related signals are grouped to reduce noise"
section: "Signals"
order: 3
---

# Signal Clustering

When multiple signals fire at once, they often share a root cause. A site with a technical issue might generate a `ranking_drop_keyword`, `organic_traffic_drop`, `pagespeed_regression`, and `ctr_below_threshold` signal simultaneously — all pointing to the same underlying problem. Signal clustering identifies these relationships and groups them.

## How clustering works

Clustering runs automatically after each Conductor pass. The cluster engine examines all open signals and looks for relationships based on:

- **Connector proximity** — signals from connectors that measure the same funnel layer (e.g., GSC + GA4 both measure search performance)
- **Timing** — signals that appeared within the same sync window
- **Semantic overlap** — signal types that are known co-indicators (e.g., ranking drops and traffic drops commonly co-occur)

When a group of signals meets the clustering threshold, the engine creates a cluster with a descriptive label. Example clusters:

| Signals | Cluster label |
|---------|--------------|
| `traffic_drop_7day` + `ranking_drop_keyword` + `ctr_below_threshold` | SEO health degradation |
| `pagespeed_regression` + `cwv_lcp_failing` + `score_drop_mobile` | Page performance regression |
| `shopify_revenue_drop` + `shopify_aov_drop` | Revenue health decline |
| `conversion_drop` + `bounce_rate_spike` | On-site conversion issue |

## Why clustering matters

Without clustering, a site-wide issue could generate six or seven separate signals, each routing to different agents and creating multiple overlapping task proposals. Clustering ensures:

- **Reduced noise** — the Conductor treats a cluster as one problem, not six
- **Better prioritisation** — a cluster of three alert-severity signals ranks higher than a single warning
- **Coherent agent response** — the agent assigned to a cluster has the full picture, not just one data point
- **Fewer notifications** — if Telegram notifications are enabled, a cluster sends one message rather than one per signal

## Clusters in the UI

In the Signals view, clustered signals appear with a badge showing the number of constituent signals (e.g., "3 signals"). The cluster card displays the cluster label and the severity of the most severe constituent signal.

Clicking a cluster opens the cluster detail view, which shows:
- The cluster label and description
- All constituent signals with their individual details
- Any tasks that have been proposed in response to the cluster
- The overall status (open / partially acknowledged / resolved)

A cluster is considered resolved when all its constituent signals are resolved. Resolving signals individually within a cluster is supported — the cluster status updates to reflect partial resolution.

## Cluster reassignment

If you acknowledge one signal in a cluster while others remain open, Blueprint keeps the cluster intact. This is intentional: the remaining signals share the same root cause and should be addressed together.

If two signals in a cluster turn out to be unrelated, you can manually break the cluster in the signal detail view. The signals will return to the independent signal queue.
