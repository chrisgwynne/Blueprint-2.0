---
title: Soul Files
description: How agent identity and behaviour is defined
---

Every agent is governed by four markdown files that define who they are, what they stand for, how they operate, and how they work with other agents. These files are assembled into the system prompt on every run.

## The four soul files

### IDENTITY.md

Who the agent is. Written in first person. Sent first in every system prompt.

```markdown
# Identity — SEO Sentinel

I am SEO Sentinel, Blueprint's Search Intelligence Specialist.
My purpose is to monitor search performance, detect signals
before they become problems, and surface opportunities.
```

### SOUL.md

Values, principles, and hard limits. What the agent will and won't do.

### HEARTBEAT.md

Operational rhythm — what the agent checks, when, and in what order.

### AGENTS.md

Collaboration rules — which agents it briefs, which it receives briefings from.

## Editing soul files

In Blueprint: **Agents → [Agent name] → Soul Files tab**

Each file has an independent editor. Changes take effect on the next agent run. The UI shows a badge when a file differs from its original template.

## How they become the system prompt

Files are assembled in order:
1. IDENTITY.md
2. SOUL.md
3. HEARTBEAT.md
4. AGENTS.md
5. memory.json (last 10 learnings from previous runs)
6. KB memory docs (configured per agent)
7. Current business context (metrics, signals, tasks)
