---
title: "Trend Spotter"
description: "Finds growth opportunities before they peak"
section: "Agents"
order: 5
---

# Trend Spotter

Trend Spotter is Blueprint's Analytics and Opportunity Intelligence agent. Where SEO Sentinel watches for problems, Trend Spotter watches for possibilities. It runs every Monday morning and looks for the green shoots — keywords gaining ground, product categories showing increasing interest, traffic patterns that suggest an untapped market. Every opportunity it surfaces is backed by data with a confidence score and a realistic assessment of effort versus reward.

## Schedule

| Job | Cron | Description |
|-----|------|-------------|
| Weekly opportunity scan | `0 10 * * 1` | Monday: keyword momentum, rising pages, product trends |
| Monthly trend analysis | `0 9 1 * *` | 1st of month: aggregate metric comparison, seasonal outlook |

---

## Required and Optional Connectors

**Required:** None. Trend Spotter runs without any connectors, though most of its value comes from connected data.

**Optional:** Google Search Console (keyword positions and impression trends), GA4 (traffic patterns, landing page performance, conversion funnel analysis), Shopify (product categories with rising page views, inventory signals).

With only GSC connected, Trend Spotter focuses on keyword momentum. With GA4 added, it can identify pages with growing traffic but poor conversion — a different kind of opportunity. With Shopify, it can cross-reference search intent with actual product catalogue performance.

---

## What Trend Spotter Does Each Run

**Keyword momentum tracking.** Trend Spotter looks for queries where both position and impression volume are improving week-over-week. A keyword moving from position 18 to position 14 over four weeks is more interesting than a keyword sitting at position 8 unchanged — it signals momentum that can be accelerated with targeted work.

**"Almost there" opportunities.** Queries ranked 11–20 with more than 100 weekly impressions are flagged as quick wins — one focused optimisation could push them into the top 10 and significantly increase clicks. Trend Spotter distinguishes these from the keyword-drop alerts SEO Sentinel raises; it is looking for the upward trajectory, not the fall.

**Seasonal pattern identification.** Trend Spotter compares current impression volume against the same period in previous years (where data exists) to identify seasonal patterns. If a product category typically peaks in Q4 but GSC shows early impression growth in October, it surfaces the preparation opportunity before it's too late to act.

**Rising landing pages.** Trend Spotter identifies pages where impressions have grown consistently over the last 28 days. It asks: what's driving the growth? Can it be accelerated? Is there an adjacent keyword cluster the page isn't targeting yet?

**Product categories with growing interest (Shopify).** When Shopify is connected, Trend Spotter cross-references GSC trends with product catalogue data. A search trend for "personalised slate coasters" that doesn't yet have a dedicated product page is a concrete commercial opportunity.

**Period-over-period acceleration.** Trend Spotter explicitly compares current performance to the prior period to identify acceleration — not just "this is good" but "this is getting better faster."

---

## What Trend Spotter Tracks in Memory

Trend Spotter maintains a `watched_trends` list in `memory.json` — opportunities it is tracking over time:

```json
{
  "watched_trends": [
    {
      "keyword": "personalised slate coasters",
      "first_seen": "2026-01-08",
      "trajectory": "rising",
      "current_position": 18,
      "weekly_impressions": 45,
      "notes": "Potential for Q4 gift season. Monitor weekly."
    }
  ]
}
```

This list is updated every run. When a tracked trend reaches a significance threshold (position improvement, impression growth rate), Trend Spotter escalates to Conductor.

---

## What Trend Spotter Produces

Each run produces 2–3 opportunity proposals, each with:
- The specific keyword or page
- Current position and impression volume
- Direction of travel (how many weeks of consistent movement)
- Confidence score
- Risk/reward assessment (is the competition realistic?)
- Recommended action (new content, page expansion, Quill commission)

---

## Data Quality Requirements

Before proposing any task, Trend Spotter confirms:

1. At least one successful GA4 sync (primary source) in the last 48 hours.
2. Every trend cited includes a specific metric, time window, and magnitude from synced data.
3. Enough historical data to distinguish a real trend from a noise spike — no single-week guesses, no seasonal tasks proposed without year-over-year data to anchor them.

If it cannot confirm all three, it returns a clean skip with explanation for Conductor. It does not file tasks or signals from insufficient data.

---

## Trust Tier

**Yellow.** All proposals require approval.
