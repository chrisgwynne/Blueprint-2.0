---
title: "Restraint System"
description: "How Blueprint prevents acting on areas still being measured"
section: "The Brain"
order: 3
---

# Restraint System

The restraint system enforces a simple rule: **don't change things before measuring them.**

In plain English: "We changed the meta description 8 days ago. The measurement window is 21 days. Don't change it again for 13 more days."

---

## The Problem It Solves

Without restraint, agents can propose actions that overwrite their own previous work before any measurement is possible. A human can do the same — approve a meta description rewrite on Monday, then approve another one on Friday because "the data didn't improve yet." Seven days is not enough time to measure a meta description change. The second change destroys the clean signal from the first.

The restraint system makes it impossible to accidentally contaminate your own data. It is not a warning — it is a hard block at the task creation level. Blocked tasks are deferred, not discarded.

---

## How It Works Technically

Every time a task is completed (status changes to `done`), Blueprint writes an entry to the `action_memory` table:

```
action_type:          meta_update
target:               /products/personalised-gifts
completed_at:         2026-04-08T14:23:00Z
measurement_window:   21 days
do_not_touch_until:   2026-04-29T14:23:00Z
```

The `target` field is the URL, product ID, keyword, or entity the action affected. The `do_not_touch_until` timestamp is calculated by adding the expected measurement window to the completion time.

Before any new task is created, `checkRestraint()` queries `action_memory`. The query checks:
- Does an entry exist with the same `action_type` and the same `target`?
- Is the `do_not_touch_until` timestamp in the future?

If both conditions are true, the new task is blocked.

---

## Deferred Tasks

Blocked tasks do not disappear. They are placed into a deferred queue with a `retry_after` date set to the `do_not_touch_until` timestamp.

Every day, Blueprint runs a brain pass that checks all deferred tasks. When a task's `retry_after` date has passed, it is moved from the deferred queue back into the standard task queue. It appears in the task list with a "Deferred — now ready" label so you know it was waiting.

You can view all deferred tasks at **Tasks → Deferred**. Each entry shows the original task description, the action that blocked it, and the date it will become available.

---

## The Override

Sometimes you have a legitimate reason to act before the window closes. You found an error in the copy you changed. A critical brand event changed the context entirely. The measurement window is a default, not a law.

To override: go to **Settings → Brain → Deferred Tasks**, find the task, and click **Override**. You will be asked to enter a reason. Blueprint logs the override with your reason, the timestamp, and the task that was unblocked.

**Why it asks for a reason:** the override log is part of your attribution record. If the metric changes in an unexpected way after an override, you want to know that an out-of-window change was made. The reason field forces a moment of deliberate thought and creates a paper trail.

> [!WARNING]
> If you override constantly, the attribution system breaks down. Blueprint's causal attribution compares "what changed" against measurement windows. An override means there are two changes to the same area within one window — Blueprint cannot cleanly attribute the metric change to either one. Use override only when you have a reason, not when you are impatient.

---

## What Gets Restrained

The restraint system applies to any completed task that modifies a specific URL, entity, or resource. The most common cases:

| Action Type | What Is Restrained | Window |
|-------------|-------------------|--------|
| `meta_update` | The specific URL whose meta was changed | 21 days |
| `content_draft` | The URL or new page path | 56 days |
| `github_pr` | The repository (or specific file path, if scoped) | 3 days |
| `shopify_description` | The specific product ID | 14 days |
| `new_page` | The new page URL | 56 days |
| `backlink` | The target domain | 90 days |
| `ad_campaign` | The specific campaign ID | 14 days |
| `social_post` | The platform + account | 7 days |
| `email_campaign` | The list segment | 7 days |

The restraint is scoped to the specific target. Changing the meta description for `/products/a` does not block a change to `/products/b`. Two different Shopify products have independent windows.

---

## Why This Matters for the System Getting Smarter

Blueprint's causal attribution only works if measurement windows are respected. If you change a page's meta description, see CTR improve 3 weeks later, and Blueprint correctly attributes that improvement to the meta change — that learning is recorded and used in future decisions.

But if the window is broken (two changes within 21 days), Blueprint cannot make the attribution. The learning never accumulates. The system's confidence in future recommendations for that action type stays lower than it should be.

The restraint system is not just preventing individual mistakes. It is maintaining the data quality that makes every future recommendation more accurate. Every clean measurement window is an investment in better future decisions.
