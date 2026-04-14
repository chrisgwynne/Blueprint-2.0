---
title: "Tasks"
description: "How Blueprint proposes, approves, and executes actions"
section: "Tasks"
order: 1
---

# Tasks

Tasks are action proposals from Blueprint's agents. When an agent analyses a signal or a goal and determines that something should be done, it creates a task. That task enters your queue for review, approval, and execution.

Blueprint does not take action without your knowledge. Every task is visible, and unless you have explicitly set an agent to green trust tier, nothing executes without your approval.

## What a task contains

Each task has the following fields:

| Field | Description |
|-------|-------------|
| `title` | Short description of what the task is |
| `description` | Full explanation of the reasoning, context, and what will be done |
| `action_type` | The category of action (see below) |
| `priority` | p1–p4 indicating urgency |
| `trust_tier` | green / yellow / red — determines if it auto-executes |
| `confidence` | 0–1 score representing how confident the agent is in this proposal |
| `proposed_by` | The agent ID that created this task |
| `metadata` | Additional structured data relevant to the task (signal data, target URLs, etc.) |

## Action types

| Action type | What it means |
|-------------|---------------|
| `investigation` | Research a question and return findings. No external changes. |
| `content_brief` | Produce a brief for new content (blog post, landing page, product copy). |
| `meta_edit` | Propose changes to page title, meta description, or heading. |
| `notification` | Send an alert or report to a specified channel or person. |
| `strategic_review` | High-level analysis requiring human judgement. Always red tier. |
| `write_back` | Execute a change in an external service (Shopify, WordPress, GBP, GitHub). |

## Priority levels

| Level | Meaning | Expected response time |
|-------|---------|----------------------|
| p1 | Critical — something is broken or a major opportunity is closing | Today |
| p2 | Important — meaningful impact, should not be deferred long | This week |
| p3 | Normal — standard priority work | This sprint/fortnight |
| p4 | Nice to have — low urgency, do when capacity allows | No deadline |

Priority is set by the proposing agent based on signal severity and business context.

## Task lifecycle

```
proposed → approved → in_progress → complete → outcome measured
```

**Proposed** — the task is in your queue, waiting for a decision. No action has been taken.

**Approved** — you have approved the task (or it was auto-approved by green tier). If it involves a write-back, execution begins immediately. If it is an investigation or brief, the agent starts working.

**In progress** — the task is actively being executed by an agent or write-back action.

**Complete** — the task has finished. The result is recorded in the task detail view.

**Outcome measured** — Blueprint's brain layer records the result in `action_memory`. This feeds the restraint system, which tracks how often an agent's proposals lead to positive outcomes, and adjusts agent confidence over time.

## The Kanban board

The Tasks page displays tasks in a Kanban layout with columns for each status stage. Tasks move right as they progress through the lifecycle.

Within each column, tasks are ordered by priority (p1 at top). You can drag to reorder tasks within a column if you want to adjust the sequence.

Click any task card to open the full detail view, which shows the complete description, the agent's reasoning, any attached signal data, and the available actions (Approve, Defer, Reject, Edit + Approve).

## How tasks relate to signals and goals

Most tasks are proposed in response to a signal or a goal milestone. The task detail view shows which signal triggered it (if any) and which goal it is aligned with (if any). This traceability means you can always understand why a task exists and what business outcome it is expected to contribute to.
