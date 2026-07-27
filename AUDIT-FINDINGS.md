# Blueprint — Detailed Findings Register

This register accompanies [AUDIT.md](./AUDIT.md). Findings are derived from direct code reading (file:line citations throughout), and the most severe items were **verified live** against a running instance (see the "Verified" column) — not inferred from filenames or documentation claims.

Severity scale: **Critical** (data leakage, unauthorised access, irreversible/duplicate external actions) · **High** (breaks a core autonomy guarantee or a major security control) · **Medium** (real defect, bounded blast radius) · **Low** (hygiene/robustness) · **Informational** (no immediate risk, worth tracking).

"Autonomy blocker" = would prevent Blueprint from being safely operated by an unattended Hermes-style agent as-is.

---

## Critical

| ID | Category | Title | Evidence (file:line) | Reproducibility | Autonomy blocker |
|---|---|---|---|---|---|
| F-01 | Security / BAP | Unauthenticated self-registration grants arbitrary permissions & all-business access | `server/routes/bap.ts:65-129` | **Verified live** — single `curl` | Yes |
| F-02 | Security / KB | KB path traversal escapes `KB_ROOT` entirely on read and write | `server/kb/kb-engine.ts:324,463`; `server/routes/bap.ts:646-661` | **Verified live** — file written to `/home/user/tmp/` from a business-scoped call | Yes |
| F-03 | Security / BAP | `PATCH /signals/:id` and `PATCH /tasks/:id` skip business-scope authorization (IDOR) | `server/routes/bap.ts:398,515`; `server/bap/auth.ts:149-165`; `server/tasks/task-queue.ts:338-401` | High confidence — code-path traced, not yet executed live | Yes |
| F-04 | Security / BAP | `GET /runs/:runId` has no permission check at all | `server/routes/bap.ts:775-794` | High confidence — code-path traced | Yes |
| F-05 | Security / Telegram | Telegram command/callback handlers never verify sender identity | `server/notifications/telegram.ts:195-281` | High confidence — code-path traced; requires Telegram enabled | Yes (when Telegram used) |
| F-06 | Security / BAP | Webhook fan-out is not filtered by `business_access`, broadcasting cross-tenant IDs to every subscriber | `server/bap/webhook-dispatcher.ts:33-38` | High confidence | Yes (compounds F-03) |

### F-01 detail
**Observed:** `POST /api/bap/v1/register` requires no authentication and stores whatever `requested_permissions`/`business_access` the caller sends, verbatim (comment at `bap.ts:92-93`: *"For personal Blueprint instances, grant all requested permissions"*). **Verified live:** `curl -X POST /api/bap/v1/register -d '{"name":"x","requested_permissions":["*:*"],"business_access":["*"]}'` returned a working `bap_...` key with global admin-equivalent scope in under 200ms, no prior credential needed.
**Expected:** registration should either require an existing authenticated principal (dashboard session) to mint agent keys, or cap self-granted permissions to a safe default (e.g. read-only) with an explicit human-approval step for anything that can write or approve.
**Why it matters:** this is a full authentication bypass — anyone who can reach the HTTP port owns the instance.
**Recommended fix:** require session-auth (or a one-time operator-issued bootstrap token) to call `/register`; alternatively auto-grant only a minimal read-only permission set and require an explicit dashboard "approve new agent" action before `tasks:approve`, `kb:write`, or `agents:trigger` are granted.
**Tests required:** integration test asserting unauthenticated `/register` cannot obtain write/approve permissions; permission-matrix unit tests for `hasPermission()`.

### F-02 detail
**Observed:** `kb-engine.ts` builds the write/read path via `join(this.root, relativePath)` with zero containment check; the BAP route passes the caller's JSON `path` straight through. **Verified live:** registered a wildcard key (F-01), created a test business, then `POST /businesses/biz_audittest/kb/write` with `path:"../../../../tmp/blueprint-audit-poc.md"` returned `{"committed":true}` and the file materialised at `/home/user/tmp/blueprint-audit-poc.md` — four directories above the KB root, entirely outside the repository.
**Expected:** every KB path must be `resolve()`d and checked with `startsWith(root + sep)` (or equivalent) before any `fs` call, rejecting traversal, absolute paths, and null bytes.
**Why it matters:** any BAP agent — including the one any anonymous caller can mint via F-01 — can read or overwrite arbitrary files reachable by the server process's file permissions.
**Recommended fix:** add a `containPath(root, relativePath)` guard shared by `readFile`/`writeFile`/`archiveFile`/`deleteFile` in `kb-engine.ts`; reject reserved Windows device names and case-collisions defensively even though the deploy target is Linux.
**Tests required:** unit tests for `../../`, absolute paths, `%2e%2e%2f`, null bytes, reserved names, and a same-file case-variant, all asserting rejection.

### F-03 / F-04 / F-06 detail
See `AUDIT-BAP-GAPS.md` §Permission Matrix for the full endpoint-by-endpoint breakdown. In short: `requirePermission()` derives `businessId` from `req.params.businessId ?? req.body.businessId ?? null` (`auth.ts:152-155`); the two PATCH routes have no `:businessId` path segment, so the check is silently skipped, and the underlying `SELECT/UPDATE ... WHERE id=?` queries never re-verify tenant ownership. `GET /runs/:runId` has no `requirePermission()` call whatsoever. The webhook dispatcher queries `SELECT * FROM bap_agents WHERE status='active' AND webhook_url IS NOT NULL` with no `business_access` filter, so a business-A agent subscribed to `signal.*`/`task.*` events receives business-B's IDs and can feed them straight into F-03.
**Recommended fix:** add `:businessId` to both PATCH routes (or re-derive and check business ownership from the fetched row before mutating), add `requirePermission()` to `GET /runs/:runId`, and filter webhook recipients by whether the event's `business_id` is in the agent's `business_access`.
**Tests required:** cross-tenant IDOR regression tests for both PATCH routes, `/runs/:id`, and webhook fan-out.

### F-05 detail
**Observed:** `handleCommandInternal()` receives the *configured* `chatId` but never compares it against `message.chat.id` (the actual sender) before executing `/approve <id>`/`/reject <id>`; `handleCallbackInternal()` never checks `callbackQuery.from.id` before acting on a button tap. The optional `TELEGRAM_WEBHOOK_SECRET` only gates the webhook transport, not command authorization, and polling mode (the default) has no secret check at all.
**Recommended fix:** hard-fail (ignore + log) any command/callback whose `chat.id`/`from.id` isn't in an explicit allow-list sourced from `TELEGRAM_CHAT_ID` (and optionally an admin-configurable extra list).
**Tests required:** unit test asserting a message from an unconfigured chat ID is ignored, not acted on.

---

## High

| ID | Category | Title | Evidence | Autonomy blocker |
|---|---|---|---|---|
| F-07 | BAP | `GET /businesses/:bid/agents` ignores `:bid` in its SQL — leaks every business's internal agents | `server/routes/bap.ts:726-733` | Yes |
| F-08 | Reliability / Tasks | No recovery for tasks stuck in `executing` after a crash — no timeout sweep exists | `server/tasks/executor.ts:1249-1264`; absent from `server/jobs/scheduler.ts` | Yes |
| F-09 | Reliability / Write-back | No idempotency / external-reference check before create-type write-backs | `server/tasks/executor.ts:190-265,782-810,913-935` | Yes |
| F-10 | Reliability / Tasks | Approval gate is read-then-write, not atomic — concurrent `executeTask()` calls can both pass | `server/tasks/task-queue.ts:250-280`; `server/tasks/executor.ts:1143-1171` | Yes |
| F-11 | Reliability / Scheduling | No cross-process lock — two Blueprint instances double-run every cron job | `server/jobs/scheduler.ts:9-215` | Yes |
| F-12 | Reliability / Telegram | Approving a task via Telegram never calls `executeTask()` — approvals silently do nothing | `server/notifications/telegram.ts:213-229,264-268` | Yes |
| F-13 | Reliability / Write-back | "Every action can be undone" is true for only 3 of ~10 write-back action types | `server/tasks/executor.ts:1051-1093` | Partially |
| F-14 | API / BAP | BAP list endpoints hard-cap at 200 items with no pagination | `server/routes/bap.ts:317-346,420-450` | Yes, at scale |
| F-15 | Testing | Zero automated test coverage for `bap/`, `tasks/`, `connectors/`, `db/`, `kb/`, `routes/` | Repo-wide (9 test files total, none in these dirs) | Yes |
| F-16 | Security | SSRF via BAP webhook dispatcher — raw `fetch()`, no allowlist | `server/bap/webhook-dispatcher.ts:109` | Yes |
| F-17 | Security | Outbound SSRF allowlist (`safe-fetch.ts`) is wired into ~2 of dozens of outbound call sites | `server/lib/safe-fetch.ts` usage vs. `server/connectors/*/index.ts` | No, but broad exposure |
| F-18 | Security | No rejection of default admin credentials (`admin`/`changeme`) in production | `server/routes/auth.ts:47-84` | No |
| F-19 | Security | 26 dependency advisories (11 high) via `bun audit`, several in packages parsing untrusted input | `server/package.json` (basic-ftp, js-yaml, marked, form-data via `@anthropic-ai/sdk`) | No |
| F-20 | Autonomy / Goals | No BAP endpoint for goals at all | `server/routes/goals.ts:11` (session-auth only); absent from `bap.ts` | Yes — largest single autonomy gap |
| F-21 | Data integrity / KB | No write locking/OCC on KB files — concurrent writers silently clobber each other | `server/kb/kb-engine.ts:452-532` | Yes |
| F-22 | Data integrity / Scheduling | Scheduler staleness checks parse non-`Z`-suffixed timestamps as local time | `server/jobs/scheduler.ts:202,267` (contrast the fix already applied at line 340) | Conditionally (non-UTC hosts) |
| F-23 | Autonomy / BAP | No task/signal search or duplicate-detection endpoint, despite `SKILL.md` instructing agents to "check first" | `server/routes/bap.ts` (full file); `SKILL.md:168,234,479-480` | Yes |
| F-24 | Reliability / BAP | No idempotency-key support on signal/task creation | `server/routes/bap.ts:347,454` | Yes |
| F-25 | Docs / API | No OpenAPI spec; hand-written docs wrong on auth header, key prefix, error shape, and pagination shape | `docs/content/integrations/api-reference.md` vs `server/routes/public-api.ts:42-46`, `server/routes/bap.ts:403` | No, but forces guesswork |
| F-26 | Connectors | Stripe swallows all API errors to `{data:[]}`, indistinguishable from real zero data; doc claims hourly sync, code polls every 6h; documented metrics don't exist in code | `server/connectors/stripe/index.ts:61,115-121`; `docs/content/connectors/stripe.md` | No, but corrupts financial signal quality |
| F-27 | Connectors / Docs | WordPress and Stannp docs describe write-back (draft posts / mail dispatch) that doesn't exist in code | `docs/content/connectors/wordpress.md`, `stannp.md` vs `wordpress/index.ts:52`, `stannp/index.ts:65` (`capabilities.write:false`) | No |
| F-28 | Connectors / Docs | Meta Ads doc's auth setup contradicts the real OAuth flow; connector has no `fetchedAt` field anywhere | `docs/content/connectors/meta-ads.md` vs `server/connectors/meta-ads/index.ts:133-158,266-274` | No |
| F-29 | Connectors | Tavily connector's `fetch()`/`extractMetrics()` are stubs — silently produces nothing if scheduler polls it | `server/connectors/tavily/index.ts:168-171` | No |

---

## Medium

| ID | Category | Title | Evidence |
|---|---|---|---|
| F-30 | Agents | Per-agent tool capability boundary (`tools_allowed`/`ROLE_SPECS`) is declared but never enforced — every agent gets the same 5 tools | `server/agents/tools/registry.ts:175-181`; `server/agents/tool-loop.ts:192` |
| F-31 | LLM | No timeout on 5 of 6 documented provider adapters (only OpenAI sets one) | `server/lib/providers/{anthropic,google,ollama,lmstudio,custom}.ts` |
| F-32 | LLM | No retry/backoff on any provider adapter; fallback provider is opt-in and unconfigured by default | `server/lib/llm-providers.ts:310-315`; `server/agents/agent-runner.ts:1253-1272` |
| F-33 | Agents | No cancel endpoint for agent runs; no sweep for `agent_runs` rows orphaned in `'running'` after a crash | `server/routes/agents.ts`; `server/jobs/scheduler.ts` |
| F-34 | Tasks | No `cancelled` status; no way to stop an in-flight `executing` task | `server/tasks/task-queue.ts:5-15,84-95,378-401` |
| F-35 | Signals | Docs claim signals auto-resolve when the underlying condition clears; no such logic exists for rule-based signals | `server/signals/signal-engine.ts:79-230` vs `docs/content/signals/overview.md:33` |
| F-36 | Signals | Cross-connector correlation exists only as an LLM guess, not a deterministic computation | `server/signals/rules.ts` (all single-connector-scoped); `server/signals/ai-analysis.ts:129-160` |
| F-37 | Outcomes | Outcome methodology is a naive single-metric before/after delta at a fixed 5% threshold — no control group, no confounder check | `server/tasks/outcomes.ts:96-108` |
| F-38 | Tasks | `DANGEROUS_ACTION_TYPES` hard floor lives in `shouldAutoApprove()`, but the actual green-tier auto-execute branch checks `trust_tier`/`approval_mode` directly, bypassing it at that call site | `server/tasks/task-queue.ts:368-370` vs `server/tasks/approval.ts:36-46,71-85` |
| F-39 | Goals | Goals schema is missing owner, confidence, explicit dependency/conflict links, and measurement-window fields | `server/db/db.ts:145-169` |
| F-40 | Telegram | Approval preview shows a text summary only, never the actual before/after `action_payload` diff | `server/notifications/telegram.ts:350-387` |
| F-41 | API / Frontend | No BAP key rotation (revoke-only); no dashboard UI at all for the separate public-API (`/api/v1`, `bpk_...`) key system | `client/src/pages/Settings.tsx`; `server/routes/public-api.ts:401-412` |
| F-42 | DB | Write-back side effect and its status transition are not wrapped in a DB transaction | `server/tasks/executor.ts:1142-1268` |
| F-43 | DB | SQLite pragmas (`busy_timeout`, `foreign_keys`) are per-connection and not enforced against other openers; no multi-instance guard | `server/db/db.ts:20-23` |
| F-44 | Docker | Container runs as root — no `USER` directive | `Dockerfile` |
| F-45 | Agents | Agent-trigger cooldown has an explicit override for `signal.critical`/`signal.alert`/`agent.brief.immediate` events | `server/agents/event-triggers.ts:73-95,212-224` |
| F-46 | CI | CI runs only on `ubuntu-latest`, no lint step, no Docker build verification despite Docker being a first-class install path | `.github/workflows/ci.yml` |
| F-47 | Connectors | Freshness/cursor/source-account-identity fields are structurally absent from the schema for all 23 connectors | `server/db/schema.sql:14-25,120-129` |
| F-48 | Connectors / Docs | 6 real, working connectors (buffer, klaviyo, semrush, server-access, social, wix) are omitted from the README's "14 connectors" table | `README.md:20,268-279` vs `server/types/connectors.ts:4-27,104` |
| F-49 | Connectors | Google Ads and GitHub silently swallow per-section fetch failures with no caller-visible partial-failure flag | `server/connectors/google-ads/index.ts:146-198` vs the `partial_failures[]` pattern in `gbp/index.ts:148-154` |
| F-50 | Connectors | `social` connector bypasses the shared outbound allowlist, uses raw `node-fetch`, swallows per-post insight errors | `server/connectors/social/index.ts:11,296-318,361-385` |
| F-51 | Connectors | `server-access` connector builds SSH exec commands with `JSON.stringify`-based quoting, not shell-safe (currently unreachable — all inputs are developer-hardcoded) | `server/connectors/server-access/connection.ts:151`; `index.ts:122` |

---

## Low / Informational

| ID | Category | Title | Evidence |
|---|---|---|---|
| F-52 | DB | No versioned migrations system — an ever-growing array of idempotent `IF NOT EXISTS` statements re-run on every boot | `server/db/db.ts:36-622` |
| F-53 | DB | No automated backup/restore tooling; only manual operator instructions in docs | `docs/content/deployment/*.md` |
| F-54 | DB | `job_queue` table is defined in schema but entirely unused | `server/db/schema.sql:390-405` |
| F-55 | Frontend | Logout clears the wrong cookie name (`connect.sid` vs actual `blueprint.sid`) — server-side session is still destroyed, cosmetic only | `server/routes/auth.ts:118` vs `server/index.ts:143` |
| F-56 | Observability | No HTTP request/correlation-ID middleware (DB-level IDs — `task.id`, `agent_runs.id` — do exist and thread through records) | repo-wide |
| F-57 | LLM | `custom` and `minimax` providers are implemented but absent from the provider docs | `server/lib/llm-providers.ts:80-107` vs `docs/content/agents/llm-providers.md` |
| F-58 | Security | `/api/system/db-init` executes a child process from a session-authenticated route (low risk — fixed, non-injectable path) | `server/index.ts:422-436` |

---

## Cross-reference

For the BAP-specific subset of these findings mapped onto the full endpoint inventory and permission matrix, see [AUDIT-BAP-GAPS.md](./AUDIT-BAP-GAPS.md). For how each finding maps onto a documented feature's implementation status, see [AUDIT-FEATURE-MATRIX.md](./AUDIT-FEATURE-MATRIX.md). For the phased remediation plan, see [AUDIT-ROADMAP.md](./AUDIT-ROADMAP.md).
