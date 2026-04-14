---
title: "Approval Flow"
description: "How to review and approve agent task proposals"
section: "Tasks"
order: 2
---

# Approval Flow

The approval flow is how you stay in control of what Blueprint does. Agents propose — you decide. This page covers the approval interface, the available actions, and the options for timed and bulk approval.

## The Tasks page

The Tasks page shows all pending task proposals organised in a Kanban board by status. The **Proposed** column is where new tasks land and where your attention belongs.

Each task card shows:
- Task title
- The agent that proposed it
- Confidence score (0–1, displayed as a percentage)
- Action type (investigation, write_back, content_brief, etc.)
- Priority (p1–p4)
- The signal or goal that triggered it (if applicable)

Cards are ordered by priority within each column (p1 at top). Drag to reorder within a column if you want to adjust the sequence.

## Reviewing a task

Click any task card to open the full detail view. This shows:

- **Full description** — the agent's complete explanation of what it wants to do and why
- **Reasoning** — the evidence and signal data that led to this proposal
- **What will change** — for write-back tasks, an exact preview of the content that will be written
- **Confidence and source** — how confident the agent is and what it is based on
- **Linked signal or goal** — the context that triggered this task

Read the description and reasoning before acting. The reasoning section is where the agent explains its logic — if it doesn't make sense, reject and note why so the agent can be improved.

## Available actions

### Approve

Moves the task to **In Progress** and triggers execution (for write-back tasks) or marks it ready for the agent to begin work (for investigation, brief, etc.).

For write-back tasks, execution begins immediately on approval. Review the "what will change" section carefully before approving.

### Defer

Snooze the task for a set period. Choose from: 1 day, 3 days, 7 days, 14 days, or 30 days.

The task disappears from the proposed queue and reappears at the chosen time. Use defer when the task is valid but the timing is wrong — for example, deferring a content brief until after a product launch.

Deferred tasks do not re-trigger agents. The original proposal resurfaces; the agent does not re-evaluate from scratch.

### Reject

Removes the task from the queue permanently. The agent will not re-propose the same task in the next run cycle.

Use reject when:
- The proposal is wrong or based on a misunderstanding
- You have already handled this manually
- The action is not appropriate for your business

Rejecting feeds into the restraint system. Repeated rejections of proposals from the same agent on the same signal type will reduce that agent's confidence score for that signal in future runs.

### Edit + Approve

Opens the task editor, allowing you to modify the title, description, metadata, or write-back content before approving. Once you save the edit, the task is approved and execution proceeds with your modified version.

Use Edit + Approve when:
- The proposal is mostly right but needs a small adjustment
- You want to refine the copy before a write-back executes
- The priority or action type needs changing

## Timed approvals

Tasks with a time-sensitive window can have an auto-approve deadline. This is set in the task metadata when the agent proposes it — typically for tasks like "publish this announcement before the sale ends" or "apply this fix before the crawl budget resets".

If the task has an auto-approve deadline:
- A countdown timer appears on the task card
- If the deadline passes and you have not acted, the task auto-approves **only if** the trust tier is green
- Yellow-tier tasks never auto-approve regardless of deadline — the deadline is informational only

To set a timed approval manually, open the task detail view and use the "Set deadline" option.

## Bulk approval

To approve multiple tasks at once:

1. Select tasks using the checkbox on each card (or "Select all" in the column header)
2. Click **Approve All** in the selection toolbar

Use bulk approval after reviewing an agent's batch output — for example, when an agent has proposed a set of meta edits across multiple pages after a `ctr_below_threshold` signal. Review each card individually first, then bulk approve the ones you're comfortable with.

Bulk approval respects trust tiers. Yellow-tier tasks in a bulk approval still execute after your approval. If a red-tier task is included in a selection, it is skipped automatically and flagged for individual review.

## Notification when tasks arrive

If Telegram notifications are configured, you receive a message when new tasks enter the proposed queue. The message includes the task title, agent, priority, and a direct link to the task in Blueprint.

See the Telegram Notifications page for setup instructions.
