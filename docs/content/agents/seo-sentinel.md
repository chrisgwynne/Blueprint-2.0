---
title: "SEO Sentinel"
description: "Monitors search rankings, Core Web Vitals, and SEO health"
section: "Agents"
order: 3
---

# SEO Sentinel

SEO Sentinel is Blueprint's Search Intelligence Specialist. It runs every weekday morning and monitors your Google Search Console data for ranking changes, CTR opportunities, and Core Web Vitals regressions. It cites specific data — exact keyword names, position numbers, CTR percentages, URLs — never generalisations.

## Schedule

| Job | Cron | Description |
|-----|------|-------------|
| Daily scan | `0 7 * * 1-5` | Weekday morning: 7-day GSC review, top findings, task proposals |
| Weekly deep-dive | `0 8 * * 1` | Monday: 28-day analysis, keyword movers, content gap scan |

The daily scan runs at 07:00 Monday through Friday. The weekly deep-dive runs at 08:00 on Mondays (after the daily scan completes) and goes deeper — 28-day windows, content gap analysis, meta description audit.

---

## Required and Optional Connectors

**Required:** Google Search Console. SEO Sentinel will not run (it records a `skipped` status) if GSC has not synced within the last 48 hours. No guessing from stale data.

**Optional:** GA4 (closes the loop between search visibility and on-site behaviour), PageSpeed Insights (Core Web Vitals context).

---

## Signal Triggers

SEO Sentinel runs immediately when these signals are raised:

- `traffic_drop_7day` — assesses which pages and keywords drove the drop
- `gsc_ctr_drop` — identifies affected pages, analyses title and meta against search intent
- `pagespeed_regression` — confirms regression, assesses SEO risk, briefs Velocity if hired
- `gsc_ranking_drop` — confirms the drop, checks for Google update signals, proposes a response

---

## What SEO Sentinel Does Each Run

**Keyword ranking analysis.** SEO Sentinel compares position data for the current 7-day period against the prior 7-day period. It looks for momentum, not just state: a keyword at position 8 that was at position 4 last week is more urgent than a keyword stuck at position 15. It specifically focuses on keywords ranked 4–20 where a small push can meaningfully change click volume.

**CTR opportunities.** Queries with high impressions and below-average CTR are candidates for title tag and meta description rewrites. The weekly deep-dive specifically looks for queries with more than 50 weekly impressions and CTR below 2%.

**"Almost there" keywords.** Queries ranked 11–20 with more than 100 weekly impressions are flagged as quick-win opportunities — one targeted optimisation could push them into the top 10.

**Core Web Vitals.** When PageSpeed is connected, SEO Sentinel checks for regressions in LCP (Largest Contentful Paint), CLS (Cumulative Layout Shift), and FID (First Input Delay) against the previous run's scores.

**Ranking drops greater than 3 positions.** Any keyword that has dropped more than 3 positions is flagged automatically, regardless of whether a signal was raised externally.

**Content gaps.** In the weekly deep-dive, SEO Sentinel identifies queries with significant impression volume where the site has no dedicated page — these are handed off to Quill as content brief opportunities.

---

## Data Quality Requirements

Before proposing any task, SEO Sentinel confirms three things:

1. At least one successful GSC sync in the last 48 hours.
2. Every claim cites a specific query, page, position value, or CTR figure from synced data.
3. Trends are based on more than one or two data points — no single-week extrapolations.

If it cannot confirm all three, it logs a clean skip with an explanation for Conductor. It does not file tasks, signals, or KB entries from incomplete data.

---

## What SEO Sentinel Produces

Each run produces:
- 0–5 task proposals (filtered to confidence ≥ 0.7, max 3 unless a P1 signal triggered the run)
- 0–N signal evaluations
- A memory update (patterns noticed, key data points)
- A run log entry (`run-log.jsonl`)
- A structured briefing for Conductor (always, even on skipped runs)

---

## Trust Tier

**Yellow.** All proposals require approval. SEO Sentinel never modifies live pages or GSC properties directly — it proposes and a human approves.

---

## Example Output

Below is a representative task proposal from SEO Sentinel:

```json
{
  "title": "Rewrite meta description: 'personalised gifts for mum' dropping CTR (position 6, CTR 1.4%)",
  "description": "The query 'personalised gifts for mum' is ranked position 6 with 2,340 impressions in the last 7 days but CTR of only 1.4% — well below the site average of 3.8% at that position. The current meta description reads 'Browse our range of personalised gifts.' It is generic and does not mention delivery time, price range, or personalisation options — all of which competitors in positions 1–3 call out explicitly. Recommended rewrite: lead with the personalisation hook and a specific benefit (e.g., 'Personalised gifts for mum, made to order — engrave her name, add a photo, delivered in 3 days.').",
  "action_type": "meta_edit",
  "trust_tier": "yellow",
  "priority": "p2",
  "confidence": 0.87,
  "estimated_impact": "Bringing CTR from 1.4% to 3.0% at position 6 with 2,340 weekly impressions = approximately 37 additional clicks per week."
}
```

Every proposal includes: the specific keyword, the URL, the current position, the current CTR, the comparison context, and the exact reason for the recommendation.

---

## Soul Files

SEO Sentinel's soul files live at `server/agents/seo-sentinel/`:

- `IDENTITY.md` — who SEO Sentinel is, its expertise, how it works
- `SOUL.md` — its principles: what it stands for, what it will always do, what it will never do
- `HEARTBEAT.md` — its operating rhythm: exact steps for daily scan and weekly deep-dive
- `AGENTS.md` — its relationships with other agents (Conductor, Quill, Velocity)

See [Soul Files](/agents/soul-files) for how to read and edit these files safely.

---

## Hiring

Conductor recommends hiring SEO Sentinel (for users who started without it) once Google Search Console is connected and has at least 7 days of data. Blueprint checks GSC data freshness and readiness before the recommendation fires.

SEO Sentinel is a pre-installed agent — it does not need to be hired. It activates as soon as a GSC connector is connected and synced.
