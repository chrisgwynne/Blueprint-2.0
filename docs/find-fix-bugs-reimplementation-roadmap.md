# `find-fix-bugs-TSahh` → master re-implementation roadmap

This document preserves the value of the `claude/find-fix-bugs-TSahh` branch so that
branch can be **safely deleted**. The branch (4 commits, ~5,400 lines, last updated
2026-04-19) diverged from `master` weeks ago; a git merge would conflict heavily and
its old TypeScript would not compile against current APIs. The decision (owner) was to
**re-implement** the still-valuable parts on current `master`, not merge. This roadmap
is that plan — re-implement from here; the branch itself is disposable.

Source commits (for reference until the branch is deleted):
`cacba8f` (audit security/reliability fixes), `fd01967` (reliability/observability infra),
`2b4046d` (work sessions, shared brain, autonomy), `c3c15d4` (rollback, preview, brief,
ingest, experiments, templates, forecast).

Verified against `master`: none of the branch's hardening is present on master yet
(every patched line still exists), so all Tier-1/2 items below are net-new.

---

## TIER 1 — security/reliability hardening (do first; low-risk, high-value, no schema/deps)

Closes gaps named in the codebase audit. One focused PR.

1. **SESSION_SECRET hard-fail + ≥32 chars** — `server/index.ts` ~L123-129 currently falls back to the literal `'blueprint-dev-secret-please-set-in-env'`. Replace with: missing/short ⇒ `console.error` + `process.exit(1)`.
2. **`assertEncryptionKey()` at boot** — add export to `server/crypto.ts` wrapping the existing key-derivation; call in the `index.ts` startup try/catch so a bad `ENCRYPTION_KEY` fails fast instead of at first decrypt.
3. **CORS origins: trim + drop-empty + exit-if-empty** — `index.ts` ~L106 `.split(',')` → `.map(s=>s.trim()).filter(Boolean)`; exit if the resulting allowlist is empty in production.
4. **Global error handler: no 5xx message/stack leak in prod** — `index.ts` error handler; return a generic message in production, detail only in dev; use `'Origin not allowed.'` for CORS rejections.
5. **KB path-traversal containment (highest value)** — `server/kb/kb-engine.ts` uses raw `join(this.root, …)` at ~L324/382/463/563/592/679; add a `safeJoin()` that resolves and asserts containment under root, and swap those 6 call sites. Add `assertSafeKBPath()` guard in `server/routes/kb.ts` on every `/file/*`, `/backlinks/*`, `/history/*`, `/diff/*`, `/restore` handler.
6. **Obsidian vault symlink hardening** — `routes/kb.ts` settings handler: `realpathSync`/`lstatSync` + `.obsidian` containment instead of plain `existsSync`.
7. **BAP API-key prefix-collision fix** — `server/bap/auth.ts` (~L41 single `.get()`): fetch **all** candidates sharing the 12-char prefix, bcrypt-verify each, and reject unknown `businessId`. (Use the narrow version unless also doing Tier-2 `audit-signature`, whose port supersedes this hunk.)
8. **public-api rate-limiter idle sweep** — `routes/public-api.ts` ~L87: add `setInterval(...).unref()` janitor so the in-memory map can't grow unbounded.
9. **DB export truncation visibility** — `routes/export.ts` ~L159 silently `LIMIT 10000`; add per-table `COUNT(*)` + a `truncated[]` field in the response.
10. **Replace ~26 silent `.catch(() => {})`** with logging catches across agent-runner, self-healer, bap, retrospective-engine, chat-engine, goal-engine, telegram, auth, tasks, oauth, workflow-engine, task-queue. Pure observability; zero behaviour change.
11. **JSON.parse swallow logging** in `routes/dashboard.ts` (`latestData`) and `routes/public-api.ts` (`safeJSON`).
12. **Login rate-limit + lockout** — new `server/middleware/login-rate-limit.ts` (dependency-free); wire before the `/login` handler in `routes/auth.ts`; `clearLoginAttempts(req)` on success. Master has **no** login throttling today.
13. **Security-headers middleware** — new `server/middleware/security-headers.ts` (nosniff, frame-deny, referrer-policy, permissions-policy, HSTS in prod). Keep CSP behind an env flag / relaxed initially — verify it doesn't break the Vite SPA before enforcing `script-src 'self'`.
14. **fetch timeout** — fold an `AbortController` timeout into the existing `server/lib/safe-fetch.ts` (so allowlist + timeout live together) rather than a parallel helper; master's `safeFetch` can currently hang forever.

> Apply the **union** of `cacba8f`+`fd01967` edits to `index.ts` once (they overlap). Convert any `require(...)` in ported hunks to ESM `import`.

## TIER 2 — net-new infra modules (assess; some need wiring/idempotent schema)

`lib/migrate.ts` + versioned `db/migrations` runner (**prerequisite for Tier 3**); `db/db.ts` `walCheckpoint()`/`vacuum()`/`closeDatabase()`; `lib/shutdown.ts` (disposer registry — **replaces** master's existing SIGTERM/SIGINT block, don't stack); `lib/logger.ts` (structured NDJSON) + `lib/request-context.ts` (AsyncLocalStorage request-id) + `lib/error-reporter.ts`; `lib/circuit-breaker.ts` (+ scheduler wiring for failing connectors); `lib/spend-cap.ts` (per-business daily LLM cap, gate in agent-runner); `lib/queue-limits.ts` (per-agent pending-task backpressure); `middleware/csrf.ts` + `types/session.ts` (port session types first; removes `(req.session as any)`); `middleware/etag.ts`; `lib/oauth-state.ts` (**real upgrade**: server-side OAuth state table + PKCE vs master's unvalidated base64 state); `lib/audit-signature.ts` (HMAC hash-chained BAP audit); `lib/pagination.ts`; `lib/openapi.ts` + `/api/openapi.json`; enriched `/api/health` (DB read+write probe, 503 on degraded); Dockerfile multi-stage + non-root + `tini` + `HEALTHCHECK`; `client/src/App.tsx` per-route ErrorBoundary.

## TIER 3 — large feature subsystems (PRODUCT DECISION; all net-new; depend on Tier-2 migrations runner)

- **Work sessions** — operator opens a bounded auto-approval window (agent/action/trust scope, USD + task-cap + deadline budget, atomic counter). Hands-off autonomy with hard guardrails.
- **Shared brain / cross-business patterns** — transferable lessons promoted from retrospectives, scored, folded into agent prompts, outcome-attributed.
- **Outcome-driven autonomy tiers** — 60-day rollup → 0-100 score → probation/standard/trusted/restricted; trusted agents raise the session trust ceiling; restricted auto-paused.
- **Action preview** — diff/before-after snapshot before approval.
- **Morning brief** — daily composed digest (telegram/email/dashboard) at a configurable local hour.
- **Inbound webhooks / ingest** — public bearer-authed endpoint (bcrypt secret + optional body-HMAC) that synthesises signals from external payloads. *Security-sensitive — review auth path.*
- **Experiments** — variant/control task A/B with a measurement window + auto-promote winner.
- **Business templates / fork** — transactional clone of connectors (creds stripped), goals, workflows + KB scaffold.
- **Attributed-revenue forecast** — lookback run-rate → horizon projection + confidence label.
- **Generic task-rollback policy layer** — ⚠️ master already has executor-level rollback (`tasks/executor.ts` `rollbackTask` + `file_backups`). Only port the policy/audit/API *wrapper*; do not duplicate the restore mechanism.

## SKIP — already on master (do NOT re-port)
Graceful shutdown (basic), outbound allowlist, content sanitiser, AES-256-GCM crypto, in-memory rate-limiter primitive, executor rollback + `file_backups`, ROI/attribution/retrospectives/calibration, KB engine, BAP auth core, BAP webhook HMAC signing. (The branch's *additions* on top of these — `assertEncryptionKey`, KB path-safety, the public-api sweep, the audit-log HMAC chain — are the net-new bits captured in Tier 1/2 above.)

## Recommended order
1. Tier-1 #1-11 (one focused PR, no schema/deps). 2. Tier-1 #12-14 + dependency-free Tier-2 (login-rate-limit, security-headers, fetch-timeout, logger, request-context, error-reporter). 3. Tier-2 migrations runner + db helpers + shutdown (unblocks Tier 3). 4. Tier-2 stateful modules. 5. Tier-3 only after a product decision, each behind a feature flag, its own PR.
