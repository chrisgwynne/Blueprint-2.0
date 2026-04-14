---
title: "Agent Failures"
description: "Diagnosing and fixing agent run errors"
section: "Troubleshooting"
order: 3
---

# Agent Failures

Agent runs can fail for a variety of reasons. Most failures are one of a small set of predictable problems. This page covers each one: what the error means, how to diagnose it, and the exact steps to fix it.

To see an agent's run history: go to **Agents → [agent name] → Run History**. Click any run to see the full status, error message, and run log.

---

## "No active LLM provider configured"

**What it means:** Blueprint tried to run the agent but found no LLM provider configured in Settings. Without an LLM, agents cannot generate task proposals.

**Fix:**

1. Go to **Settings → LLM Providers**.
2. Add at least one provider — Anthropic, OpenAI, Google Gemini, or Ollama.
3. Click the **Test** button next to the provider. You should see a green confirmation that the model responded correctly.
4. Trigger a manual run: **Agents → [agent name] → Run Now**.

If the test button itself fails, the issue is with the provider credentials — check your API key for typos. For Ollama, verify the `OLLAMA_BASE_URL` is reachable from the server: `curl http://localhost:11434/api/tags`.

---

## "LLM rate limit exceeded" / Daily cost cap reached

**What it means:** The agent has spent its daily cost allowance (`cost_cap_daily_usd` in `profile.yaml`) and the run was skipped to stay within budget. This is a deliberate cost protection mechanism, not a crash.

**Where to look:** The run status will be `skipped` with reason `cost_cap`. The run history will show these skipped runs with a budget-exceeded note.

**Fix options:**

- **Wait for reset.** Cost caps reset at midnight UTC. The agent will run normally on its next scheduled trigger the following day.
- **Increase the cap.** Open `server/agents/{agent-id}/profile.yaml` and increase `cost_cap_daily_usd`:

  ```yaml
  llm:
    cost_cap_daily_usd: 2.00   # increase from the current value
  ```

  Save the file. The change takes effect on the next run — no restart required.

- **Check the global monthly budget.** Settings → LLM Providers shows the monthly budget. If the total spend across all agents has hit the monthly cap, all agents will be skipped until the budget is increased or the month rolls over.

---

## "Required connector not connected"

**What it means:** The agent's `connectors_required` list includes a connector type that is not connected for this business. The agent will remain in `pending` status and not run until the connector is active.

**Diagnosis:** Go to **Agents → [agent name]** and look at the status badge. If it shows **Pending**, hover over it to see which connector is missing. Alternatively, check the run history — the skip reason names the missing connector type.

**Fix:**

1. Go to **Connectors** in the left navigation.
2. Find the connector type listed as missing (e.g., `shopify`, `github`, `uptimerobot`).
3. Click **Connect** and complete the setup.
4. Once the connector status changes to **Active**, trigger a manual sync.
5. After a successful sync, the agent's status will automatically update from `pending` to `active`.

You do not need to re-hire or reinstall the agent — the transition from `pending` to `active` happens automatically when the readiness check passes.

---

## "Connector data is stale"

**What it means:** The connector is connected, but its last successful sync was more than 48 hours ago. Blueprint's readiness system treats stale data as unusable — an agent running on 3-day-old data might propose tasks based on a situation that has already resolved. The run is recorded as `skipped`.

**Diagnosis:** Go to **Connectors** and check the **Last synced** timestamp for each connector. Any connector showing "Never" or a timestamp older than 48 hours is the likely cause.

**Fix:**

1. Go to **Connectors → [connector name]**.
2. Click **Sync now**.
3. Wait for the sync to complete (status changes from **Syncing** to **Active** with a fresh timestamp).
4. If the sync fails with an error, check the connector's error message — it usually indicates an expired token (re-authorise via OAuth) or a changed API credential (update the key in connector settings).
5. Once the sync succeeds, the agent will run on its next scheduled trigger. Or trigger it manually with **Run Now**.

---

## Agent runs but proposes 0 tasks

**What it means:** The agent ran successfully and the LLM returned a valid response, but the `tasks` array was empty (or all tasks were below the 0.7 confidence threshold and were dropped). This is not a failure state — it means the agent found no actionable signals in the current data.

**Common reasons:**
- Everything is in good shape and there is nothing to act on. This is the correct outcome.
- All potential tasks already exist in the pending task queue. The agent is designed to avoid duplicates.
- The data changed recently (e.g., a connector just synced after being stale) and the LLM genuinely found no issues in the first look.
- The agent is running on very sparse data — a Shopify connector with 2 products and no recent orders will give Merchant almost nothing to work with.

**How to diagnose:** Open the run record and read the `reasoning` field. The agent always explains its analysis even when it produces no tasks. If the reasoning says "all products have complete catalogue data and no stock issues were found," that's a healthy outcome. If it says "insufficient data to perform analysis," the data sparsity explanation above applies.

If you believe the agent should be finding issues but isn't, the most productive step is to check the data quality in the connected source directly — verify in Shopify/Stripe/GitHub that the issues you expect exist in the data the connector has synced.

---

## "LLM response did not match expected schema"

**What it means:** The LLM returned a response that Blueprint's JSON parser could not extract a valid task list from. The run status is set to `error`. The raw LLM response is logged in the run record.

**Common causes:**
- A very small Ollama model (under 7B parameters) that cannot reliably follow the JSON-only output constraint.
- A model that wraps its response in markdown code fences (` ```json ... ``` `) when it should return raw JSON. Blueprint attempts to strip these fences, but some model/prompt combinations produce responses the parser cannot recover from.
- A truncated response — the model hit `max_tokens` before closing the JSON object.

**Fix:**

1. Open the run record and read the raw LLM response. This tells you exactly what went wrong.
2. If the response is wrapped in prose or markdown, switch to a model that follows instructions more reliably. The minimum recommended models are `claude-haiku-4-5-20251001` (Anthropic), `gpt-4o-mini` (OpenAI), or Ollama models of **12B parameters or larger** (e.g., `gemma3:12b`, `llama3.1:8b`).
3. If the response was truncated, increase `max_tokens` in the agent's `profile.yaml`:
   ```yaml
   llm:
     max_tokens: 4000
   ```
4. Trigger a manual run to confirm the fix worked.

> [!NOTE]
> Models below 7B parameters (e.g., `phi3:mini`, `gemma3:4b`) frequently fail to follow the strict JSON-only output requirement. If you are using Ollama for cost reasons, `gemma3:12b` is the minimum model size that produces reliable structured output with Blueprint's prompts.

---

## Agent stuck in "running" state

**What it means:** The run record in the database has `status = 'running'` but the agent is not actually executing. This is an orphaned run, typically caused by a server crash or restart while a run was in progress.

**How to identify:** On the Agents page, the agent shows a spinning "running" indicator that never completes. In Run History, the most recent run is stuck with status `running` and no completion timestamp.

**Fix:**

1. Go to **Agents → [agent name] → Run History**.
2. Click the stuck run.
3. Click **Mark as failed** (or **Cancel run**). This updates the run's status to `error` and unblocks the agent.
4. Trigger a new run manually with **Run Now** to confirm the agent is working correctly.

Alternatively, restart the Blueprint server process (`pm2 restart blueprint` or `sudo systemctl restart blueprint`). Blueprint does not automatically clean up orphaned run records on startup, but the scheduler will proceed as normal and the stuck record has no effect on future runs.

---

## Memory file corrupted

**What it means:** The `memory.json` file for an agent has been written with invalid JSON — possibly from a failed partial write, manual editing, or a disk error. The agent-runner catches this error and falls back to an empty memory, but you may see a warning in the logs.

**Symptom:** Log line like: `[agent-runner] Failed to parse memory.json for 'merchant' — using empty memory.`

**Fix:**

Delete the corrupted file. The agent will create a fresh `memory.json` on its next run:

```bash
rm server/agents/{agent-id}/memory.json
```

Replace `{agent-id}` with the actual agent ID (e.g., `merchant`, `seo-sentinel`).

The agent will rebuild its memory from scratch over the following runs. Accumulated `learnings` and `patterns` from previous runs will be lost, but all historical run records in the database are unaffected.

> [!TIP]
> Before deleting, try to view the file to understand how it became corrupted:
> ```bash
> cat server/agents/{agent-id}/memory.json
> ```
> A common cause is a partial write from a previous run that crashed mid-write. Another is manual editing that introduced a syntax error.

---

## Soul file edited and agent broke

**What it means:** A soul file (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, or `AGENTS.md`) was manually edited and the edit introduced a problem — the agent now produces poor output, errors on every run, or behaves inconsistently.

**Common causes:**
- Invalid Markdown that confuses the LLM's interpretation of the sections
- A required section was accidentally deleted (e.g., removing the "What I will never do" section from `SOUL.md`)
- A conflicting instruction was added that contradicts the JSON output requirements
- A typo introduced an unintended instruction

**Fix — reset a single file to its template:**

1. Go to **Agents → [agent name] → Soul Files**.
2. Click the **diff badge** next to the file that has changed (the badge appears when a live file differs from its template).
3. Review the diff to confirm which lines you changed.
4. Click **Reset to template** to replace the live file with the original template version exactly as shipped.

**Fix — manual reset via command line:**

```bash
cp server/agents/templates/{agent-id}/SOUL.md server/agents/{agent-id}/SOUL.md
```

Replace `SOUL.md` with whichever file you need to reset, and `{agent-id}` with the agent's ID.

After resetting, trigger a manual run to confirm the agent is producing valid output again.

> [!NOTE]
> Resetting a soul file to its template discards your customisations for that file. If you made intentional edits alongside the accidental ones, use the diff view to identify which lines to restore and re-apply your intentional changes after the reset.
