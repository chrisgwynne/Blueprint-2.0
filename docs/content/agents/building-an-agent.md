---
title: "Building an Agent"
description: "How to create a custom agent in Blueprint from directory structure to registration and testing"
section: "Agents"
order: 9
---

# Building an Agent

Blueprint's agent system is designed to be extended. Any agent you can describe in plain language can be wired into the same scheduler, readiness checks, memory system, and task queue that the built-in agents use. This page walks through the full process of building a custom agent from scratch — directory structure, `run.js`, soul files, registration, and testing.

---

## Agent Directory Structure

Each agent lives in `server/agents/{agent-id}/`. The directory contains:

```
server/agents/
  my-agent/
    run.js            ← Entry point — exports a run(business, options) function
    souls/
      SOUL.md         ← Agent identity, values, and hard limits
      PRINCIPLES.md   ← Operating principles and decision-making rules
      MEMORY.md       ← Persisted learnings and patterns from previous runs
      HISTORY.md      ← (Optional) Notable past events and context
```

The `souls/` subdirectory is read by `getAgentContext()` on every run. Blueprint concatenates the files in alphabetical order and appends any memory context before building the prompt.

---

## run.js — the Entry Point

Every agent must export a `run(business, options)` function from `run.js`. This is the function the scheduler calls when the agent's cron fires or a signal triggers it.

### Full skeleton

```js
// server/agents/my-agent/run.js

import { getAgentContext } from '../lib/agent-context.js';
import { buildPrompt }    from '../lib/prompt-builder.js';
import { callLLM }        from '../lib/llm.js';
import { createTask }     from '../tasks/create-task.js';

const AGENT_ID = 'my-agent';

export async function run(business, options = {}) {
  const { businessId } = business;

  // 1. Load soul files + memory for this agent and business
  const context = await getAgentContext(AGENT_ID, businessId);

  // 2. Assemble the data payload the agent will analyse
  //    Pull whatever connector data this agent needs
  const data = {
    // e.g. await getShopifySnapshot(businessId)
  };

  // 3. Build the full prompt from context + live data
  const prompt = buildPrompt(context, data);

  // 4. Call the LLM — returns a parsed JS object
  const response = await callLLM(prompt, {
    agentId: AGENT_ID,
    businessId,
    temperature: 0.4,
    maxTokens: 3000,
  });

  // 5. Parse the tasks array from the response
  const tasks = response?.tasks ?? [];

  // 6. Create a task record for each proposed action
  const created = [];
  for (const task of tasks) {
    if ((task.confidence ?? 0) < 0.7) continue; // drop low-confidence proposals
    const record = await createTask({
      agentId:       AGENT_ID,
      businessId,
      title:         task.title,
      description:   task.description,
      action_type:   task.action_type,
      action_payload: task.action_payload ?? {},
      priority:      task.priority ?? 'p2',
      confidence:    task.confidence,
      trust_tier:    context.profile?.trust_tier ?? 'yellow',
    });
    created.push(record);
  }

  // 7. Persist learnings back to MEMORY.md
  if (response?.learnings?.length) {
    await context.appendLearnings(response.learnings);
  }

  return {
    tasksCreated: created.length,
    summary: response?.summary ?? '',
  };
}
```

### What each step does

| Step | Function | Purpose |
|------|----------|---------|
| 1 | `getAgentContext(agentId, businessId)` | Reads `souls/` files and `MEMORY.md`, returns context object |
| 2 | Connector queries | Pull the live data this agent analyses |
| 3 | `buildPrompt(context, data)` | Merges soul context with live data into a full LLM prompt |
| 4 | `callLLM(prompt, options)` | Sends prompt to configured provider, parses JSON response |
| 5 | Response parsing | Extracts `tasks`, `learnings`, `summary` arrays from response |
| 6 | `createTask(...)` | Inserts each qualifying task into the task queue |
| 7 | `appendLearnings(...)` | Writes new patterns to `souls/MEMORY.md` for future runs |

> [!NOTE]
> `callLLM` expects the LLM to return **valid JSON only** — no prose, no markdown fences. Blueprint passes this requirement to the model via the prompt builder's output schema block. If the model returns malformed JSON, `callLLM` throws and the run is logged as `error`.

---

## Soul Files

The `souls/` directory contains the plain-text files that define the agent's identity and behaviour. They are read on every run and assembled into the system prompt.

### SOUL.md

The core identity file. Define who the agent is, what domain it covers, and its working style.

```markdown
# Soul — My Agent

I am My Agent, Blueprint's specialist in [domain].

My expertise covers [what you analyse].

## What I stand for
- Specificity over vagueness — every proposal includes concrete numbers
- Proportionality — prioritise by business impact, not just severity

## What I will always do
- Include a confidence score and reasoning for every task I propose
- Check whether an open task already exists before proposing a duplicate

## What I will never do
- Propose more than 5 tasks per run
- Recommend an action on an area still inside its measurement window
```

### PRINCIPLES.md

Operational rules — the step-by-step procedure for each scheduled run type.

```markdown
# Principles — My Agent

## Daily run
1. Pull latest [connector] data
2. Compare to prior period
3. Identify the top 3 findings by impact
4. Propose tasks for findings above confidence threshold
5. Append key patterns to memory

## Data quality gate
If connector data is older than 48 hours, note it in reasoning
and propose no tasks.
```

### MEMORY.md

Starts empty. Blueprint appends learnings after each run. You can seed it with known patterns before the first run.

```markdown
# Memory — My Agent

## Learnings
<!-- Blueprint appends agent learnings here after each run -->

## Patterns
<!-- Recurring observations the agent has noted over time -->
```

### HISTORY.md (optional)

Static context about the business or domain that does not change run-to-run. Use it to provide founding context, known constraints, or historical events.

```markdown
# History — My Agent

- 2026-01: Business replatformed from WooCommerce to Shopify — pre-2026 product data is incomplete
- 2026-03: Migrated from USD to GBP pricing
```

> [!TIP]
> Copy soul files from an existing agent as a starting point. For example: `cp -r server/agents/seo-sentinel/souls server/agents/my-agent/souls`. Then edit `SOUL.md` for your agent's domain and rewrite `PRINCIPLES.md` for its specific operating steps.

---

## Registering the Agent

### 1. Add to registry.js

Open `server/agents/registry.js` and add an entry to the `AGENTS` array:

```js
// server/agents/registry.js

export const AGENTS = [
  // ... existing agents ...
  {
    id:          'my-agent',
    name:        'My Agent',
    displayName: 'My Agent',
    schedule:    '0 8 * * 1-5',   // cron — weekdays at 08:00
    connectors:  ['shopify'],       // connector IDs required for this agent to run
  },
];
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier. Must match the directory name. |
| `name` | Internal name used in logs and the task queue. |
| `displayName` | Human-readable name shown in the UI. |
| `schedule` | Standard 5-field cron expression for when this agent runs. |
| `connectors` | Array of connector type IDs. The agent is skipped if any are stale. |

### 2. Add to AGENT_MAP in conductor.js

Open `server/agents/conductor.js` and add the agent to `AGENT_MAP` so Conductor can route briefings to it and trigger it based on signals:

```js
// server/agents/conductor.js

const AGENT_MAP = {
  'seo-sentinel':  () => import('./seo-sentinel/run.js'),
  'quill':         () => import('./quill/run.js'),
  'trend-spotter': () => import('./trend-spotter/run.js'),
  'my-agent':      () => import('./my-agent/run.js'),  // ← add this line
};
```

> [!WARNING]
> If you register the agent in `registry.js` but forget `AGENT_MAP`, the scheduler will attempt to run it but Conductor will not be able to trigger it reactively (e.g. in response to a signal or a manual Conductor pass). Both entries are required for full functionality.

---

## Testing the Agent

### Manual CLI run

Trigger a single run without waiting for the cron schedule:

```bash
bun run agent:run --agent=my-agent --business=1
```

This executes `run.js` directly, prints the LLM response and any created tasks to stdout, and exits. Useful for rapid iteration during development.

### Dry-run mode

Pass `--dry-run` to execute the full pipeline without writing any tasks to the database:

```bash
bun run agent:run --agent=my-agent --business=1 --dry-run
```

The response and any proposed tasks are printed but nothing is persisted.

### From the UI

1. Go to **Agents** in the left navigation.
2. Find your agent in the list.
3. Click the agent name to open the detail view.
4. Click **Run Now**.

The run executes immediately. Open the **Run History** tab to see the assembled prompt, the raw LLM response, and any tasks created.

> [!TIP]
> Set `DISABLE_SCHEDULER=true` in `.env` while building and testing your agent. This prevents scheduled runs from interfering with your manual tests. Remove the variable once the agent is ready to run on its schedule.

---

## Complete Example: Skeleton Agent

The following is a minimal but complete custom agent you can use as a starting point.

**Directory layout:**
```
server/agents/stock-watcher/
  run.js
  souls/
    SOUL.md
    PRINCIPLES.md
    MEMORY.md
```

**run.js:**
```js
import { getAgentContext } from '../lib/agent-context.js';
import { buildPrompt }    from '../lib/prompt-builder.js';
import { callLLM }        from '../lib/llm.js';
import { createTask }     from '../tasks/create-task.js';

const AGENT_ID = 'stock-watcher';

export async function run(business, options = {}) {
  const { businessId } = business;
  const context = await getAgentContext(AGENT_ID, businessId);
  const prompt  = buildPrompt(context, { trigger: options.trigger ?? 'scheduled' });
  const response = await callLLM(prompt, { agentId: AGENT_ID, businessId });

  for (const task of response?.tasks ?? []) {
    if ((task.confidence ?? 0) >= 0.7) {
      await createTask({ agentId: AGENT_ID, businessId, ...task,
        trust_tier: context.profile?.trust_tier ?? 'yellow' });
    }
  }

  if (response?.learnings?.length) await context.appendLearnings(response.learnings);

  return { tasksCreated: response?.tasks?.length ?? 0, summary: response?.summary ?? '' };
}
```

**registry.js entry:**
```js
{ id: 'stock-watcher', name: 'Stock Watcher', displayName: 'Stock Watcher',
  schedule: '0 7 * * 1-5', connectors: ['shopify'] }
```

**AGENT_MAP entry:**
```js
'stock-watcher': () => import('./stock-watcher/run.js'),
```
