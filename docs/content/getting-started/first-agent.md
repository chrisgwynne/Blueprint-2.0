---
title: "Your First Agent"
description: "Hire your first agent and understand how agent runs work"
section: "Getting Started"
order: 5
---

# Your First Agent

Agents are the active layer of Blueprint. Each one is an autonomous specialist that reads metrics, signals, business context, and goal state, then proposes (or, at higher trust levels, takes) concrete actions. An agent without data to read does nothing — which is why connecting at least one data source comes first.

---

## What Agents Are

An agent is a named role with a defined purpose, a set of data sources it depends on, and a soul file that gives it its perspective and operating instructions. When an agent runs:

1. It loads its soul file (personality, role definition, operating constraints).
2. It assembles business context: active goals, recent signals, connector metrics, knowledge base excerpts, and its own memory from prior runs.
3. It sends a structured prompt to the configured LLM provider.
4. It parses the LLM's response into one or more structured tasks.
5. It writes the tasks to the task queue, writes a run summary to its run log, and updates its memory.

Every agent run is fully logged. You can see what prompt was assembled, what the LLM returned, how many tokens were used, the estimated cost, and the tasks that were proposed.

---

## Hiring an Agent

### Via Conductor's recommendation (recommended)

If Conductor is hired, it automatically recommends specialist agents after connectors sync. Look for a task in the **Tasks** queue with:

- `action_type`: `hire_agent`
- `proposed_by`: `conductor`
- `title`: something like "Hire SEO Sentinel — GSC and GA4 data is ready"

Click **Approve** on that task to hire the agent. Blueprint creates the agent, loads its default configuration, and queues an initial run.

### Manually

1. Go to **Agents** in the left sidebar.
2. Click the **Available** tab to see agents that are not yet hired.
3. Find the agent you want (hover for a description of what it does and what connectors it needs).
4. Click **Hire**.

Blueprint validates that the agent's required connectors are connected and have synced at least once. If a required connector is missing, the hire is still allowed but the agent enters `pending` status and waits until the connector is added.

> [!TIP]
> Start with Conductor if you have not hired it already. Conductor is a meta-agent that surveys the connected data sources and orchestrates the rest of the agent roster. It does not analyse domain-specific data — it decides which specialist agents are worth running and when.

---

## What Happens on the First Run

Hiring an agent queues an immediate first run. Here is what occurs in sequence:

### Soul file loading

Blueprint reads the agent's soul file from `server/agents/<agent-id>/soul.md`. The soul file defines:

- The agent's role and persona
- Its analytical framework (what it looks for, how it weighs evidence)
- Its output format (the kinds of tasks it is allowed to propose)
- Its operating constraints (what it must not do, e.g. never propose irreversible destructive actions without explicit human approval)

### Business context assembly

Before calling the LLM, Blueprint assembles a context packet that includes:

| Context element | Source |
|---|---|
| Active goals and milestones | `goals` table |
| Open and recently resolved signals | `signals` table |
| Latest metrics for relevant connectors | `metrics` table |
| Agent's memory from prior runs | `server/agents/<agent-id>/memory.json` |
| Relevant knowledge base documents | `kb/` directory (vector search) |
| Recent tasks proposed by this agent | `tasks` table |

### LLM call

The assembled context is formatted into a prompt and sent to the configured LLM provider. The system prompt comes from the soul file. The user prompt contains the business context and a directive to analyse and propose actions.

### Task extraction

Blueprint parses the LLM's structured JSON response into task rows. Each proposed task is written to the `tasks` table with status `proposed`.

### Memory and logging

The agent writes a summary of the run to `memory.json` (condensed insights and decisions it should remember for next time) and appends a full run record to `run-log.jsonl`.

---

## Reading the Task Queue

After the first run completes, go to **Tasks** in the left sidebar. You will see proposed tasks from the agent.

Each task shows:

| Field | What it contains |
|-------|-----------------|
| **Title** | A plain-English description of the proposed action, e.g. "Fix crawl errors on /products/** pages" |
| **Confidence** | The agent's stated confidence in this proposal, from 0.0 to 1.0. Higher values indicate stronger evidence. |
| **Proposed by** | The agent that created this task, e.g. `seo-sentinel` |
| **Action type** | The category of action: `content_update`, `technical_fix`, `campaign_adjustment`, `hire_agent`, `notify`, `investigate`, etc. |
| **Details** | The agent's full reasoning — what data it observed, why it thinks this action matters, and what outcome it expects |
| **Evidence** | Links to the specific signals or metrics that triggered this proposal |
| **Created** | When the task was proposed |

---

## Approving vs Deferring Tasks

Every proposed task requires a decision:

### Approve

Click **Approve** to accept the task. What happens next depends on the agent's trust tier:

- **Tier 1 (Suggest)** — Approval marks the task as accepted. Blueprint records your decision but takes no automated action. You act on it yourself.
- **Tier 2 (Write-back)** — Approval triggers Blueprint to execute the action directly via the connector's write-back API (e.g., publishing a meta description update to WordPress, creating a Todoist task, or sending a Telegram message).
- **Tier 3 (Autonomous)** — At this tier the agent can act without approval. Tasks may already be completed by the time you review them.

Most agents default to Tier 1. You promote an agent's trust tier in **Agents → [Agent Name] → Trust Tier**.

### Defer

Click **Defer** to postpone the decision. The task stays in the queue but is deprioritised. Blueprint's restraint system tracks deferred tasks and prevents the same agent from proposing the same type of action repeatedly if you keep deferring it.

### Dismiss

Click **Dismiss** to reject the task entirely. Blueprint logs the dismissal so the agent can factor it into future proposals. Repeatedly dismissed tasks of the same type cause the agent to lower its confidence on similar proposals.

---

## Agent Run Logs

Every agent run is recorded. To view run history:

1. Go to **Agents** and click the agent's name.
2. Click the **Run History** tab.

Each run record shows:

| Field | What it contains |
|-------|-----------------|
| **Timestamp** | When the run started and how long it took |
| **Trigger** | What triggered the run: `scheduled`, `data_ready` (connector synced), `manual`, or `conductor_queued` |
| **Status** | `complete`, `failed`, or `skipped` (skipped when the restraint system determined a run was not warranted) |
| **Tasks proposed** | Number of tasks the agent proposed in this run |
| **Tokens used** | Input and output token counts |
| **Estimated cost** | Cost in USD based on the provider's pricing at the time of the run |
| **Summary** | The agent's own one-paragraph summary of what it observed and proposed |
| **Full prompt** | Toggle to expand the complete assembled prompt that was sent to the LLM |
| **Raw response** | Toggle to expand the raw LLM response before task extraction |

> [!TIP]
> If an agent is proposing tasks that feel off-target or too aggressive, reading the full prompt in the run log is the fastest way to understand why. The assembled context shows exactly what data the agent was given and what it was asked to do with it.

---

## Next Steps

Now that you have a connector syncing data and an agent proposing tasks, you have the core Blueprint loop running:

- **Add more connectors** to give agents a richer view of your business.
- **Create goals** in the Goals section so agents can orient their proposals toward your actual objectives.
- **Review the restraint system** to understand how Blueprint prevents agents from being too noisy.
- **Explore write-back actions** to let agents take direct action on your connected services.
