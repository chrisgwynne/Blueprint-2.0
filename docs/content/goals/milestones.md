---
title: "Milestones"
description: "How Blueprint breaks goals into measurable checkpoints"
section: "Goals"
order: 3
---

# Milestones

Milestones are intermediate checkpoints on the path from your current value to your goal target. They break a large target into a sequence of smaller, verifiable progress markers — and give Blueprint a way to identify when you are falling behind early, rather than discovering it at the deadline.

## How milestones are generated

When you create a goal, Blueprint automatically generates milestones based on the gap between your current value and the target, distributed across the time to the deadline.

Example:

| Goal | Current | Target | Deadline | Generated milestones |
|------|---------|--------|----------|--------------------|
| Monthly revenue | £32,000 | £50,000 | 16 weeks | £35k (wk 4), £40k (wk 8), £45k (wk 12), £50k (wk 16) |
| Organic sessions/week | 420 | 1,000 | 12 weeks | 580 (wk 4), 740 (wk 8), 870 (wk 10), 1000 (wk 12) |
| PageSpeed mobile score | 54 | 90 | 8 weeks | 62 (wk 2), 70 (wk 4), 80 (wk 6), 90 (wk 8) |

The spacing is not always linear — Blueprint adjusts for realistic acceleration curves where the metric type warrants it (SEO metrics typically compound, PageSpeed scores have diminishing returns near 100, etc.).

## Milestone status

Each milestone has one of three statuses, updated on every relevant connector sync:

| Status | Meaning |
|--------|---------|
| **On track** | Current value and rate of change indicate this milestone will be reached by its due date |
| **At risk** | Progress is slower than needed — the milestone may be missed if the current rate continues |
| **Missed** | The milestone's due date has passed and the value did not reach the checkpoint |

A missed milestone does not mean the overall goal is failed — it means you are behind pace and need to accelerate. Blueprint will surface this in the Goals view and increase the priority of related agent tasks.

## Editing milestones

You can edit any milestone's target value or due date from the goal detail page. Click the milestone to open the editor.

After you save changes to a milestone, Blueprint recalculates trajectory for the overall goal based on the updated checkpoint. Other milestones are not automatically adjusted — you can edit them individually if needed.

Reasons to edit milestones:

- The initial spacing does not match your team's working rhythm (e.g., you prefer monthly checkpoints)
- External events have changed what is realistic in a particular window (e.g., a seasonal dip is expected)
- You want to add a milestone that was not auto-generated (e.g., a specific campaign date)

## Adding milestones manually

Click **Add Milestone** in the milestone timeline on the goal detail page. Set a target value and due date. Blueprint incorporates the new checkpoint into trajectory calculations immediately.

## Milestone notifications

When a milestone status changes — particularly when a milestone moves from "on track" to "at risk" — Blueprint logs the change in the goal history. If Telegram notifications are configured, you receive an alert.

This early warning is the main reason milestones exist: catching trajectory problems weeks before the final deadline, while there is still time to act.

## Milestones and agent behaviour

When a milestone is "at risk", Blueprint increases the priority weighting of tasks linked to the parent goal. Agents running in the context of that goal will:

- Prioritise higher-impact actions over incremental improvements
- Flag the risk explicitly in their task proposal descriptions
- Propose p1 or p2 priority tasks rather than p3

This means Blueprint responds to milestone risk automatically — you do not need to manually re-prioritise every time trajectory slips.
