# Blueprint Skill

A business intelligence system that monitors your connected tools,
detects signals in the data, and manages a task queue with human
approval. When you install this skill you become a participant in
Blueprint's signal â†’ goal â†’ task â†’ approval â†’ execution â†’ outcome loop.

This document is generated to match the implemented BAP (Blueprint Agent
Protocol) surface exactly â€” every endpoint, parameter, and response field
below is verified against the actual route code, not aspirational. For the
complete machine-readable contract (full request/response JSON Schemas,
every error response, every permission), see
[`docs/openapi/bap-v1.yaml`](docs/openapi/bap-v1.yaml). This file is the
narrative "when and why" companion to that spec.

**Everything you need to operate Blueprint autonomously is reachable
through BAP.** You should never need to scrape the dashboard UI or guess
at state. If you find yourself needing to do either, that's a gap â€” file
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
`BAP_REGISTRATION_SECRET` configured by the operator (ask them for it â€” it's
set in their `.env`, not something you can obtain yourself). Wildcard
permissions and wildcard business access (`"*"`) are never granted by
self-registration, no matter what you request â€” request only the specific
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
      "opportunities:read", "opportunities:trigger",
      "conflicts:read",
      "decisions:read",
      "graph:read", "graph:trigger",
      "recommendations:read",
      "retrospectives:read", "retrospectives:trigger",
      "calibration:read",
      "kb:read", "kb:write",
      "metrics:read", "agents:read", "agents:trigger"
    ],
    "business_access": ["biz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]
  }'
```

The full grantable permission list is exactly: `signals:read`,
`signals:create`, `tasks:read`, `tasks:propose`, `tasks:approve`,
`goals:read`, `goals:propose`, `goals:update`, `connectors:read`,
`connectors:sync`, `outcomes:read`, `audit:read`, `opportunities:read`,
`opportunities:trigger`, `conflicts:read`, `decisions:read`, `graph:read`,
`graph:trigger`, `recommendations:read`, `retrospectives:read`,
`retrospectives:trigger`, `calibration:read`, `kb:read`, `kb:write`,
`metrics:read`, `agents:read`, `agents:trigger`, `capabilities:read`, `capabilities:propose`, `capabilities:update`, `corrections:read`, `corrections:propose`, `revenue_paths:read`, `revenue_paths:update`, `scorecards:read`, `approval_policies:read`, `measurement_policies:read`, `provider_preflight:read`. Requesting anything else is
silently dropped, not an error. There is no `signals:update` or
`tasks:update` permission â€” updating a signal's status or approving a task
is gated by `signals:read` / `tasks:approve` respectively (see the
Signals/Tasks sections below). `recommendations:read` also gates
`BLUEPRINT_PATTERNS` below â€” there is no separate `patterns:read`.

Store the returned `api_key`. Shown once only â€” if you lose it, register a
new agent rather than trying to recover it.

**Find your business ID (and every business you can see):**
```bash
curl $BLUEPRINT_URL/api/bap/v1/me \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

The `businesses` array in the response is the answer to "what businesses
exist" â€” filtered to ones your key has access to. There is no separate
"list all businesses" endpoint; this is it.

---

## Conventions

These apply to every endpoint below â€” read this once rather than
re-deriving it per-call.

**Auth.** Every route except `POST /register` and `GET /discover` requires
`BAP-Key: $BLUEPRINT_API_KEY` (or `Authorization: Bearer $BLUEPRINT_API_KEY`).

**Idempotency.** Every mutating endpoint (anything that creates or changes
state â€” proposing a task, approving one, creating a signal, writing to the
KB, proposing or updating a goal, triggering a sync or an agent run,
cancelling/retrying a run or job) **requires** an `Idempotency-Key` header.
Reusing the same key with the same request body replays the original
response instead of re-running the action â€” this is how you safely retry a
timed-out call without risking a duplicate task, signal, or KB write.
Generate a fresh UUID per distinct action; reuse the same key only when
retrying the exact same call.

**Pagination.** Every list endpoint accepts `?page=1&limit=50` (limit caps
at 200, defaults to 50) and returns:
```json
{ "<data_key>": [...], "total": 42, "pagination": { "page": 1, "limit": 50, "total": 42, "pages": 1 } }
```
`total` is kept at the top level for backwards compatibility alongside the
newer `pagination` object â€” read whichever you prefer, they're always equal.

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
`{"error": ...}` without `code`/`request_id` â€” always check `error` first,
treat the other two as present-when-available.

**Rate limits.** Default: 60 calls/minute per agent. Tighter limits on a
few expensive/sensitive routes: `kb:write` 20/min, `kb:query` 10/min,
`agents:trigger` 5/min, `register` 5 per 5 minutes. A 429 includes
`retry_after_seconds`.

**Cross-tenant safety.** Every route scopes to businesses your key has
`business_access` for. Routes without a `:businessId` in the path (e.g.
`GET /tasks/:taskId`) still enforce this â€” they look the resource up, then
check your permission against *that resource's* actual business, returning
403 if it's not one of yours. You never need to (and can't) pre-filter by
business yourself.

---

## Trust, Applicability and Corrections

Before proposing work, check capability/applicability state when an action depends on a specific platform or business model. Use:

- `GET /businesses/$BLUEPRINT_BUSINESS_ID/capabilities`
- `POST /businesses/$BLUEPRINT_BUSINESS_ID/applicability/evaluate`
- `GET /businesses/$BLUEPRINT_BUSINESS_ID/revenue-paths`
- `GET /businesses/$BLUEPRINT_BUSINESS_ID/scorecards`
- `GET /provider-preflight`

If you believe Blueprint has a false business fact, propose a correction instead of acting on the assumption:

- `POST /businesses/$BLUEPRINT_BUSINESS_ID/corrections/propose`
- `GET /businesses/$BLUEPRINT_BUSINESS_ID/corrections/$CORRECTION_ID/impacts`

A proposed correction does not mutate durable facts until a human confirms it. Treat `unknown` applicability as a verification task, not proof that the capability exists. Treat `blocked` or `failed` provider preflight evidence as authoritative for the current run; do not start LLM-dependent work until a later preflight passes or an approved fallback is recorded.

## Tools

---

### BLUEPRINT_HEALTH

Get current business health â€” score, open signal counts, task counts, a
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
business â€” don't assume it's always a number.

**Interpret the score:**
- 80â€“100: healthy, routine monitoring
- 60â€“79: some issues, review open signals
- 40â€“59: degraded, action likely needed
- below 40: critical, immediate attention

---

### BLUEPRINT_SIGNALS

Search signals Blueprint has detected â€” anomalies, opportunities, risks,
and AI-generated insights from all connected data sources.

**When to use:**
- Human asks "what's happening with the business"
- Health score is below 70
- Before proposing tasks or creating a signal â€” check if it already exists
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
run for this signal type â€” all `null` otherwise.

---

### BLUEPRINT_UPDATE_SIGNAL

Change a signal's status â€” acknowledge it, resolve it, snooze it, or
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
`dismissed` are the conventional values â€” there's no server-side enum
check, so use these). Setting `resolved` also stamps `resolved_at`. This
route is gated by `signals:read`, not a `signals:update` permission â€” there
isn't one.

---

### BLUEPRINT_CREATE_SIGNAL

Tell Blueprint about something you detected that its connectors wouldn't
catch â€” conversations, external research, social media, news, competitor
activity.

**When to use:**
- You notice something relevant while browsing or researching
- Human mentions something that affects the business
- You find external information that suggests a risk or opportunity

**When NOT to use:**
- For things Blueprint already detects from its connectors
- Run `BLUEPRINT_SIGNALS` first â€” don't create duplicates

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

`type`, `severity`, and `title` are required. `type` values: `anomaly` Â·
`opportunity` Â· `risk` Â· `correlation`. `severity` values: `info` Â·
`warning` Â· `alert` Â· `critical`.

**Response:** `{ "signal_id": "sig_xxx", "created": true }` (201).

---

### BLUEPRINT_TASKS

Search the task queue â€” proposed, approved, executing, completed, or
rejected actions from Blueprint's internal agents and from external agents
like you.

**When to use:**
- Before proposing a task â€” check nothing similar already exists
- Human asks what's pending approval or what's been done
- Checking on something you proposed earlier

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/tasks?status=proposed&priority=p1,p2&sort=created_at&order=desc" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `q`, `status` (comma-separated), `priority`
(`p1,p2,p3`), `action_type`, `created_by` (matches `proposed_by`, e.g.
`bap:agt_xxx`), `assigned_agent`, `signal_id`, `goal_id` (best-effort â€”
see note below), `created_from`/`created_to`. `sort`/`order` as with
signals.

> **`goal_id` filter note:** goals and tasks have no direct foreign key
> today â€” they only share an optional `project_id` column. The `goal_id`
> filter resolves the goal's `project_id` and filters tasks by that; if the
> goal has no `project_id`, the filter returns zero tasks rather than
> silently ignoring it. Treat any goalâ†”task linkage in this API as a
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
`target_metric`) â€” see `BLUEPRINT_OUTCOMES` below for the full vocabulary.

---

### BLUEPRINT_KANBAN_CARD

Read the canonical card projection for Hermes or another external Kanban executor. Blueprint remains the source of truth; mirror `blueprint_task_id`, `business_id`, `goal_id`, `signal_id`, approval fields, acceptance criteria, expected outcome and measurement policy into external cards.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID/kanban-card" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

For a business sync feed:

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kanban-cards?status=proposed,approved,executing" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

Do not create a separate strategic backlog in Hermes. A Hermes card should point back to `blueprint_task_id` and preserve the Blueprint approval state and measurement policy.

---

### BLUEPRINT_TASK_HISTORY

The narrative event timeline for a task â€” the same feed the dashboard's
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
- Vague intentions ("improve SEO") â€” be specific or don't propose
- Duplicating a task Blueprint has already proposed â€” run
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
      "suggested_meta": "Transform your doorway with handcrafted oak door toppers â€” personalised and made in Wales. From Â£29.99."
    }
  }'
```

Only `title` is required, but `action_type` and `action_payload` are what
let an approved task actually execute automatically (rather than sitting in
`manual_review`) â€” supply them whenever the action is a known automatable
type. `priority` values: `p1` urgent Â· `p2` normal Â· `p3` low.

**Response:** `{ "task_id": "tsk_xxx", "status": "proposed", "trust_tier": "yellow", "approval_required": true }` (201). If Blueprint returns 400 with an `issues` array such as `payload_schema_mismatch` or `unknown_action_type`, fix the proposed `action_type`/`action_payload` or report the block; do not retry the same invalid proposal.

After proposing, tell the human:
*"I've proposed [title] in Blueprint â€” it's waiting for your approval."*
Do not say you've done the thing. You've proposed it.

---

### BLUEPRINT_APPROVE_TASK

Approve, reject, or cancel a task. Requires `tasks:approve` â€” a stronger
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
durable execution job â€” this is the same code path the dashboard and
Telegram use, so an approval here executes for real, not just changes
status. `cancel` is only valid from `proposed`/`approved`/`manual_review`
and also cancels any active execution job.

**Response:** `{ "task_id": "tsk_xxx", "status": "approved", "action": "approve" }`. 422 if the action doesn't apply to the task's current state.

---

### BLUEPRINT_EXECUTION_JOBS

List or inspect the durable execution jobs behind approved tasks â€”
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
â€” check `status` first if you're unsure.

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
â€” defaults to everything except `cancelled`), `tags` (comma-separated).

**Response:** `{ "goals": [...], "total": N, "pagination": {...} }`. Each
goal includes `metric_name`/`metric_baseline`/`metric_target`/
`metric_current`/`metric_unit`/`progress_pct`/`deadline`/`milestones`
(array)/`tags`(array)/`assigned_agents`(array).

---

### BLUEPRINT_GOAL_DETAIL

Full detail: progress history (`goal_checks`), linked tasks/signals/outcomes
(via the real `tasks.goal_id`/`signals.goal_id`/`task_outcomes.goal_id`
foreign keys added in Phase 3, unioned with the legacy `project_id` proxy so
nothing created before the FK existed loses its linkage), blockers (open
conflicts + a `deadline_at_risk` flag), conflicts, and a `strategic_planning`
summary.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ goal, linked_metrics, linked_tasks, linked_signals, linked_outcomes, progress: { progress_pct, last_checked, checks }, blockers: { open_conflicts, deadline_at_risk }, conflicts, strategic_planning }`.

`goal.dependencies` (inside the `goal` object itself) is now a real list â€”
`[{ goal_id, title, status, progress_pct, note }]` â€” populated from
`goal_dependencies`, one row per goal this goal depends on. `goal.milestones`
merges the real `goal_milestones` table with any legacy free-form JSON
milestones a goal created before Phase 3 still carries.

`strategic_planning` is `{ latest_assessment, strategy_count }` â€”
`latest_assessment` is `null` until `BLUEPRINT_GOAL_PLAN` has run at least
once for this goal (either automatically on goal creation, or triggered
manually). See `BLUEPRINT_GOAL_STRATEGIC_PLANNING` below for the full
assessment/strategy detail this summarizes.

---

### BLUEPRINT_GOAL_TIMELINE

The merged, chronological history of everything that has happened to a
goal â€” created, progress checks, strategic assessments, strategies
proposed, conflicts detected, and decisions recorded against it â€” as one
feed instead of five separate calls.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/timeline" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "goal_id": "goal_xxx", "events": [{ "at": "...", "type": "goal_created", "summary": "...", "data": {...} }, ...] }`,
sorted oldest first. `type` is one of `goal_created`, `progress_check`,
`strategic_assessment`, `strategy_proposed`, `conflict_detected`,
`decision`, `goal_achieved`.

---

### BLUEPRINT_GOAL_STRATEGIC_PLANNING

The Phase 3 Strategic Planning Engine: is this goal actually achievable,
what are the risks/assumptions/dependencies, and which of several candidate
strategies should it pursue. Backed by `server/brain/goal-reasoner.ts`.

**Latest assessment** (feasibility verdict/confidence/reasoning, key
constraint, gap analysis, assumptions, risks, dependencies, measurement
plan, success criteria):
```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/assessment" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
404 if planning has never run for this goal â€” trigger it first (below).

**Full assessment history** (every reasoning pass, newest first, paginated):
```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/assessments?page=1&limit=20" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Candidate strategies for this goal** (comparable side-by-side: confidence,
estimated effort/cost, time to impact, historical success rate for similar
strategies, evidence, `is_recommended`):
```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/strategies" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Only candidates still open (vs. already selected/rejected)
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/strategies?status=candidate" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
**Response:** `{ strategies: [...], total: N }` â€” sorted recommended-first,
then by confidence.

**(Re-)run strategic planning now** â€” fire-and-forget, same shape as
`BLUEPRINT_CHECK_GOAL`. Use when the goal's situation has materially
changed (new metric data, a new constraint, a resolved blocker) and you
don't want to wait for it to happen automatically:
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/plan" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
**Response:** `{ "goal_id": "goal_xxx", "status": "planning", "message": "..." }` (202) â€”
poll `BLUEPRINT_GOAL_STRATEGIC_PLANNING`'s assessment/strategies endpoints
for the result; a fresh assessment also runs automatically whenever a goal
is created.

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
    "tags": ["seo", "q2-2026"],
    "owner": "you",
    "confidence": 0.8,
    "priority": "p1",
    "depends_on": ["goal_xxx"]
  }'
```

`title` is required. If `metric_baseline` is omitted but `metric_name` is
given, Blueprint auto-fills the baseline from the latest matching metric.
`priority` must be `p1`, `p2`, or `p3` (defaults to `p2`) â€” it feeds
`BLUEPRINT_RECOMMENDATIONS`' ranking. `depends_on` is an array of other goal
IDs this goal can't meaningfully proceed without (unknown or invalid IDs are
silently dropped, not an error â€” same "best effort, not fatal" philosophy
as the rest of this file). Creating a goal fires background goal-reasoning
(Phase 3: this now also produces a `goal_assessments` row and one
`goal_strategies` row per candidate approach â€” see
`BLUEPRINT_GOAL_STRATEGIC_PLANNING`) and conflict-detection â€” don't expect
`linked_metrics`/`conflicts`/`strategic_planning` to be populated instantly;
poll `BLUEPRINT_GOAL_DETAIL` after a few seconds if you need them.

**Response:** `{ "goal": {...} }` (201).

---

### BLUEPRINT_UPDATE_GOAL

Update a goal's fields â€” progress, status, deadline, strategy, milestones,
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
`strategy`, `project_id`, `owner`, `confidence`, `priority`. Updatable array
fields (replace-whole-array, not merge): `assigned_agents`, `milestones`,
`notes`, `tags`. `depends_on` (array of goal IDs) is accepted too but is
handled separately from the other fields â€” it replaces the goal's full
dependency set in `goal_dependencies` rather than a plain column update.
`status` must be one of `active | paused | achieved | missed | cancelled`.
`priority` must be one of `p1 | p2 | p3`. To archive a goal specifically,
prefer `BLUEPRINT_ARCHIVE_GOAL` below (same effect, clearer intent).

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

All conflicts (open or resolved) referencing a specific goal â€” e.g. a task
that works against it, or two goals pulling in different directions.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/goals/$GOAL_ID/conflicts" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

---

### BLUEPRINT_CONFLICTS

The general, business-wide conflict list â€” every `conflict_type`
(`goal_vs_goal`, `task_vs_window`, `task_vs_goal`, `task_vs_task`,
`signal_vs_goal`, `goal_dependency`), not just ones referencing one specific
goal (`BLUEPRINT_GOAL_CONFLICTS` above is the goal-scoped version of this).
Read-only â€” resolving or dismissing a conflict is a dashboard-only action;
use this to see conflicts and factor them into what you recommend or
propose, not to adjudicate them.

```bash
# Open conflicts (the default)
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/conflicts" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Filter by type/category, or a specific entity, across all statuses
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/conflicts?status=all&conflict_type=task_vs_goal&category=resource&entity_id=tsk_xxx" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Detail
curl "$BLUEPRINT_URL/api/bap/v1/conflicts/$CONFLICT_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `status` (defaults to `open`; pass `status=all` for
resolved too), `conflict_type` (CSV), `category` (CSV â€” `direct`,
`resource`, `timing`, `dependency`; Phase 3 addition, orthogonal to
`conflict_type` â€” it distinguishes *what kind* of conflict independent of
*which entities* collided), `entity_id` (matches either side of the
conflict). **Response:** `{ "conflicts": [...], "total": N, "pagination": {...} }`.

---

### BLUEPRINT_CONNECTORS

List every connected data source with its live freshness status â€” the
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
state (`connected`, `stale`, `error`, `disconnected`, ...) â€” the same
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
Returns 202 immediately (`{ connector_id, status: "syncing", message }`) â€”
the sync runs in the background. Poll `.../syncs` for its outcome.

---

### BLUEPRINT_OUTCOMES

Whether past actions actually worked â€” the single most important check
before proposing a task similar to one done before.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/outcomes?action_type=meta_update&status=successful" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

Only tasks with a `target_metric` set appear here at all â€” most tasks
without one are excluded, not shown as `null`. **Filter params:** `status`
(the mapped vocabulary below), `action_type`, `proposed_by`.

**Status vocabulary** (mapped from the DB's raw `improved`/`worsened`/
`no_change` verdicts â€” this mapping is a pure function, see
`server/tasks/outcome-status.ts` if you need the exact rules):
| `status` | Meaning |
|---|---|
| `pending` | Task not yet complete, or complete <14 days ago (grace period before the first check is due) |
| `measuring` | Complete >14 days, first outcome check hasn't landed yet, or verdict inconclusive |
| `successful` | Latest check verdict is `improved` |
| `neutral` | Latest check verdict is `no_change` |
| `unsuccessful` | Latest check verdict is `worsened` |
| `abandoned` | Task was rejected, cancelled, or failed |

`is_final` is `true` once a check â‰¥4 weeks after completion exists â€” before
that, treat the status as provisional.

**Single-task outcome (adds confidence calibration and a recommendation):**
```bash
curl "$BLUEPRINT_URL/api/bap/v1/tasks/$TASK_ID/outcome" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
`confidence: { stated, calibrated, agent_calibration }` â€” `calibrated`
adjusts the task's stated confidence using that agent's historical
accuracy, if calibration data exists. `recommendation: { action_type,
sample_size, success_rate }` â€” the historical hit-rate for this
`action_type` in this business, from other final outcomes. `sample_size:
0` (and `success_rate: null`) means no prior data â€” treat your own
confidence as unadjusted in that case.

---

### BLUEPRINT_OPPORTUNITIES

Quantified opportunities Blueprint's connector-data scanner has already
found â€” "this is worth roughly Â£X/month if you do Y" â€” before you go
looking for one yourself. Backed by the same engine that feeds
`BLUEPRINT_RECOMMENDATIONS` (`server/brain/goal-suggester.ts`).

```bash
# Pending opportunities (the default)
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/opportunities" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# All statuses, from one connector
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/opportunities?status=all&connector_source=gsc" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Detail
curl "$BLUEPRINT_URL/api/bap/v1/opportunities/$OPPORTUNITY_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `status` (defaults to `pending`; pass `status=all` for
accepted/dismissed/snoozed too â€” comma-separated for multiple), `connector_source`.
Sorted by `opportunity_value` descending, then newest first. **Response:**
`{ "opportunities": [...], "total": N, "pagination": {...} }`. Each
opportunity carries `opportunity_value`/`opportunity_unit`, `barrier`,
`required_effort`, `related_goal_ids`, `related_risks`, `why_it_matters`,
and `evidence` (parsed object).

**Trigger a fresh scan now** (requires `opportunities:trigger`, a stronger
grant than `opportunities:read` â€” most external agents only need to read):
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/opportunities/scan" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
**Response:** `{ "business_id": "biz_xxx", "status": "scanning", "message": "..." }`
(202) â€” fire-and-forget, an LLM-backed pattern scan over connector data.
Poll `GET .../opportunities` for results; don't expect them immediately.

---

### BLUEPRINT_DECISIONS

"Why did we decide this six months ago?" â€” a durable, evidence-carrying
record of every consequential decision Blueprint (or a human, or you) has
made, answerable without reconstructing it from scattered task/goal/audit
state. **Read-only from BAP: decisions are written by the engines that make
them (task approval/rejection, strategy selection, conflict resolution,
opportunity accept/dismiss) â€” you can never create or edit one directly.**

```bash
# Recall â€” search + filter + paginate
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/decisions?q=seo&decision_type=strategy_selection" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Detail
curl "$BLUEPRINT_URL/api/bap/v1/decisions/$DECISION_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `q` (searches title/decision/reasoning text),
`decision_type` (one of `task_approval`, `task_rejection`,
`task_cancellation`, `strategy_selection`, `goal_creation`,
`goal_status_change`, `conflict_resolution`, `conflict_dismissal`,
`opportunity_accepted`, `opportunity_dismissed`, `manual`),
`related_goal_id`, `related_task_id`, `date_from`/`date_to`. **Response:**
`{ "decisions": [...], "total": N, "pagination": {...} }`. Each decision
carries `title`, `decision`, `reasoning`, `evidence` (array),
`alternatives_rejected` (array), `confidence`, `author`, and whichever
`related_goal_id`/`related_task_id`/`related_signal_id`/`related_outcome_id`/
`related_conflict_id` apply â€” these are soft references (not foreign keys),
so a decision remains readable even after the thing it references is
deleted. **Always check this before recommending something that sounds
familiar** â€” see the "Strategic planning" pattern below.

---

### BLUEPRINT_GRAPH

Relationship traversal, not keyword search: starting from one entity (a
goal, task, signal, decision, or registered knowledge-graph entity), walk
the typed edges outward to a bounded depth. Backed by
`server/brain/knowledge-graph.ts`. Edge types: `caused`, `supports`,
`blocks`, `depends_on`, `relates_to`, `mentions`, `supersedes`,
`contradicts`, `improves`, `regresses`.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/graph?ref_table=goals&ref_id=$GOAL_ID&depth=2" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Only follow specific edge types
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/graph?ref_table=tasks&ref_id=$TASK_ID&edge_types=caused,improves,regresses" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Required params:** `ref_table` (one of `goals`, `tasks`, `signals`,
`decisions`, `kg_entities`) and `ref_id` â€” together identify the starting
node. **Optional:** `depth` (`1`â€“`5`, default `2`), `edge_types` (CSV).
**Response:** `{ nodes: [...], edges: [...], total_nodes: N, total_edges: N }`.
Traversal follows edges in both directions and is capped at 200 nodes.
Returns `{ nodes: [], edges: [] }` (not a 404) if the starting entity has no
graph node yet â€” try `BLUEPRINT_GRAPH_REBUILD` below, or the entity may
genuinely have no derivable relationships yet. Entity types with no backing
table (competitor, product, customer, campaign, person) never appear here
automatically â€” there is no automatic extraction pipeline for them yet.

**Rebuild derived edges now** (requires `graph:trigger`) â€” synchronous, not
fire-and-forget (a full rebuild over existing rows is comparatively cheap;
unlike the other Phase 3 triggers, this returns its result directly, not a
202):
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/graph/rebuild" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
**Response:** `{ "business_id": "biz_xxx", "entities": N, "edges": N }` (200) â€”
total counts after the rebuild, not how many changed. Idempotent (upserts),
safe to call repeatedly.

---

### BLUEPRINT_RECOMMENDATIONS

"What should we do next?" â€” every currently-actionable candidate (proposed
tasks, pending opportunities, candidate goal strategies) merged into one
ranked, explainable list. Scored on confidence, goal priority, urgency,
historical success rate, effort, and open-conflict risk â€” check this
**before** proposing something new, in case it's already been surfaced and
ranked.

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/recommendations?limit=10" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ recommendations: [...], excluded: [...], explanation_depth, total }`.
Each recommendation carries `source_type` (`task`/`opportunity`/`strategy`),
`score`, `rationale` (human-readable strings, never an opaque number
alone), and an `explanation` object: `evidence`, `reasoning`,
`alternatives_considered`, `risk`, `expected_impact`, `historical_evidence`,
`linked_kb`, `linked_signals`, `linked_metrics`. Full KB-backed explanation
is only computed for the top 5 (expensive per-item search) â€” the rest still
get every other explanation field, just without `linked_kb` populated;
`explanation_depth` tells you which is which, so this is documented, not
silently inconsistent. `excluded` lists candidates a blocking constraint
ruled out, with the reason â€” so nothing vanishes silently.

---

### BLUEPRINT_RETROSPECTIVES

Periodic, structured look-backs â€” what worked, what didn't, learnings,
per-agent assessments, still-open windows of opportunity, recommendations,
and any operating changes to make. Backed by
`server/brain/retrospective-engine.ts`.

```bash
# List, newest first, paginated
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/retrospectives" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Detail
curl "$BLUEPRINT_URL/api/bap/v1/retrospectives/$RETROSPECTIVE_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response (list):** `{ "retrospectives": [...], "total": N, "pagination": {...} }` â€”
each row is a summary (`period_start`, `period_end`, `executive_summary`,
`kb_path`, `triggered_by`, `created_at`); fetch the detail for the full
report. **Response (detail):** the summary fields plus
`what_worked`/`what_didnt`/`learnings`/`agent_assessments`/`open_windows`/
`recommendations`/`operating_changes`/`calibration_notes` (all parsed
arrays).

**Trigger one now** (requires `retrospectives:trigger`, distinct from the
`retrospectives:read` needed to list/read them):
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/retrospectives/run" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
**Response:** `{ "business_id": "biz_xxx", "status": "running", "message": "..." }`
(202) â€” fire-and-forget, an LLM call over a month of data plus a KB write.
Poll `GET .../retrospectives` for the result.

---

### BLUEPRINT_CALIBRATION

How well-calibrated is a given agent's stated confidence against what
actually happened â€” per-agent, so you can tell whether to trust your own
(or another agent's) confidence numbers at face value or discount them.

```bash
# Latest calibration per agent for this business
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/calibration" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# One agent's full history instead of just its latest row
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/calibration?agent_id=seo-sentinel&history=1" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response (default, latest-per-agent):** `{ "calibration": [...], "total": N }`.
**Response (`history=1`):** `{ "calibration_history": [...] }` (up to 50 rows,
newest first, one row per calculation pass). Each row carries
`tasks_with_outcomes`, `avg_stated_confidence`, `avg_actual_outcome_rate`,
`calibration_error`, `calibration_score`, `calibration_offset`, `trend`,
`false_positives`/`false_negatives`, `recommendations_accepted`/`_rejected`,
`execution_success_rate`, `long_term_success_rate`, `calibration_method`,
`conservatism_factor`, and `bins` (parsed array). `calibration_method` is
`simple_average` for rows computed before Phase 3's richer calibration
existed â€” an honest marker, not a silent reinterpretation of old data.

---

### BLUEPRINT_PATTERNS

Cross-business learning, fully abstracted: "across every business on this
Blueprint instance, action X succeeded Y% of the time" â€” no business name,
URL, task title, or other tenant-identifying value is ever included, only
an `action_type`, an aggregate success rate/sample size, and the set of
business *types* (e.g. `ecommerce`, `saas` â€” never names) that contributed.
Requires `recommendations:read` (no separate `patterns:read` permission).

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/patterns" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "patterns": [...], "total": N }`, filtered to patterns
applicable to your business's type (or with no type restriction). Each
pattern: `{ pattern_key, action_type, description, sample_size,
success_count, success_rate, applicable_business_types }`.

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

Do not assume a fixed roster of agent IDs â€” installed agents vary per
instance and per business. Discover which are actually available with:
```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/agents" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```
`{ "agents": [{ id, name, status, last_run, next_run, run_count, total_cost_usd }, ...] }` â€”
`run_count`/`total_cost_usd`/`last_run` are scoped to this business only.

**Response (trigger):** `{ "run_id": "run_xxx", "agent_id": "seo-sentinel", "status": "queued" }` (202) â€” fire-and-forget, poll for status (below).

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

**Cancel a running run** (requires `agents:trigger`) â€” **honesty note:**
this is a DB-status flip (`running` â†’ `cancelled`) for tracking/cost-cap
purposes only. It does **not** interrupt an in-flight LLM call or task
creation already under way; there is no abort mechanism in the underlying
agent runner. Don't rely on it to stop side effects mid-run.
```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/runs/$RUN_ID/cancel" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```
409 if the run already finished.

**Retry a failed run** (requires `agents:trigger`) â€” re-triggers the same
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
everything agents have learned over time. It compounds â€” the longer
Blueprint has been running, the more valuable it is.

**When to use:**
- Before writing any content â€” check brand voice and style first
- Before making recommendations â€” check existing strategy
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
needed â€” this is a read, not a write (rate-limited to 10/min instead).

---

### BLUEPRINT_KB_WRITE

Write a page to the knowledge base. Research, decisions, insights,
competitive intelligence â€” anything worth keeping. Filed pages persist
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
| `signals/` | Do not write here â€” Blueprint writes this automatically |
| `raw/` | Do not write here â€” for source documents only |

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/write" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "path": "research/competitor-rustic-signs-jan-2026.md",
    "content": "# Competitor Analysis â€” Rustic Signs\n\n## Finding\n\nMain competitor is out of stock on their rustic wall sign range as of 15 Jan 2026.\n\n## Opportunity\n\nTarget [[entities/rustic-signs]] keywords while stock is depleted.",
    "frontmatter": {
      "title": "Competitor Analysis â€” Rustic Signs Jan 2026",
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
- Before querying â€” find which pages exist on a topic
- Before writing â€” check nothing similar already exists

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/search?q=brand+voice&limit=5" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:** `{ "results": [{ "path": "concepts/brand-voice.md", "matches": [...] }], "query": "brand voice" }`.
An empty `q` returns `{ "results": [] }`, not an error.

---

### BLUEPRINT_METRICS

Get raw connector data â€” actual numbers from GA4, GSC, Shopify, Stripe, and
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
Snapshot only includes connectors with `status = 'connected'` â€” use
`BLUEPRINT_CONNECTORS` to check whether a missing connector here means "no
data" or "connector is stale/errored".

---

### BLUEPRINT_AUDIT

The full audit trail â€” who did what, when, across tasks, signals,
connectors, business changes, and agent actions.

**When to use:**
- Verifying a task/signal/connector's change history
- Answering "who approved this" or "when did this connector get reconfigured"

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/audit?entity_type=task&entity_id=$TASK_ID" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `entity_type` (one of `task, signal, business,
connector, agent, agent_file, server_file` â€” anything else is a 400; the
whitelist is deliberate, not an oversight), `entity_id`, `action`, `actor`,
`date_from`/`date_to`.

**Response:** `{ "entries": [...], "total": N, "pagination": {...} }`. Any
key that looks like a credential/secret/token/password/API key (in
`before_state`, `after_state`, or `metadata`) is replaced wholesale with
`"[redacted]"` before you ever see it â€” this is defense-in-depth on top of
the entity-type whitelist, not something you need to additionally sanitize
on your end.

---

## Patterns

These are the standard sequences for common situations. Follow these
rather than deciding the order yourself â€” they're designed so you never
need anything outside BAP to complete them.

---

### Morning briefing

When asked for a morning update, daily summary, or "what's happening":

```
1. BLUEPRINT_HEALTH                              â†’ score, signal/task counts, metrics
2. BLUEPRINT_SIGNALS (severity=critical,alert)    â†’ urgent items needing a name
3. BLUEPRINT_TASKS (status=proposed)              â†’ what's waiting for approval
4. BLUEPRINT_CONNECTORS                           â†’ any connector stale/errored?
5. BLUEPRINT_GOALS (status=active)                â†’ progress, anything at-risk (deadline_at_risk)
6. BLUEPRINT_RUNS (status=running)                â†’ anything still in flight
7. Compose summary:
   - One sentence on health (score + direction)
   - Any critical/alert signals, named specifically
   - Count of tasks waiting for approval
   - Any stale/errored connector â€” flag explicitly, don't silently omit its data
   - Goal progress, flagging anything at-risk
   - One key metric per connected source
8. If health_score < 60, any critical signal, or a stale connector for a
   metric you're about to report on â†’ flag that something needs attention
```

---

### Investigation

When asked why something is happening, what's wrong, or to look into a
specific signal:

```
1. BLUEPRINT_SIGNAL_DETAIL (or BLUEPRINT_SIGNALS if starting from scratch)
                                                  â†’ evidence, attribution, related signals/tasks
2. BLUEPRINT_METRICS                             â†’ raw numbers for the relevant connector
3. BLUEPRINT_TASK_HISTORY (if related_tasks non-empty)
                                                  â†’ has this already been worked before?
4. BLUEPRINT_KB_QUERY                            â†’ historical context, prior decisions
5. Synthesise: likely cause, impact, what should be done
6. BLUEPRINT_OUTCOMES (action_type=<the action you're about to recommend>)
                                                  â†’ did this kind of action work before?
7. BLUEPRINT_PROPOSE_TASK if a specific action follows
```

---

### Content workflow

When writing content, or acting toward a goal:

```
1. BLUEPRINT_KB_QUERY ("What is our brand voice?")    â†’ always first
2. BLUEPRINT_GOALS                                    â†’ is there a goal this serves?
3. BLUEPRINT_SIGNALS                                  â†’ anything already flagging this?
4. Write the draft, following what the KB says
5. BLUEPRINT_PROPOSE_TASK (action_type=content_draft or similar)
                                                       â†’ if it should be published
6. BLUEPRINT_KB_WRITE                                 â†’ file the draft/research for the record
7. After the task's outcome checks land: BLUEPRINT_OUTCOMES / task outcome
                                                       â†’ close the loop, learn for next time
```

---

### Duplicate prevention

Before proposing *anything* (task, goal, or signal):

```
1. BLUEPRINT_TASKS (q=<keywords>, status=all)     â†’ has this exact action already been proposed?
2. BLUEPRINT_SIGNALS (q=<keywords>, status=all)   â†’ has this already been detected/flagged?
3. BLUEPRINT_GOALS (q=<keywords>)                 â†’ is there already a goal for this?
4. Decide: if a live equivalent exists, reference
   it (or its ID) rather than creating a duplicate.
5. Only then propose.
```

This is not optional â€” it's the difference between Blueprint being a
reliable single source of truth and a queue full of near-duplicate noise.

---

### Long-running execution

When you've approved (or are watching) a task that executes asynchronously:

```
1. BLUEPRINT_APPROVE_TASK (action=approve)        â†’ atomically enqueues an execution job
2. BLUEPRINT_TASK_DETAIL                          â†’ execution.active_job_id, execution.jobs[]
3. BLUEPRINT_EXECUTION_JOBS (or job detail by ID) â†’ poll status until complete/failed/dead_letter
   - If dead_letter or manual_review and it should be retried:
     BLUEPRINT_EXECUTION_JOBS retry (requires tasks:approve)
4. Once execution.status is complete/verified:
   outcome checks are scheduled automatically (2 and 4 weeks out) â€”
   nothing to trigger yourself.
5. After the check window: BLUEPRINT_OUTCOMES (or the task's outcome
   detail) â†’ was it successful? File the learning: BLUEPRINT_KB_WRITE
   if the result should inform future similar tasks.
```

---

### Strategic planning / historical learning

Before recommending or proposing anything non-trivial â€” a new push, a
strategy change, a re-run of something that sounds familiar â€” check what's
already known and already ranked, in this order:

```
1. BLUEPRINT_DECISIONS (q=<keywords>)              â†’ have we already decided
                                                       something about this?
2. BLUEPRINT_RECOMMENDATIONS                        â†’ is it already ranked?
                                                       Check score/rationale
                                                       before duplicating the
                                                       analysis yourself.
3. BLUEPRINT_GOAL_STRATEGIC_PLANNING (strategies)   â†’ if this serves a goal,
                                                       compare against its
                                                       existing candidate
                                                       strategies rather than
                                                       proposing a new one
                                                       that duplicates one.
4. BLUEPRINT_PATTERNS                               â†’ has this action_type
                                                       worked elsewhere, in
                                                       the abstract?
5. BLUEPRINT_GRAPH (ref_table=goals&ref_id=...)     â†’ what else is connected
                                                       to this goal/task that
                                                       might be affected?
6. Only then: BLUEPRINT_PROPOSE_TASK / BLUEPRINT_UPDATE_GOAL / BLUEPRINT_GOAL_PLAN
```

Example: before recommending a new SEO push â€” `GET decisions?q=seo` (have we
tried this before, and what did we decide?) â†’ `GET
businesses/:id/recommendations` (is an SEO task or strategy already
ranked?) â†’ `GET goals/:id/strategies` (compare against existing candidate
strategies for the relevant goal) â†’ only then `POST tasks`.

---

## Rules

**Read before you write.**
Before proposing a task, goal, or signal, check what Blueprint already
knows â€” see "Duplicate prevention" above.

**Be specific or don't propose.**
A task proposal must say exactly what should happen. Current state.
Proposed state. Why. Expected outcome.

**Honest confidence scores.**
0.85+ â†’ confident. 0.70â€“0.84 â†’ note uncertainty. Below 0.50 â†’ investigate
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
`BLUEPRINT_CONNECTORS` before assuming "no activity" â€” it may mean the
connector is stale or erroring, not that the number is genuinely zero.

**Decisions are read-only â€” never write directly.**
`BLUEPRINT_DECISIONS` is a recall surface only. There is no "create a
decision" endpoint and there never will be one via BAP â€” decisions are
recorded automatically, at the moment they're made, by the engine that made
them (task approval/rejection, strategy selection, conflict resolution,
opportunity accept/dismiss). If you want a record of your own reasoning
kept, use `BLUEPRINT_KB_WRITE` (`decisions/`) instead.

**Conflicts are read-only from BAP.**
`BLUEPRINT_CONFLICTS` / `BLUEPRINT_GOAL_CONFLICTS` let you see and factor in
open conflicts; resolving or dismissing one is a dashboard-only action, same
boundary as the audit trail.

**Check before you plan, not just before you propose.**
`BLUEPRINT_RECOMMENDATIONS` and `BLUEPRINT_GOAL_STRATEGIC_PLANNING`'s
strategies exist specifically so you don't re-derive an analysis Blueprint
has already ranked or already generated candidates for â€” see "Strategic
planning / historical learning" above.

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
BLUEPRINT_HEALTH             â†’ situational awareness â€” start here
BLUEPRINT_SIGNALS             â†’ search signals Blueprint has detected
BLUEPRINT_SIGNAL_DETAIL        â†’ evidence, attribution, related signals/tasks
BLUEPRINT_UPDATE_SIGNAL        â†’ acknowledge/resolve/snooze/dismiss a signal
BLUEPRINT_CREATE_SIGNAL        â†’ tell Blueprint what you found externally
BLUEPRINT_TASKS                â†’ search the task queue
BLUEPRINT_TASK_DETAIL          â†’ approval/execution/outcome/audit detail
BLUEPRINT_TASK_HISTORY         â†’ task event timeline
BLUEPRINT_PROPOSE_TASK         â†’ suggest an action for human approval
BLUEPRINT_APPROVE_TASK         â†’ approve/reject/cancel a task
BLUEPRINT_EXECUTION_JOBS       â†’ operational visibility into async execution
BLUEPRINT_GOALS                â†’ search business goals
BLUEPRINT_GOAL_DETAIL          â†’ progress, links, blockers, conflicts, strategic_planning
BLUEPRINT_GOAL_TIMELINE        â†’ merged chronological history of a goal
BLUEPRINT_GOAL_STRATEGIC_PLANNING â†’ feasibility assessment + candidate strategies + (re)plan
BLUEPRINT_PROPOSE_GOAL         â†’ propose a new goal
BLUEPRINT_UPDATE_GOAL          â†’ update goal fields/status/progress
BLUEPRINT_ARCHIVE_GOAL         â†’ soft-cancel a goal
BLUEPRINT_CHECK_GOAL           â†’ force a progress recompute
BLUEPRINT_GOAL_CONFLICTS       â†’ conflicts referencing a goal
BLUEPRINT_CONFLICTS            â†’ business-wide conflict list/detail
BLUEPRINT_CONNECTORS           â†’ connector health, freshness, sync history
BLUEPRINT_OUTCOMES             â†’ did past actions actually work?
BLUEPRINT_OPPORTUNITIES        â†’ quantified opportunities found by the scanner
BLUEPRINT_DECISIONS            â†’ recall why something was decided (read-only)
BLUEPRINT_GRAPH                â†’ traverse typed relationships between entities
BLUEPRINT_RECOMMENDATIONS      â†’ ranked, explainable "what should we do next"
BLUEPRINT_RETROSPECTIVES       â†’ periodic structured look-backs
BLUEPRINT_CALIBRATION          â†’ how well-calibrated is an agent's confidence
BLUEPRINT_PATTERNS             â†’ cross-business learning, fully abstracted
BLUEPRINT_TRIGGER_AGENT        â†’ run an internal Blueprint agent now
BLUEPRINT_RUNS                 â†’ list/cancel/retry agent runs
BLUEPRINT_KB_QUERY             â†’ ask the knowledge base a question
BLUEPRINT_KB_WRITE             â†’ file research or findings permanently
BLUEPRINT_KB_SEARCH            â†’ find relevant KB pages by keyword
BLUEPRINT_METRICS              â†’ raw connector data (GA4, GSC, Shopify...)
BLUEPRINT_AUDIT                â†’ who did what, when
```
