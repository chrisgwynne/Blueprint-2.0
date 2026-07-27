# Blueprint Agent Protocol (BAP) — Gap Analysis

Full endpoint inventory, permission matrix, and recommended additions for the API surface Hermes and other external agents are meant to use. All routes below are mounted at `/api/bap/v1` (`server/index.ts:216`) unless noted; source: `server/routes/bap.ts` (922 lines).

## Complete endpoint inventory

| Method & Path | Permission required | `businessId` in path | Business-ownership enforced | Notes |
|---|---|---|---|---|
| `POST /register` | None (open) | n/a | n/a | **F-01 — unauthenticated, grants requested permissions verbatim** |
| `GET /discover` | None (togglable) | n/a | n/a | Instance capability discovery |
| `GET /me` | Key only | n/a | n/a | — |
| `GET /capabilities` | Key only | n/a | n/a | — |
| `GET /businesses/:businessId/health` | `signals:read` | Y | Y | — |
| `GET /businesses/:businessId/signals` | `signals:read` | Y | Y | No search/query params beyond severity/status/connector/type/limit |
| `POST /businesses/:businessId/signals` | `signals:create` | Y | Y | No idempotency key (F-24) |
| `PATCH /signals/:signalId` | `signals:read` | **N** | **N — F-03** | Cross-tenant mutation possible |
| `GET /businesses/:businessId/tasks` | `tasks:read` | Y | Y | No `GET /tasks/:id` detail route |
| `POST /businesses/:businessId/tasks` | `tasks:propose` | Y | Y | No idempotency key (F-24); no search-before-propose |
| `PATCH /tasks/:taskId` | `tasks:approve` | **N** | **N — F-03** | Cross-tenant approve/reject, fires real execution |
| `GET /businesses/:businessId/kb/file/*` | `kb:read` | Y | Y | — |
| `GET /businesses/:businessId/kb/search` | `kb:read` | Y | Y | Keyword search over KB only, not tasks/signals |
| `POST /businesses/:businessId/kb/query` | `kb:read` | Y | Y | Grounded LLM query, verified real |
| `POST /businesses/:businessId/kb/write` | `kb:write` | Y | Y (business), **N (path — F-02)** | Path traversal escapes KB_ROOT entirely |
| `GET /businesses/:businessId/metrics` | `metrics:read` | Y | Y | — |
| `GET /businesses/:businessId/metrics/snapshot` | `metrics:read` | Y | Y | — |
| `GET /businesses/:businessId/agents` | `agents:read` | Y (checked) | **N — query has no `WHERE business_id` (F-07)** | Leaks every business's internal agents |
| `POST /businesses/:businessId/agents/:agentId/run` | `agents:trigger` | Y | Partial (agent existence checked, not business membership) | — |
| `GET /runs/:runId` | **None at all — F-04** | n/a | **N** | Any valid key reads any business's run reasoning/cost |
| `PUT /me/webhook` | Key only | n/a | Y (self) | — |
| `GET /me/webhook/deliveries` | Key only | n/a | Y (self) | — |
| `POST /me/webhook/deliveries/:id/retry` | Key only | n/a | Y (self) | — |
| `GET/POST /agents-admin/*` | `isAuthenticated` (session, **not** BAP key) | n/a | n/a | Operator-only; includes revoke and audit-log read |

## Permission matrix (resource:action)

| Permission | Endpoints it gates | Wildcard forms accepted |
|---|---|---|
| `signals:read` | GET signals, GET health, PATCH signal (broken scope) | `signals:*`, `*:*` |
| `signals:create` | POST signals | `signals:*`, `*:*` |
| `tasks:read` | GET tasks | `tasks:*`, `*:*` |
| `tasks:propose` | POST tasks | `tasks:*`, `*:*` |
| `tasks:approve` | PATCH task (broken scope) | `tasks:*`, `*:*` |
| `kb:read` | GET kb/file, kb/search, POST kb/query | `kb:*`, `*:*` |
| `kb:write` | POST kb/write (path traversal unguarded) | `kb:*`, `*:*` |
| `metrics:read` | GET metrics, snapshot | `metrics:*`, `*:*` |
| `agents:read` | GET agents (broken scope) | `agents:*`, `*:*` |
| `agents:trigger` | POST agent run | `agents:*`, `*:*` |
| *(none defined)* | goals, connectors, outcomes, audit log — **no BAP permission exists for any of these because no BAP route exists** | — |

At registration, `POST /register` grants **exactly** whatever `requested_permissions` array the caller sends, with no allow-list, no admin approval, and a default `business_access: ['*']` if omitted (F-01, F-D in the BAP sub-audit). There is no distinction in code between a "read-only agent" and a "fully-privileged agent" at the registration layer — that distinction exists only if the caller voluntarily requests a narrower scope.

## Missing endpoints (confirmed absent, not just under-documented)

| Need | Status | Evidence |
|---|---|---|
| Task detail (`GET /tasks/:id`) | **Missing** | Only list + PATCH exist |
| Task cancel | **Missing** | No `cancelled` status exists in the state machine at all (F-34) |
| Task retry (safe, idempotent) | **Missing** | Manual `failed→proposed` cycle only, no dedup (F-09) |
| **Goal read/write** | **Missing — largest gap (F-20)** | `routes/goals.ts` exists, session-auth only, never mounted under `/api/bap/v1` |
| Outcome status (read or write) | **Missing** | `tasks.outcome`/`outcome_data` columns exist but no BAP endpoint reads or writes them |
| Connector status/freshness | **Missing** | `routes/connectors.ts` / `connector-data.ts` exist, not exposed under BAP; only reachable indirectly via `metrics/snapshot` |
| Connector sync triggering | **Missing** | No BAP route to force a sync |
| **Task search / duplicate detection** | **Missing (F-23)** | Confirmed — `SKILL.md` instructs agents to "check first," but no endpoint supports keyword/title search on tasks or signals; only `kb/search` exists, and it searches KB documents, unrelated |
| Audit-log retrieval (self) | **Missing for BAP callers** | Only reachable via session-authenticated `/agents-admin/:id/audit` |
| Agent-run cancel | **Missing** | No cancel/abort route anywhere |
| Agent-run structured logs | **Partial** | Only `reasoning`/`error` text fields, no structured log stream |

## Inconsistent responses

- **Error shape**: internally consistent (`{error: string}` + correct status codes) across BAP routes — but the *public API* (`/api/v1`, separate from BAP) uses a different key prefix and header name than documented, and BAP's own docs (`AGENT-GUIDE.md`) don't describe a machine-readable error-code taxonomy (F-25).
- **Not-found semantics**: explicit for `businessId` (404), but signals/tasks/metrics GET endpoints silently return empty arrays for a nonexistent `businessId` rather than 404ing — no existence check performed.
- **409 Conflict is never used** — duplicate creates (no idempotency key exists to trigger this anyway) return 201, not 409.

## Missing pagination

**Every BAP list endpoint (`GET .../signals`, `GET .../tasks`) hard-caps at `limit=200` with no `page`/`offset`/cursor parameter (F-14).** This is a hard functional ceiling: an agent managing a business with more than 200 open items cannot retrieve the rest through BAP at all. Contrast with the dashboard API, which properly supports `page`/`limit` with `pages`/`total` metadata (`server/routes/signals.ts:266-316`, `server/routes/tasks.ts:71-106`) — the inconsistency suggests BAP was extended from the dashboard routes without carrying pagination over.

## Missing task search

Confirmed and detailed in F-23: `SKILL.md:168,234,479-480` explicitly tells agents to check `BLUEPRINT_SIGNALS`/existing tasks before proposing or creating, to avoid duplicates. No endpoint supports this beyond pulling the full list client-side (itself capped at 200 items, per above) and diffing titles locally. This is the exact contradiction the audit brief called out, and it is real: **the skill's core anti-duplication instruction has no server-side tool to fulfil it.**

## Missing goal access

Confirmed and detailed in F-20: `server/routes/goals.ts:11` is gated by `isAuthenticated` (session cookie), not `bapAuth`. No `goals` permission exists in the BAP permission vocabulary. An external agent's only path to goal information is indirect — reading a KB page a human or the goal engine happened to file about a goal — which is unreliable and not queryable by goal ID, status, or deadline. **This is independently the single largest functional (non-security) blocker to autonomous operation**: an agent cannot know what the business is trying to achieve, cannot propose a new goal, and cannot report progress against one.

## Missing outcome access

`tasks.outcome` / `tasks.outcome_data` columns exist and are populated by the internal 2/4-week outcome-check job (`server/tasks/outcomes.ts`), but there is no BAP endpoint to read a task's outcome once it's been measured, nor to query outcomes in aggregate (e.g. "what's our historical hit rate on `meta_update` actions"). An agent proposing a new task has no BAP-accessible way to check whether a similar past action succeeded — it would need dashboard access or direct KB reads of whatever the outcome engine happened to file.

## Missing connector status

No BAP route surfaces `connectors.status`/`last_sync`/`last_error`. The closest proxy is `metrics/snapshot`, which returns metric values but not connector health. An agent cannot distinguish "this business has 0 orders" from "the Shopify connector has been failing to sync for 3 days" through BAP — it would have to infer staleness from the *absence* of expected data, which is unreliable.

## Missing execution status

Task execution status is visible only through the task's own `status` field (`executing`/`complete`/`failed`) via the list/PATCH endpoints — there's no dedicated execution-log or step-by-step progress endpoint, and (per F-08) a task stuck in `executing` after a crash is indistinguishable from one still legitimately running, since no BAP field exposes "last updated" staleness for execution specifically.

## Idempotency gaps

No BAP write endpoint (`POST .../signals`, `POST .../tasks`, `POST .../kb/write`, `PATCH .../tasks/:id`) accepts or honors an `Idempotency-Key` header. Every one of these unconditionally performs its write on every call (F-24). A network-level retry from a well-behaved autonomous client (exactly what Hermes's own retry/backoff logic will do) silently creates duplicate signals, duplicate tasks, or duplicate KB pages.

---

## Recommended BAP v1 additions (near-term, additive, non-breaking)

1. **Fix the two IDOR routes** by adding `:businessId` to the PATCH paths (or re-deriving and checking ownership server-side from the fetched row) — F-03.
2. **Add `requirePermission()` to `GET /runs/:runId`** and scope the query to the caller's `business_access` — F-04.
3. **Scope `GET /businesses/:businessId/agents`'s SQL query to `business_id`** — F-07.
4. **Add pagination** (`page`/`limit` with `pages`/`total`, matching the dashboard convention) to all BAP list endpoints — F-14.
5. **Add `Idempotency-Key` header support** to all POST/PATCH BAP endpoints, keyed per-agent, with response replay on a repeated key within a TTL window — F-24.
6. **Add `GET /businesses/:businessId/tasks?q=...` and `GET .../signals?q=...`** full-text search over title/description, so agents can genuinely "check first" — F-23.
7. **Mount a scoped `goals` BAP surface**: `GET/POST /businesses/:businessId/goals`, `GET /goals/:id`, `PATCH /goals/:id` (progress/status updates only, not full rewrite) — F-20.
8. **Add `GET /businesses/:businessId/connectors`** exposing `type`, `status`, `last_sync`, `last_error`, staleness — closes the connector-status gap.
9. **Add `GET /tasks/:id`** for single-task detail (currently list-only).
10. **Add `POST /tasks/:id/cancel`**, backed by a new `cancelled` terminal state in the task state machine, with a guard preventing cancellation of a task already `executing` past its point of no return — F-34.
11. **Add `GET /businesses/:businessId/outcomes`** and `GET /tasks/:id/outcome` for outcome retrieval.
12. **Publish an OpenAPI 3.x spec** generated from (or validated against) the actual route handlers, replacing/supplementing the hand-written `api-reference.md`, and fix the three confirmed doc/code mismatches (auth header, key prefix, error shape) — F-25.

## Recommended future BAP v2 changes (larger, potentially breaking)

1. **Registration overhaul**: require either session-auth or a one-time operator-issued bootstrap token to call `/register`; separate "self-service read-only key" from "operator-approved write/approve key" as genuinely different flows — F-01.
2. **Cursor-based pagination** (not just offset) for high-volume endpoints, to support stable pagination under concurrent writes.
3. **Structured, typed error codes** (`validation_error`, `not_found`, `conflict`, `rate_limited`, `permission_denied`) in a documented, machine-parseable envelope, replacing free-text `error` strings.
4. **Webhook event filtering by `business_access`** at dispatch time, not just at the subscriber's own read-time filtering (currently the dispatcher broadcasts cross-tenant, F-06).
5. **A `runs` v2 that supports cancellation and structured step-by-step logs**, not just a terminal reasoning/error blob.
6. **API key TTL/expiry and rotation** (currently revoke-only, no expiry concept at all).
7. **Per-key rate-limit persistence** (currently in-memory, resets on restart, doesn't work across instances) backed by SQLite or Redis for multi-instance deployments.
