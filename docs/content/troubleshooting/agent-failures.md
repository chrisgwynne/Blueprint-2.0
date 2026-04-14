---
title: "Agent Failures"
description: "Common agent failure modes and how to diagnose and fix them"
section: "Troubleshooting"
order: 3
---

# Agent Failures

Agent runs can fail for a variety of reasons. Most failures are one of a small set of predictable problems. This page covers each one: what the error means, how to diagnose it, and the exact steps to fix it.

To see an agent's run history: go to **Agents → [agent name] → Run History**. Click any run to see the full status, error message, assembled prompt, and raw LLM response.

---

## "Agent run returned no tasks"

This is not always an error. The agent assessed the current data and found nothing actionable — everything is within acceptable thresholds, no signals crossed the confidence cutoff, or all potential proposals already exist as pending tasks in the queue.

**When to be concerned:** If the same agent consistently returns zero tasks across many runs spanning multiple weeks, the more likely explanation is a data or configuration problem rather than a perpetually healthy business.

**How to diagnose:**

1. Open the run record in **Run History** and read the `reasoning` field. The agent always explains its analysis even when it produces zero tasks.
2. Check the agent run logs at `/logs/agents/`. Each run appends a structured log entry including the signals evaluated and the decision rationale.
3. If the reasoning reads "insufficient data" or "no connector data available," the issue is data, not the agent.

**Common causes and fixes:**

| Cause | Fix |
|-------|-----|
| Required connectors have no recent data | Go to **Connectors**, check last-synced timestamps, trigger a manual sync |
| Connector credentials have expired | Re-authorise the connector via OAuth or update the API key |
| Agent is running on an empty data set (new connector, no historical data yet) | Wait for the connector to accumulate at least 7 days of data |
| All proposals exist as pending tasks already | Review and action tasks in the queue — agents avoid duplicates |

> [!TIP]
> For a new connector that just authorised, trigger a manual agent run after 24 hours (once the connector has completed its first full sync). The first run on a new connector is typically the most task-dense.

---

## "LLM response parse error" / "not valid JSON"

The LLM returned a response that Blueprint's parser could not interpret as valid JSON. The run status is set to `error`. The raw LLM response is logged in the run record so you can see exactly what was returned.

**How to view the raw response:**

Go to **Agents → [agent name] → Run History**, click the failed run, and expand the **Raw LLM response** section.

**Common causes:**

| Cause | Symptom in raw response | Fix |
|-------|------------------------|-----|
| Model too small | Response wrapped in prose, or JSON mixed with conversational text | Switch to a 7B+ parameter model |
| Temperature too high | Inconsistent format, hallucinated structure | Lower `temperature` to 0.3–0.4 in `profile.yaml` |
| Context too long | Response truncated mid-JSON | Increase `max_tokens` in `profile.yaml`, or reduce context window size |
| Model wraps in code fences | Response starts with ` ```json ` | Blueprint strips these, but some combinations break the parser — switch to a model that follows JSON-only instructions reliably |

**Fix — check model configuration:**

Open the agent's `profile.yaml` and verify the model settings:

```bash
nano server/agents/{agent-id}/profile.yaml
```

```yaml
llm:
  provider: ollama
  model: gemma3:12b        # minimum 7B parameters for reliable JSON output
  temperature: 0.4         # 0.3–0.5 is the reliable range
  max_tokens: 3000         # increase if responses are being truncated
```

> [!WARNING]
> Models below 7B parameters (e.g., `phi3:mini`, `llama3.2:1b`) frequently fail to follow Blueprint's strict JSON-only output constraint. If you are using Ollama for cost reasons, `gemma3:12b` or `llama3.1:8b` are the minimum model sizes that produce reliably parseable output with Blueprint's prompts.

---

## "Agent skipped: data too stale"

The restraint system blocked the run because the connector data is older than the readiness threshold (48 hours by default). Blueprint refuses to run agents on stale data because proposing tasks based on outdated information creates noise, not insight.

**How to fix:**

1. Go to **Connectors** in the left navigation.
2. Find the connector that is stale — look for a last-synced timestamp older than 48 hours, or a red status badge.
3. Click **Sync now** to trigger an immediate sync.
4. Once the sync completes successfully, trigger a manual agent run with **Run Now**.

**If the sync keeps failing:**

The most common reasons are expired OAuth tokens or changed API credentials.

- **OAuth connectors** (Google Analytics, Google Search Console, Google Ads): click **Re-authorise** on the connector settings page and complete the OAuth flow again.
- **API key connectors** (Shopify, UptimeRobot, etc.): verify the API key is still valid in the source platform and update it in connector settings.

See [Connector Errors](/troubleshooting/connector-errors) for a full list of sync error codes and fixes.

---

## "Conductor not routing to agents"

Conductor runs on its schedule but does not trigger specialist agents — the task queue stays empty, agent run counts don't increase, and no briefings are received.

**Diagnosis:**

1. Confirm Conductor itself is running: check **Agents → Conductor → Run History** for recent runs.
2. If Conductor runs but no other agents are triggered, the most likely cause is a registration gap.

**Check 1 — registry.js:**

Open `server/agents/registry.js` and verify your agent appears in the `AGENTS` array:

```js
export const AGENTS = [
  { id: 'my-agent', name: 'My Agent', displayName: 'My Agent',
    schedule: '0 8 * * 1-5', connectors: ['shopify'] },
  // ...
];
```

If it is missing, add it and restart Blueprint.

**Check 2 — AGENT_MAP in conductor.js:**

Open `server/agents/conductor.js` and verify your agent appears in `AGENT_MAP`:

```js
const AGENT_MAP = {
  'seo-sentinel':  () => import('./seo-sentinel/run.js'),
  'quill':         () => import('./quill/run.js'),
  'my-agent':      () => import('./my-agent/run.js'),  // must be present
};
```

If it is missing from `AGENT_MAP`, Conductor cannot route to it. Add the entry and restart.

> [!NOTE]
> Both `registry.js` and `AGENT_MAP` are required. `registry.js` registers the agent with the scheduler (cron-based runs). `AGENT_MAP` in conductor.js is required for Conductor to trigger the agent reactively in response to signals or during its own strategic passes.

---

## "Soul file not found"

The agent cannot find one of its soul files at startup or during a run. Blueprint logs an error like: `[agent-runner] Soul file not found: server/agents/my-agent/souls/SOUL.md`.

**Path requirements:**

Soul files must be at exactly this path:

```
server/agents/{agentId}/souls/SOUL.md
server/agents/{agentId}/souls/PRINCIPLES.md
server/agents/{agentId}/souls/MEMORY.md
```

> [!WARNING]
> Linux filesystems are case-sensitive. `SOUL.md`, `soul.md`, and `Soul.md` are three different files. Blueprint looks for uppercase filenames. If you created files with lowercase names, rename them:
> ```bash
> mv server/agents/my-agent/souls/soul.md server/agents/my-agent/souls/SOUL.md
> ```

**How to check:**

```bash
ls -la server/agents/{agent-id}/souls/
```

All required files should be present with their exact uppercase names. Verify the `souls/` directory itself exists — it will be missing if you created the agent directory without the subdirectory:

```bash
mkdir -p server/agents/my-agent/souls
```

---

## "Agent memory not updating"

Agent learnings are not being persisted between runs. The agent starts each run without the context it built in previous runs.

**Check 1 — directory exists and is writable:**

```bash
ls -la server/agents/{agent-id}/souls/MEMORY.md
```

If `MEMORY.md` does not exist, Blueprint will attempt to create it on the first run that produces learnings. If the directory is not writable by the process user, the write will silently fail.

```bash
# Check ownership
ls -la server/agents/{agent-id}/souls/

# Fix ownership if needed (replace 'blueprint' with your process user)
sudo chown -R blueprint:blueprint server/agents/{agent-id}/
```

**Check 2 — agent is returning learnings:**

Open a recent run record and look for the `learnings` array in the parsed LLM response. If the array is empty or absent, the agent is not producing learnings — this is not a write failure, it means the LLM's response did not include any learnings. This is normal for runs that found nothing significant.

**Check 3 — data/agent-memory/ directory:**

Some Blueprint configurations store agent memory in `data/agent-memory/` rather than inside the agent directory. Check whether this directory exists and is writable:

```bash
ls -la data/agent-memory/
```

If it does not exist, Blueprint should create it on first run. If it is missing and runs are failing, create it manually:

```bash
mkdir -p data/agent-memory
chown blueprint:blueprint data/agent-memory
```

---

## "Agent produces the same task every run"

The agent keeps proposing the same task on every run, even though the task was previously created and is sitting in the queue.

**How deduplication works:**

Blueprint deduplicates task proposals based on a hash of the task content (title, description, action type, and target). Before creating a task, the runner queries `task_proposals` for any existing pending task with the same hash on the same target. If one exists, the new proposal is dropped.

**Diagnosis:**

1. Go to **Tasks** and check whether the task already exists in the pending queue. If it does, the agent is working correctly — it proposed the task, it was created, and it is waiting for approval.

2. If the same task keeps being created as a duplicate (multiple pending tasks for the same thing), query the database directly:

```bash
bun --eval "
import db from './server/db/db.js';
const tasks = db.prepare(
  'SELECT id, title, status, created_at FROM tasks WHERE title LIKE ? ORDER BY created_at DESC LIMIT 10'
).all('%your task title%');
console.table(tasks);
"
```

**Common causes and fixes:**

| Cause | Fix |
|-------|-----|
| Task exists in queue but agent can't see it | Verify the business ID matches — tasks are scoped per business |
| Task was closed/rejected and agent re-proposes correctly | This is correct behaviour — a rejected task can be re-proposed next cycle |
| Deduplication hash collision | Unlikely; check if task content is slightly different each time |
| Task is stuck in `pending` and never actioned | Review and approve or reject the backlog |

> [!TIP]
> If you want to prevent a specific task from ever being proposed again, reject it and select "Do not re-propose." Blueprint adds the hash to a suppression list, and the agent will not generate this task on future runs.

---

## "No active LLM provider configured"

Blueprint tried to run the agent but found no LLM provider configured. Without an LLM, agents cannot generate any output.

**Fix:**

1. Go to **Settings → LLM Providers**.
2. Add at least one provider (Anthropic, OpenAI, Google Gemini, or Ollama).
3. Click **Test** to verify the provider responds correctly.
4. Trigger a manual run with **Run Now**.

For Ollama specifically, verify it is reachable from the server:

```bash
curl http://localhost:11434/api/tags
```

If this returns an error, Ollama is not running or not bound to the expected address. Start it with `ollama serve`.
