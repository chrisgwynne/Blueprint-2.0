# Phase 2 — BAP Completeness & Hermes Autonomy

**Goal:** make Blueprint's BAP API complete enough that Hermes (or any
external AI agent) can operate Blueprint autonomously — reading business
state, proposing and tracking work, and reasoning about whether past
actions succeeded — without relying on undocumented behaviour or the web
dashboard.

This closes every functional gap identified in `AUDIT-BAP-GAPS.md`
("Missing endpoints", "Missing goal access", "Missing outcome access",
"Missing connector status", "Missing execution status", "Missing
pagination", "Missing task search", "Inconsistent responses") and follows
the architecture established in Phase 0 (security) and Phase 1
(idempotency, durable execution): security-first, multi-tenant, idempotent,
durable, audit-friendly, human approval where required, backwards
compatible.

---

## 1. New endpoints implemented

47 BAP-key-authenticated endpoints exist after this phase (up from 24
before it), plus the 3 pre-existing session-authenticated
`/agents-admin/*` operator routes — 51 operations total, one-to-one with
[`docs/openapi/bap-v1.yaml`](docs/openapi/bap-v1.yaml). Grouped by what's
new:

### Task APIs (search, detail, history, cancel) — `server/routes/bap.ts`
| Method & Path | Notes |
|---|---|
| `GET /businesses/:id/tasks` | **Rewritten** — added `q` search, `priority`/`action_type`/`created_by`/`assigned_agent`/`signal_id`/`goal_id`/date-range filters, `sort`/`order`, pagination |
| `GET /tasks/:id` | **New** — approval status, execution state + jobs, linked signal, best-effort linked goals, parent/child dependencies, outcome status, audit summary |
| `GET /tasks/:id/history` | **New** — the `task_events` narrative timeline |
| `PATCH /tasks/:id` | **Extended** — now also accepts `action: "cancel"` (previously approve/reject only) |

### Signal APIs (detail, search) — `server/routes/bap.ts`
| Method & Path | Notes |
|---|---|
| `GET /businesses/:id/signals` | **Rewritten** — added `q` search, `sort`/`order`, pagination (previously severity/status/connector/type/limit only, hard-capped at 200) |
| `GET /signals/:id` | **New** — evidence, AI attribution, related signals (cluster or same-detector), related tasks, source connector freshness, resolution history |

### Goal APIs — `server/routes/bap-goals.ts` (new file)
| Method & Path |
|---|
| `GET /businesses/:id/goals` |
| `POST /businesses/:id/goals` |
| `GET /goals/:id` |
| `PATCH /goals/:id` |
| `POST /goals/:id/archive` |
| `POST /goals/:id/check` |
| `GET /goals/:id/conflicts` |

Previously goals were reachable only through `server/routes/goals.ts`,
gated by a dashboard session cookie — **zero** BAP surface existed
(`AUDIT-BAP-GAPS.md`'s F-20, called out there as "independently the single
largest functional blocker to autonomous operation"). These routes reuse
the exact same tables and engine functions the dashboard uses
(`server/goals/goal-engine.ts`, `server/brain/goal-reasoner.ts`,
`server/brain/conflict-engine.ts`) — a goal created via BAP is
indistinguishable from a dashboard-created one everywhere else in the
system.

### Connector APIs — `server/routes/bap-connectors.ts` (new file)
| Method & Path |
|---|
| `GET /businesses/:id/connectors` |
| `GET /connectors/:id` |
| `GET /connectors/:id/syncs` |
| `POST /connectors/:id/sync` |

Freshness/staleness is computed by a new shared module,
`server/connectors/freshness.ts`, extracted from `server/routes/
system-health.ts`'s dashboard logic — an agent calling this endpoint and a
human looking at the dashboard's System Health page now always see the
same freshness verdict (previously `server/jobs/scheduler.ts`'s hourly
downgrade cron and `system-health.ts`'s live compute used two independently
maintained threshold tables that had quietly diverged). `credentials` is
never selected by any query in this file — explicit column lists only.

### Outcome APIs — `server/routes/bap-outcomes.ts` (new file)
| Method & Path |
|---|
| `GET /businesses/:id/outcomes` |
| `GET /tasks/:id/outcome` |

Read-only. The DB's stored verdict vocabulary (`improved | worsened |
no_change`) is mapped to the wider `pending | measuring | successful |
neutral | unsuccessful | abandoned` vocabulary the spec required via a new
pure, independently unit-tested function, `server/tasks/outcome-status.ts`
(`computeOutcomeStatus()`). Single-task detail also returns calibrated
confidence (via the existing `server/brain/calibration.ts`) and an
`action_type`-level historical success-rate recommendation — new
aggregation logic, no prior implementation existed to reuse.

### Agent Run APIs — `server/routes/bap-runs.ts` (new file)
| Method & Path |
|---|
| `GET /businesses/:id/runs` |
| `POST /runs/:id/cancel` |
| `POST /runs/:id/retry` |

(`POST /businesses/:id/agents/:id/run` and `GET /runs/:id` already existed
in `bap.ts` and were left there.) **Honesty notes, both documented in the
API response itself, not just here:** cancel is a DB-status flip only
(`running` → `cancelled`) — `server/agents/agent-runner.ts` has no abort
signal anywhere in its call chain, so cancelling stops Blueprint from
*treating* the run as active but does not interrupt an in-flight LLM call
or task creation already under way. Retry re-triggers the same
`(agent_id, business_id)` as a fresh run — nothing about a past run's exact
inputs is snapshotted for true replay (unlike `execution_jobs`, which
stores its payload verbatim).

### Audit APIs — `server/routes/bap-audit.ts` (new file)
| Method & Path |
|---|
| `GET /businesses/:id/audit` |

Previously reachable only via the session-authenticated
`server/routes/audit.ts`. Two things this route does that the dashboard's
own reader does not, both deliberate hardening for an external-facing
surface: (1) `entity_type` is validated against a fixed whitelist
(`task, signal, business, connector, agent, agent_file, server_file`)
confirmed via code review to never carry secret-shaped data — not
`SELECT *` trusting every future `audit()` call site to stay careful
forever; (2) `before_state`/`after_state`/`metadata` pass through a
key-shaped redaction pass (`/credential|secret|token|password|api[_-]?key/i`)
before serialization, replacing the *whole* value when a key matches (not a
partial/nested redaction) — defense-in-depth on top of (1).

---

## 2. New permissions

Added to `GRANTABLE_BAP_PERMISSIONS` in `server/bap/auth.ts` (the
allow-list `POST /register` filters requested permissions against — an
agent can never self-grant anything outside this list):

```
goals:read   goals:propose   goals:update
connectors:read   connectors:sync
outcomes:read
audit:read
```

No new permission was needed for task cancel or execution-job retry/cancel
(covered by the existing `tasks:approve` — same trust tier as
approve/reject, Phase 1 precedent) or for agent-run retry/cancel (covered
by the existing `agents:trigger`). `PATCH /signals/:id` (update a signal's
status) is gated by `signals:read`, not a `signals:update` permission —
there isn't one, matching the actual implementation exactly (this is
intentionally documented, not an oversight — see `SKILL.md` and the
OpenAPI spec's description of that operation).

---

## 3. New database objects

Exactly one migration, appended to `STARTUP_MIGRATIONS` in
`server/db/db.ts`:

```sql
ALTER TABLE bap_audit ADD COLUMN request_id TEXT;
ALTER TABLE bap_audit ADD COLUMN correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bap_audit_correlation ON bap_audit(correlation_id);
```

No new tables. Every Phase 2 subsystem (goals, connectors, outcomes,
agent_runs, audit_log) reads tables that already existed from earlier
phases — Phase 2 is purely a new *BAP-authenticated read/write surface*
over pre-existing dashboard-only data, not new storage.

---

## 4. Consistency layer (applies to every endpoint, old and new)

New shared module `server/bap/route-helpers.ts`, wired into `bap.ts` and
every Phase 2 subsystem router:

- **Pagination** — every list endpoint takes `?page=1&limit=50` (max 200)
  and returns `{ ..., total, pagination: { page, limit, total, pages } }`.
  The pre-existing top-level `total` field is kept for backwards
  compatibility alongside the new `pagination` object, not replaced.
- **Timestamps** — normalized to full ISO-8601 UTC at the API boundary
  (`toIso()`), regardless of whether the underlying column was written by
  SQLite's `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, implicitly UTC) or
  `Date.toISOString()` (Phase 1's idempotency/execution-jobs code). The
  underlying columns are untouched — this is a read-time normalization,
  not a data migration.
- **Request/correlation IDs** — every response carries `X-Request-Id`
  (server-generated, unique per call) and `X-Correlation-Id` (echoes a
  caller-supplied value, or defaults to the request ID). Both are
  persisted onto the existing per-call `bap_audit` row (the migration
  above), including for `POST /register` itself.
- **Stable error schema** — `sendError()` produces `{ error, code,
  request_id }`, `code` ∈ `validation_error | not_found | permission_denied
  | conflict | rate_limited | internal_error`. Additive: the `error`
  string field every existing client already depends on never changes
  shape or is removed; `code`/`request_id` are new fields layered on top,
  used by Phase 2's new routes. Older routes that still return bare
  `{error}` continue to work unchanged.

---

## 5. Migration notes / backwards compatibility

**No breaking changes.** Specifically:

- Every pre-existing endpoint's response shape is a strict superset of its
  Phase 1 shape — new fields (`pagination`, `request_id`, etc.) were added,
  none were removed or renamed. A client reading only the fields it always
  read continues to work unmodified.
- `GET .../tasks` and `GET .../signals` gained new optional query
  parameters (`q`, `sort`, `order`, additional filters); omitting them
  reproduces the previous default behaviour (signals still default to
  `status=open`, tasks still default to unfiltered/`created_at desc`).
- `PATCH /tasks/:id` gained a new valid `action` value (`"cancel"`) — the
  existing `"approve"`/`"reject"` values are unchanged.
- The new `goals:*`/`connectors:*`/`outcomes:read`/`audit:read`
  permissions are opt-in: an existing agent's `business_access` and
  `permissions` are untouched by this migration, so an already-registered
  agent gets no new capability until it's explicitly re-granted one.
- The one schema migration (`bap_audit.request_id`/`correlation_id`) is
  additive (`ALTER TABLE ... ADD COLUMN`, nullable, no default required) —
  safe to apply to an existing database with no downtime and no backfill.
- **Internal-only refactor, not a compatibility change:** the 5 new
  subsystem route files (`bap-goals.ts`, `bap-connectors.ts`,
  `bap-outcomes.ts`, `bap-runs.ts`, `bap-audit.ts`) are mounted as
  sub-routers *inside* `bap.ts`'s already-authenticated middleware chain
  (`router.use(bapGoalsRouter)` etc., after `bapAuth`/`bapRateLimit`), not
  independently in `server/index.ts`. Mounting them independently at the
  same `/api/bap/v1` prefix would have caused every router's own
  unconditional auth/rate-limit middleware to re-run for any request that
  fell through an earlier router without matching one of its routes —
  Express runs a mounted router's top-level middleware for every request
  under its prefix, not just ones matching its own routes. This was caught
  via live end-to-end testing (a real server process, a real registered
  agent, real curl calls, direct SQLite inspection) as a duplicate
  `bap_audit` row per request — no unit test caught it, since each
  subsystem's own test file mounts only its own router in isolation. Fixed
  before merge; verified live afterwards (exactly one `bap_audit` row per
  request, for requests handled by `bap.ts` directly, by a subsystem
  router via fallthrough, and by the last-mounted `bap-audit.ts` router).

---

## 6. Hermes workflow examples

These map directly onto the validation scenarios this phase was built
against — see `SKILL.md`'s "Patterns" section for the full call sequences.
All five now complete using BAP alone:

1. **Morning briefing** — `GET health` → `GET signals?severity=critical,alert`
   → `GET tasks?status=proposed` → `GET connectors` (freshness) →
   `GET goals?status=active` (progress, at-risk deadlines) →
   `GET runs?status=running` → compose.
2. **Investigation** — `GET signals/:id` (evidence, attribution, related) →
   `GET metrics` → `GET tasks/:id/history` (has this been worked before?)
   → `POST kb/query` (historical context) → `GET outcomes?action_type=...`
   (did this kind of fix work before?) → `POST tasks` if a specific action
   follows.
3. **Content workflow** — `POST kb/query` (brand voice) → `GET goals`
   (does this serve a goal?) → `GET signals` → draft → `POST tasks`
   (`action_type=content_draft`) → `POST kb/write` (file the draft) →
   later, `GET tasks/:id/outcome` (close the loop).
4. **Duplicate prevention** — `GET tasks?q=...&status=all` → `GET
   signals?q=...&status=all` → `GET goals?q=...` → decide → only then
   `POST`. This was previously impossible for tasks/signals (no search
   parameter existed at all — `AUDIT-BAP-GAPS.md` F-23, "the skill's core
   anti-duplication instruction has no server-side tool to fulfil it") and
   entirely impossible for goals (no BAP surface existed).
5. **Long-running execution** — `PATCH tasks/:id` (`action: "approve"`,
   atomically enqueues a durable execution job — Phase 1) → `GET
   tasks/:id` (`execution.active_job_id`, `execution.jobs[]`) → poll `GET
   execution-jobs/:id` until `complete`/`failed`/`dead_letter` → outcome
   checks are scheduled automatically at 2/4 weeks → `GET tasks/:id/outcome`
   once final → `POST kb/write` if the result should inform future tasks.

---

## 7. Testing

337 tests across 33 files pass on this branch, typecheck clean
(`server` and `client`). BAP-specific coverage: **146 tests across 13
files, 0 failures** covering every new and modified endpoint —
permissions (missing scope → 403), cross-tenant isolation (resource from
another business → 403/404, never leaked), pagination shape, filter
correctness, invalid IDs (404), malformed requests (400/`validation_error`),
idempotency replay (same key → same response, no duplicate row), concurrent
reads (20 simultaneous list/detail requests against the same resource),
stale/errored connector state, tasks/goals with no linked outcome, and the
redaction behaviour of the audit endpoint. Two isolated pre-existing test
files (`server/agents/agentLifecycle.test.ts`,
`server/jobs/scheduler-lock.test.ts`) fail identically on the unmodified
base branch (verified via `git stash`) — unrelated to this phase's changes,
not introduced or worsened by it.

Full breakdown of what each new subsystem's test file covers is in the
file itself; see `server/routes/bap-goals.test.ts`,
`bap-connectors.test.ts`, `bap-outcomes.test.ts`, `bap-runs.test.ts`,
`bap-audit.test.ts`, `server/bap/route-helpers.test.ts`, and
`server/tasks/outcome-status.test.ts`.

---

## 8. Remaining autonomy gaps (honest, not exhaustive)

- **Goal↔task/signal linkage is a proxy, not a real relationship.** Goals,
  tasks, and signals only share an optional `project_id` column — there is
  no `tasks.goal_id` foreign key. The `goal_id` filter on `GET .../tasks`
  and `linked_tasks`/`linked_signals` on `GET /goals/:id` resolve through
  `project_id` as a best-effort proxy. A goal or task created without a
  `project_id` will show no linkage even if one conceptually exists. A
  real `tasks.goal_id` (and `signals.goal_id`) column is Phase 3 work.
- **Agent-run cancel does not abort in-flight work.** Documented honestly
  in both the API response and `SKILL.md`, but it's a real capability gap:
  Hermes cannot actually stop a runaway or misbehaving internal-agent run
  mid-flight, only mark it as no longer "active" for tracking/cost-cap
  purposes. A true abort would need a cancellation token threaded through
  `agent-runner.ts`'s LLM call chain — non-trivial, out of scope here.
- **No structured step-by-step agent-run logs.** Only a terminal
  `reasoning`/`error` text blob is available — there's no per-step
  progress an external agent could poll mid-run to understand *what* an
  internal agent is currently doing, only that it's `running`.
- **Outcome status has a hard-coded 14-day pending grace period and a
  4-week final threshold** (`server/tasks/outcome-status.ts`). These are
  reasonable defaults but not configurable per business or per
  `action_type` — a business that wants faster or slower measurement
  windows can't adjust this via BAP today.
- **The `discover` endpoint and `capabilities` endpoint are unauthenticated
  or lightly-authenticated instance-info surfaces**, not part of this
  phase's scope for expansion — they were left as-is except for
  `capabilities`' endpoint list, which was corrected to include every
  route added in this phase (it had silently gone stale in earlier
  development and would have under-informed a caller trying to
  self-discover what's available).
- **Webhook event payloads were not part of this phase's scope** — Phase 1
  closed the cross-tenant fan-out bug (F-06), but webhook payload schemas
  for the new `goal.*`/`connector.sync.*` event types this phase's engines
  can trigger (goal-reasoner, conflict-engine, `syncConnector`) were not
  audited or newly documented here. Existing webhook consumers relying on
  `signal.*`/`task.*` events are unaffected.

## 9. Recommended Phase 3 work

1. **Real `goal_id` foreign keys** on `tasks` and `signals`, replacing the
   `project_id` proxy — removes the single largest "best-effort, not
   guaranteed" caveat left in this phase's API surface.
2. **True agent-run cancellation** — a cancellation token / abort signal
   threaded through `agent-runner.ts`, so `POST /runs/:id/cancel` can
   actually stop in-flight work, not just mark it cancelled for tracking.
3. **Structured agent-run step logs**, queryable mid-run, replacing the
   terminal reasoning/error blob — would materially improve an external
   agent's ability to supervise a long-running internal-agent run.
4. **Webhook event catalogue audit** for the new event types this phase's
   engines can emit (`goal.*`, `connector.sync.*`), including a schema per
   event type and business-scoped fan-out verification matching Phase 0's
   F-06 fix for the existing event types.
5. **Cursor-based pagination** for the highest-volume list endpoints
   (audit, tasks, signals) — the current offset-based pagination is
   consistent and correct but can skip/duplicate rows under concurrent
   writes at the page boundary, same caveat `AUDIT-BAP-GAPS.md` flagged for
   BAP v2.
6. **Configurable outcome-measurement windows** per business or
   `action_type`, replacing the hard-coded 14-day/4-week constants in
   `outcome-status.ts`.
