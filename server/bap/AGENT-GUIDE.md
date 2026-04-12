# Blueprint Agent Protocol (BAP) — Integration Guide

Any agent that can make HTTP requests and receive webhooks can connect to Blueprint as a participant. Language, framework, LLM — irrelevant.

## Quick Start

### 1. Register your agent

```bash
curl -X POST http://localhost:4000/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "description": "What this agent does",
    "owner": "you@example.com",
    "requested_permissions": ["signals:read", "tasks:propose", "kb:read", "metrics:read"],
    "business_access": ["*"],
    "webhook_url": "https://myagent.local:3001/blueprint",
    "webhook_events": ["signal.created", "task.approved", "task.complete"]
  }'
```

**Store the returned `api_key` securely — it will not be shown again.**

### 2. Make your first call

```bash
curl http://localhost:4000/api/bap/v1/me \
  -H "BAP-Key: bap_your_key_here"
```

### 3. Get a business health summary

```bash
curl http://localhost:4000/api/bap/v1/businesses/YOUR_BIZ_ID/health \
  -H "BAP-Key: bap_your_key_here"
```

### 4. Propose a task

```bash
curl -X POST http://localhost:4000/api/bap/v1/businesses/YOUR_BIZ_ID/tasks \
  -H "BAP-Key: bap_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Update homepage meta description",
    "description": "Current meta is generic. Suggest keyword-rich version.",
    "action_type": "meta_update",
    "priority": "p2",
    "confidence": 0.85
  }'
```

### 5. Create a signal

```bash
curl -X POST http://localhost:4000/api/bap/v1/businesses/YOUR_BIZ_ID/signals \
  -H "BAP-Key: bap_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "anomaly",
    "severity": "warning",
    "title": "Unusual Telegram engagement spike",
    "description": "Messages up 340% in last 2 hours",
    "data": {"spike_pct": 340},
    "confidence": 0.78
  }'
```

### 6. Query the Knowledge Base

```bash
curl -X POST http://localhost:4000/api/bap/v1/businesses/YOUR_BIZ_ID/kb/query \
  -H "BAP-Key: bap_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"question": "What is our brand voice?"}'
```

## Authentication

Every request (except `/register`) must include:

```
BAP-Key: bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Or: `Authorization: Bearer bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## Webhook Events

When you register with a `webhook_url`, Blueprint POSTs events to your endpoint:

```json
{
  "id": "del_abc123",
  "event": "signal.critical",
  "timestamp": "2026-01-15T07:23:41Z",
  "blueprint_version": "1.0.0",
  "data": {
    "signal_id": "sig_xxx",
    "business_id": "biz_xxx",
    "severity": "critical",
    "title": "Site down"
  }
}
```

**Verify HMAC signature** (if you set a webhook_secret):

```javascript
const sig = req.headers['blueprint-signature']
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex')
const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
```

### Available events

| Event | When |
|---|---|
| `signal.created` | Any new signal detected |
| `signal.critical` | Critical-severity signal specifically |
| `task.approved` | A task was approved |
| `task.rejected` | A task was rejected |
| `task.complete` | A task executed successfully |
| `task.failed` | A task execution failed |
| `agent.run.complete` | An internal agent finished a run |
| `connector.sync.complete` | A connector synced new data |
| `connector.error` | A connector sync failed |
| `kb.ingest.complete` | A raw source was ingested into the wiki |

## Permissions Reference

| Permission | Allows |
|---|---|
| `signals:read` | Read signals, business health |
| `signals:create` | Create new signals |
| `tasks:read` | Read tasks |
| `tasks:propose` | Propose new tasks |
| `tasks:approve` | Approve or reject tasks |
| `kb:read` | Read KB files, search, query |
| `kb:write` | Write KB files |
| `metrics:read` | Read connector metrics |
| `agents:read` | List internal agents |
| `agents:trigger` | Trigger internal agent runs |

## Rate Limits

| Endpoint class | Limit |
|---|---|
| Default | 60 calls / minute |
| KB write | 20 calls / minute |
| KB query (LLM) | 10 calls / minute |
| Agent trigger | 5 calls / minute |

Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## SDK Example (Node.js / Bun)

```javascript
class BlueprintClient {
  constructor(baseUrl, apiKey) {
    this.base = `${baseUrl}/api/bap/v1`
    this.key = apiKey
  }

  async fetch(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...opts,
      headers: { 'BAP-Key': this.key, 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    if (!res.ok) throw new Error(`BAP ${res.status}: ${await res.text()}`)
    return res.json()
  }

  health(bizId)                    { return this.fetch(`/businesses/${bizId}/health`) }
  signals(bizId, params = {})      { return this.fetch(`/businesses/${bizId}/signals?${new URLSearchParams(params)}`) }
  proposeTask(bizId, task)         { return this.fetch(`/businesses/${bizId}/tasks`, { method: 'POST', body: task }) }
  queryKB(bizId, question)         { return this.fetch(`/businesses/${bizId}/kb/query`, { method: 'POST', body: { question } }) }
  writeKB(bizId, path, content)    { return this.fetch(`/businesses/${bizId}/kb/write`, { method: 'POST', body: { path, content } }) }
  triggerAgent(bizId, agentId)     { return this.fetch(`/businesses/${bizId}/agents/${agentId}/run`, { method: 'POST' }) }
}

const bp = new BlueprintClient('http://192.168.1.100:4000', process.env.BLUEPRINT_API_KEY)
const health = await bp.health('your-business-id')
console.log(`Health: ${health.health_score}, Open signals: ${health.signals.total}`)
```

## SDK Example (Python)

```python
import httpx, os

class BlueprintClient:
    def __init__(self, base_url, api_key):
        self.base = f"{base_url}/api/bap/v1"
        self.headers = {"BAP-Key": api_key, "Content-Type": "application/json"}

    def health(self, biz_id):
        return httpx.get(f"{self.base}/businesses/{biz_id}/health", headers=self.headers).json()

    def propose_task(self, biz_id, task):
        return httpx.post(f"{self.base}/businesses/{biz_id}/tasks", json=task, headers=self.headers).json()

    def query_kb(self, biz_id, question):
        return httpx.post(f"{self.base}/businesses/{biz_id}/kb/query",
                         json={"question": question}, headers=self.headers).json()

bp = BlueprintClient(os.environ["BLUEPRINT_URL"], os.environ["BLUEPRINT_API_KEY"])
health = bp.health("your-business-id")
```
