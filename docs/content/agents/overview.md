---
title: "Agents Overview"
description: "How Blueprint's AI agents work, what's included, and how to configure them"
section: "Agents"
order: 1
---

# Agents Overview

Blueprint ships with four pre-installed agents that run on a schedule and analyse your business data. You can also hire additional agents from the template library when you connect the right data sources.

## Pre-installed Agents

These agents are active the moment Blueprint starts. They require no setup beyond connecting the data sources they depend on.

| ID | Name | Role | Schedule | Required Connectors |
|----|------|------|----------|---------------------|
| `conductor` | Conductor | Strategic orchestration — coordinates all other agents, reads cross-channel signals, sets priorities | Hourly | None |
| `seo-sentinel` | SEO Sentinel | Monitors search rankings, Core Web Vitals, and GSC performance | Daily, weekdays (Mon–Fri) | Google Search Console |
| `quill` | Quill | Content and copy strategist — proposes briefs, meta updates, and page refreshes | Weekly, Wednesday | None |
| `trend-spotter` | Trend Spotter | Finds growth opportunities before they peak — keyword momentum, seasonal patterns | Weekly, Monday | None |

> [!NOTE]
> Conductor is the only agent that cannot be paused. It is always running. All other agents can be individually paused from the Agents page.

## Template Agents (Available to Hire)

Template agents are dormant until you hire them. Conductor recommends hiring an agent when it detects that a relevant connector has been connected and the agent would immediately have useful data to work with.

| Name | Role | Required Connectors |
|------|------|---------------------|
| Merchant | Ecommerce operations — product catalogue completeness, description quality, inventory signals | Shopify |
| Velocity | Performance and Core Web Vitals specialist | PageSpeed Insights API |
| Ledger | Revenue and commercial intelligence | Stripe |
| Sentinel | Uptime and systems health monitoring | UptimeRobot |
| Researcher | Competitive intelligence — market research, competitor analysis | None |
| Reporter | Business intelligence briefing specialist — weekly summaries | None |
| Dev | Technical implementation and GitHub issue management | GitHub |
| Outreach | Campaign and marketing strategy | None (optional: various) |

To hire a template agent: navigate to **Agents → Browse Templates**, select the agent, and click **Hire**. Blueprint copies the agent's soul files and profile into `server/agents/<id>/`, then activates it.

---

## How a Run Works

Every scheduled and signal-triggered agent run follows the same pipeline:

1. **Cron fires (or signal received)** — the scheduler checks whether the agent is due to run, either because its cron schedule has elapsed or because a matching signal has been raised.

2. **Readiness check** — Blueprint verifies that the agent's required connectors have synced within the last 48 hours. If a required connector has stale or missing data, the run is recorded as `skipped` and Conductor is notified. No tasks are proposed from stale data.

3. **Soul files assembled** — the four soul files (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `AGENTS.md`) are read from the agent's directory and concatenated with `---` separators to form the system prompt. If a `memory.json` exists, the last 10 learnings and patterns are appended. Any `.md` or `.txt` files in the agent's `kb/` subdirectory are also included (up to 5 files).

4. **Business context injected** — a user-turn message is assembled containing: the current run trigger, recent signals from connected sources, the last-fetched metric snapshots, the existing task queue (to prevent duplicates), and a list of active connectors. The agent sees everything relevant in one structured prompt.

5. **LLM call** — the assembled system prompt and context are sent to the configured LLM. The agent must respond with valid JSON only — no markdown fences, no prose outside the JSON object.

6. **JSON response parsed** — Blueprint parses the response and validates the schema. If parsing fails, the run is logged as `error` and retried on the next cron cycle.

7. **Tasks created** — for each task in the response with `confidence >= 0.7`, Blueprint creates a task record in the queue. Tasks are checked against the restraint system (see [Restraint System](/brain/restraint-system)) and against existing open tasks to prevent duplicates.

8. **Trust tier applied** — green tasks execute automatically; yellow tasks enter an approval queue for human review; red tasks are flagged for human action only.

9. **Memory updated** — any `learnings` strings from the response are appended to the agent's `memory.json`. Run stats (total runs, tasks proposed) are incremented.

10. **Briefing sent to Conductor** — every non-Conductor agent appends a structured briefing to `server/agents/conductor/inbox.jsonl`. Conductor reads this inbox on its next run to maintain cross-agent situational awareness.

---

## LLM Provider Configuration

Each agent has an `llm` block in its `profile.yaml` that controls which model it uses.

```yaml
llm:
  provider: anthropic          # anthropic | openai | gemini | ollama | lm-studio | claude-cli
  model: claude-sonnet-4-20250514
  temperature: 0.4
  max_tokens: 4096
  cost_cap_daily_usd: 2.00
```

To set a provider for all agents globally, go to **Settings → LLM Providers**. The per-agent `llm` block in `profile.yaml` overrides the global default for that specific agent.

See [LLM Providers](/agents/llm-providers) for the full configuration guide.

---

## Trust Tiers

Every task Blueprint proposes is assigned one of three trust tiers. The tier is set in the agent's `profile.yaml` and can be configured per task type.

| Tier | Colour | Behaviour |
|------|--------|-----------|
| `green` | Green | Task executes automatically without human review |
| `yellow` | Yellow | Task enters the approval queue — a human must approve or reject it |
| `red` | Red | Task is flagged as human-only — Blueprint will not attempt to execute it |

All four pre-installed agents default to **yellow**. This means every proposal you see in the task queue is waiting for your approval before anything changes.

You can change the trust tier of an individual agent by editing the `trust_tier` field in its `profile.yaml`, or override per-task by editing the task in the queue before approving.

> [!WARNING]
> Setting an agent to `green` means it will take actions automatically. Do this only for low-risk action types (e.g., sending a notification or creating a draft) — never for live page edits, product updates, or anything that affects paying customers without review.
