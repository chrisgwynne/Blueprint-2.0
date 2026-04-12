---
title: Agents Overview
description: How AI agents work in Blueprint
---

Blueprint agents are autonomous specialists that analyse your business data, detect patterns, and propose actions. Each agent has:

- **Identity** — who they are (IDENTITY.md)
- **Values** — what they stand for and won't do (SOUL.md)
- **Rhythm** — when they run and what they check (HEARTBEAT.md)
- **Collaboration** — how they work with other agents (AGENTS.md)

## Pre-installed agents

| Agent | Role | Schedule |
|-------|------|----------|
| **Conductor** | Strategy & orchestration | Hourly |
| **SEO Sentinel** | Search rankings & CWV | Daily (weekdays) |
| **Quill** | Content & copy | Weekly (Wed) |
| **Trend Spotter** | Growth opportunities | Weekly (Mon) |

## Template agents (install from Settings)

Merchant, Velocity, Ledger, Sentinel, Researcher, Reporter, Dev, Outreach.

## How agents run

1. Scheduler checks if an agent's cron schedule is due
2. Agent runner loads soul files and assembles the system prompt
3. Business context (metrics, signals, tasks) is injected as user context
4. LLM generates a JSON response with tasks, learnings, and summary
5. Tasks are created in the queue (requires approval unless green tier)
6. Memory is updated with learnings from this run
7. Run log is appended with timing, cost, and token usage
8. If not Conductor, a briefing is sent to Conductor's inbox

## LLM providers

Agents can use any configured LLM provider:

| Provider | Local? | Cost |
|----------|--------|------|
| Claude CLI | No (uses your Claude Code subscription) | Subscription |
| Anthropic API | No | Per-token |
| OpenAI | No | Per-token |
| Google Gemini | No | Per-token |
| Ollama | Yes | Free |
| LM Studio | Yes | Free |

Configure in Settings → LLM Providers, or per-agent in the agent's profile.
