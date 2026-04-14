---
title: "Blueprint Agent Protocol (BAP)"
description: "Connect any external agent to Blueprint via HTTP"
section: "Integrations"
order: 1
---

# Blueprint Agent Protocol (BAP)

The Blueprint Agent Protocol is an HTTP API that allows any external agent — running on any machine, in any language, in any stack — to connect to Blueprint as a full participant. A BAP agent can read signals, propose tasks, query the knowledge base, write KB files, read metrics, and trigger internal agent runs.

BAP exists because Blueprint's internal agent system is powerful but opinionated. If you want to connect a specialist agent, a custom analytics script, a third-party AI service, or an internal tool, BAP is the integration layer. Your external agent registers once, gets an API key, and immediately has structured access to your business data and the Blueprint action system.

## What BAP agents can do

A registered BAP agent with the right permissions can:

- Read open signals and health summaries for any connected business
- Create signals (inject external detections into Blueprint's signal queue)
- Read and propose tasks (including write-back tasks)
- Approve or reject tasks (useful for building approval bots)
- Search and query the knowledge base via LLM-backed search
- Write files to the knowledge base
- Read raw and snapshot metric data from all connectors
- List and trigger internal Blueprint agent runs
- Subscribe to events via webhook

## Authentication

All requests (except registration and discovery) require a BAP key:

```
BAP-Key: bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Or alternatively: `Authorization: Bearer bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## Registration

```
POST /api/bap/v1/register
```

No authentication required. Send a JSON body describing your agent:

```bash
curl -X POST https://your-blueprint-instance/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAnalyticsAgent",
    "description": "Custom analytics agent that monitors custom KPIs",
    "owner": "you@yourdomain.com",
    "requested_permissions": [
      "signals:read",
      "signals:create",
      "tasks:read",
      "tasks:propose",
      "metrics:read",
      "kb:read"
    ],
    "business_access": ["*"],
    "webhook_url": "https://your-server.com/blueprint-webhook",
    "webhook_events": ["signal.created", "task.approved"]
  }'
```

The response includes your `api_key`. **Store it immediately** — it is shown once and cannot be recovered. If lost, you must register a new agent.

`business_access` accepts an array of business IDs or `["*"]` for all businesses on the instance.

## Endpoints reference

### Discovery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/bap/v1/discover` | None | Instance info, version, available capabilities |
| GET | `/api/bap/v1/me` | Required | Your agent identity and granted permissions |
| GET | `/api/bap/v1/capabilities` | Required | What this Blueprint instance supports |

### Business

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/bap/v1/businesses/:id/health` | `signals:read` | Business health summary |
| GET | `/api/bap/v1/businesses/:id/metrics/snapshot` | `metrics:read` | All latest metric values |
| GET | `/api/bap/v1/businesses/:id/metrics` | `metrics:read` | Raw metric history |

### Signals

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/bap/v1/businesses/:id/signals` | `signals:read` | List signals (filterable by status, severity, type) |
| POST | `/api/bap/v1/businesses/:id/signals` | `signals:create` | Create a new signal |
| PATCH | `/api/bap/v1/signals/:id` | `signals:read` | Update signal status (acknowledge / resolve) |

### Tasks

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/bap/v1/businesses/:id/tasks` | `tasks:read` | List tasks (filterable by status, priority) |
| POST | `/api/bap/v1/businesses/:id/tasks` | `tasks:propose` | Propose a new task |
| PATCH | `/api/bap/v1/tasks/:id` | `tasks:approve` | Approve or reject a task |

### Knowledge Base

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/bap/v1/businesses/:id/kb/search` | `kb:read` | Keyword search across KB documents |
| POST | `/api/bap/v1/businesses/:id/kb/query` | `kb:read` | LLM-backed semantic query |
| GET | `/api/bap/v1/businesses/:id/kb/file/*` | `kb:read` | Read a specific KB file |
| POST | `/api/bap/v1/businesses/:id/kb/write` | `kb:write` | Write a file to the KB |

### Agents

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/bap/v1/businesses/:id/agents` | `agents:read` | List internal Blueprint agents |
| POST | `/api/bap/v1/businesses/:id/agents/:id/run` | `agents:trigger` | Trigger an agent run |
| GET | `/api/bap/v1/runs/:runId` | `agents:read` | Get run status and output |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/api/bap/v1/me/webhook` | Register or update webhook (body: `{ url, events }`) |
| GET | `/api/bap/v1/me/webhook/deliveries` | Delivery history |
| POST | `/api/bap/v1/me/webhook/deliveries/:id/retry` | Retry a failed delivery |

## Permissions

Request only the permissions your agent needs. Blueprint admins can review and revoke permissions per agent.

| Permission | Grants access to |
|------------|-----------------|
| `signals:read` | Read signals, health summaries |
| `signals:create` | Create new signals |
| `tasks:read` | Read tasks |
| `tasks:propose` | Propose new tasks |
| `tasks:approve` | Approve or reject tasks |
| `kb:read` | Search KB, LLM query, read files |
| `kb:write` | Write files to KB |
| `metrics:read` | Read connector metrics and snapshots |
| `agents:read` | List internal agents |
| `agents:trigger` | Trigger internal agent runs |

## Rate limits

| Scope | Limit |
|-------|-------|
| Default (all endpoints) | 60 requests / minute |
| KB write (`kb/write`) | 20 requests / minute |
| KB query (`kb/query`) | 10 requests / minute |
| Agent trigger | 5 requests / minute |

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1713099600
```

When a limit is exceeded, Blueprint returns HTTP 429. Back off and retry after the `X-RateLimit-Reset` timestamp.

## Webhook registration

To receive events in real time, register a webhook endpoint:

```bash
curl -X PUT https://your-blueprint-instance/api/bap/v1/me/webhook \
  -H "BAP-Key: bap_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/hooks/blueprint",
    "events": ["signal.created", "signal.critical", "task.approved", "task.complete"]
  }'
```

Available webhook events:

| Event | Fires when |
|-------|-----------|
| `signal.created` | Any new signal is detected |
| `signal.critical` | A critical severity signal is detected |
| `task.approved` | A task is approved by a human |
| `task.rejected` | A task is rejected |
| `task.complete` | A task executes successfully |
| `task.failed` | A task execution fails |
| `agent.run.complete` | An internal agent run finishes |
| `connector.sync.complete` | A connector syncs new data |
| `connector.error` | A connector sync fails |
| `kb.ingest.complete` | A knowledge source is ingested |

## Signature verification

Every webhook delivery includes a `Blueprint-Signature` header. Verify it to ensure the payload is genuine:

```javascript
const sig = req.headers['blueprint-signature']
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_BAP_KEY)
  .update(rawBody)
  .digest('hex')
const valid = crypto.timingSafeEqual(
  Buffer.from(sig),
  Buffer.from(expected)
)
```

## Operational patterns

### 1. Read signals and propose tasks

The most common pattern: read open signals for a business, analyse them, and propose tasks.

```javascript
const bp = new BlueprintClient('https://your-instance', 'bap_xxx')
const signals = await bp.signals(bizId, { status: 'open', severity: 'alert' })

for (const signal of signals.data) {
  if (signal.type === 'shopify_no_orders') {
    await bp.proposeTask(bizId, {
      title: 'Investigate no-orders gap',
      description: `No orders detected since ${signal.data.lastOrderTime}. Check payment gateway, checkout flow, and active campaigns.`,
      action_type: 'investigation',
      priority: 'p1',
      signal_id: signal.id
    })
  }
}
```

### 2. Monitor and alert

Create a monitoring agent that injects external signals into Blueprint when your own systems detect anomalies:

```javascript
// Your external monitoring detects a database slow query
await bp.createSignal(bizId, {
  type: 'db_slow_query',
  severity: 'warning',
  title: 'Database query time exceeded threshold',
  description: 'Query avg response time is 2,400ms vs 400ms baseline',
  data: { avg_ms: 2400, baseline_ms: 400 }
})
```

### 3. Knowledge base read/write agent

Build a specialised agent that writes structured analysis back to the KB for other agents to read:

```javascript
// Read existing KB context
const existing = await bp.queryKB(bizId, 'What do we know about our checkout conversion rate?')

// Run your analysis...
const analysis = await runYourAnalysis(existing.answer)

// Write findings back to KB
await bp.writeKB(bizId, 'analysis/checkout-conversion-q2.md', analysis, {
  title: 'Checkout Conversion Analysis — Q2',
  date: new Date().toISOString(),
  author: 'MyAnalyticsAgent'
})
```

### 4. Custom analytics agent

Pull raw metrics, run your own calculations, and surface results as tasks or signals:

```javascript
const metrics = await bp.metrics(bizId)
const revenuePerSession = metrics.shopify_revenue / metrics.ga4_sessions

if (revenuePerSession < THRESHOLD) {
  await bp.createSignal(bizId, {
    type: 'revenue_per_session_drop',
    severity: 'warning',
    title: 'Revenue per session below threshold',
    description: `Current: £${revenuePerSession.toFixed(2)}/session. Threshold: £${THRESHOLD}.`,
    data: { revenuePerSession, threshold: THRESHOLD }
  })
}
```

### 5. Approval bot

Build a bot that monitors proposed tasks and applies auto-approval rules for low-risk task types, routing others to human review:

```javascript
// Subscribe to task.proposed webhook, then:
async function handleNewTask(task) {
  if (task.action_type === 'investigation' && task.confidence > 0.85) {
    await bp.approveTask(task.id)
  } else if (task.action_type === 'write_back') {
    // Send to Slack/Telegram for human review
    await notifyTeam(task)
  }
}
```

## Further reading

The full technical API reference with request/response schemas is in [`server/bap/AGENT-GUIDE.md`](/server/bap/AGENT-GUIDE.md). That document also includes complete Node.js and Python client examples.
