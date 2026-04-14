---
title: "Temporal Reasoning"
description: "How Blueprint understands that actions take time to show results"
section: "The Brain"
order: 2
---

# Temporal Reasoning

Blueprint tracks not just what you changed, but when you changed it — and how long that type of change typically takes to produce measurable results. This is temporal reasoning: the understanding that different actions have different measurement windows.

---

## Why Measurement Windows Exist

When you change something on your website or in your marketing, the effect doesn't appear instantly. Search engines take time to re-crawl and re-index. User behaviour data accumulates gradually. Revenue effects play out over the normal purchase cycle.

Each action type has a characteristic delay before its effects become measurable. Blueprint knows these windows and uses them in two ways:

1. **Before proposing a new task** — it checks whether the same area is still inside a measurement window from a previous action. If so, the new task is deferred.
2. **When attributing a metric change** — it checks whether any recent actions fall within the expected measurement window for that metric. If so, it reports the action as a likely cause.

---

## Action Windows Reference

| Action | Min | Expected | Max | Key Metric |
|--------|-----|----------|-----|------------|
| Meta title / description | 7d | 21d | 42d | GSC CTR |
| Product description | 7d | 14d | 28d | Conversion rate |
| New landing page | 21d | 56d | 112d | Rankings |
| Code deployment | 0d | 3d | 14d | PageSpeed, bounce rate |
| New content / blog post | 28d | 56d | 120d | Rankings |
| Backlink acquired | 30d | 90d | 180d | Domain authority |
| Ad campaign change | 3d | 14d | 28d | ROAS, CTR |
| Social post | 1d | 7d | 14d | Engagement |
| Email campaign | 1d | 7d | 14d | Opens, clicks |

**Min** is the earliest you could plausibly see any effect. **Expected** is when most sites see meaningful data. **Max** is when effects have typically fully materialised (or not). Blueprint uses the **Expected** window as the default restraint duration for deferred tasks, and the **Max** window as the upper bound for causal attribution.

---

## A Real Example: 7 Weeks of Confusion

Here's the situation this is designed to prevent.

You rewrote all your meta descriptions on March 1st. On March 8th, traffic was flat. "Did it work?" you wondered. On March 15th, traffic was down 3%. You started worrying. On March 22nd, traffic was up 11% — but was that the meta descriptions, or just normal weekly variance? On April 15th, GSC showed your average CTR improved 23% site-wide.

Without Blueprint, those 45 days were seven weeks of confusion. You had no way to attribute the improvement cleanly because you weren't certain what had changed, when it had changed, or whether the traffic fluctuations in between were signal or noise.

With Blueprint, the sequence looks like this: the meta description task is logged with an action timestamp of March 1st. The measurement window is 21 days (expected), 42 days (max). On April 15th, Blueprint checks the action log: the elapsed time is 45 days, which falls within the expected-to-max window for meta description changes. CTR improved 23%. Attribution confidence: high. Blueprint reports: "The March 1st meta description update likely caused the 23% CTR improvement. Attribution window: 45 days, within the 21–42 day expected range."

Without temporal tracking, you had seven weeks of confusion. With it, you have a clear causal narrative.

---

## What Happens When Blueprint Detects a Conflict

If an agent tries to propose a meta description change on a page that was updated 8 days ago, Blueprint intervenes:

> **Task deferred:** Meta description update for `/products/personalised-gifts` is blocked until April 29th. A meta description change on this page was completed on April 8th. The measurement window is 21 days. Changing it again now would prevent clean measurement of the first change. Retry after April 29th.

The task is not discarded. It goes into the deferred queue with a "retry after" date. When April 29th arrives, the daily brain pass resurfaces it and it returns to the normal task queue.

This applies to changes on the same URL or entity. If you updated `/products/personalised-gifts`, Blueprint will not block a meta description change on `/products/engraved-jewellery` — they are different pages with independent measurement windows.

---

## The Principle Behind the Windows

The measurement windows are not arbitrary — they reflect how each type of change propagates through the systems that measure it.

**Meta descriptions** change the snippet that appears in Google search results. Google typically re-crawls frequently-updated pages within a few days. CTR data in GSC accumulates over 7-day rolling windows. Meaningful sample size for CTR comparison requires 2–3 weeks of data. Hence: min 7d, expected 21d.

**New landing pages** must be discovered by Google's crawler, indexed, evaluated for ranking potential, tested in search results, and then position data must accumulate enough impressions to measure reliably. This is a multi-step process with each step introducing delay. Hence: min 21d, expected 56d.

**Backlinks** affect domain authority signals, which Google re-evaluates periodically across its full index. These are among the slowest-moving signals in SEO — a new high-quality backlink may not reflect in measurable domain authority improvement for 60–90 days. Hence: min 30d, expected 90d.

**Code deployments** can affect PageSpeed and user behaviour metrics within hours for already-indexed pages, but search ranking effects (if any) take longer to propagate. Hence: min 0d for direct metrics, but 3–14 days for search-related effects.

---

## How Blueprint Uses This in Practice

When Conductor or any agent proposes a task, the system calls `checkRestraint()` before creating the task. If a matching entry exists in `action_memory` with a `do_not_touch_until` timestamp in the future, the task is blocked and queued for later.

When a metric changes and an agent tries to attribute it, the system looks back through `action_memory` for entries in the relevant category (e.g., `meta_update` for a CTR change) and checks whether the elapsed time falls within the expected window. If it does, that action is flagged as the likely cause with a confidence score.

See [Causal Attribution](/brain/causal-attribution) for how the attribution confidence score is calculated.
