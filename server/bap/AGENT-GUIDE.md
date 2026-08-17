# Blueprint Agent Protocol — API Reference

For agent skill installation, see [SKILL.md](/SKILL.md) in the repo root. That file tells agents what Blueprint is, what tools are available, when to use each one, and how to operate. This document is the technical API reference for developers building custom integrations.

> **2026-08 update:** this pass documents Goals, Outcomes, and Connectors
> (existing endpoints that were missing from this reference) and adds the
> new Operating Policy and Receipts endpoints, plus two behavior changes
> that affect how proposed tasks resolve. Full details in
> [CHANGELOG.md](/CHANGELOG.md). The Decision Queue, Comparison mode, the
> Executive Command Centre, multi-business Portfolios, and the "While You
> Were Away" Digest now have read-only BAP surfaces too (#77–#81, below).
> Five more dashboard features (Explanations, Audit Search, Retrospectives,
> Playbooks, Simulation) exist but have no BAP surface yet — see issues
> #82–#86.

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

### Comparisons (2026-08)
```
GET  /api/bap/v1/businesses/:id/comparisons/candidates  — what may be compared
POST /api/bap/v1/businesses/:id/comparisons             — compare candidates you name
```
Read-only. When you have several candidates for the same decision, POST their
ids (`{"candidates": ["id1","id2"]}`, or `{"id","kind"}` objects where `kind`
is `task` | `opportunity` | `strategy`, 2–6 of them) and you get Blueprint's
own normalised reading of them: which fields they genuinely **share**, which
actually **differ**, and the single operating policy all of them are judged
against — approval tier, whether each needs a human, connector blocks.

Every field carries a `state` of `known` / `unknown` / `not_comparable` with a
citation or a reason, and the holes are collected in `missing_data`. Nothing
is defaulted, averaged or zero-filled — if Blueprint has not measured
something, you are told that instead of being handed a number. Read the
`comparability.warnings` too: mixed decision classes and no measured track
record are flagged rather than smoothed over.

Building a comparison is inert — `read_only: true`, no approval, no execution
job, no status change. Candidates from a different business are a `422` naming
the offending id: different businesses have different policies, connectors and
evidence windows, so one table over both would be dishonest.

Not to be confused with `GET /businesses/:id/recommendations`
(`recommendations:read`), which returns the ranked list Blueprint generated
for you. This compares the specific candidates *you* nominate.

There is no BAP endpoint to record which candidate won. Recording a selection
writes to Blueprint's decision memory, and no BAP route writes that — present
the comparison with your recommendation and let a human record the choice.

### Command Centre (2026-08)
```
GET  /api/bap/v1/command-centre        — cross-business executive summary
GET  /api/bap/v1/command-centre/scope  — which businesses you may select
```
Read-only, permission `command_centre:read`. One call for the picture you
would otherwise assemble from four surfaces across every business you run:
pending decisions with lane and risk breakdown, recent verified changes from
receipts, the outcome/ROI summary including measured declines, connector
health, and a ranked cross-business `attention` list of what to look at first.

Query `?business_ids=a,b,c` (repeated `business_ids=` params work too), plus
`?window_days=` (default 30) and `?sample_size=` (items per section, default
5). Omit `business_ids` for every business in your grant. A selection is
capped at 25 businesses.

Two things to read carefully before trusting a number:

- **Freshness is two timestamps, not one.** Every section carries `as_of`
  (when it was computed — always now) and `data_as_of` (the newest source
  record behind it, or `null`). A section computed a second ago from a
  three-week-old receipt is three weeks old and says so.
- **Failures are visible, not silent.** Each section is an envelope with its
  own `status` of `ok` or `failed`; a business is `ok` / `degraded` /
  `unavailable` with a `failed_sections` list. One business's ROI outage
  leaves every other business — and every other section of that same
  business — intact and real. `portfolio_totals.excluded` names every
  business and section missing from the totals, so a partial total is never
  presented as complete.

Every item carries an `evidence` link (`kind`, `id`, `business_id`, `href`)
pointing at the real record it came from — drill into it on the owning
surface below.

Naming a business outside your `business_access` grant is a `403` listing
`denied_business_ids`, not a partial answer: a summary of the three
businesses you were allowed must never be mistaken for a summary of the five
you asked about. Call `/command-centre/scope` first to see exactly what you
may select (it also reports `unknown_business_ids` — ids in your grant with
no matching business).

`?portfolio_id=` from the dashboard route is not offered over BAP: a
portfolio's membership can change under you between two identical calls, and
its members are a set you never named. Name your businesses explicitly.

> **Not a replacement for the per-business surfaces it summarises.** Each
> section has its own endpoint returning full records — Decision Queue
> (`decision_queue:read`), Receipts (`receipts:read`), Outcomes
> (`outcomes:read`), Connectors (`connectors:read`). This one returns a
> bounded, ranked overview across many businesses, `sample_size` items per
> section rather than the whole list. Triage here, then drill in there via
> each item's `evidence.id`. Holding `command_centre:read` does not confer
> those four grants, and none of them confers this one.

There is no write path. Approving from a summary card would skip the policy
re-check the Decision Queue performs at the moment of decision, so it does
not exist here for an agent any more than it does for a human.

### Portfolios (2026-08)
```
GET /api/bap/v1/portfolios                  — portfolios containing a business you can read
GET /api/bap/v1/portfolios/:id              — membership + membership-change history
GET /api/bap/v1/portfolios/:id/comparison   — the per-metric comparative view
```
Read-only, permission `portfolios:read`. A portfolio is a saved, named
grouping of businesses — "UK shops", "Q3 turnaround" — and membership
**overlaps** on purpose: the same shop is in both of those at once. The
comparison lays it out one row per **metric**, one cell per business, ranked,
across goals, Blueprint spend, outcomes, risk and connector health. Use
`?window_days=` (1–365, default 30) on the comparison and `?history_limit=`
(0 omits it) on the detail.

Note these paths carry no `:businessId` — a portfolio spans businesses by
definition. Scoping comes from your `business_access` grant instead.

**Read the honesty markings before you quote a number.** Every cell has a
`state` of `known` / `unknown` / `not_comparable` with a citation or a reason:

- `unknown` is **not zero.** It means Blueprint could not measure that, and it
  is excluded from the row's aggregate with the omission named in
  `aggregate.excluded`. A total that quietly skipped two businesses would read
  as complete.
- `not_comparable` means the figure genuinely cannot be ranked across *these*
  businesses, because it is derived differently for each — one business's
  "$/month" is directly observed revenue, another's is a benchmark
  coefficient applied to a proxy metric. Both are currency; they are not the
  same kind of number. Such a row comes back with `ranking: null` and an
  aggregate whose own field is `not_comparable`, so **there is no ranked
  figure to read off** — the per-business cells are still there, and putting
  them in an order yourself is exactly the fabrication this marking exists to
  prevent. `coverage.not_comparable_metrics` lists every such row up front,
  and `comparability_reason` explains each one.
- `caveats` is a list of plain sentences meant to be read before acting, and
  `membership_changes_in_window` is why: a business that joined the portfolio
  partway through the window has been observed for less time than the others,
  so its column is not like-for-like.

If part of a portfolio is outside your `business_access`, you get the part you
can read, never the rest — the inaccessible members' ids, names and every
figure derived from them are withheld, and they contribute to no cell, rank,
total or caveat. What you do get is an `access` block with
`complete: false` and an `excluded_member_count`, so you can tell a partial
portfolio from a whole one. Report it as partial. A portfolio in which you can
read nothing at all is a `403`.

There is no BAP path to create, rename, delete or change the membership of a
portfolio. Which businesses get compared together is an operator's editorial
choice about their own view, not something to reshape while being measured
by it.

> **Not to be confused with the operating-policy portfolios behind `GET
> /businesses/:id/operating-policy` (`operating_policies:read`).** Those are a
> different table with the opposite rule: they *partition* businesses — a
> business can be in only one — because they exist to apply one operating
> policy across several businesses, and policy inheritance has no answer to
> "which of my two portfolios' thresholds wins". The portfolios in this
> section are reporting groupings, they overlap freely, and they govern
> nothing.

### Digest (2026-08)
```
GET  /api/bap/v1/businesses/:id/digest             — the catch-up digest
GET  /api/bap/v1/businesses/:id/digest/watermark    — this agent's current catch-up point
POST /api/bap/v1/businesses/:id/digest/acknowledge  — advance this agent's watermark
```
Read-only, permission `digest:read`. The #62 "what happened while I was
away" digest, unchanged from what the dashboard gets: four sections —
`verified_outcomes` (a measurement actually landed), `pending_decisions`
(straight from the Decision Queue), `failures_and_stale_data` (broken
connectors, open system issues, failed executions), `informational_activity`
(everything else, deliberately low-signal and last). Every item cites the
exact table/row it came from — nothing here is a synthesised count.

Repeats collapse into one entry with `occurrence_count` and
`first_occurrence_at`/`last_occurrence_at`, but a repeat that got WORSE is
never buried in that collapse: it's promoted to the worse severity and
stamped with an `escalation` explaining what changed, citing both the first
and the escalated occurrence. Read `escalation` before treating an
`occurrence_count > 1` item as "just a duplicate."

**Your watermark is your own — not the dashboard operator's.** The digest's
catch-up point is stored per caller, and a BAP agent's storage is a
genuinely separate dimension from the human operator's dashboard-session
watermark (different table, keyed on your agent id, not a username). Your
calls can never advance, and are never affected by, what a human operator has
acknowledged in the dashboard, or vice versa.

**GET never advances your watermark.** Call it as many times as you want —
polling on a schedule is fine and won't cause you to silently lose track of
what you've genuinely seen. Advancing is a separate, explicit step:
`POST .../digest/acknowledge`. If you don't call it, your next `GET` (without
`since=`) replays the same window. Body is optional — omit it entirely (or
omit `items`) and the server acknowledges exactly what the digest you'd get
right now would show; only pass `items`/`acknowledged_through`/`digest_id`
yourself if you're acknowledging a digest you fetched earlier and want to be
precise about what you actually consumed.

`?since=<ISO>` overrides your stored watermark for that one read (both the
window floor and the seen-item suppression) **without mutating it** — a
one-off look back at a period doesn't cost you your catch-up position. Omit
it to read "everything since I last acknowledged." `?until=` (default now)
and `?limit=` (items per section) are also supported.

There is no cross-business digest over BAP — each call is scoped to one
`:id`. For a ranked cross-business overview, see Command Centre above;
for the full per-business catch-up, call this once per business you run.

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
| `comparisons:read` | List comparable candidates, build a side-by-side comparison |
| `command_centre:read` | Read the cross-business executive summary and your selectable scope |
| `portfolios:read` | Read saved multi-business portfolios, their membership history and comparative view (not the operating-policy portfolios — see above) |
| `digest:read` | Read the "while you were away" catch-up digest and advance your own digest watermark (a dimension separate from the dashboard operator's) |

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
