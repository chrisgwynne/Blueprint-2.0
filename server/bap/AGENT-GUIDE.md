# Blueprint Agent Protocol — API Reference

For agent skill installation, see [SKILL.md](/SKILL.md) in the repo root. That file tells agents what Blueprint is, what tools are available, when to use each one, and how to operate. This document is the technical API reference for developers building custom integrations.

> **2026-08 update:** this pass documents Goals, Outcomes, and Connectors
> (existing endpoints that were missing from this reference) and adds the
> new Operating Policy and Receipts endpoints, plus two behavior changes
> that affect how proposed tasks resolve. Full details in
> [CHANGELOG.md](/CHANGELOG.md). The Decision Centre now has a read-only BAP
> surface too (#77, below). Nine more dashboard features (Comparisons, Command
> Centre, Portfolios, Digest, Explanations, Audit Search, Retrospectives,
> Playbooks, Simulation) exist but have no BAP surface yet — see issues
> #78–#86.

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

Requires **either** an authenticated dashboard session **or** an
`X-Registration-Secret` header matching the operator-configured
`BAP_REGISTRATION_SECRET` environment variable. Unauthenticated
self-service registration is not permitted. Body:

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
  "business_access": ["biz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
  "webhook_url": "https://optional-webhook-endpoint/",
  "webhook_events": ["signal.critical", "task.approved"]
}
```

`requested_permissions` and `business_access` are filtered server-side:
wildcard permissions (`*:*`, `resource:*`) and wildcard business access
(`"*"`) are never granted by this endpoint, regardless of what's
requested — only the specific, valid permissions/business IDs you ask for
are granted. An operator can widen access afterwards via the dashboard.

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

### Connectors
```
GET   /api/bap/v1/businesses/:id/connectors        — list connectors
GET   /api/bap/v1/connectors/:id                   — connector detail
GET   /api/bap/v1/connectors/:id/syncs             — sync history
POST  /api/bap/v1/connectors/:id/sync              — trigger a sync
```
Each connector (2026-08) now carries `health_state`, `health_summary`,
`health_impact`, `health_next_step`, and `health_coverage_complete` alongside
the older `status` field. `health_state` is one of `healthy`, `stale`,
`partial`, `failing`, `permission_required`, or `not_applicable` —
`permission_required` is distinct from a generic `failing`/auth error, and
`health_coverage_complete: false` means treat any totals from that connector
as a lower bound, not a finished count.

### Signals
```
GET   /api/bap/v1/businesses/:id/signals    — list signals
POST  /api/bap/v1/businesses/:id/signals    — create signal
PATCH /api/bap/v1/signals/:id               — update status
```

### Goals
```
GET   /api/bap/v1/businesses/:id/goals      — list goals
POST  /api/bap/v1/businesses/:id/goals      — propose a goal
GET   /api/bap/v1/goals/:id                 — goal detail
PATCH /api/bap/v1/goals/:id                 — update a goal
POST  /api/bap/v1/goals/:id/archive         — archive a goal
POST  /api/bap/v1/goals/:id/check           — run a progress check
GET   /api/bap/v1/goals/:id/conflicts       — conflicts with other goals
GET   /api/bap/v1/goals/:id/assessment      — latest strategic assessment
GET   /api/bap/v1/goals/:id/assessments     — assessment history
GET   /api/bap/v1/goals/:id/strategies      — proposed strategies
POST  /api/bap/v1/goals/:id/plan            — trigger strategy planning
GET   /api/bap/v1/goals/:id/timeline        — chronological linked events
```
`timeline` (2026-08): now includes explicit `gap` entries for expected-but-
missing steps (no signal ever linked, stale activity, no downstream action,
no measured outcome past its window) instead of silently omitting them, and
every event carries `correlation` vs. `verified_attribution` — the latter
means a measured outcome or cited evidence backs the link, not just that it
happened during the goal's active window.

### Outcomes
```
GET   /api/bap/v1/businesses/:id/outcomes   — list measured task outcomes
GET   /api/bap/v1/tasks/:id/outcome         — outcome for one task
```

### Tasks
```
GET   /api/bap/v1/businesses/:id/tasks      - list tasks
GET   /api/bap/v1/businesses/:id/kanban-cards - canonical Hermes card sync feed
GET   /api/bap/v1/tasks/:id/kanban-card      - canonical Hermes card projection
POST  /api/bap/v1/businesses/:id/tasks      - propose task; returns 400 with structured `issues` when action schema/applicability blocks the proposal
PATCH /api/bap/v1/tasks/:id                 — approve/reject
```

**`scheduled_workflow` action type (2026-08):** for recurring, non-destructive
automation you own and execute yourself (cron jobs, folder watchers,
monitoring, scheduled checks) — propose it instead of misusing
`content_draft`. Required payload fields: `schedule`, `target_system`.
Optional: `cron_job_id`, `target_resource`, `side_effects`, `verification`,
`constraints`, `disable_path`. Blueprint tracks and displays these; it never
executes them — you do, and you're responsible for verification.

**Approval routing (2026-08):** if you propose a task whose `action_type` is
registered but has no Blueprint executor, approval now routes it straight to
`manual_review` instead of creating a job that would just retry and
dead-letter. If you're polling for a task to move to `executing`/`complete`
and it goes to `manual_review` instead, that's the terminal state — it
won't self-resolve without a human, and it won't keep cycling either.

### Trust
```
GET  /api/bap/v1/businesses/:id/capabilities                 - capability registry
POST /api/bap/v1/businesses/:id/applicability/evaluate       - applicability status and suppression reason
GET  /api/bap/v1/businesses/:id/suppressions                 - active applicability suppressions
GET  /api/bap/v1/businesses/:id/corrections                  - correction history
GET  /api/bap/v1/businesses/:id/corrections/:correctionId/impacts - affected records from a correction
POST /api/bap/v1/businesses/:id/corrections/propose          - propose a correction for human review
GET  /api/bap/v1/businesses/:id/revenue-paths                - revenue paths
GET  /api/bap/v1/businesses/:id/scorecards                   - agent scorecard snapshot
GET  /api/bap/v1/provider-preflight                          - provider/model preflight cache
```

### Operating Policy (2026-08)
```
GET  /api/bap/v1/businesses/:id/operating-policy                    — effective policy + version history
GET  /api/bap/v1/businesses/:id/operating-policy/versions/:version  — one historical version
GET  /api/bap/v1/businesses/:id/operating-policy/history             — audit trail of policy changes
```
Read-only by design — there is no BAP write path to a policy version.
This is the actual rule set your proposals are judged against: auto-approve
confidence ceiling, thresholds, `always_require_human_action_types`,
autonomy caps and dry-run state. Worth checking before proposing something
you expect to auto-execute, and worth citing if you need to explain why
something needed a human.

### Receipts (2026-08)
```
GET  /api/bap/v1/businesses/:id/receipts    — list receipts (filterable, paginated)
GET  /api/bap/v1/tasks/:id/receipts         — every receipt for one task
GET  /api/bap/v1/receipts/:id               — single receipt detail
```
Read-only. A receipt is durable proof of what happened to an approved task,
with five distinct states: `requested` → `authorized` → `executed` →
`externally_acknowledged` → `verified`, plus external IDs/permalinks and
verification evidence where available. Use this instead of polling task
status if you need to know something genuinely landed on the other end, not
just that Blueprint attempted it.

### Decision Queue (2026-08)
```
GET  /api/bap/v1/businesses/:id/decision-queue          — pending review queue, sorted by lane
GET  /api/bap/v1/businesses/:id/decision-queue/classes  — recurring decision classes
GET  /api/bap/v1/decision-queue/:taskId                 — single queue item detail
```
Read-only, permission `decision_queue:read`. This is the queue of items still
awaiting a human, and it tells you **why** yours is sitting there: `lane`
(`manual_review` | `policy_gated` | `routine`) with a `lane_reason`,
`risk_tier` and its evidence, `hold_reasons`, `required_action` (including
`executable: false` when no executor exists, so approving could never make it
run) and the policy citation in force. Use `?proposed_by=agent:you` to see
only your own proposals. Far more useful than polling task status: if the lane
is `policy_gated` you can stop re-proposing and supply better evidence, or cite
the Operating Policy above to explain why a human is required.

There is no BAP approve/reject/defer/amend path — review is a human act on the
dashboard by design.

> **Not to be confused with `GET /businesses/:id/decisions` and `GET
> /decisions/:id` (permission `decisions:read`).** Those are the decision
> *memory* log — historical decisions already made, for answering "why did we
> decide this six months ago?". This section is the *pending* queue. An item
> leaves the queue when reviewed and its outcome appears on that other surface,
> so an agent that wants the full before-and-after needs both grants.

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

**Quarantine (2026-08):** if your webhook URL ever fails the SSRF safety
check (resolves to localhost/a private address, or an update makes it
unsafe), it's now automatically quarantined instead of generating endless
failed deliveries. Quarantine clears the moment you `PUT /me/webhook` with
a URL that validates. If `GET /me` shows a `webhook_url` you expect but
events have silently stopped arriving, this is the first thing to check.

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
| `goals:read` | Read goals, conflicts, assessments, strategies, timeline |
| `goals:propose` | Propose a goal |
| `goals:update` | Update, archive, check, or plan a goal |
| `outcomes:read` | Read measured task outcomes |
| `connectors:read` | Read connector list, detail, sync history, health |
| `connectors:sync` | Trigger a connector sync |
| `operating_policies:read` | Read effective policy, version history, audit trail |
| `receipts:read` | Read action receipts |
| `decision_queue:read` | Read the pending-decision review queue (not the decision-memory log — see above) |

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
  connectors(bizId)                 { return this.call(`/businesses/${bizId}/connectors`) }
  goalTimeline(goalId)              { return this.call(`/goals/${goalId}/timeline`) }
  operatingPolicy(bizId)            { return this.call(`/businesses/${bizId}/operating-policy`) }
  receipts(bizId, p = {})           { return this.call(`/businesses/${bizId}/receipts?${new URLSearchParams(p)}`) }
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
    def connectors(self, biz):    return httpx.get(f"{self.base}/businesses/{biz}/connectors", headers=self.h).json()
    def operating_policy(self, biz): return httpx.get(f"{self.base}/businesses/{biz}/operating-policy", headers=self.h).json()
    def receipts(self, biz, **p): return httpx.get(f"{self.base}/businesses/{biz}/receipts", params=p, headers=self.h).json()
```
