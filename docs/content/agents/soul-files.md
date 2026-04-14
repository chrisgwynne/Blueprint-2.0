---
title: "Soul Files"
description: "How to read, understand, and safely edit the files that define each agent's behaviour"
section: "Agents"
order: 6
---

# Soul Files

Every agent in Blueprint has four plain-text Markdown files that collectively define its personality, values, operating rhythm, and inter-agent relationships. These files are assembled into the agent's system prompt on every run. They are called soul files.

Soul files live at `server/agents/<agent-id>/`:

```
server/agents/
  conductor/
    IDENTITY.md
    SOUL.md
    HEARTBEAT.md
    AGENTS.md
    memory.json        ← written by the system, not a soul file
    profile.yaml       ← configuration, not a soul file
  seo-sentinel/
    IDENTITY.md
    SOUL.md
    HEARTBEAT.md
    AGENTS.md
  quill/
    ...
  trend-spotter/
    ...
```

---

## The Four Soul Files

### IDENTITY.md

IDENTITY.md answers: *who is this agent?* It defines the agent's domain expertise, its working style, and the lens through which it interprets data. This is the file that gives an agent its character.

When the system prompt is assembled, IDENTITY.md comes first. It establishes the persona before any instructions are given. An agent that doesn't know who it is will give generic, unfocused responses. An agent with a well-defined identity will speak with specificity — it will cite exact keyword positions, not just "rankings declined."

**What to put here:** Who the agent is. What it's an expert in. How it approaches its work. What distinguishes it from a generic analyst.

**What not to put here:** Schedules, relationships with other agents, hard rules. Those belong in HEARTBEAT.md and SOUL.md.

---

### SOUL.md

SOUL.md answers: *what does this agent stand for?* It contains the agent's values, its non-negotiable principles, and its explicit constraints. It is the moral and operational rulebook.

A well-written SOUL.md contains three sections:
- **What I stand for** — the positive values: cross-channel thinking, honest prioritisation, specificity over vagueness.
- **What I will always do** — the guaranteed behaviours regardless of what the data shows.
- **What I will never do** — hard limits. These are the lines that cannot be crossed even if the LLM "thinks" it would help.

SOUL.md is where you add hard limits. If you want SEO Sentinel to never propose more than three tasks per run, you add that constraint here. If you want Conductor to always include a confidence score in every proposal, that goes in SOUL.md.

---

### HEARTBEAT.md

HEARTBEAT.md answers: *how does this agent operate, step by step?* It defines the agent's operating rhythm — the exact sequence of checks it runs, in order, on each scheduled job type.

For agents with multiple scheduled jobs (like Conductor, which has an hourly run, a morning briefing, and a weekly review), HEARTBEAT.md defines the procedure for each. The LLM reads this file and uses it to structure its analysis for the current run type.

**A well-written HEARTBEAT.md controls output quality more than any other soul file.** If you want SEO Sentinel to always check Core Web Vitals before ranking positions, you put that step first in its heartbeat. If you want Conductor to always check for P1 signals before anything else, you write that into the heartbeat.

**Example structure for SEO Sentinel's daily scan:**
```
## Daily scan — weekdays 07:00
1. Pull last 7 days GSC data, compare to prior 7 days
2. Pull latest PageSpeed scores, compare to previous run
3. Evaluate all signal rules against current + previous data
4. Score each finding by: severity × confidence × business impact
5. Propose tasks for top 3 findings only (never more than 5)
6. Append key findings to memory.json
7. Send summary to Conductor: signal count, task count, top finding
```

The numbers matter — they define the order of operations. An agent that checks its memory before pulling fresh data will behave differently from one that checks fresh data first.

---

### AGENTS.md

AGENTS.md answers: *how does this agent relate to every other agent?* It defines the inter-agent relationship graph from this agent's perspective.

For Conductor, AGENTS.md is the hub: it describes what it receives from each agent and what it sends back. For SEO Sentinel, AGENTS.md describes how it briefs Conductor, how it hands off content opportunities to Quill, and how it escalates technical issues to Velocity or Dev.

**Why this matters:** Without AGENTS.md, agents operate in silos. With it, they behave like a team. SEO Sentinel will actively write its briefing with Conductor's needs in mind. Quill will wait for direction from Conductor before proceeding with a brief. The inter-agent protocol exists in these files.

**The briefing protocol.** After every run, each non-Conductor agent appends a structured JSON briefing to `server/agents/conductor/inbox.jsonl`. AGENTS.md is where you define what that briefing should contain and what information the agent should hold back (a briefing that contains 2,000 words of reasoning is not a briefing — it's a dump).

---

## How the System Prompt Is Assembled

When a run is triggered, `agent-runner.js` assembles the system prompt in this order:

```
1. IDENTITY.md
   ---
2. SOUL.md
   ---
3. HEARTBEAT.md
   ---
4. AGENTS.md
   ---
5. Memory context (last 10 patterns + last 10 learnings from memory.json)
   ---
6. Knowledge base files (up to 5 .md or .txt files from kb/ subdirectory)
   ---
7. Output requirements (injected by the system — JSON schema, trust tier, confidence threshold)
```

The `---` separator is a horizontal rule that signals a new section to the LLM. The soul files are read verbatim — exactly as they appear in the files. No transformation happens. What you write in SOUL.md is exactly what the LLM reads.

The output requirements block (section 7) is always appended by the system and cannot be overridden by soul files. It enforces the JSON response schema, the confidence threshold (0.7), and the maximum task count.

---

## memory.json

`memory.json` is written by the system after each run. It accumulates learnings over time and is included in every subsequent run's system prompt. It is not a soul file — you should not edit it manually unless correcting an error.

Each run, the LLM can include a `learnings` array in its response (0–3 strings). These are appended to `memory.json`. The last 50 learnings are stored; the last 10 are included in the system prompt.

```json
{
  "learnings": [
    "Traffic drops on /products/ URLs correlating with revenue drops are usually the same event.",
    "Meta description rewrites for informational queries rarely improve CTR — focus on commercial queries first.",
    "Seasonal impression spikes for 'personalised gifts' begin appearing in GSC data 8–10 weeks before peak."
  ],
  "patterns": [
    "Monday runs consistently show weekend traffic anomalies — discount these in weekly comparison.",
    "PageSpeed scores degrade on Tuesdays — likely a caching issue with the CDN provider."
  ],
  "stats": {
    "total_runs": 47,
    "total_tasks_proposed": 23
  },
  "last_updated": "2026-04-14T07:02:11.000Z"
}
```

Over time, memory gives each agent a business-specific context that generic LLM responses cannot have. An agent that has run 50 times on your GSC data knows things about your site that no new agent can know.

---

## The Diff Badge in the UI

When you navigate to **Agents → [agent name] → Soul Files**, Blueprint compares each soul file against its template (the original file in `server/agents/templates/<agent-id>/`). If the live file differs from the template, a **diff badge** appears next to the file name in the UI.

The diff badge is informational — it does not mean something is wrong. It means you (or a previous user) have customised that file. Click the badge to see a line-by-line diff between your version and the original template.

If you want to revert a file to its template state, use the **Reset to template** button in the diff view. This replaces the live file with the template file exactly as shipped.

---

## Best Practices for Editing Soul Files

**What to change:**

- **SOUL.md hard limits** — this is the most valuable thing to customise. Add specific constraints for your business. "Never propose content briefs for competitor brand keywords." "Never raise a P1 alert for a single-day traffic anomaly." "Always include a 90-day seasonal context window when evaluating impression trends."
- **HEARTBEAT.md step order** — reorder steps to match your priorities. If Core Web Vitals matter more to your business than keyword rankings, move that step to the top.
- **IDENTITY.md domain context** — add context about your specific industry. "This business sells personalised gifts in the UK. Seasonal peaks are Mother's Day (March), Father's Day (June), and Christmas (November–December)."
- **AGENTS.md relationships** — if you've hired new agents, add their relationship entries.

**What not to change:**

- **Do not remove the output format section from SOUL.md** if it exists. The system appends output requirements anyway, but some soul files include reinforcing format instructions.
- **Do not hardcode specific metric values** that will go stale (e.g., "the site average CTR is 3.2%"). The agent reads live data on every run — let it calculate averages dynamically.
- **Do not contradict the profile.yaml trust tier** in SOUL.md. If the profile says `yellow`, the soul file saying "auto-execute" will create inconsistent behaviour.

---

## Example: Editing SEO Sentinel's SOUL.md to Add a Hard Limit

Say you want SEO Sentinel to never propose meta description rewrites for pages that were updated in the last 21 days, regardless of what the CTR data shows.

Open `server/agents/seo-sentinel/SOUL.md` and add to the "What I will never do" section:

```markdown
## What I will never do
- Propose a meta description rewrite for any page that has been modified in the last 21 days.
  The measurement window for meta changes is 21 days — proposing a second change before the
  first one has been measured contaminates the attribution data.
```

This constraint will be read on every subsequent SEO Sentinel run. The LLM will check its task proposals against this rule before including them in its response.

After saving, the diff badge will appear next to SOUL.md in the UI, indicating your customisation. If you ever want to revert to the original behaviour, use **Reset to template**.
