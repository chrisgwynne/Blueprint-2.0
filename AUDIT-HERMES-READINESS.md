# Hermes Autonomous Readiness

This document answers the audit's primary question directly: **can Blueprint currently support a genuinely autonomous Hermes agent?** Scores are 0–5. "Blocks" cross-references [AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md) IDs.

## Scorecard

| Dimension | Score | What's missing for a higher score |
|---|---|---|
| Situational awareness (`BLUEPRINT_HEALTH`, metrics snapshot) | **4/5** | Real, working, well-shaped. Missing: connector-status visibility through BAP (no route), so "why is a metric zero" can't be distinguished from "connector is broken" without dashboard access. |
| Data freshness | **2/5** | No cursor, no per-metric freshness flag, no source-account identity at the schema level for any of 23 connectors (F-47). Only a coarse, hourly-recomputed connector-level `stale` status exists. `period_start`/`period_end` are fabricated from ingestion time, not the real upstream window. |
| Task discovery | **3/5** | List endpoints work and are well-shaped, but hard-capped at 200 with no pagination (F-14), and no detail-by-ID route. |
| Duplicate prevention | **1/5** | No task/signal search endpoint despite `SKILL.md` telling agents to "check first" (F-23); no idempotency keys anywhere in BAP (F-24); executor has no external-reference dedup check before create-type write-backs (F-09) — this is the single weakest dimension. |
| KB grounding | **4/5** | Genuinely real retrieval-then-synthesis with accurate `sources_read`. Loses a point for the path-traversal hole (F-02, security not grounding-quality) and no update-conflict detection between concurrent writers (F-21). |
| Action proposal | **4/5** | `BLUEPRINT_PROPOSE_TASK` is real, well-validated server-side (dangerous action types can't be self-downgraded by the model), trust-tier gating works as designed. |
| Approval tracking | **2/5** | Dashboard and BAP approval work. Telegram approval is broken end-to-end (F-05, F-12) — approvals via the one channel marketed for remote/mobile use silently do nothing and aren't authenticated. |
| Execution tracking | **2/5** | Task status is visible, but a task stuck in `executing` after a crash is indistinguishable from one still legitimately running (F-08); no execution step log. |
| Recovery and retries | **1/5** | No stuck-task timeout sweep (F-08), no atomic approve→execute transition (F-10), retrying a failed task can duplicate the external side effect it already performed (F-09). This is the second-weakest dimension. |
| Long-running workflows | **3/5** | Agent runs, goal checks, and outcome checks are all real, scheduled, and durable at the row level — but no cancel capability exists anywhere (F-33, F-34), and fixed-clock weekly/monthly jobs have no catch-up after downtime. |
| Multi-business isolation | **2/5** | Sound by design at the connector/credential layer (verified: no shared token cache across businesses) and on most BAP routes — but two PATCH routes and one GET route bypass it entirely (F-03, F-04), and webhook fan-out ignores it (F-06). The design intent is good; the implementation has confirmed holes. |
| Write-back safety | **1/5** | No idempotency (F-09), no atomic approval gate (F-10), no cross-process lock (F-11), rollback works for only 2 of 8 action families (F-13). This is the weakest dimension alongside duplicate prevention. |
| Outcome tracking | **3/5** | Real, scheduled, feeds a genuine calibration/KB feedback loop — but the underlying methodology is a naive single-metric before/after delta with no control group or confounder check (F-37), so the feedback loop can be trained on noise. |
| Observability | **3/5** | Rich DB-level identifiers (`agent_runs.id`, `task.id`, audit rows) exist and are queryable, but no HTTP request/correlation-ID middleware (F-56), and agent-run audit logs aren't reachable via BAP key at all (only session auth). |
| Security | **1/5** | Open self-registration (F-01) and KB path traversal (F-02) are both full compromises of the BAP trust boundary, both verified live in this audit. Everything else is downstream of these two. |
| API completeness | **2/5** | Goals are entirely absent from BAP (F-20) — the single biggest functional gap. No connector-status, no outcome-read, no task-detail-by-ID, no cancel, no OpenAPI spec (F-25). |

**Average: 2.4/5. Four dimensions score ≥4; seven score ≤2.**

---

## 1. Can Hermes currently operate Blueprint autonomously?

**No — not safely, and not completely.** The system has the right shape (a real state machine, a real trust-tier floor, real prompt-injection defenses, a real grounded KB) but the specific trust boundary an autonomous external agent operates through — BAP — has a full authentication bypass (F-01) and a filesystem escape (F-02) that were both reproduced live in this audit within minutes, using nothing but the publicly documented registration flow from `SKILL.md` itself. Any deployment reachable from an untrusted network is not safe to hand to an autonomous agent today. Even in a fully trusted, single-operator, network-isolated deployment, the lack of idempotency and stuck-task recovery (F-08, F-09, F-10, F-11) means an autonomous agent that retries on failure — which any resilient agent will do — can and will eventually create duplicate real-world side effects (a second GitHub issue, a second live Shopify product).

## 2. What can it safely do now?

In a **trusted, single-tenant, network-isolated** deployment (the only configuration the current security posture actually supports):
- Read health, signals, and metrics (`BLUEPRINT_HEALTH`, `BLUEPRINT_SIGNALS`, `BLUEPRINT_METRICS`) — these are read-only, well-shaped, and safe to poll.
- Query the KB (`BLUEPRINT_KB_QUERY`, `BLUEPRINT_KB_SEARCH`) for grounded answers with real source citations — safe, read-only.
- Trigger an internal agent to run — bounded by real cost/iteration caps, safe.
- Propose tasks (`BLUEPRINT_PROPOSE_TASK`) — safe in isolation, since nothing executes without separate approval, **but** without a search-first capability (F-23) an autonomous agent proposing repeatedly across sessions will create duplicate proposals over time; this degrades signal quality but isn't unsafe.
- File KB pages **outside path-traversal payloads** — but since nothing currently constrains the `path` field, this bullet's safety rests entirely on the calling agent's own good behavior, not on Blueprint.

## 3. What can it not safely do?

- **Register itself and receive write/approve permissions** — F-01 means this "capability" is really "anyone can grant themselves anything."
- **Write to the KB with an untrusted or adversarially-controlled `path` value** — F-02.
- **Approve or reject tasks/signals across business boundaries** if it holds a key scoped to even one business — F-03, and F-06 means it doesn't even need to guess IDs, they arrive via webhook.
- **Retry a failed task proposal-to-execution cycle** without risk of duplicating the external action — F-09, F-10.
- **Rely on Telegram as an approval channel** — it doesn't execute what it approves (F-12) and doesn't verify who's approving (F-05).
- **Assume two Blueprint processes (e.g. a crash-restart with an orphaned old process) won't double-execute scheduled work** — F-11.
- **Trust that "no data" means "no data" for financial connectors** — Stripe silently converts API errors into empty results (F-26).

## 4. What still requires manual dashboard use?

- **All goal management** — creation, reading, progress updates. No BAP surface exists (F-20).
- **Outcome inspection** — no BAP endpoint reads `tasks.outcome`/`outcome_data`.
- **Connector health/status** — no BAP route; only inferable indirectly and unreliably from missing metrics.
- **BAP key rotation** — revoke-only from the dashboard; no self-service rotation for either key system, and no dashboard UI at all for the public-API key system (F-41).
- **Any list beyond 200 items** — BAP pagination doesn't exist (F-14).
- **Cancelling a stuck or wrong in-flight task** — no `cancelled` state exists (F-34); a human must intervene via direct DB/dashboard status edits, which itself risks the double-execution bug (F-09).

## 5. What failures could leave work stuck?

- A process crash (or an unhandled error in the final `updateTaskStatus(..., 'complete', ...)` call) between dispatching a write-back and marking the task complete leaves it **permanently stuck in `executing`** — no timeout sweep exists anywhere in the scheduler (F-08).
- Agent runs interrupted mid-execution leave an orphaned `'running'` row in `agent_runs` with no sweep or cancel path (F-33).
- Missed fixed-clock weekly/monthly cron jobs (process down at the scheduled time) are silently skipped with no catch-up and no alert — e.g. a monthly retrospective can be lost for a full month unnoticed.
- A KB write racing another concurrent writer can be silently lost (last-write-wins, F-21), and the git-commit failure that would normally be the tell is swallowed to a console warning while the API still reports success.

## 6. What failures could cause duplicate external actions?

- **Retry after failure**: `failed → proposed` is an explicitly allowed transition; nothing checks whether the create-type write-back (GitHub issue/PR, Shopify product/page/blog-post) already succeeded before the failure was recorded (F-09).
- **Concurrent execution race**: the approve→execute transition is read-then-write, not compare-and-swap; two near-simultaneous `executeTask()` calls (e.g. from two Blueprint instances, F-11) can both pass the approval check and both perform the external write.
- **A human "helpfully" retrying a stuck-in-`executing` task** (see §5) after incorrectly assuming it failed, when the external action already succeeded — this is the most likely real-world trigger, because F-08 actively produces the stuck state that invites the retry.
- **Network-level client retries against BAP `POST` endpoints** — no `Idempotency-Key` support anywhere (F-24), so a timeout-and-retry from Hermes's own HTTP client duplicates signals/tasks/KB pages, not just write-back actions.

## 7. What APIs are missing?

Goals (read/write), task detail-by-ID, task cancel, task/signal search, outcome read, connector status/freshness, connector sync-trigger, agent-run cancel, structured agent-run logs, audit-log retrieval for BAP callers, and an OpenAPI contract. Full detail in [AUDIT-BAP-GAPS.md](./AUDIT-BAP-GAPS.md).

## 8. What state is not durable?

- In-memory BAP rate-limit counters (reset on restart, don't work across instances).
- The `job_queue` table exists but nothing writes to or reads from it — dead, not durable because it's not used at all.
- Agent-run "running" status has no crash-recovery reconciliation.
- Task "executing" status has no crash-recovery reconciliation.
- Scheduler leadership (`schedulerStarted` boolean) is in-process memory only — not shared/coordinated across instances.

## 9. What actions are not reversible?

- GitHub issue creation, GitHub draft PR creation — no rollback code exists at all.
- Shopify blog-post creation, Shopify tag update, Shopify collection update — no `rollback_data` is ever stored.
- Shopify page creation — `rollback_data` is stored but the rollback handler has no matching case, so attempting rollback throws at runtime.
- Any KB write — reversible only via manual `git` operations outside Blueprint's own tooling.
- Cross-tenant mutations performed via F-03/F-06 — there is no way to distinguish an unauthorized cross-tenant change from a legitimate one after the fact without manual audit-log archaeology.

## 10. What would be required for reliable unattended operation?

In priority order (maps to [AUDIT-ROADMAP.md](./AUDIT-ROADMAP.md)):
1. Close F-01 and F-02 — without these, "unattended" is indistinguishable from "unsecured."
2. Fix the IDOR routes and webhook fan-out (F-03, F-04, F-06, F-07) so multi-business isolation is actually enforced, not just designed.
3. Add idempotency keys to every BAP write endpoint and an external-reference check before every create-type write-back (F-09, F-24).
4. Make the approve→execute transition atomic (compare-and-swap or a real transaction) and add a stuck-task timeout sweep with alerting (F-08, F-10).
5. Add a cross-process scheduler lock so a crash-restart or an accidental second instance can't double-execute cron jobs (F-11).
6. Fix Telegram: authenticate senders and actually call `executeTask()` on approval (F-05, F-12), or don't market it as an approval channel until both are fixed.
7. Expose goals, connector status, outcomes, task search, and task cancellation via BAP (F-20, F-23, F-34, and the connector/outcome gaps).
8. Publish an OpenAPI contract and align the hand-written docs with actual behavior (F-25).
9. Add automated tests for `bap/auth.ts`, `tasks/executor.ts`, and the state machine — the exact code that had the highest-severity findings had zero coverage (F-15).

---

## Proposed end-to-end autonomous workflow (once the above lands)

```
1. Hermes calls GET /businesses/:id/health           → situational awareness, freshness-aware
2. Hermes calls GET /businesses/:id/signals?status=open&severity=critical,alert
3. For each signal worth acting on:
   a. GET /businesses/:id/tasks?q=<keywords>          → duplicate check (currently impossible — F-23)
   b. GET /businesses/:id/goals                       → does this align with a stated goal? (currently impossible — F-20)
   c. POST /businesses/:id/tasks  (Idempotency-Key: <uuid>)   → propose, safe to retry (currently unsafe — F-24)
4. Human or auto-approval (green tier) approves       → atomic approve→execute (currently racy — F-10)
5. Execution dispatches with an external-reference pre-check → no duplicate GitHub issue/Shopify product (currently absent — F-09)
6. If the process crashes mid-execution, a reconciliation sweep resolves the stuck task on restart (currently absent — F-08)
7. GET /tasks/:id/outcome two/four weeks later        → currently impossible via BAP, only internal
8. Outcome feeds calibration (already real, F-37 caveat on methodology) and Shared KB (already real)
9. Hermes cites the outcome in its next proposal for a similar signal — closes the loop
```

Steps 3a, 3b, 3c(Idempotency-Key), 4(atomicity), 5(dedup), 6(recovery), and 7 are the seven concrete gaps between the current system and this workflow being safe to run unattended.
