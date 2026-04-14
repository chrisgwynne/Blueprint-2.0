---
title: "Todoist"
description: "Connect Todoist to track task completion rates and overdue task trends in Blueprint."
section: "Connectors"
order: 21
---

# Todoist

The Todoist connector pulls task counts, completion rates, overdue backlogs, and project distributions from the Todoist REST API. It syncs every hour and provides Blueprint with a ground-truth signal about whether work is actually getting done — including tasks proposed by Blueprint agents.

---

## Setup

### 1. Get your Todoist personal API token

1. Log in to [todoist.com](https://todoist.com).
2. Click your avatar in the top-right corner and go to **Settings → Integrations → Developer**.
3. Your API token is displayed under **API token**. Copy it.

> [!NOTE]
> The Todoist personal API token gives access to all tasks and projects in your account. Blueprint only reads task data — it does not create, modify, or delete tasks via this connector. (Task write-back is done through the agent task system, not directly via this connector.)

### 2. Add the connector in Blueprint

Go to **Connectors → Add → Todoist** and paste the API token. Click **Connect**. Blueprint verifies the token and returns a summary of your project count and total task count.

---

## Data pulled

Each sync fetches all active tasks, recently completed tasks (last 7 days and 30 days), and project-level distributions.

| Data | Description |
|---|---|
| Active tasks | All currently open tasks across all projects |
| Overdue tasks | Tasks past their due date |
| Completed tasks (7d) | Tasks completed in the last 7 days |
| Completed tasks (30d) | Tasks completed in the last 30 days |
| Tasks created (7d) | New tasks created in the last 7 days |
| Project breakdown | Task counts per project |

**Update frequency:** every 1 hour.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `todoist.overdue_count` | Total overdue tasks right now |
| `todoist.active_count` | Total active (non-completed) tasks |
| `todoist.completed_7d` | Tasks completed in the last 7 days |
| `todoist.completed_30d` | Tasks completed in the last 30 days |
| `todoist.created_7d` | Tasks created in the last 7 days |
| `todoist.completion_rate_7d` | Completion rate for the last 7 days (completed / created) |
| `todoist.completion_rate_30d` | Completion rate for the last 30 days |
| `todoist.created_vs_completed_delta` | Net task accumulation (created minus completed, last 7 days) |
| `todoist.project_data` | Rich data — per-project task counts |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `todoist_overdue_spike` | warning | Overdue task count exceeds 20 and is growing vs the previous sync |
| `todoist_completion_drop` | warning | Weekly completion rate drops >30% vs the previous week |

> [!TIP]
> The `todoist_overdue_spike` signal uses both an absolute threshold (>20 overdue) and a growth condition (overdue count must be higher than the previous reading). This prevents the signal from firing persistently if you have a stable backlog — it only fires when things are actively getting worse.

---

## Blueprint agent calibration

A key purpose of the Todoist connector is to help Blueprint calibrate its agent output volume. Blueprint tracks which tasks it proposes through the task system and checks whether similar tasks are being completed in Todoist.

If `todoist_completion_drop` fires persistently while Blueprint continues generating new agent tasks, the Conductor agent will reduce task generation frequency. This prevents Blueprint from becoming a task-flooding system.

> [!NOTE]
> This calibration is heuristic and does not require tasks to be explicitly linked between Blueprint and Todoist. The completion rate acts as a general health signal for whether the user is in a position to absorb more AI-proposed work.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Conductor | Uses completion rate data to modulate how many agent tasks are proposed |

---

## Troubleshooting

**API token rejected**

Personal API tokens do not expire but can be regenerated. If you have recently regenerated your token in Todoist, update the connector in Blueprint with the new token at **Connectors → Todoist → Edit**.

**Completed tasks not appearing**

Todoist's REST API v2 returns recently completed tasks via the activity log endpoint. If this returns empty results, check that your account is on the **Pro** plan — free accounts have limited activity log history via the API.

**Overdue count is much higher than expected**

Blueprint counts all tasks with a due date in the past as overdue, including recurring tasks whose due date has passed. If you use recurring tasks heavily, the overdue count may be inflated by tasks that are "in progress" but not yet checked off. This is a known limitation of the Todoist API — there is no distinction between an unstarted overdue task and one being actively worked on.

**Completion rate metric is zero**

If no tasks were created in the measurement window (7 days), the completion rate is calculated as 0 to avoid division by zero. This is expected if you have not added any tasks recently — it does not indicate a data error.
