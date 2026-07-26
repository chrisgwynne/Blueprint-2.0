# Blueprint — Remediation Roadmap

Ordered implementation plan. Each item references finding IDs from [AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md). Complexity: **S** (hours), **M** (1-3 days), **L** (3-7 days), **XL** (1-3+ weeks).

---

## Phase 0 — Critical safety

*Anything that could cause data leakage, unauthorised access, or irreversible/duplicate actions. Nothing else should be prioritized ahead of this phase.*

### 0.1 — Close the open BAP registration bypass
- **Finding IDs:** F-01
- **Objective:** an unauthenticated caller must not be able to obtain a fully-privileged API key.
- **Scope:** `server/routes/bap.ts:65-129`. Require either (a) an existing session-authenticated operator to call `/register` on an agent's behalf, or (b) a one-time bootstrap token issued by the operator out-of-band, or (c) auto-grant only a minimal read-only default (`signals:read`, `metrics:read`, `kb:read`) regardless of `requested_permissions`, with any write/approve/trigger permission requiring a subsequent explicit dashboard approval step that flips the key from `pending` to `active` for those scopes.
- **Dependencies:** none — can land independently and immediately.
- **Acceptance criteria:** an unauthenticated `POST /register` with `requested_permissions:["*:*"]` either fails, or returns a key that cannot call `tasks:approve`/`kb:write`/`agents:trigger` until an operator explicitly upgrades it.
- **Tests required:** integration test asserting unauthenticated registration cannot obtain write-capable permissions; regression test for the exact PoC used in this audit.
- **Complexity:** M

### 0.2 — Fix KB path traversal
- **Finding IDs:** F-02
- **Objective:** every KB file operation must be provably contained within the business's KB root.
- **Scope:** `server/kb/kb-engine.ts` — add a shared `containPath(root, relativePath)` helper used by `readFile`, `writeFile`, `archiveFile`, and any delete/rename operation; reject `..` segments, absolute paths, null bytes, and (defensively) reserved Windows device names, applied before any `fs` call.
- **Dependencies:** none.
- **Acceptance criteria:** the exact traversal PoC from this audit (`path: "../../../../tmp/x.md"`) is rejected with a 400, not executed.
- **Tests required:** unit tests for `../../`, absolute paths, encoded traversal, null bytes, reserved names, case-collision — all asserting rejection; one test asserting normal in-root paths still work.
- **Complexity:** S

### 0.3 — Fix the two cross-tenant IDOR routes and the unauthenticated runs route
- **Finding IDs:** F-03, F-04
- **Objective:** every BAP mutation/read must be scoped to the caller's authorized business.
- **Scope:** `server/routes/bap.ts:398,515,775`; `server/bap/auth.ts:149-165`. Add `:businessId` to the PATCH routes' paths (or re-derive `business_id` from the fetched row and check it against `req.agent.business_access` before acting); add a `requirePermission()` call to `GET /runs/:runId` scoped by the run's `business_id`.
- **Dependencies:** none, but should land alongside 0.1 since both affect the same route file.
- **Acceptance criteria:** an agent scoped to business A receives 403 when attempting to PATCH a business-B task/signal or read a business-B run.
- **Tests required:** cross-tenant IDOR regression tests for all three routes.
- **Complexity:** M

### 0.4 — Filter webhook fan-out by business access
- **Finding IDs:** F-06
- **Objective:** an agent must not receive webhook events for businesses it isn't scoped to.
- **Scope:** `server/bap/webhook-dispatcher.ts:33-38` — filter the `bap_agents` query result (or the dispatch loop) by whether the event's `business_id` is in each candidate agent's `business_access`.
- **Dependencies:** should land with 0.3 (they compound each other).
- **Acceptance criteria:** a business-A-scoped agent's webhook never receives a business-B event.
- **Tests required:** webhook dispatch test with two businesses and a single-business-scoped subscriber.
- **Complexity:** S

### 0.5 — SSRF-harden the webhook dispatcher and extend the outbound allowlist
- **Finding IDs:** F-16, F-17
- **Objective:** Blueprint must not be usable as an SSRF proxy against internal/cloud-metadata addresses via a self-registered `webhook_url`.
- **Scope:** route `server/bap/webhook-dispatcher.ts:109`'s `fetch()` through `server/lib/safe-fetch.ts`; audit and extend `safeFetch` usage across all connector `index.ts` files that currently call raw `fetch`/`node-fetch`.
- **Dependencies:** 0.1 (registration hardening reduces who can set a `webhook_url` in the first place, but this must be fixed independently in depth).
- **Acceptance criteria:** a webhook URL pointing at `169.254.169.254` or a private RFC1918 address is rejected before the request is sent.
- **Tests required:** unit test for the allowlist rejecting metadata/private addresses; integration test for webhook dispatch honoring the same check.
- **Complexity:** M

### 0.6 — Authenticate Telegram command/callback senders
- **Finding IDs:** F-05
- **Objective:** only the configured chat (and any explicitly operator-added chats) can issue `/approve`, `/reject`, or tap an approval callback button.
- **Scope:** `server/notifications/telegram.ts:195-281` — compare `message.chat.id`/`callbackQuery.from.id` against an allow-list sourced from `TELEGRAM_CHAT_ID` (extendable) before acting; log and silently drop everything else.
- **Dependencies:** none.
- **Acceptance criteria:** a message from an unconfigured chat ID is ignored, not acted upon; existing configured-chat flow is unaffected.
- **Tests required:** unit test asserting unauthorized chat IDs are rejected.
- **Complexity:** S

### 0.7 — Reject default admin credentials in production
- **Finding IDs:** F-18
- **Objective:** Blueprint must not silently run with `admin`/`changeme` in production.
- **Scope:** `server/routes/auth.ts:47-84` — mirror the existing `SESSION_SECRET` fail-closed pattern (`index.ts:123-130`): if `NODE_ENV==='production'` and `ADMIN_PASSWORD==='changeme'` (or unset), refuse to start.
- **Dependencies:** none.
- **Acceptance criteria:** production startup with default credentials exits non-zero with a clear error.
- **Tests required:** startup test asserting the fail-closed behavior.
- **Complexity:** S

**Phase 0 total: ~2-3 weeks for one engineer, most items parallelizable across two.**

---

## Phase 1 — Autonomous reliability

*Durable state, idempotency, retries, execution status, and recovery — the properties an unattended agent depends on.*

### 1.1 — Idempotency keys on all BAP write endpoints
- **Finding IDs:** F-24, F-09
- **Objective:** a retried BAP write does not create a duplicate resource.
- **Scope:** accept an `Idempotency-Key` header on `POST .../signals`, `POST .../tasks`, `POST .../kb/write`, `PATCH .../tasks/:id`, `PATCH .../signals/:id`; persist `(agent_id, idempotency_key) → response` with a TTL (e.g. 24h) and replay the stored response on a repeat key instead of re-executing.
- **Dependencies:** Phase 0 (don't build reliability features on top of an insecure registration flow).
- **Acceptance criteria:** two identical `POST .../tasks` calls with the same `Idempotency-Key` produce exactly one task row and two identical HTTP responses.
- **Tests required:** idempotency replay test; conflict test (same key, different payload) returning 409.
- **Complexity:** L

### 1.2 — External-reference idempotency in the executor
- **Finding IDs:** F-09
- **Objective:** retrying a task does not create a second GitHub issue/PR or Shopify product/page/post.
- **Scope:** `server/tasks/executor.ts` — before each create-type handler (`executeGithubIssue`, `executeGithubPR`, `executeShopifyProductCreate`, `executeShopifyBlogPostCreate`, etc.) calls its external API, check `task.outcome_data` for a previously-recorded external ID from a prior attempt; if present, skip re-creation and proceed directly to marking the task complete with the existing reference.
- **Dependencies:** 1.1 conceptually related but independent in implementation.
- **Acceptance criteria:** forcing a task through `executing→failed→proposed→approved→executing` twice, where the first attempt's external call actually succeeded, results in exactly one GitHub issue/Shopify object.
- **Tests required:** simulated double-execution test per action type using a mocked connector client.
- **Complexity:** L

### 1.3 — Atomic approve→execute transition
- **Finding IDs:** F-10
- **Objective:** two concurrent `executeTask()` calls for the same task cannot both pass the approval gate.
- **Scope:** `server/tasks/task-queue.ts:250-280`, `server/tasks/executor.ts:1143-1171` — replace the read-then-write with a single `UPDATE tasks SET status='executing' WHERE id=? AND status='approved'` and check the affected-row count before proceeding; wrap the whole approve→execute handoff in a `db.transaction()`.
- **Dependencies:** none within Phase 1, but pairs naturally with 1.5 (scheduler lock) since both are concurrency fixes.
- **Acceptance criteria:** firing two simultaneous execute requests for the same approved task results in exactly one execution.
- **Tests required:** concurrency test issuing two parallel `executeTask()` calls against the same task ID.
- **Complexity:** M

### 1.4 — Stuck-task recovery sweep
- **Finding IDs:** F-08
- **Objective:** a task orphaned in `executing` after a crash is automatically detected and either resumed-safely or flagged for human attention — never silently invisible.
- **Scope:** new cron job in `server/jobs/scheduler.ts` scanning `tasks WHERE status='executing' AND updated_at < now - N minutes`; on find, check for an external reference (per 1.2) — if one exists, mark `complete`; if not, mark `failed` with a clear "recovered from stuck execution" audit note and raise a signal so a human/agent knows to investigate. Add a `last_heartbeat`/`updated_at` touch inside long-running handlers so the sweep's threshold is meaningful.
- **Dependencies:** 1.2 (the sweep's recovery logic needs the external-reference check to decide complete-vs-failed correctly).
- **Acceptance criteria:** a task artificially left in `executing` for longer than the threshold is resolved automatically within one sweep interval, and a signal is raised.
- **Tests required:** sweep unit test with a stale `executing` row and mocked connector-reference lookup.
- **Complexity:** M

### 1.5 — Cross-process scheduler lock
- **Finding IDs:** F-11
- **Objective:** two Blueprint processes sharing a database file do not both run the same cron job concurrently.
- **Scope:** `server/jobs/scheduler.ts:9-215` — replace the in-process `schedulerStarted` boolean with a DB-backed advisory lock (e.g. a `scheduler_lock` row with `BEGIN IMMEDIATE`/owner-PID/heartbeat-expiry semantics, or a `INSERT OR IGNORE` per-job-per-tick claim row) so only one process's scheduler is "active" at a time, with automatic failover if the lock-holder's heartbeat goes stale.
- **Dependencies:** none, but should land after 1.3-1.4 since it removes one of the two concurrency vectors that motivated them (the other being retries).
- **Acceptance criteria:** starting two server processes against the same database results in each cron job firing once per interval, not twice.
- **Tests required:** integration test starting two scheduler instances against a shared in-memory-backed-by-file DB and asserting single execution.
- **Complexity:** L

### 1.6 — Fix Telegram's silent no-op and add sender-scoped payload preview
- **Finding IDs:** F-12, F-40
- **Objective:** approving a task via Telegram actually executes it, and shows what will change.
- **Scope:** `server/notifications/telegram.ts:213-229,264-268` — call `executeTask(task.id)` after a successful `approveTask()`, matching the dashboard/BAP routes; extend `sendApprovalRequest()` to include a concise before/after summary of `action_payload` (not the full JSON, a human-readable diff line per field that changes).
- **Dependencies:** 0.6 (don't wire up execution on top of an unauthenticated approval channel).
- **Acceptance criteria:** a task approved via Telegram transitions to `executing`/`complete` without any additional dashboard action; the approval message shows the actual change, not just a title.
- **Tests required:** integration test asserting `executeTask` is called after a Telegram approve callback.
- **Complexity:** M

### 1.7 — Write locking / OCC on KB writes
- **Finding IDs:** F-21
- **Objective:** two concurrent writers to the same KB file don't silently clobber each other, and a git-commit failure is never masked as success.
- **Scope:** `server/kb/kb-engine.ts:452-532` — add an optional `expected_hash`/`If-Match`-style parameter for update-in-place writes (compare against the current file's content hash before writing, reject with 409 on mismatch); make `_commit()` failures propagate as a non-2xx response instead of being swallowed to a warning.
- **Dependencies:** 0.2 (path-safety fix should land first since both touch `kb-engine.ts`).
- **Acceptance criteria:** two racing writes to the same path with stale `expected_hash` values — one succeeds, one gets a 409; a forced git-commit failure surfaces as a non-success API response.
- **Tests required:** concurrent-write test; simulated git-commit-failure test.
- **Complexity:** M

**Phase 1 total: ~3-4 weeks for one engineer.**

---

## Phase 2 — BAP completeness

*Missing APIs, permissions, schemas, pagination, and error contracts.*

### 2.1 — Goals BAP surface
- **Finding IDs:** F-20
- **Objective:** an external agent can read, propose, and update progress on goals.
- **Scope:** new routes under `/api/bap/v1/businesses/:businessId/goals` (list/create/detail) and `/api/bap/v1/goals/:id` (progress/status PATCH only, not full rewrite), gated by new `goals:read`/`goals:propose`/`goals:update` permissions; reuse the existing `server/goals/goal-engine.ts` logic.
- **Dependencies:** Phase 0 (permission model must be trustworthy first).
- **Acceptance criteria:** an agent with `goals:read` can list a business's goals and their current progress via BAP; one with `goals:propose` can create a goal that flows into the existing goal-reasoner pipeline.
- **Tests required:** BAP goals CRUD tests including permission-boundary tests.
- **Complexity:** M

### 2.2 — Task/signal search endpoint
- **Finding IDs:** F-23
- **Objective:** agents can genuinely "check first" before proposing, as `SKILL.md` instructs.
- **Scope:** add `q` query param to `GET .../tasks` and `GET .../signals` performing a keyword match against `title`/`description` (SQLite `LIKE` is sufficient at current data volumes; consider FTS5 if this becomes a bottleneck).
- **Dependencies:** none.
- **Acceptance criteria:** `GET .../tasks?q=meta+description` returns tasks whose title/description contain the terms.
- **Tests required:** search endpoint tests including no-match and partial-match cases.
- **Complexity:** S

### 2.3 — BAP pagination
- **Finding IDs:** F-14
- **Objective:** BAP list endpoints are not capped at 200 with no way to see more.
- **Scope:** add `page`/`limit` (matching the dashboard API's existing convention) to `GET .../signals` and `GET .../tasks`, returning `pagination: {page, limit, total, pages}`.
- **Dependencies:** none.
- **Acceptance criteria:** a business with >200 tasks is fully enumerable via repeated paginated calls.
- **Tests required:** pagination boundary tests.
- **Complexity:** S

### 2.4 — Connector status, outcome-read, task-detail, task-cancel endpoints
- **Finding IDs:** connector-status gap, outcome-read gap, task-detail gap, F-34
- **Objective:** close the remaining "forces Hermes to guess or use the dashboard" gaps identified in AUDIT-BAP-GAPS.md.
- **Scope:** `GET .../connectors` (status/last_sync/last_error/staleness), `GET .../outcomes` and `GET /tasks/:id/outcome`, `GET /tasks/:id` detail, and a new `cancelled` terminal state plus `POST /tasks/:id/cancel` (blocked once a task has passed the point of no return in `executing`, per the executor's own internal tracking).
- **Dependencies:** 1.4 (cancel semantics should be defined consistently with the stuck-task recovery sweep).
- **Acceptance criteria:** each new endpoint returns real data matching dashboard-visible state; cancel transitions a `proposed`/`approved` task to `cancelled` and is rejected for `executing` tasks past their point of no return.
- **Tests required:** endpoint-level tests per route; state-machine test for the new `cancelled` transitions.
- **Complexity:** L

### 2.5 — OpenAPI contract and doc alignment
- **Finding IDs:** F-25
- **Objective:** BAP and the public API have a machine-readable, accurate contract.
- **Scope:** generate an OpenAPI 3.x spec from route handlers (or hand-write one and add a CI check that response shapes match it via a schema-validation test middleware in non-production); fix the three confirmed doc/code mismatches (public API auth header/key prefix, error response shape, pagination shape) in `docs/content/integrations/api-reference.md`.
- **Dependencies:** 2.1-2.4 (spec should describe the completed surface, not the current one).
- **Acceptance criteria:** the spec validates against live responses for a representative endpoint set; the three known doc mismatches are corrected.
- **Tests required:** contract test asserting live responses conform to the spec for at least signals/tasks/kb/goals endpoints.
- **Complexity:** L

**Phase 2 total: ~3-4 weeks for one engineer.**

---

## Phase 3 — Intelligence quality

*Signals, attribution, goals, outcomes, calibration, and knowledge learning.*

### 3.1 — Rule-based signal auto-resolution
- **Finding IDs:** F-35
- **Objective:** make the documented auto-resolve behavior real, or correct the documentation.
- **Scope:** `server/signals/signal-engine.ts:79-230` — when a rule that previously triggered no longer triggers on a fresh sync, transition the corresponding open signal to `resolved` (mirroring the `ai_analysis` rule's existing self-resolution pattern at `ai-analysis.ts:600-606`).
- **Dependencies:** none.
- **Acceptance criteria:** a signal whose underlying condition clears on a subsequent sync is automatically resolved without human action.
- **Tests required:** rule-engine test asserting resolution on a triggered→not-triggered transition.
- **Complexity:** M

### 3.2 — Deterministic cross-connector correlation
- **Finding IDs:** F-36
- **Objective:** compound incidents (e.g. simultaneous traffic and ranking drops) are detected deterministically, not only guessed at by an LLM pass.
- **Scope:** new correlation layer in `server/signals/` that, on a new signal, checks for other open signals across different connectors within a time window and business, and raises a `correlation`-type signal with both source signal IDs linked when a known-correlated pair (e.g. GA4 traffic-drop + GSC ranking-drop) is found.
- **Dependencies:** 3.4 (schema needs the signal-to-signal linkage this depends on).
- **Acceptance criteria:** two independently-triggering rules on different connectors within the correlation window produce a linked correlation signal without relying on the LLM pass.
- **Tests required:** correlation-detection unit tests with synthetic multi-connector signal fixtures.
- **Complexity:** L

### 3.3 — Improve outcome-check methodology
- **Finding IDs:** F-37
- **Objective:** reduce false "improved"/"worsened" verdicts feeding calibration and new signals.
- **Scope:** `server/tasks/outcomes.ts:96-108` — at minimum, add a simple trend/seasonality baseline (e.g. compare against the same weekday/period in the prior cycle rather than a single point) and flag (don't auto-verdict) outcomes where a concurrent unrelated task/signal on the same metric makes attribution ambiguous.
- **Dependencies:** none.
- **Acceptance criteria:** outcome verdicts on synthetic data with known seasonal variation are meaningfully more accurate than the current fixed-5%-single-point method (measured via a backtest fixture).
- **Tests required:** outcome-methodology tests against fixture time series with known ground truth.
- **Complexity:** L

### 3.4 — Goals schema completeness
- **Finding IDs:** F-39
- **Objective:** goals carry enough structured data for Hermes to reason about them without inferring from free text.
- **Scope:** `server/db/db.ts:145-169` — add `owner_id`, `confidence`, `blocked_by` (goal-id array or join table), `measurement_window_days`, and a real FK-backed link table for signals/tasks/outcomes associated with a goal (replacing the implicit JSON-matching approach).
- **Dependencies:** 2.1 (the BAP goals surface should expose these fields once added).
- **Acceptance criteria:** a goal can be queried for its linked signals/tasks/outcomes via a join, not a JSON scan; `owner_id` and `confidence` are populated on creation.
- **Tests required:** migration test; goal-linkage query tests.
- **Complexity:** M

### 3.5 — Connector freshness/cursor/source-account schema fields
- **Finding IDs:** F-47
- **Objective:** every connector can report per-metric freshness and a real sync cursor, not just a coarse per-connector `stale` flag.
- **Scope:** add `source_recorded_at`, `sync_cursor`, `source_account_id` columns to `metrics` (or a lightweight companion table if a full-table migration is too invasive); update the scheduler's per-connector write path to populate them from whatever each connector's payload already carries where available.
- **Dependencies:** none, but touches every connector's write path — coordinate with connector-specific fixes below.
- **Acceptance criteria:** at least the 5 connectors already exposing a `fetchedAt`/account concept in their payload (GBP, Shopify, Meta Ads pending 4.3, Brevo, UptimeRobot) populate the new columns end-to-end.
- **Tests required:** schema migration test; per-connector write-path test for populated freshness fields.
- **Complexity:** L

**Phase 3 total: ~3-4 weeks for one engineer.**

---

## Phase 4 — UX and operational polish

*Dashboard, onboarding, connector visibility, audit inspection, and developer experience.*

### 4.1 — Complete write-back rollback coverage
- **Finding IDs:** F-13
- **Objective:** the README's "every action can be undone" claim becomes true, or is corrected.
- **Scope:** `server/tasks/executor.ts:1051-1093` — add rollback handlers for `shopify_page_create` (fixing the stored-but-unhandled `delete_page` case), `shopify_blog_post_create`, `shopify_collection_update`, `shopify_tag_update`; for GitHub issue/PR, add a "close issue"/"close PR" rollback path (closing, not deleting, since GitHub doesn't support issue deletion via the API for non-admins) and store the needed `rollback_data` at creation time; correct the README/docs to describe exactly which actions are reversible if full coverage isn't reached in this phase.
- **Dependencies:** 1.2 (rollback and idempotency both need reliable external-reference tracking).
- **Acceptance criteria:** every `EXECUTABLE_ACTION_TYPES` entry has either a working rollback handler or is explicitly documented as non-reversible in both code comments and user-facing docs.
- **Tests required:** rollback test per action type.
- **Complexity:** M

### 4.2 — Dependency updates and CI audit gate
- **Finding IDs:** F-19
- **Objective:** the 26 known advisories (11 high) are resolved or explicitly risk-accepted, and future regressions are caught in CI.
- **Scope:** update `basic-ftp`, `js-yaml`, `marked`, `uuid`, and the `@anthropic-ai/sdk`-transitive `form-data`; add a `bun audit` (or equivalent) step to `.github/workflows/ci.yml` that fails the build on new high/critical advisories.
- **Dependencies:** none.
- **Acceptance criteria:** `bun audit` reports zero high-severity advisories in direct dependencies; CI fails on a reintroduced high-severity advisory.
- **Tests required:** N/A (CI config change), verify by intentionally downgrading a dependency in a throwaway branch.
- **Complexity:** S

### 4.3 — Connector documentation corrections
- **Finding IDs:** F-27, F-28, F-26, F-48
- **Objective:** every connector doc page matches actual behavior.
- **Scope:** remove the fabricated write-back sections from `wordpress.md`/`stannp.md`; rewrite `meta-ads.md`'s setup instructions to describe the real OAuth flow; correct `stripe.md`'s sync cadence and metric list; add the 6 missing connectors (buffer, klaviyo, semrush, server-access, social, wix) to the README's connector table and update the badge count.
- **Dependencies:** none.
- **Acceptance criteria:** each corrected doc page's claims are individually verifiable against the connector's actual code.
- **Tests required:** N/A (documentation), consider a lightweight doc-lint that flags connector doc pages referencing `capabilities.write` methods that don't exist in the corresponding `index.ts`.
- **Complexity:** S

### 4.4 — Docker hardening
- **Finding IDs:** F-44
- **Objective:** the container doesn't run as root.
- **Scope:** `Dockerfile` — add a non-root `USER` directive after dependency installation, adjusting file ownership for `/app/data`, `/app/kb`, `/app/server/agents` bind-mount targets accordingly.
- **Dependencies:** none.
- **Acceptance criteria:** `docker exec <container> whoami` returns a non-root user; the app still starts and passes its healthcheck.
- **Tests required:** Docker build+run smoke test (also closes part of F-46).
- **Complexity:** S

### 4.5 — CI matrix expansion
- **Finding IDs:** F-46
- **Objective:** cross-platform and packaging claims are actually verified in CI.
- **Scope:** `.github/workflows/ci.yml` — add a lint step (ESLint/Prettier check), add a Docker build-and-healthcheck job, and add at minimum a Windows runner job exercising `scripts/setup.ps1` end-to-end (macOS is lower priority given the Bun/Node toolchain parity, but consider adding if resourcing allows).
- **Dependencies:** 4.4 (Docker job needs the hardened Dockerfile).
- **Acceptance criteria:** CI fails on a lint violation; CI fails on a broken Docker build; a Windows job runs `setup.ps1` and `bun test` successfully.
- **Tests required:** N/A (CI config), validated by intentionally breaking each check in a throwaway branch.
- **Complexity:** M

### 4.6 — Automated backup tooling
- **Finding IDs:** F-53
- **Objective:** operators (and, longer-term, autonomous agents) have a documented, scriptable backup/restore path rather than manual instructions only.
- **Scope:** add `scripts/backup.js` (WAL-safe SQLite copy + KB directory archive) and `scripts/restore.js`, referenced from a new `bun run backup`/`bun run restore` package script; document in `docs/content/deployment/*.md`.
- **Dependencies:** none.
- **Acceptance criteria:** running the backup script produces a restorable archive; the restore script round-trips a backup into a working instance.
- **Tests required:** backup/restore round-trip test.
- **Complexity:** M

### 4.7 — Dashboard UI for public API key management and BAP key rotation
- **Finding IDs:** F-41
- **Objective:** operators can manage both key systems entirely from the dashboard.
- **Scope:** `client/src/pages/Settings.tsx` — add a panel for the `/api/v1` public-API key system (create/list/revoke, mirroring the existing BAP agent panel); add a rotate action for BAP keys (issue a new key, invalidate the old one after a grace period).
- **Dependencies:** none.
- **Acceptance criteria:** an operator can create, view, and revoke a public API key from the dashboard without touching the database directly; rotating a BAP key issues a new credential without requiring full re-registration.
- **Tests required:** frontend component tests for the new panel; backend rotation-endpoint test.
- **Complexity:** M

**Phase 4 total: ~3-4 weeks for one engineer.**

---

## Summary timeline

| Phase | Focus | Estimated effort (1 engineer) | Can start before prior phase fully lands? |
|---|---|---|---|
| 0 | Critical safety | 2-3 weeks | — (do first) |
| 1 | Autonomous reliability | 3-4 weeks | Design can start in parallel with late Phase 0 |
| 2 | BAP completeness | 3-4 weeks | Yes, once Phase 0's permission model is stable |
| 3 | Intelligence quality | 3-4 weeks | Yes, fully parallel with Phase 2 |
| 4 | UX & operational polish | 3-4 weeks | Yes, fully parallel with Phases 2-3 |

With two engineers (one on security/reliability, one on features/polish), Phases 0-1 and Phases 2-4 can run substantially in parallel after Phase 0's first week, compressing the total critical-path to roughly **8-10 weeks** to a state where autonomous Hermes operation is genuinely safe and reasonably complete.
