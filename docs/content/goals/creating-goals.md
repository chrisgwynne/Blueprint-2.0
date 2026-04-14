---
title: "Creating Goals"
description: "How to create and configure goals in Blueprint"
section: "Goals"
order: 2
---

# Creating Goals

## How to create a goal

Navigate to **Goals → New Goal**. Fill in the following fields:

**Title** — a short, clear name for the goal. This appears in agent context and task proposals, so make it specific: "Reach 1,000 organic sessions/week" is better than "Improve SEO".

**Description** — optional but recommended. Add any relevant context: what is driving this goal, what constraints exist, what you have already tried. Agents use this when reasoning about how to help.

**Target metric** — choose from the metrics available from your connected connectors (e.g., `ga4.organic_sessions`, `shopify.monthly_revenue`, `pagespeed.mobile_score`) or enter a custom metric name. If the metric is not yet connected, Blueprint will tell you which connector is needed.

**Target value** — the number you want to reach.

**Deadline** — the date by which you want to reach the target.

Once you save, Blueprint begins the goal setup process immediately.

## What Blueprint does after you save

### 1. Goal reasoning pass

Blueprint runs an LLM analysis of the goal using your current connector data. This takes a few seconds. The result is displayed on the goal detail page:

- **Feasibility** (likely / possible / unlikely) — based on your current metric value, historical rate of change, and the gap to the target
- **Suggested strategy** — the recommended approach. For a revenue goal, this might be "focus on AOV improvement and reduce cart abandonment" rather than "acquire more traffic"
- **Required connectors** — which connectors need to be active to measure and influence this goal. If any are missing, Blueprint shows a setup prompt
- **Estimated effort** — a rough indication of what achieving the goal will require

If feasibility is "unlikely", Blueprint explains what would need to change: extend the deadline, raise the available budget, address a blocking technical issue. It will not just mark the goal as active and ignore the constraint.

### 2. Milestone generation

Blueprint automatically generates intermediate milestones between your current value and the target. For example:

- Goal: £50k MRR by December, current: £32k
- Milestones: £35k (4 weeks), £40k (8 weeks), £45k (12 weeks), £50k (16 weeks)

You can edit milestone values and dates after they are generated. Blueprint recalculates trajectory based on your adjustments.

### 3. Agent connection

Blueprint identifies which agents are relevant to this goal based on the target metric type and assigns the goal as context for their runs. A revenue goal connects to agents that affect Shopify metrics. A PageSpeed goal connects to agents that handle performance and technical SEO.

Connected agents appear in the "Agents working on this goal" section of the goal detail page.

### 4. Progress tracking

From this point, Blueprint updates the goal's current value on every relevant connector sync. Trajectory is recalculated each time. If the trajectory shifts from "on track" to "at risk", Blueprint surfaces this in the Goals view and increases task priority for work linked to this goal.

## Editing a goal

You can edit the target value, deadline, and description at any time from the goal detail page. Blueprint will re-run goal reasoning and regenerate milestones after a significant change (target value or deadline).

Editing a goal does not reset progress or disconnect agents.

## Pausing and archiving goals

**Pause** — temporarily removes the goal from active tracking. Agents will not propose tasks aligned to this goal while it is paused. Progress data is retained.

**Archive** — marks the goal as complete or abandoned. Archived goals are visible in the Goals history view but are not factored into active agent runs.

## Tips for effective goals

- **One metric per goal** — goals with a single, measurable metric are more useful than composite goals. If you have multiple targets, create multiple goals.
- **Connect the right data first** — a goal on a metric that is not yet connected cannot be tracked. Check that your connectors are active before setting targets.
- **Use descriptions** — agents read goal descriptions. Context like "we're launching a new product line in Q3 which will affect revenue numbers" helps agents reason more accurately.
- **Review feasibility honestly** — if Blueprint says "unlikely", take it seriously. Adjust the target or deadline rather than ignoring the assessment.
