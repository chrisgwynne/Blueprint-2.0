---
title: "Action Windows"
description: "How Blueprint enforces minimum measurement periods before allowing the same action to be repeated on the same target"
section: "The Brain"
order: 4
---

# Action Windows

Blueprint enforces **action windows** — minimum time periods that must pass before the same type of action can be repeated on the same target. This prevents agents (and humans) from overwriting their own changes before those changes have had time to produce measurable results.

Without action windows, you might rewrite a product description today, see conversion rate dip two days later, and rewrite it again immediately — before anyone knows whether the first change helped or hurt. The second rewrite destroys the measurement signal from the first. Action windows prevent that from happening.

---

## The Window Table

Each action type has three window values:

- **min_days** — the absolute minimum before a repeat action is allowed (hard block)
- **expected_days** — the recommended measurement period (shown in the UI)
- **max_days** — the outer bound used by the attribution engine when assessing causal relationships

| Action Type | Display Name | Min Days | Expected Days | Max Days |
|-------------|--------------|----------|---------------|----------|
| `meta_update` | Meta title/description change | 7 | 21 | 42 |
| `shopify_description_update` | Product description rewrite | 7 | 14 | 28 |
| `shopify_page_create` | New landing page | 21 | 56 | 112 |
| `shopify_meta_update` | Shopify SEO title/description | 7 | 21 | 42 |
| `shopify_collection_update` | Collection page update | 14 | 28 | 56 |
| `content_draft` | New content / blog post | 28 | 56 | 120 |
| `github_pr` | Code change / deployment | 0 | 3 | 14 |
| `meta-ads-change` | Meta Ads campaign change | 3 | 7 | 21 |
| `gbp_post` | Google Business Profile post | 1 | 7 | 28 |

> [!NOTE]
> The `min_days` column is the enforcement threshold — the hard block. `expected_days` is what Blueprint recommends waiting before drawing conclusions. For example, a meta description change has a 7-day hard block (Blueprint won't allow another change for at least a week) but a 21-day expected window (the recommended time before assessing whether the change improved CTR).

---

## Why Each Window Is Set the Way It Is

### Meta title and description (`meta_update`, `shopify_meta_update`)

Google recrawls pages on its own schedule. CTR changes appear in Google Search Console only after the page has been recrawled and served with the new title or description enough times to accumulate impression volume. On active pages this can happen within a few days; on low-traffic pages it can take 4–6 weeks. The 21-day expected window covers the most common case.

### Product description (`shopify_description_update`)

Conversion rate changes are visible relatively quickly — within 1–2 weeks — but require a minimum number of sessions to the page to be statistically meaningful. The 14-day expected window provides enough traffic for most product pages. High-traffic pages will converge faster.

### New landing pages and blog posts (`shopify_page_create`, `content_draft`)

New pages take time to be discovered, crawled, indexed, and ranked. Expect 4–8 weeks before meaningful ranking signals appear, and up to 4 months for competitive keywords. Evaluating a new page's performance at 10 days tells you almost nothing. The 56-day expected window is the minimum useful evaluation horizon.

### Code changes (`github_pr`)

PageSpeed and Core Web Vitals data updates immediately after a deployment. However, user behaviour metrics (bounce rate, session duration) need 1–2 weeks of data to reflect statistically significant change. The 3-day expected window covers the immediate technical signal; the 14-day max covers the behavioural data.

### Meta Ads (`meta-ads-change`)

Meta's algorithm requires a "learning period" — typically 50 conversions or 7 days, whichever comes first. Changing an ad campaign during the learning phase resets the algorithm's progress. The 7-day expected window maps to this learning period minimum.

> [!WARNING]
> Making changes to a Meta Ads campaign before the 7-day expected window closes resets Meta's algorithm learning. This is not just a Blueprint rule — it is a Meta platform behaviour. The action window enforces the same boundary the platform requires.

---

## How Enforcement Works

When a task reaches `done` status, Blueprint calls `recordActionMemory()` in `server/brain/action-windows.js`. This writes a row to the `action_memory` table:

```
action_type:            meta_update
target_url:             /products/personalised-mug
measurement_window_start: 2026-04-01T09:00:00Z
do_not_touch_until:       2026-04-08T09:00:00Z   ← min_days after completion
measurement_window_end:   2026-04-22T09:00:00Z   ← expected_days after completion
```

Before any new task is created, Blueprint calls `checkRestraint()` in `server/brain/restraint.js`. This queries `action_memory` for any open windows that match the proposed task's `action_type` and `target_url`. If a matching open window exists, the task is blocked.

The check looks for:
1. Same `action_type` and same `target_url` (same page or entity), **and**
2. `do_not_touch_until` is still in the future

If both are true, the new task is deferred rather than created.

---

## Deferred Tasks

Blocked tasks are not discarded. They are placed in the deferred queue with a `retry_after` date equal to `do_not_touch_until`. Every day, Blueprint runs a pass that promotes deferred tasks whose `retry_after` has passed back into the main task queue.

You can view all deferred tasks at **Tasks → Deferred**. Each entry shows:

- The task description
- Which completed action blocked it
- The date the block lifts (the `do_not_touch_until` timestamp)
- A countdown showing how many days remain

When a deferred task re-enters the main queue, it appears with a **"Deferred — now ready"** label so you know it was waiting.

---

## Override

Sometimes you have a legitimate reason to act before the window closes — a critical error in the copy you changed, a brand emergency, or a structural change to the business that makes the previous measurement irrelevant.

To override: go to **Tasks → Deferred**, find the task, and click **Override**. Blueprint will prompt you to enter a reason. This reason, the timestamp, and the task are recorded in the override audit log.

> [!WARNING]
> If you override action windows frequently, Blueprint's causal attribution degrades. Attribution works by comparing "what changed" against known measurement windows. An override means two changes were applied within one window — Blueprint cannot cleanly attribute a subsequent metric movement to either one. Use override only when you have a specific reason, not when you are impatient.

---

## Action Windows and Attribution

The `measurement_window_end` timestamp is used by `server/brain/causal.js` when assessing whether a metric change is likely attributable to a completed action. An action is only considered a candidate cause for a metric movement if:

1. The action completed before the metric movement was detected
2. The metric movement falls within the action's measurement window (`measurement_window_start` to `measurement_window_end`)
3. No other action of the same type was taken on the same target within the window (no confounding)

When a window closes (`measurement_window_end` passes), Blueprint marks the `action_memory` row as `measurement_ready = 1`. The attribution engine then runs a retrospective assessment of that action: did the relevant metrics move in the expected direction? This feeds back into the agent's confidence calibration for future proposals of the same action type.

---

## Customising Windows

Action window durations are seeded into the `action_windows` table on first run. You can edit them directly via the database if your business has specific measurement requirements:

```bash
bun --eval "
import db from './server/db/db.js';
db.prepare(\`
  UPDATE action_windows
  SET expected_days = 28
  WHERE action_type = 'shopify_description_update'
\`).run();
console.log('Updated');
"
```

> [!TIP]
> If you have high-traffic product pages where conversion data accumulates quickly, reducing `expected_days` for `shopify_description_update` from 14 to 7 is reasonable. If you have low-traffic pages, consider increasing it. The defaults are calibrated for medium-traffic businesses.
