# Blueprint Skill

A business intelligence system that monitors your connected tools,
detects signals in the data, and manages a task queue with human
approval. When you install this skill you become a participant in
Blueprint's signal → goal → task → approval → execution → outcome loop.

This document is generated to match the implemented BAP (Blueprint Agent
Protocol) surface exactly — every endpoint, parameter, and response field
below is verified against the actual route code, not aspirational. For the
complete machine-readable contract (full request/response JSON Schemas,
every error response, every permission), see
[`docs/openapi/bap-v1.yaml`](docs/openapi/bap-v1.yaml). This file is the
narrative "when and why" companion to that spec.

**Everything you need to operate Blueprint autonomously is reachable
through BAP.** You should never need to scrape the dashboard UI or guess
at state. If you find yourself needing to do either, that's a gap — file
it via `BLUEPRINT_KB_WRITE` (`research/` or `decisions/`) so it gets
picked up.

---

## Setup

You need three environment variables before any Blueprint tool works:

```
BLUEPRINT_URL=http://your-blueprint-instance:4000
BLUEPRINT_API_KEY=bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BLUEPRINT_BUSINESS_ID=biz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Get your API key (run once):**

Registration requires either a logged-in Blueprint dashboard session, or a
`BAP_REGISTRATION_SECRET` configured by the operator (ask them for it — it's
set in their `.env`, not something you can obtain yourself). Wildcard
permissions and wildcard business access (`"*"`) are never granted by
self-registration, no matter what you request — request only the specific
permissions and business IDs you need, and ask the operator to grant more
via the dashboard if required.

```bash
curl -X POST $BLUEPRINT_URL/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -H "X-Registration-Secret: $BLUEPRINT_REGISTRATION_SECRET" \
  -d '{
    "name": "YourAgentName",
    "requested_permissions": [
      "signals:read", "signals:create",
      "tasks:read", "tasks:propose", "tasks:approve",
      "goals:read", "goals:propose", "goals:update",
      "connectors:read", "connectors:sync",
      "outcomes:read", "audit:read",
      "kb:read", "kb:write",
      "metrics:read", "agents:read", "agents:trigger"
    ],
    "business_access": ["biz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]
  }'
```

The full grantable permission list is exactly: `signals:read`,
`signals:create`, `tasks:read`, `tasks:propose`, `tasks:approve`,
`goals:read`, `goals:propose`, `goals:update`, `connectors:read`,
`connectors:sync`, `outcomes:read`, `audit:read`, `kb:read`, `kb:write`,
`metrics:read`, `agents:read`, `agents:trigger`. Requesting anything else is
silently dropped, not an error. There is no `signals:update` or
`tasks:update` permission — updating a signal's status or approving a task
is gated by `signals:read` / `tasks:approve` respectively (see the
Signals/Tasks sections below).

Store the returned `api_key`. Shown once only — if you lose it, register a
new agent rather than trying to recover it.

**Find your business ID (and every business you can see):**
```bash
curl $BLUEPRINT_URL/api/bap/v1/me \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

The `businesses` array in the response is the answer to "what businesses
exist" — filtered to ones your key has access to. There is no separate
"list all businesses" endpoint; this is it.

---

## Conventions

These apply to every endpoint below — read this once rather than
re-deriving it per-call.

**Auth.** Every route except `POST /register` and `GET /discover` requires
`BAP-Key: $BLUEPRINT_API_KEY` (or `Authorization: Bearer $BLUEPRINT_API_KEY`).

**Idempotency.** Every mutating endpoint (anything that creates or changes
state — proposing a task, approving one, creating a signal, writing to the
KB, proposing or updating a goal, triggering a sync or an agent run,
cancelling/retrying a run or job) **requires** an `Idempotency-Key` header.
Reusing the same key with the same request body replays the original
response instead of re-running the action — this is how you safely retry a
timed-out call without risking a duplicate task, signal, or KB write.
Generate a fresh UUID per distinct action; reuse the same key only when
retrying the exact same call.

**Pagination.** Every list endpoint accepts `?page=1&limit=50` (limit caps
at 200, defaults to 50) and returns:
```json
{ "<data_key>": [...], "total": 42, "pagination": { "page": 1, "limit": 50, "total": 42, "pages": 1 } }
```
`total` is kept at the top level for backwards compatibility alongside the
newer `pagination` object — read whichever you prefer, they're always equal.

**Filtering.** Most list endpoints accept comma-separated values for
multi-select filters (e.g. `?status=open,acknowledged`) and a `q` param for
a LIKE-based text search over title/description.

**Timestamps.** Always full ISO-8601 UTC (`2026-01-15T07:23:41.000Z`) in
every response, regardless of how the underlying row was stored.

**Request/correlation IDs.** Every response carries `X-Request-Id` (unique
per call) and `X-Correlation-Id` (echoes what you send, or defaults to the
request ID). Send your own `X-Correlation-Id` to tie a multi-call workflow
together (e.g. "investigate signal X" spanning several GETs and a propose)
for easier debugging on the operator's side.

**Errors.** `{"error": "human-readable message", "code": "...", "request_id": "..."}`.
`code` is one of `validation_error | not_found | permission_denied |
conflict | rate_limited | internal_error`. Some older routes only return
`{"error": ...}` without `code`/`request_id` — always check `error` first,
treat the other two as present-when-available.

**Rate limits.** Default: 60 calls/minute per agent. Tighter limits on a
few expensive/sensitive routes: `kb:write` 20/min, `kb:query` 10/min,
`agents:trigger` 5/min, `register` 5 per 5 minutes. A 429 includes
`retry_after_seconds`.

**Cross-tenant safety.** Every route scopes to businesses your key has
`business_access` for. Routes without a `:businessId` in the path (e.g.
`GET /tasks/:taskId`) still enforce this — they look the resource up, then
check your permission against *that resource's* actual business, returning
403 if it's not one of yours. You never need to (and can't) pre-filter by
business yourself.

---

## Tools

---

### BLUEPRINT_HEALTH

Get current business health — score, open signal counts, task counts, a
metrics snapshot per connector, and recent agent-run activity.

**When to use:**
- Start of every session
- Morning briefings
- Before proposing tasks
- Any time you need situational awareness

```bash
curl $BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/health \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response shape:**
```json
{
  "business": { "id": "biz_xxx", "name": "...", "slug": "...", "type": "..." },
  "health_score": 74,
  "period": "last_7_days",
  "signals": {
    "total": 4, "critical": 1, "alert": 2, "warning": 1, "info": 0,
    "top_signals": [
      { "id": "sig_xxx", "title": "LCP regression on mobile", "severity": "critical", "connector_id": "conn_xxx", "confidence": 0.87, "created_at": "2026-01-15T07:23:41.000Z" }
    ]
  },
  "tasks": { "proposed": 3, "approved": 1, "executing": 1, "completed_7d": 8, "pending_approval": 3 },
  "metrics": { "ga4": { "sessions": 4821, "bounce_rate": 0.42 }, "shopify": { "revenue_30d": 13429.90 } },
  "agents": { "last_run": "2026-01-15T06:00:00.000Z", "runs_today": 2, "tasks_proposed_today": 1 }
}
```

`health_score` can be `null` if no analysis run has completed yet for this
business — don't assume it's always a number.

**Interpret the score:**
- 80–100: healthy, routine monitoring
- 60–79: some issues, review open signals
- 40–59: degraded, action likely needed
- below 40: critical, immediate attention

---

### BLUEPRINT_SIGNALS

Search signals Blueprint has detected — anomalies, opportunities, risks,
and AI-generated insights from all connected data sources.

**When to use:**
- Human asks "what's happening with the business"
- Health score is below 70
- Before proposing tasks or creating a signal — check if it already exists
- Any investigation into why a metric changed

```bash
# Open signals (the default)
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Search + filter + sort + paginate
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals?q=ranking&severity=critical,alert&status=all&sort=confidence&order=desc&page=1&limit=20" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `q` (title/description search), `severity`
(`info,warning,alert,critical`), `status` (defaults to `open`; pass
`status=all` to see acknowledged/resolved/snoozed/dismissed too),
`connector` (a `connector_id`), `type` (`anomaly,opportunity,risk,correlation`),
`created_from`/`created_to` (ISO date). `sort` is one of `created_at`,
`resolved_at`, `severity`, `confidence` (default `created_at desc`).

**Response:** `{ "signals": [...], "total": N, "filters_applied": {...}, "pagination": {...} }`.

---

### BLUEPRINT_SIGNAL_DETAIL

Get everything about one signal: the raw evidence payload, AI attribution
(if analyzed), related signals (same cluster, or same connector+detector),
related tasks proposed from it, the source connector's freshness, and its
full resolution history.

**When to use:**
- Investigating a specific signal before acting on it
- Checking whether a signal already has a task proposed against it
(`related_tasks`)

```bash
curl "$BLUEPRINT_URL/api/bap/v1/signals/$SIGNAL_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ signal, evidence, attribution, related_signals, related_tasks, connector_freshness, resolution_history }`.
`evidence` is the signal's raw `data` payload. `attribution` includes
`primary_cause`/`primary_confidence`/`recommendation` when AI analysis has
run for this signal type — all `null` otherwise.

---

### BLUEPRINT_UPDATE_SIGNAL

Change a signal's status — acknowledge it, resolve it, snooze it, or
dismiss it.

**When to use:**
- You've addressed what a signal was pointing at (directly or via a task
  that's now complete)
- A signal is a known false positive or not worth acting on

```bash
curl -X PATCH "$BLUEPRINT_URL/api/bap/v1/signals/$SIGNAL_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "status": "resolved", "note": "Fixed via tsk_xxx" }'
```

`status` is required (`open`, `acknowledged`, `resolved`, `snoozed`, or
`dismissed` are the conventional values — there's no server-side enum
check, so use these). Setting `resolved` also stamps `resolved_at`. This
route is gated by `signals:read`, not a `signals:update` permission — there
isn't one.

---

### BLUEPRINT_CREATE_SIGNAL

Tell Blueprint about something you detected that its connectors wouldn't
catch — conversations, external research, social media, news, competitor
activity.

**When to use:**
- You notice something relevant while browsing or researching
- Human mentions something that affects the business
- You find external information that suggests a risk or opportunity

**When NOT to use:**
- For things Blueprint already detects from its connectors
- Run `BLUEPRINT_SIGNALS` first — don't create duplicates

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "type": "opportunity",
    "severity": "info",
    "title": "Competitor out of stock on rustic wall signs",
    "description": "Main competitor showing out-of-stock on their rustic wall sign range. Potential to capture traffic.",
    "data": { "competitor_url": "https://competitor.com/rustic-signs" },
    "confidence": 0.72
  }'
```

`type`, `severity`, and `title` are required. `type` values: `anomaly` ·
`opportunity` · `risk` · `correlation`. `severity` values: `info` ·
`warning` · `alert` · `critical`.

**Response:** `{ "signal_id": "sig_xxx", "created": true }` (201).

---

### BLUEPRINT_TASKS

Search the task queue — proposed, approved, executing, completed, or
rejected actions from Blueprint's internal agents and from external agents
like you.

**When to use:**
- Before proposing a task — check nothing similar already exists
- Human asks what's pending approval or what's been done
- Checking on something you proposed earlier

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/tasks?status=proposed&priority=p1,p2&sort=created_at&order=desc" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `q`, `status` (comma-separated), `priority`
(`p1,p2,p3`), `action_type`, `created_by` (matches `proposed_by`, e.g.
`bap:agt_xxx`), `assigned_agent`, `signal_id`, `goal_id` (best-effort —
see note below), `created_from`/`created_to`. `sort`/`order` as with
signals.

> **`goal_id` filter note:** goals and tasks have no direct foreign key
> today — they only share an optional `project_id` column. The `goal_id`
> filter resolves the goal's `project_id` and filters tasks by that; if the
> goal has no `project_id`, the filter returns zero tasks rather than
> silently ignoring it. Treat any goal↔task linkage in this API as a
> best-effort proxy, not a guaranteed relationship.

**Response:** `{ "tasks": [...], "total": N, "pagination": {...} }`. Each
task includes `action_payload` and `outcome_data` as parsed objects.

---

### BLUEPRINT_TASK_DETAIL

Full detail on one task: approval status, execution state (with any
execution jobs), linked signal, best-effort linked goals, parent/child task
dependencies, outcome status, and an audit summary.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:**
```json
{
  "task": { "...": "full task row" },
  "approval": { "status": "approved", "approved_by": "bap:agt_xxx", "approved_at": "...", "trust_tier": "yellow", "approval_mode": "requires_approval" },
  "execution": { "status": "executing", "started_at": "...", "completed_at": null, "active_job_id": "job_xxx", "jobs": [...] },
  "linked_signal": { "id": "sig_xxx", "title": "...", "...": "..." },
  "linked_goals": [{ "id": "goal_xxx", "title": "...", "status": "active", "progress_pct": 40 }],
  "dependencies": { "parent_task": null, "child_tasks": [] },
  "outcome": { "target_metric": "gsc.avg_ctr", "target_metric_baseline": 2.1, "checks": [...], "status": "measuring", "is_final": false },
  "audit_summary": { "total_events": 3, "last_action": { "action": "approve", "actor": "bap:agt_xxx", "at": "..." } }
}
```

`outcome.status` is one of `pending | measuring | successful | neutral |
unsuccessful | abandoned | null` (`null` when the task has no
`target_metric`) — see `BLUEPRINT_OUTCOMES` below for the full vocabulary.

---

### BLUEPRINT_TASK_HISTORY

The narrative event timeline for a task — the same feed the dashboard's
task detail page shows (created, approved, status changes, etc).

```bash
curl "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID/history" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "task_id": "tsk_xxx", "events": [{ "type": "approved", "actor": "bap:agt_xxx", "message": "...", "created_at": "..." }, ...] }`.

---

### BLUEPRINT_PROPOSE_TASK

Propose an action for the human to approve. Tasks you propose enter the
same approval queue as tasks from Blueprint's internal agents.

**When to use:**
- Human asks you to fix, improve, or action something
- You identify an issue that needs a specific action
- A signal you read suggests a clear next step

**When NOT to use:**
- Things you can do yourself without Blueprint (just do them)
- Vague intentions ("improve SEO") — be specific or don't propose
- Duplicating a task Blueprint has already proposed — run
  `BLUEPRINT_TASKS` first

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/tasks" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "title": "Rewrite meta description for /products/door-toppers",
    "description": "Current meta is 47 chars with no target keywords. GSC shows 0.8% CTR vs 3.2% category average.",
    "action_type": "meta_update",
    "priority": "p2",
    "confidence": 0.84,
    "estimated_impact": "Estimated +2.4% CTR based on similar pages",
    "signal_id": "sig_xxx",
    "action_payload": {
      "url": "/products/door-toppers",
      "current_meta": "Door toppers for sale",
      "suggested_meta": "Transform your doorway with handcrafted oak door toppers — personalised and made in Wales. From £29.99."
    }
  }'
```

Only `title` is required, but `action_type` and `action_payload` are what
let an approved task actually execute automatically (rather than sitting in
`manual_review`) — supply them whenever the action is a known automatable
type. `priority` values: `p1` urgent · `p2` normal · `p3` low.

**Response:** `{ "task_id": "tsk_xxx", "status": "proposed", "trust_tier": "yellow", "approval_required": true }` (201).

After proposing, tell the human:
*"I've proposed [title] in Blueprint — it's waiting for your approval."*
Do not say you've done the thing. You've proposed it.

---

### BLUEPRINT_APPROVE_TASK

Approve, reject, or cancel a task. Requires `tasks:approve` — a stronger
grant than `tasks:propose`; only request it if you're actually meant to be
making approval decisions (most external agents propose and let a human
approve).

```bash
curl -X PATCH "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "action": "approve", "note": "Looks good" }'
```

`action` is `approve`, `reject`, or `cancel` (required). `reject`/`cancel`
use `note` or `reason` for the explanation. Approving atomically enqueues a
durable execution job — this is the same code path the dashboard and
Telegram use, so an approval here executes for real, not just changes
status. `cancel` is only valid from `proposed`/`approved`/`manual_review`
and also cancels any active execution job.

**Response:** `{ "task_id": "tsk_xxx", "status": "approved", "action": "approve" }`. 422 if the action doesn't apply to the task's current state.

---

### BLUEPRINT_EXECUTION_JOBS

List or inspect the durable execution jobs behind approved tasks —
Blueprint's write-back layer (GitHub, Shopify, etc). Most tasks execute
without you ever needing this; use it when a task has been `approved` for
a while but isn't `complete` yet.

```bash
# List, filterable by status (queued/leased/executing/complete/failed/dead_letter/manual_review/cancelled)
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/execution-jobs?status=dead_letter,manual_review" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Detail
curl "$BLUEPRINT_URL/api/bap/v1/execution-jobs/$JOB_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Retry a dead-lettered/manual-review/cancelled job (requires tasks:approve)
curl -X POST "$BLUEPRINT_URL/api/bap/v1/execution-jobs/$JOB_ID/retry" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"

# Cancel a queued/manual-review job (requires tasks:approve)
curl -X POST "$BLUEPRINT_URL/api/bap/v1/execution-jobs/$JOB_ID/cancel" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```

Retry/cancel return 409 if the job isn't in a state that allows the action
— check `status` first if you're unsure.

---

### BLUEPRINT_GOALS

Goals are first-class: what the business is trying to achieve, with a
baseline, target, deadline, and measured progress. Always check existing
goals before proposing a new one or a task that duplicates one.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/goals?status=active&q=organic+traffic" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `q`, `status` (`active,paused,achieved,missed,cancelled`
— defaults to everything except `cancelled`), `tags` (comma-separated).

**Response:** `{ "goals": [...], "total": N, "pagination": {...} }`. Each
goal includes `metric_name`/`metric_baseline`/`metric_target`/
`metric_current`/`metric_unit`/`progress_pct`/`deadline`/`milestones`
(array)/`tags`(array)/`assigned_agents`(array).

---

### BLUEPRINT_GOAL_DETAIL

Full detail: progress history (`goal_checks`), best-effort linked
tasks/signals (via shared `project_id` — same caveat as the task list's
`goal_id` filter), blockers (open conflicts + a `deadline_at_risk` flag),
and conflicts.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ goal, linked_metrics, linked_tasks, linked_signals, progress: { progress_pct, last_checked, checks }, blockers: { open_conflicts, deadline_at_risk }, conflicts }`.

---

### BLUEPRINT_PROPOSE_GOAL

Propose a new goal for the business.

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/goals" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "title": "Grow organic clicks 20% by Q2",
    "description": "Focus on category pages with declining CTR.",
    "deadline": "2026-06-30",
    "metric_name": "gsc.total_clicks",
    "metric_target": 1450,
    "strategy": "Prioritise meta rewrites on top-traffic pages first.",
    "tags": ["seo", "q2-2026"]
  }'
```

`title` is required. If `metric_baseline` is omitted but `metric_name` is
given, Blueprint auto-fills the baseline from the latest matching metric.
Creating a goal fires background goal-reasoning and conflict-detection —
don't expect `linked_metrics`/`conflicts` to be populated instantly; poll
`BLUEPRINT_GOAL_DETAIL` after a few seconds if you need them.

**Response:** `{ "goal": {...} }` (201).

---

### BLUEPRINT_UPDATE_GOAL

Update a goal's fields — progress, status, deadline, strategy, milestones,
notes, tags, etc.

```bash
curl -X PATCH "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "status": "paused", "notes": [{ "author": "you", "text": "Paused pending Q2 budget review." }] }'
```

Updatable scalar fields: `title`, `description`, `status`, `deadline`,
`metric_name`, `metric_baseline`, `metric_target`, `metric_unit`,
`strategy`, `project_id`. Updatable array fields (replace-whole-array, not
merge): `assigned_agents`, `milestones`, `notes`, `tags`. `status` must be
one of `active | paused | achieved | missed | cancelled`. To archive a goal
specifically, prefer `BLUEPRINT_ARCHIVE_GOAL` below (same effect, clearer
intent).

**Response:** `{ "goal": {...} }`.

---

### BLUEPRINT_ARCHIVE_GOAL / BLUEPRINT_CHECK_GOAL

```bash
# Soft-cancel (sets status='cancelled')
curl -X POST "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/archive" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"

# Force an immediate progress recompute (normally runs on a schedule)
curl -X POST "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/check" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```

---

### BLUEPRINT_GOAL_CONFLICTS

All conflicts (open or resolved) referencing a specific goal — e.g. a task
that works against it, or two goals pulling in different directions.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/conflicts" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

---

### BLUEPRINT_CONNECTORS

List every connected data source with its live freshness status — the
answer to "are my connectors fresh". `credentials` is never returned by
any connector endpoint, under any circumstances.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/connectors" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "connectors": [...], "total": N, "pagination": {...} }`.
Each connector: `{ id, type, name, status, raw_status, last_sync,
last_error, config_summary, hours_since_sync, next_sync_in_minutes,
stale_threshold_hours, created_at }`. `status` is the computed freshness
state (`connected`, `stale`, `error`, `disconnected`, ...) — the same
live-computed value the dashboard's System Health page shows, so you and a
human looking at the dashboard never disagree about whether something is
stale. `raw_status` is the underlying DB column if you need it.
`config_summary` is a whitelisted, non-secret subset of `config` (URL,
site URL, property ID, repos, etc).

**Detail (adds sync stats):**
```bash
curl "$BLUEPRINT_URL/api/bap/v1/connectors/$CONNECTOR_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
`{ connector, sync_stats: { total_syncs, failed_syncs, complete_syncs, avg_duration_ms, last_sync_attempt_at }, metrics_stored }`.

**Sync history:**
```bash
curl "$BLUEPRINT_URL/api/bap/v1/connectors/$CONNECTOR_ID/syncs?status=failed" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Trigger a sync now (requires `connectors:sync`):**
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/connectors/$CONNECTOR_ID/sync" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
Returns 202 immediately (`{ connector_id, status: "syncing", message }`) —
the sync runs in the background. Poll `.../syncs` for its outcome.

---

### BLUEPRINT_OUTCOMES

Whether past actions actually worked — the single most important check
before proposing a task similar to one done before.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/outcomes?action_type=meta_update&status=successful" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

Only tasks with a `target_metric` set appear here at all — most tasks
without one are excluded, not shown as `null`. **Filter params:** `status`
(the mapped vocabulary below), `action_type`, `proposed_by`.

**Status vocabulary** (mapped from the DB's raw `improved`/`worsened`/
`no_change` verdicts — this mapping is a pure function, see
`server/tasks/outcome-status.ts` if you need the exact rules):
| `status` | Meaning |
|---|---|
| `pending` | Task not yet complete, or complete <14 days ago (grace period before the first check is due) |
| `measuring` | Complete >14 days, first outcome check hasn't landed yet, or verdict inconclusive |
| `successful` | Latest check verdict is `improved` |
| `neutral` | Latest check verdict is `no_change` |
| `unsuccessful` | Latest check verdict is `worsened` |
| `abandoned` | Task was rejected, cancelled, or failed |

`is_final` is `true` once a check ≥4 weeks after completion exists — before
that, treat the status as provisional.

**Single-task outcome (adds confidence calibration and a recommendation):**
```bash
curl "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID/outcome" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
`confidence: { stated, calibrated, agent_calibration }` — `calibrated`
adjusts the task's stated confidence using that agent's historical
accuracy, if calibration data exists. `recommendation: { action_type,
sample_size, success_rate }` — the historical hit-rate for this
`action_type` in this business, from other final outcomes. `sample_size:
0` (and `success_rate: null`) means no prior data — treat your own
confidence as unadjusted in that case.

---

### BLUEPRINT_TRIGGER_AGENT

Trigger an internal Blueprint agent to run immediately.

**When to use:**
- Human wants a specific agent to run now
- You've added new KB content an agent should incorporate

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/agents/seo-sentinel/run" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason": "User requested immediate SEO check"}'
```

Do not assume a fixed roster of agent IDs — installed agents vary per
instance and per business. Discover which are actually available with:
```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/agents" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
`{ "agents": [{ id, name, status, last_run, next_run, run_count, total_cost_usd }, ...] }` —
`run_count`/`total_cost_usd`/`last_run` are scoped to this business only.

**Response (trigger):** `{ "run_id": "run_xxx", "agent_id": "seo-sentinel", "status": "queued" }` (202) — fire-and-forget, poll for status (below).

---

### BLUEPRINT_RUNS

List agent runs, or inspect/cancel/retry one.

```bash
# List, filterable by agent_id/status/trigger
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/runs?status=failed" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Single-run detail (reasoning, cost, counts)
curl "$BLUEPRINT_URL/api/bap/v1/runs/$RUN_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Cancel a running run** (requires `agents:trigger`) — **honesty note:**
this is a DB-status flip (`running` → `cancelled`) for tracking/cost-cap
purposes only. It does **not** interrupt an in-flight LLM call or task
creation already under way; there is no abort mechanism in the underlying
agent runner. Don't rely on it to stop side effects mid-run.
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/runs/$RUN_ID/cancel" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
409 if the run already finished.

**Retry a failed run** (requires `agents:trigger`) — re-triggers the same
`(agent_id, business_id)` as a fresh run; it does not replay the exact
original inputs (nothing about a past run's inputs is snapshotted).
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/runs/$RUN_ID/retry" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
`{ "run_id": "run_new", "retried_from": "run_old", "agent_id": "...", "status": "queued" }` (202). 422 if the run isn't `failed`.

---

### BLUEPRINT_KB_QUERY

Ask a question answered from the business knowledge base. The KB contains
brand voice, strategy, decisions, research, competitive intelligence, and
everything agents have learned over time. It compounds — the longer
Blueprint has been running, the more valuable it is.

**When to use:**
- Before writing any content — check brand voice and style first
- Before making recommendations — check existing strategy
- Human asks how something was decided or why something is the way it is
- Any time you'd otherwise be guessing about the business

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/query" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is our brand voice and tone?",
    "context": "I am about to write a product description for door toppers"
  }'
```

**Response:** `{ "answer": "...", "sources_read": ["concepts/brand-voice.md", ...], "filed_as": null }`.
`context` is optional but improves answer quality. No `Idempotency-Key`
needed — this is a read, not a write (rate-limited to 10/min instead).

---

### BLUEPRINT_KB_WRITE

Write a page to the knowledge base. Research, decisions, insights,
competitive intelligence — anything worth keeping. Filed pages persist
across all sessions and are read by every agent.

**When to use:**
- You've done research worth keeping
- Human shares something important that should be remembered
- You reach a conclusion that future agents should know

**Directory rules (follow these exactly):**
| Directory | Use for |
|-----------|---------|
| `research/` | External findings, competitor intel, market data |
| `decisions/` | Things the human decided, with context and rationale |
| `concepts/` | Strategic principles, brand guidelines, positioning |
| `signals/` | Do not write here — Blueprint writes this automatically |
| `raw/` | Do not write here — for source documents only |

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/write" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "path": "research/competitor-rustic-signs-jan-2026.md",
    "content": "# Competitor Analysis — Rustic Signs\n\n## Finding\n\nMain competitor is out of stock on their rustic wall sign range as of 15 Jan 2026.\n\n## Opportunity\n\nTarget [[entities/rustic-signs]] keywords while stock is depleted.",
    "frontmatter": {
      "title": "Competitor Analysis — Rustic Signs Jan 2026",
      "tags": ["research", "competitors"],
      "written_by": "your-agent-name",
      "confidence": 0.72
    }
  }'
```

Use `[[wikilinks]]` to reference other KB pages. Always include
`written_by` in frontmatter with your agent name. `path` and `content` are
required; a path attempting to escape the KB root (`../`) is rejected with
400.

---

### BLUEPRINT_KB_SEARCH

Search the knowledge base for relevant pages by keyword.

**When to use:**
- Before querying — find which pages exist on a topic
- Before writing — check nothing similar already exists

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/search?q=brand+voice&limit=5" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "results": [{ "path": "concepts/brand-voice.md", "matches": [...] }], "query": "brand voice" }`.
An empty `q` returns `{ "results": [] }`, not an error.

---

### BLUEPRINT_METRICS

Get raw connector data — actual numbers from GA4, GSC, Shopify, Stripe, and
every other connected source.

**When to use:**
- Human asks specific data questions ("how many visitors last week")
- You need numbers to support a recommendation
- You need a baseline before proposing a change or a goal

```bash
# Latest snapshot across every connected source
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/metrics/snapshot" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Raw metric history, filterable by connector/metric name
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/metrics?connector=gsc&limit=30" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Snapshot response:**
```json
{
  "snapshot_at": "2026-01-15T14:00:00.000Z",
  "connectors": {
    "gsc": { "total_clicks": 1204, "avg_position": 8.2 },
    "shopify": { "revenue_30d": 13429.90, "orders_30d": 164 }
  }
}
```
Snapshot only includes connectors with `status = 'connected'` — use
`BLUEPRINT_CONNECTORS` to check whether a missing connector here means "no
data" or "connector is stale/errored".

---

### BLUEPRINT_AUDIT

The full audit trail — who did what, when, across tasks, signals,
connectors, business changes, and agent actions.

**When to use:**
- Verifying a task/signal/connector's change history
- Answering "who approved this" or "when did this connector get reconfigured"

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/audit?entity_type=task&entity_id=$TASK_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `entity_type` (one of `task, signal, business,
connector, agent, agent_file, server_file` — anything else is a 400; the
whitelist is deliberate, not an oversight), `entity_id`, `action`, `actor`,
`date_from`/`date_to`.

**Response:** `{ "entries": [...], "total": N, "pagination": {...} }`. Any
key that looks like a credential/secret/token/password/API key (in
`before_state`, `after_state`, or `metadata`) is replaced wholesale with
`"[redacted]"` before you ever see it — this is defense-in-depth on top of
the entity-type whitelist, not something you need to additionally sanitize
on your end.

---

## Patterns

These are the standard sequences for common situations. Follow these
rather than deciding the order yourself — they're designed so you never
need anything outside BAP to complete them.

---

### Morning briefing

When asked for a morning update, daily summary, or "what's happening":

```
1. BLUEPRINT_HEALTH                              → score, signal/task counts, metrics
2. BLUEPRINT_SIGNALS (severity=critical,alert)    → urgent items needing a name
3. BLUEPRINT_TASKS (status=proposed)              → what's waiting for approval
4. BLUEPRINT_CONNECTORS                           → any connector stale/errored?
5. BLUEPRINT_GOALS (status=active)                → progress, anything at-risk (deadline_at_risk)
6. BLUEPRINT_RUNS (status=running)                → anything still in flight
7. Compose summary:
   - One sentence on health (score + direction)
   - Any critical/alert signals, named specifically
   - Count of tasks waiting for approval
   - Any stale/errored connector — flag explicitly, don't silently omit its data
   - Goal progress, flagging anything at-risk
   - One key metric per connected source
8. If health_score < 60, any critical signal, or a stale connector for a
   metric you're about to report on → flag that something needs attention
```

---

### Investigation

When asked why something is happening, what's wrong, or to look into a
specific signal:

```
1. BLUEPRINT_SIGNAL_DETAIL (or BLUEPRINT_SIGNALS if starting from scratch)
                                                  → evidence, attribution, related signals/tasks
2. BLUEPRINT_METRICS                             → raw numbers for the relevant connector
3. BLUEPRINT_TASK_HISTORY (if related_tasks non-empty)
                                                  → has this already been worked before?
4. BLUEPRINT_KB_QUERY                            → historical context, prior decisions
5. Synthesise: likely cause, impact, what should be done
6. BLUEPRINT_OUTCOMES (action_type=<the action you're about to recommend>)
                                                  → did this kind of action work before?
7. BLUEPRINT_PROPOSE_TASK if a specific action follows
```

---

### Content workflow

When writing content, or acting toward a goal:

```
1. BLUEPRINT_KB_QUERY ("What is our brand voice?")    → always first
2. BLUEPRINT_GOALS                                    → is there a goal this serves?
3. BLUEPRINT_SIGNALS                                  → anything already flagging this?
4. Write the draft, following what the KB says
5. BLUEPRINT_PROPOSE_TASK (action_type=content_draft or similar)
                                                       → if it should be published
6. BLUEPRINT_KB_WRITE                                 → file the draft/research for the record
7. After the task's outcome checks land: BLUEPRINT_OUTCOMES / task outcome
                                                       → close the loop, learn for next time
```

---

### Duplicate prevention

Before proposing *anything* (task, goal, or signal):

```
1. BLUEPRINT_TASKS (q=<keywords>, status=all)     → has this exact action already been proposed?
2. BLUEPRINT_SIGNALS (q=<keywords>, status=all)   → has this already been detected/flagged?
3. BLUEPRINT_GOALS (q=<keywords>)                 → is there already a goal for this?
4. Decide: if a live equivalent exists, reference
   it (or its ID) rather than creating a duplicate.
5. Only then propose.
```

This is not optional — it's the difference between Blueprint being a
reliable single source of truth and a queue full of near-duplicate noise.

---

### Long-running execution

When you've approved (or are watching) a task that executes asynchronously:

```
1. BLUEPRINT_APPROVE_TASK (action=approve)        → atomically enqueues an execution job
2. BLUEPRINT_TASK_DETAIL                          → execution.active_job_id, execution.jobs[]
3. BLUEPRINT_EXECUTION_JOBS (or job detail by ID) → poll status until complete/failed/dead_letter
   - If dead_letter or manual_review and it should be retried:
     BLUEPRINT_EXECUTION_JOBS retry (requires tasks:approve)
4. Once execution.status is complete/verified:
   outcome checks are scheduled automatically (2 and 4 weeks out) —
   nothing to trigger yourself.
5. After the check window: BLUEPRINT_OUTCOMES (or the task's outcome
   detail) → was it successful? File the learning: BLUEPRINT_KB_WRITE
   if the result should inform future similar tasks.
```

---

## Rules

**Read before you write.**
Before proposing a task, goal, or signal, check what Blueprint already
knows — see "Duplicate prevention" above.

**Be specific or don't propose.**
A task proposal must say exactly what should happen. Current state.
Proposed state. Why. Expected outcome.

**Honest confidence scores.**
0.85+ → confident. 0.70–0.84 → note uncertainty. Below 0.50 → investigate
more. When outcome data exists for the action type, prefer the calibrated
confidence (`BLUEPRINT_OUTCOMES` task detail) over your own stated guess.

**You propose. The human approves.**
Never tell the human you've done something when you've proposed it. Only
say "done" for actions you're actually authorized (`tasks:approve`) and
have actually taken.

**File valuable things.**
If you learn something worth keeping, write it to the KB. The KB compounds
across all sessions and all agents.

**Trust the freshness data, not silence.**
If a metric or connector's data is missing from a response, check
`BLUEPRINT_CONNECTORS` before assuming "no activity" — it may mean the
connector is stale or erroring, not that the number is genuinely zero.

**Blueprint unavailable.**
If API calls fail, continue without Blueprint. Note what to do when it
returns.

---

## Error reference

| Code / status | Meaning | Action |
|------|---------|--------|
| 400 `validation_error` | Missing/invalid field, or missing `Idempotency-Key` on a mutating call | Fix the request and retry |
| 401 | Invalid or expired API key | Re-register |
| 403 `permission_denied` | Missing permission, or the resource belongs to a business you don't have access to | Re-register with the required permission, or confirm the resource ID |
| 404 `not_found` | Business or resource not found | Verify the ID |
| 409 `conflict` | Idempotency key reused with a different body, an in-progress duplicate call, or an action that doesn't apply to the resource's current state (e.g. cancelling a finished run) | Check current state before retrying |
| 422 | Action valid in general but not for this resource's current status (e.g. approving an already-executing task) | Check status first |
| 429 `rate_limited` | Rate limited (see `retry_after_seconds`) | Wait and retry |
| 503 | Blueprint unavailable | Continue without it |

---

## Quick reference

```
BLUEPRINT_HEALTH             → situational awareness — start here
BLUEPRINT_SIGNALS             → search signals Blueprint has detected
BLUEPRINT_SIGNAL_DETAIL        → evidence, attribution, related signals/tasks
BLUEPRINT_UPDATE_SIGNAL        → acknowledge/resolve/snooze/dismiss a signal
BLUEPRINT_CREATE_SIGNAL        → tell Blueprint what you found externally
BLUEPRINT_TASKS                → search the task queue
BLUEPRINT_TASK_DETAIL          → approval/execution/outcome/audit detail
BLUEPRINT_TASK_HISTORY         → task event timeline
BLUEPRINT_PROPOSE_TASK         → suggest an action for human approval
BLUEPRINT_APPROVE_TASK         → approve/reject/cancel a task
BLUEPRINT_EXECUTION_JOBS       → operational visibility into async execution
BLUEPRINT_GOALS                → search business goals
BLUEPRINT_GOAL_DETAIL          → progress, links, blockers, conflicts
BLUEPRINT_PROPOSE_GOAL         → propose a new goal
BLUEPRINT_UPDATE_GOAL          → update goal fields/status/progress
BLUEPRINT_ARCHIVE_GOAL         → soft-cancel a goal
BLUEPRINT_CHECK_GOAL           → force a progress recompute
BLUEPRINT_GOAL_CONFLICTS       → conflicts referencing a goal
BLUEPRINT_CONNECTORS           → connector health, freshness, sync history
BLUEPRINT_OUTCOMES             → did past actions actually work?
BLUEPRINT_TRIGGER_AGENT        → run an internal Blueprint agent now
BLUEPRINT_RUNS                 → list/cancel/retry agent runs
BLUEPRINT_KB_QUERY             → ask the knowledge base a question
BLUEPRINT_KB_WRITE             → file research or findings permanently
BLUEPRINT_KB_SEARCH            → find relevant KB pages by keyword
BLUEPRINT_METRICS              → raw connector data (GA4, GSC, Shopify...)
BLUEPRINT_AUDIT                → who did what, when
```
