---
title: "Signals"
description: "How Blueprint detects and surfaces important business events"
section: "Signals"
order: 1
---

# Signals

Signals are automatically detected events that Blueprint surfaces from your connected data. Rather than asking you to monitor dashboards, Blueprint watches your data continuously and tells you when something meaningful happens.

Examples of signals:
- "GSC clicks dropped 15% week-over-week"
- "Shopify has had no orders today when yesterday had 12"
- "Keyword 'your main term' dropped 7 positions since last week"
- "LCP on mobile is now 4,800ms — above the failing threshold"
- "PageSpeed score dropped from 82 to 71"

Signals are not alerts you configure manually. They are the output of the signal engine running rules against your live data after every connector sync.

## Signal lifecycle

Every signal moves through a defined set of states:

```
created by signal engine → open → acknowledged → resolved
```

**Open** — the signal has been detected and needs attention. Open signals appear at the top of the Signals view and are factored into agent prioritisation.

**Acknowledged** — you (or an agent) has seen the signal and is working on it. The issue may not yet be resolved, but it is being tracked. Acknowledging a signal removes it from the urgent queue without hiding it.

**Resolved** — the underlying issue has been fixed or the signal is no longer relevant. Blueprint also auto-resolves signals when subsequent connector syncs show the condition is no longer true (e.g., traffic recovers, ranking improves).

## Severity levels

Each signal has a severity that indicates how urgently it needs attention.

| Severity | Meaning | Example |
|----------|---------|---------|
| **info** | Something worth knowing — an opportunity or a positive trend | Traffic spike, keyword surge |
| **warning** | Something to watch — deteriorating but not yet critical | Ranking drop, bounce rate increase |
| **alert** | Requires action — a meaningful negative event or failure | No Shopify orders, PageSpeed regression, conversion drop |

Severity is defined per rule in the signal engine. It does not change based on how long a signal has been open.

## The signal engine

The signal engine is the component that produces signals. It runs automatically after every connector sync.

Here is what happens on each run:

1. The connector finishes syncing and writes current data to the database.
2. The signal engine is triggered for that connector type.
3. It loads the current data snapshot and the previous snapshot.
4. It evaluates all rules that apply to that connector type.
5. For each rule that triggers, it checks whether an identical open signal already exists (deduplication).
6. If no duplicate exists, it creates a new signal record with title, description, severity, confidence score, and the raw signal data.
7. The signal appears in the Signals view and is available for agents to act on.

The signal engine does not create duplicate signals. If a rule already has an open signal for the same business and connector, it will not create another one until the first is resolved.

## How agents use signals

Signals are the primary input for Blueprint's agents. When the Conductor (the orchestration layer) runs, it looks at all open signals and matches them to agents based on each agent's `signal_triggers` field in its YAML profile.

For example, an SEO agent might have:

```yaml
signal_triggers:
  - ranking_drop_keyword
  - organic_traffic_drop
  - ctr_below_threshold
```

When one of those signal types is open, the Conductor schedules that agent to run with the signal as context. The agent then analyses the situation and proposes tasks.

This means you do not need to manually assign work. Signals flow automatically from data → signal engine → agent → task proposal → your approval queue.

## Viewing signals

The Signals page shows all signals grouped by status. You can filter by severity, connector type, or status. Each signal card shows:

- The signal title and description
- The connector and rule that generated it
- When it was created
- Current status and severity
- Which agent (if any) is handling it

Clicking a signal opens the detail view, where you can acknowledge it, mark it resolved, or see the associated tasks that have been proposed in response to it.
