---
title: "Goals"
description: "Set targets and let Blueprint work towards them"
section: "Goals"
order: 1
---

# Goals

Goals are business targets you set in Blueprint. Rather than just monitoring what is happening, goals give Blueprint a direction: something to work towards, track progress against, and orient agent activity around.

Examples of goals:

- "Reach £50k MRR by December"
- "Improve mobile PageSpeed score to 90"
- "Get 1,000 organic sessions per week"
- "Reduce checkout bounce rate below 30%"

Blueprint takes a goal, connects it to your live connector data, reasons about feasibility, and begins directing relevant agents toward it.

## Goal components

Every goal has these fields:

| Field | Description |
|-------|-------------|
| **Metric** | What you are measuring — pulled from a connected connector or entered as a custom metric |
| **Target value** | The number you want to reach |
| **Deadline** | When you want to reach it by |
| **Current value** | Pulled live from your connectors on each sync |
| **Trajectory** | Blueprint's assessment of whether you are on track, ahead, or behind |

Current value and trajectory update automatically on every connector sync — you do not need to update them manually.

## How Blueprint uses goals

Goals are not passive. Once a goal is set, Blueprint:

1. **Reasons about feasibility** — runs an LLM analysis to assess whether the target is achievable by the deadline given current data
2. **Decomposes into milestones** — breaks the journey from current value to target into measurable checkpoints
3. **Connects relevant agents** — identifies which agents can contribute to the goal and adds the goal as context for their runs
4. **Proposes aligned tasks** — agent task proposals are linked back to the goals they serve, so you can see the chain from action to outcome
5. **Tracks progress** — on each sync, updates the current value, recalculates trajectory, and marks milestones as on track, at risk, or missed

## Trajectory

Trajectory is Blueprint's answer to "are we going to get there on time?". It is calculated by comparing the rate of change in the current metric to what is needed to hit the target by the deadline.

| Trajectory | Meaning |
|------------|---------|
| On track | Current rate of change is sufficient to hit the target by the deadline |
| At risk | Progress is slower than needed — intervention likely required |
| Behind | Significantly off pace — the goal may not be achievable without a strategic change |

If a goal is marked "at risk" or "behind", Blueprint increases the priority of agent tasks linked to that goal and surfaces the gap prominently in the Goals view.

## Goal reasoning

When you create a goal, Blueprint runs a goal reasoning pass — an LLM analysis of the goal given your connected data. The result includes:

- **Feasibility** — likely / possible / unlikely
- **Suggested strategy** — the recommended approach for reaching the target
- **Required connectors** — which data sources are needed to measure and influence this goal
- **Estimated effort** — a rough guide to what achieving the goal will require

If feasibility comes back as "unlikely", Blueprint tells you honestly and explains what would need to change. This might mean extending the deadline, adjusting the target, or addressing a blocking constraint. Blueprint will never silently hide a goal that is unrealistic.

## Goals and agents

Agents can be configured to run in the context of a specific goal. When an agent runs with a goal in scope, its task proposals are oriented toward the goal metric and deadline — not just toward resolving the current signal.

For example, an SEO agent running in the context of "1,000 organic sessions/week" will prioritise keyword opportunities with higher traffic potential over minor technical fixes, because the goal context shifts its priorities.

This is what makes Blueprint different from a simple alert system: agents reason about where you want to go, not just what is wrong right now.
