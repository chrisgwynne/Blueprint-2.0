# Blueprint Agent Protocol — API Reference

For agent skill installation, see [SKILL.md](/SKILL.md) in the repo root. That file tells agents what Blueprint is, what tools are available, when to use each one, and how to operate. This document is the technical API reference for developers building custom integrations.

---

## Authentication

All requests (except `/register`) require:

```
BAP-Key: bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Or: `Authorization: Bearer bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

---

## Registration

```
POST /api/bap/v1/register
```

No auth required. Body:

```json
{
  "name": "AgentName",
  "description": "Optional description",
  "owner": "optional@email.com",
  "requested_permissions": [
    "signals:read", "signals:create",
    "tasks:read", "tasks:propose",
    "kb:read", "kb:write",
    "metrics:read", "agents:trigger"
  ],
  "business_access": ["*"],
  "webhook_url": "https://optional-webhook-endpoint/",
  "webhook_events": ["signal.critical", "task.approved"]
}
```

Returns `api_key` once. Store it securely.

---

## Endpoints

### Discovery
```
GET  /api/bap/v1/discover          — instance info, no auth
GET  /api/bap/v1/me                — agent identity + permissions
GET  /api/bap/v1/capabilities      — what this instance supports
```

### Business
```
GET  /api/bap/v1/businesses/:id/health           — health summary
GET  /api/bap/v1/businesses/:id/metrics/snapshot  — all latest metrics
GET  /api/bap/v1/businesses/:id/metrics           — raw metric history
```

### Signals
```
GET   /api/bap/v1/businesses/:id/signals    — list signals
POST  /api/bap/v1/businesses/:id/signals    — create signal
PATCH /api/bap/v1/signals/:id               — update status
```

### Tasks
```
GET   /api/bap/v1/businesses/:id/tasks      — list tasks
POST  /api/bap/v1/businesses/:id/tasks      — propose task
PATCH /api/bap/v1/tasks/:id                 — approve/reject
```

### Knowledge Base
```
GET   /api/bap/v1/businesses/:id/kb/search  — search KB
POST  /api/bap/v1/businesses/:id/kb/query   — LLM query
GET   /api/bap/v1/businesses/:id/kb/file/*  — read file
POST  /api/bap/v1/businesses/:id/kb/write   — write file
```

### Agents
```
GET   /api/bap/v1/businesses/:id/agents          — list agents
POST  /api/bap/v1/businesses/:id/agents/:id/run  — trigger run
GET   /api/bap/v1/runs/:runId                    — run status
```

### Webhooks
```
PUT   /api/bap/v1/me/webhook                        — configure
GET   /api/bap/v1/me/webhook/deliveries              — delivery history
POST  /api/bap/v1/me/webhook/deliveries/:id/retry    — retry failed
```

---

## Webhook events

| Event | Fires when |
|-------|-----------|
| `signal.created` | Any new signal |
| `signal.critical` | Critical severity signal |
| `task.approved` | Task approved by human |
| `task.rejected` | Task rejected |
| `task.complete` | Task executed successfully |
| `task.failed` | Task execution failed |
| `agent.run.complete` | Internal agent run finished |
| `connector.sync.complete` | Connector synced new data |
| `connector.error` | Connector sync failed |
| `kb.ingest.complete` | Source ingested into KB |

**Verify HMAC:**
```javascript
const sig = req.headers['blueprint-signature']
const expected = 'sha256=' + crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(rawBody).digest('hex')
const valid = crypto.timingSafeEqual(
  Buffer.from(sig), Buffer.from(expected)
)
```

---

## Permissions

| Permission | Grants access to |
|------------|-----------------|
| `signals:read` | Read signals, health |
| `signals:create` | Create signals |
| `tasks:read` | Read tasks |
| `tasks:propose` | Propose tasks |
| `tasks:approve` | Approve / reject tasks |
| `kb:read` | Read KB, search, query |
| `kb:write` | Write KB files |
| `metrics:read` | Read connector metrics |
| `agents:read` | List internal agents |
| `agents:trigger` | Trigger agent runs |

---

## Rate limits

| Scope | Limit |
|-------|-------|
| Default | 60 / minute |
| KB write | 20 / minute |
| KB query | 10 / minute |
| Agent trigger | 5 / minute |

Headers: `X-RateLimit-Limit` · `X-RateLimit-Remaining` · `X-RateLimit-Reset`

---

## Node.js client

```javascript
class BlueprintClient {
  constructor(baseUrl, apiKey) {
    this.base = `${baseUrl}/api/bap/v1`
    this.key = apiKey
  }

  async call(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...opts,
      headers: { 'BAP-Key': this.key, 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    })
    if (!res.ok) throw new Error(`BAP ${res.status}: ${await res.text()}`)
    return res.json()
  }

  health(bizId)                    { return this.call(`/businesses/${bizId}/health`) }
  signals(bizId, p = {})           { return this.call(`/businesses/${bizId}/signals?${new URLSearchParams(p)}`) }
  proposeTask(bizId, task)         { return this.call(`/businesses/${bizId}/tasks`, { method: 'POST', body: task }) }
  createSignal(bizId, signal)      { return this.call(`/businesses/${bizId}/signals`, { method: 'POST', body: signal }) }
  queryKB(bizId, q, ctx)           { return this.call(`/businesses/${bizId}/kb/query`, { method: 'POST', body: { question: q, context: ctx } }) }
  writeKB(bizId, path, content, fm){ return this.call(`/businesses/${bizId}/kb/write`, { method: 'POST', body: { path, content, frontmatter: fm } }) }
  metrics(bizId)                   { return this.call(`/businesses/${bizId}/metrics/snapshot`) }
  triggerAgent(bizId, aid, reason) { return this.call(`/businesses/${bizId}/agents/${aid}/run`, { method: 'POST', body: { reason } }) }
}
```

---

## Python client

```python
import httpx

class BlueprintClient:
    def __init__(self, base_url, api_key):
        self.base = f"{base_url}/api/bap/v1"
        self.h = {"BAP-Key": api_key, "Content-Type": "application/json"}

    def health(self, biz):        return httpx.get(f"{self.base}/businesses/{biz}/health", headers=self.h).json()
    def signals(self, biz, **p):  return httpx.get(f"{self.base}/businesses/{biz}/signals", params=p, headers=self.h).json()
    def propose(self, biz, task): return httpx.post(f"{self.base}/businesses/{biz}/tasks", json=task, headers=self.h).json()
    def signal(self, biz, s):     return httpx.post(f"{self.base}/businesses/{biz}/signals", json=s, headers=self.h).json()
    def query_kb(self, biz, q):   return httpx.post(f"{self.base}/businesses/{biz}/kb/query", json={"question": q}, headers=self.h).json()
    def write_kb(self, biz, p, c, fm={}): return httpx.post(f"{self.base}/businesses/{biz}/kb/write", json={"path": p, "content": c, "frontmatter": fm}, headers=self.h).json()
    def metrics(self, biz):       return httpx.get(f"{self.base}/businesses/{biz}/metrics/snapshot", headers=self.h).json()
```
