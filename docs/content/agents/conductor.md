---
title: "Conductor"
description: "The strategic orchestration agent that coordinates all other agents"
section: "Agents"
order: 2
---

# Conductor

Conductor is the brain's executor — the only agent in Blueprint that is always running and cannot be paused. It runs every hour. While every other agent monitors a specific domain (search, content, revenue, performance), Conductor watches everything, looks for patterns that cross channel boundaries, and decides what actually matters right now.

## What Conductor Does

**Reads all open signals.** On every run, Conductor pulls the current open signal list and checks whether any signals from different agents are pointing at the same underlying problem. A traffic drop that SEO Sentinel flagged alongside a revenue drop that Ledger flagged is a different situation than each signal in isolation — Conductor is the agent that sees them together.

**Runs due scheduled jobs for all agents.** Conductor checks which agents are scheduled to run and dispatches those runs. It also tracks per-agent daily spend against cost caps and pauses lower-priority agents if the total daily budget is approaching its ceiling.

**Runs signal clustering.** When multiple signals fire at once, Conductor groups them by likely root cause before routing work. This prevents three different agents from each proposing a task for the same underlying issue.

**Cross-channel analysis.** Conductor correlates data across all connected sources. An organic traffic drop coinciding with a conversion rate drop on mobile suggests a different cause than one where traffic holds but bounce rate increases. Conductor surfaces the correlation, not just the individual metrics.

**Proposes strategic tasks.** After its analysis, Conductor produces a short list of prioritised proposals — never more than five per run, usually one to three. It deliberately does not produce comprehensive lists; a 10-item todo is not a strategy.

**Morning briefing (weekdays 08:00).** On weekdays, Conductor sends a plain-language brief to configured notification channels covering: the single most important thing to focus on today, any P1 signals that need immediate attention, and a one-line status for each active agent.

**Weekly strategy review (Mondays 09:00).** Conductor produces a weekly brief comparing key metrics to the prior week, naming the top three priorities for the week, and updating each agent's context with relevant findings.

---

## Schedule

| Job | Cron | Description |
|-----|------|-------------|
| Hourly orchestration | `0 * * * *` | Signal review, agent routing, cross-channel correlation |
| Morning briefing | `0 8 * * 1-5` | Weekday morning situation report |
| Weekly strategy review | `0 9 * * 1` | Monday morning weekly priorities |

Conductor also runs reactively — immediately when a P1/critical signal fires from any agent, when three or more agents propose conflicting tasks, or when the pending task queue exceeds 20 items.

---

## Required and Optional Connectors

**Required:** None. Conductor works regardless of which connectors are active — it reads from whatever is connected.

**Optional:** GSC, GA4, PageSpeed, Shopify, Google Business Profile. Each additional connector gives Conductor more data to correlate.

---

## Signal Triggers

Conductor runs reactively when any of these signals are raised:

- `traffic_drop_7day` — 7-day organic traffic drop across any property
- `revenue_drop` — significant revenue decline detected by Ledger
- `conversion_drop` — conversion rate falling outside normal variance
- `critical_alert` — any P1 signal from any connected agent or monitor

---

## Capabilities

| Category | What Conductor Can Do |
|----------|-----------------------|
| Read | All connected data sources |
| Propose | `investigation`, `content_brief`, `meta_edit`, `notification`, `strategic_review` |
| Write-gated | Shopify, Google Business Profile (requires approval even after yellow approval) |
| Never | Payments, user data |

---

## Trust Tier

**Yellow.** All Conductor proposals require human approval before executing. This is intentional: Conductor's visibility is wide, which means errors propagate widely. The breadth of its access makes it the most consequential agent to get wrong.

---

## LLM Configuration

Conductor defaults to `claude-sonnet-4-20250514` with a daily cost cap of $2.00. This model is chosen for its reasoning quality — Conductor needs to weigh conflicting signals, not just extract data patterns.

```yaml
llm:
  provider: claude-cli
  model: claude-sonnet-4-20250514
  temperature: 0.4
  max_tokens: 4096
  cost_cap_daily_usd: 2.00
```

---

## How Conductor Coordinates Other Agents

**Reading agent briefings.** After every run, each non-Conductor agent appends a structured briefing to `server/agents/conductor/inbox.jsonl`. Conductor reads this file on its next run. The inbox holds the last 50 entries. Each entry records:

```json
{
  "from": "seo-sentinel",
  "business_id": "default",
  "timestamp": "2026-04-14T07:00:00.000Z",
  "summary": "Ranked keyword 'personalised gifts for mum' dropped from position 6 to position 11 over 7 days.",
  "signals_detected": 2,
  "tasks_proposed": 1,
  "reasoning_excerpt": "GSC data for the 7-day period ending 2026-04-13 shows..."
}
```

**Deduplication.** Before proposing any task, Conductor checks the current task queue. If a task addressing the same URL, keyword, or entity is already pending, Conductor does not re-propose it. This prevents duplicate work stacking up while a previous task awaits approval.

**Routing signals to specialist agents.** When Conductor detects a signal that falls within a specialist's domain, it routes the signal to that agent for the next run rather than proposing a task itself. For example: a PageSpeed regression is routed to Velocity (if hired) rather than Conductor attempting to diagnose it.

**Briefing specialist agents.** Before each specialist agent's scheduled run, Conductor can inject additional context — current business priorities, what other agents are working on, any cross-channel signals the specialist should factor in. This context appears in the user-turn message the specialist receives.

---

## What a Typical Conductor Run Looks Like

Below is a representative example of a Conductor JSON response — what Blueprint receives from the LLM and parses into tasks:

```json
{
  "reasoning": "SEO Sentinel briefed a 7-day organic traffic drop of 22% concentrated on /products/ URLs. Simultaneously, Ledger flagged a 19% revenue drop over the same window. These are almost certainly the same event — the traffic decline is directly hitting commercial pages. GA4 confirms average session duration on product pages dropped from 2m 14s to 1m 32s, suggesting the landing page experience may have changed. No deployments are logged in the last 14 days, so this is unlikely to be a technical regression. Most probable cause: a Google ranking update affecting product-category pages. Recommended action: do not rewrite anything yet — establish a baseline, then review in 7 days.",
  "signals_detected": 3,
  "tasks": [
    {
      "title": "Cross-channel analysis: organic traffic and revenue drop (22%/19%)",
      "description": "Organic traffic dropped 22% and revenue dropped 19% over the same 7-day window. SEO Sentinel and Ledger have both flagged this. No technical deployments in the past 14 days. Likely cause: algorithmic ranking change affecting /products/ category pages. Action: do not change page content yet. Set a 7-day observation window, then review keyword position data.",
      "action_type": "strategic_review",
      "trust_tier": "yellow",
      "priority": "p1",
      "confidence": 0.81,
      "estimated_impact": "Preventing premature rewrites protects attribution clarity. Correct diagnosis saves 2–3 weeks of misdirected effort."
    }
  ],
  "learnings": [
    "Traffic and revenue drops correlating within the same 7-day window are likely the same event — check product pages first."
  ],
  "summary": "22% organic traffic drop and 19% revenue drop correlate to the same product-page ranking event. Recommending observation window before action."
}
```

Conductor proposes the `strategic_review` task rather than immediately proposing a rewrite — it has identified that acting now would contaminate the data. This is the restraint system in action from the orchestration layer.
