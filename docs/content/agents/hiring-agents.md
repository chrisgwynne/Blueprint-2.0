---
title: "Hiring Agents"
description: "How to hire, pause, and manage agents in Blueprint"
section: "Agents"
order: 8
---

# Hiring Agents

Blueprint ships with four pre-installed agents (Conductor, SEO Sentinel, Quill, and Trend Spotter). The remaining agents — Merchant, Velocity, Ledger, Sentinel, Researcher, Reporter, Dev, and Outreach — live in the template library and must be hired before they become active. This page explains how hiring works, how Conductor recommends agents, and how to pause or remove them.

---

## How Hiring Recommendations Work

When you connect a data source, Blueprint's Conductor agent analyses which template agents would now have useful data to work with. This is a two-phase process:

**Phase 1 — Mechanical filter.** Conductor checks the template library and finds every agent whose `connectors_required` list is fully satisfied by your currently active connectors. An agent that requires Shopify will not be proposed until a Shopify connector is connected and active.

**Phase 2 — LLM reasoning.** Conductor sends the filtered candidate list to the LLM and asks it to reason about which agents are genuinely worth hiring given your specific business context. Candidates are ranked and assigned a confidence score (0.0–1.0) and a priority (`immediate`, `suggested`, or `optional`). Agents with a confidence below 0.7 are silently dropped — Blueprint will not propose an agent it isn't confident about.

The result is a set of `hire_agent` tasks in your task queue, each with Conductor's reasoning attached explaining what the agent will do with your data. These tasks require your approval before the agent is activated (trust tier: yellow).

**Accepting a hire task** runs the installer, which copies the agent's soul files from the template directory to the live directory and activates the agent. **Rejecting the task** dismisses the recommendation. Blueprint will not re-propose the same agent until you reset it.

---

## Manually Hiring an Agent

You do not need to wait for a Conductor recommendation. To hire any template agent directly:

1. Go to **Agents** in the left navigation.
2. Click the **Available** tab to see all template agents not currently installed.
3. Click **Hire** next to the agent you want.

The agent becomes active immediately if its required connectors are already connected and synced. If a required connector is missing, the agent is created with `status: pending` and will not run until the connector is connected.

---

## What "Hiring" Means Technically

When an agent is hired, three things happen:

1. **Soul files are copied.** The agent's files (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `AGENTS.md`, `profile.yaml`) are copied from `server/agents/templates/{agent-id}/` to `server/agents/{agent-id}/`. These are your live, editable copies.

2. **A database row is created.** A row is inserted into the `agents` table with the agent's `id`, `name`, `profile_path`, and initial `status` (`active` or `pending` depending on connector readiness).

3. **The first run is scheduled.** The agent is registered with the scheduler. Its next cron-scheduled run will execute at the next matching time defined in its `profile.yaml`.

The installer also runs a readiness check at hire time to determine whether to set the initial status to `active` or `pending`. If any required connector is missing or has never synced, the status is set to `pending`.

---

## Agent Status States

| Status | Meaning |
|--------|---------|
| `active` | Agent is running normally on its schedule |
| `paused` | Agent has been paused — runs are skipped by the scheduler until resumed |
| `pending` | Agent has been hired but is waiting for a required connector to be connected or synced |
| `error` | Agent's last run failed — check the run log for the error |
| `retired` | Agent has been removed from the active list — no longer runs, but run history is preserved |

An agent transitions from `pending` to `active` automatically when the missing connector is connected and performs a successful sync. You do not need to manually re-activate it.

---

## Pausing Agents

**Pause all agents:** Go to **Settings → Agents** and click **Pause All**. This sets a global kill switch that prevents every agent from running. Use this when you need to do maintenance or stop all AI activity temporarily. The health endpoint will not indicate agents are paused — check Settings directly.

**Pause a single agent:** Go to **Agents → [agent name]** and toggle the **Active / Paused** switch. The agent's `status` is updated in the database. The scheduler will skip this agent on every subsequent run until you toggle it back to active.

Paused agents still appear in the Agents list — they are not removed. Their run history, memory, and soul files are preserved.

---

## Removing an Agent

To remove an agent: go to **Agents → [agent name]** and click **Remove**.

Removing an agent marks it as `retired` in the database and sets its `profile.yaml` status to `retired`. The agent stops running immediately. Its on-disk files (`soul files`, `memory.json`, `run-log.jsonl`) and all historical run records in the database are preserved — nothing is deleted. This means you retain the full audit trail and memory, and if you ever re-hire the same agent it can pick up from where it left off.

If you want to re-hire a retired agent, go to **Agents → Available** — retired agents appear there and can be re-installed.

---

## Template Agent Reference

| Agent | Role | Required Connectors |
|-------|------|---------------------|
| **Merchant** | Ecommerce operations specialist — monitors Shopify catalogue completeness, identifies missing product data, flags inventory issues, and prioritises fixes by revenue impact | Shopify |
| **Velocity** | Performance and Core Web Vitals specialist — tracks PageSpeed scores over time, identifies which pages are dragging down site performance, and proposes targeted fixes | PageSpeed Insights |
| **Ledger** | Revenue and commercial intelligence — analyses Stripe data for revenue trends, anomalies, and cohort patterns, and cross-references with other data sources for commercial context | Stripe |
| **Sentinel** | Uptime and systems health monitor — watches UptimeRobot alerts and incident history, escalates downtime events, and tracks response time trends | UptimeRobot |
| **Researcher** | Competitive intelligence analyst — performs weekly competitor analysis, maps the search landscape for key terms, and identifies strategic gaps to exploit | None (no connectors required) |
| **Reporter** | Business intelligence briefing specialist — generates structured weekly and monthly performance reports, drawing on all connected data sources | None (optional: GA4, Shopify, Stripe) |
| **Dev** | Technical implementation and GitHub specialist — triages technical tasks, produces GitHub issue specifications, and manages the development task queue | GitHub |
| **Outreach** | Campaign and marketing strategist — identifies upcoming seasonal opportunities, assesses conversion performance, and proposes campaign direction with timing and channel recommendations | Stannp |

> [!NOTE]
> Researcher and Reporter have no required connectors and can be hired at any time. They are more useful the more connectors you have connected, but they will run from the start with whatever context is available.
