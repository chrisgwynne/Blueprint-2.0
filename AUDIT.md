# Blueprint — Full Repository Audit

**Scope:** complete technical, architectural, operational, security, and agent-readiness audit of Blueprint 2.0, with the primary question: *can Blueprint currently support a genuinely autonomous Hermes agent?*

**Method:** full repository read (188 server TS files, 25 connector directories, 12 agent profiles, 21 frontend pages, 56 DB tables), the system was actually installed, built, started, and exercised (not just read) — dependencies installed, database initialised, test suite run, typecheck run, client built, the server started with the scheduler and Telegram polling live, and the two most severe security findings were **reproduced against the running instance** (see below). Nine focused subsystem audits fed this synthesis; every claim below carries a `file:line` citation in the companion documents.

**Companion documents:** [AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md) (58 itemised findings) · [AUDIT-FEATURE-MATRIX.md](./AUDIT-FEATURE-MATRIX.md) · [AUDIT-BAP-GAPS.md](./AUDIT-BAP-GAPS.md) · [AUDIT-HERMES-READINESS.md](./AUDIT-HERMES-READINESS.md) · [AUDIT-ROADMAP.md](./AUDIT-ROADMAP.md)

---

## Overall verdict

**Blueprint is a genuinely substantial, mostly-real system — not a prototype or a documentation-driven mirage.** Every major subsystem claimed in the README (connectors, internal agents with soul files, the KB, the nine "Brain" intelligence features, signals, tasks, outcome tracking) has a real, working implementation behind it, verified by direct code reading and, for the most consequential claims, live execution. The engineering quality of the parts that were built carefully — the trust-tier/dangerous-action floor, the prompt-injection sanitiser, the KB's LLM-grounded query/contradiction-detection, the Brain features, the credential encryption — is good.

**But Blueprint cannot currently be operated by an unattended, autonomous Hermes-style agent safely.** Two findings, verified live against a running instance in this audit, are complete blockers on their own:

1. **Anyone who can reach the HTTP port can self-register a fully-privileged BAP API key with zero authentication** (F-01) — confirmed with a single `curl` returning a working `*:*` / all-businesses key.
2. **That key (or any KB-scoped key) can read or write arbitrary files anywhere the server process can reach**, via unvalidated path traversal in the knowledge-base write/read path (F-02) — confirmed by writing a file four directories above the KB root, landing entirely outside the repository.

Layered on top of those two: cross-tenant IDOR bugs in task approval and signal mutation (F-03/F-04/F-06), an execution engine with no idempotency protection that will create duplicate GitHub issues and Shopify products under retry or process-crash-and-restart (F-08/F-09/F-10/F-11), a Telegram approval channel whose approvals silently do nothing (F-12) and which trusts any sender (F-05), and a complete absence of goal access from the external API (F-20) — the single largest functional autonomy gap, independent of the security issues.

None of this means the system is badly engineered in general — it means the specific trust boundary that matters for *this* audit's question (an external, autonomous, unattended agent operating through BAP) has not yet been hardened, while the human-facing dashboard path (session auth, CSRF-safe cookies, allow-listed CORS) is comparatively solid.

---

## Architecture summary

```
Client (React 18 + Vite)  ──HTTP/session-cookie──▶  Express server (Bun)
                                                          │
                    ┌─────────────────────────────────────┼─────────────────────────────────────┐
                    │                                      │                                     │
         Dashboard API (/api/*, unversioned)     BAP (/api/bap/v1/*, API-key)         Public API (/api/v1/*, bpk_ key)
                    │                                      │                                     │
                    └──────────────────────────┬───────────┴─────────────────────────────────────┘
                                                 │
                          SQLite (bun:sqlite, WAL, 56 tables, single file, no versioned migrations)
                                                 │
        ┌──────────────┬──────────────┬─────────┼──────────┬───────────────┬────────────────┐
        │              │              │         │           │               │
  23 connectors   Signal engine   Task/exec   Scheduler   12 agents    KB (files+git)   Brain (9 LLM/
 (OAuth/apikey)   (rule-based +   engine     (node-cron,  (soul-file    isomorphic-git    stat features:
                   LLM overlay)  (approval    no lock,     driven,      + wikilinks +     goals, conflicts,
                                  gated,       no catch-up) shared        contradiction    calibration,
                                  no CAS)                   tool-loop)    detection)       retrospectives...)
```

Backend is TypeScript on Bun/Express; frontend is React 18 + Vite; persistence is a single SQLite file in WAL mode with no separate migrations tool; the KB is file-based markdown with `isomorphic-git` commits; LLM access goes through a shared provider abstraction (8 providers, not the 6 documented) used by both the single-shot agent-run path and a bounded ReAct tool-loop. Everything runs as one Node/Bun process — there is no queue worker, no separate scheduler process, and (confirmed) no cross-process coordination if two instances share a database file.

The three-API-surface split (unversioned dashboard API, versioned BAP, separately-versioned public API with its own key format) is real but undocumented as an intentional design decision, and the public API in particular has no dashboard UI to manage its own keys (F-41).

---

## Top risks

| # | Risk | Findings | Why it's the top of the list |
|---|---|---|---|
| 1 | Full authentication bypass on the API surface Hermes is meant to use | F-01 | Verified live; every other BAP finding is downstream of "an attacker can just register a key" |
| 2 | Arbitrary file read/write outside the KB and outside the repo | F-02 | Verified live; escapes the one sandbox (KB directory) the design relies on |
| 3 | Cross-tenant task approval/execution and data leakage | F-03, F-04, F-06 | Breaks the multi-business isolation the product is designed around |
| 4 | Duplicate external side effects (double GitHub issues/Shopify products) under retry, crash, or two-instance operation | F-08, F-09, F-10, F-11 | The exact failure mode an autonomous, retrying agent will trigger, with real-world consequences (spam issues, duplicate live products) |
| 5 | Telegram approval channel is both insecure and non-functional | F-05, F-12 | The one channel marketed as mobile/remote approval neither authenticates callers nor actually executes approved tasks |
| 6 | No goal access via BAP | F-20 | An autonomous agent cannot read or influence what the business is actually trying to achieve — the highest-level context is invisible to it |
| 7 | Zero test coverage on the exact surfaces Hermes depends on | F-15 | `bap/`, `tasks/`, `connectors/`, `db/`, `kb/`, `routes/` — the security/reliability findings above went undetected by CI because nothing exercises this code |

## Autonomy blockers

The findings above marked "Autonomy blocker: Yes" in [AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md) are, in short: **F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-14, F-15, F-16, F-20, F-21, F-23, F-24.** Nineteen of fifty-eight findings block safe autonomous operation outright; the rest degrade reliability, data quality, or developer experience without being a hard stop.

## Security findings (summary — see AUDIT-FINDINGS.md and the Y/Prompt-injection audit for full detail)

- **Critical:** open BAP registration (F-01), KB path traversal (F-02), two BAP IDOR routes (F-03), unauthenticated agent-run read (F-04), unauthenticated Telegram commands (F-05), unfiltered webhook fan-out (F-06).
- **High:** SSRF via the webhook dispatcher's raw `fetch()` (F-16), an SSRF allowlist that exists but covers almost none of the actual outbound call sites (F-17), silent acceptance of default admin credentials in production (F-18), 26 dependency advisories including 11 high-severity (F-19).
- **What's actually solid:** SQL injection — none found anywhere (parameterised queries throughout, verified across 18 files with dynamic identifiers); credential encryption (AES-256-GCM) and API-key hashing (bcrypt) are both real and correctly used; CORS is allow-list based, not permissive; session cookies are `httpOnly`/`secure`/`sameSite=strict` in production and `SESSION_SECRET` absence is fail-closed; **prompt-injection defences are real and layered** — untrusted connector/web/KB content is wrapped in explicit `<external_content>` boundaries with an instruction not to follow embedded commands, and dangerous action types cannot be self-downgraded by the model regardless of what it outputs.

## Reliability findings (summary)

The task state machine itself is well-designed on paper (defense-in-depth approval gate, a real trust-tier floor, terminal states correctly terminal) — but three structural gaps undermine it for unattended operation: no atomicity on the approve→execute transition (F-10), no idempotency/external-reference check before any create-type write-back (F-09), and no timeout/dead-letter recovery for tasks stuck in `executing` after a crash (F-08). Combine these with no cross-process scheduler lock (F-11) and the realistic failure mode is: a crash during write-back leaves a task permanently stuck, a well-meaning operator or a second Blueprint instance retries it, and the retry performs the external action a second time — with a live GitHub issue or Shopify product as the receipt.

## Data-integrity findings (summary)

No versioned migrations (F-52, low risk today, unbounded startup cost over time); no write-locking on KB files, so two concurrent writers silently clobber each other with git-commit failures swallowed as warnings while the API still reports success (F-21); a real timezone bug in scheduler staleness math that the codebase already fixed once in one place but not the two others (F-22); connector data has no cursor/freshness/source-account columns at the schema level for any of the 23 connectors, so "how stale is this number" can only be answered at the connector level, never per-metric (F-47).

## Missing features (vs. documentation)

- **Goals are invisible to BAP** (F-20) — the single biggest functional gap for an autonomous agent, independent of security.
- **No task/signal search or duplicate-detection endpoint** (F-23) despite `SKILL.md` explicitly instructing agents to "check first" before proposing — this is the exact contradiction the audit brief called out, and it is confirmed real.
- **No BAP pagination** (F-14) — an agent managing a business with more than 200 open tasks or signals structurally cannot see the rest.
- Rollback ("every action can be undone", README) is implemented for 3 of roughly 10 write-back action types (F-13); GitHub issues/PRs and most Shopify content actions cannot be undone by Blueprint at all.

## Misleading documentation

- README's connector count (14) undercounts by 6 real, working connectors (buffer, klaviyo, semrush, server-access, social, wix) that have doc pages but aren't in the marketing table (F-48) — an *inverse* mismatch, code ahead of docs, not concerning on its own.
- WordPress and Stannp docs describe write-back capabilities (draft post creation, mail dispatch) that do not exist in code at all (F-27).
- Meta Ads doc's setup instructions describe a static-token flow that contradicts the actual (better) OAuth implementation (F-28).
- Stripe docs claim hourly sync and list metrics the code doesn't produce; the code actually polls every 6 hours and silently treats API errors as "zero data" (F-26).
- Signals documentation claims auto-resolution when a condition clears; no such logic exists for rule-based signals (F-35).
- The public-facing API reference (`docs/content/integrations/api-reference.md`) is wrong about the public API's auth header, key prefix, error response shape, and pagination shape (F-25) — there is no OpenAPI contract to keep it honest.

## Hermes readiness score

See [AUDIT-HERMES-READINESS.md](./AUDIT-HERMES-READINESS.md) for the full scorecard and reasoning. Headline: **4/16 dimensions score ≥4/5; 7 score ≤2/5.** Weakest: duplicate prevention (1/5), write-back safety (1/5), API completeness (2/5), security (1/5 as currently deployable). Strongest: KB grounding (4/5), observability of agent runs (4/5), multi-business isolation *design* intent (undermined in practice by F-03/F-04/F-06, scored 2/5 as implemented).

**Answering the audit's primary question directly: no, Hermes cannot currently operate Blueprint autonomously and unattended in a way that is safe.** It could, today, safely perform read-only situational-awareness workflows (health, signals, metrics, KB query) against a *trusted, single-tenant, network-isolated* deployment where the operator accepts the current BAP registration model as intentional. It should not be given `tasks:approve`, `kb:write`, or any business-crossing scope until Phase 0 of the roadmap below lands.

## Recommended roadmap (see AUDIT-ROADMAP.md for full detail)

- **Phase 0 — Critical safety** (F-01 through F-06, F-16, F-18): close the auth bypass, the path traversal, the IDOR routes, the webhook SSRF, and the Telegram authorization gap. Nothing else matters until this lands.
- **Phase 1 — Autonomous reliability** (F-08, F-09, F-10, F-11, F-12, F-14, F-21, F-24): durable execution (idempotency keys, atomic approve→execute, stuck-task recovery), scheduler locking, fix Telegram's silent no-op.
- **Phase 2 — BAP completeness** (F-20, F-23, F-25, F-41): goals endpoint, task/signal search, an OpenAPI contract, consistent pagination.
- **Phase 3 — Intelligence quality** (F-35, F-36, F-37, F-38, F-39, F-47): signal auto-resolution, deterministic cross-connector correlation, better outcome attribution, connector freshness fields.
- **Phase 4 — UX and operational polish** (F-13, F-19, F-27, F-28, F-44, F-46, F-52, F-53): rollback completeness, dependency updates, doc corrections, CI matrix, Docker hardening, backups.

---

## What was actually run (evidence, not inference)

| Step | Result |
|---|---|
| `bun install` (root, server, client workspaces) | ✅ succeeded |
| `bun db/init.ts` | ✅ succeeded — 56 tables created |
| `bun run typecheck` (server + client, `tsc --noEmit`) | ✅ zero errors |
| `bun test` (server, `DATABASE_PATH=:memory:`) | ✅ 85 pass / 0 fail / 677 assertions across 9 files |
| `bun run build` (client, Vite) | ✅ succeeded, 2766 modules |
| `bun run --cwd server start` (production entrypoint, scheduler disabled) | ✅ started, `/api/health` returned `{"status":"ok","db":"ok"}` |
| Unauthenticated `POST /api/bap/v1/register` with `["*:*"]`/`["*"]` | ✅ **returned a working fully-privileged key** (F-01) |
| `POST .../kb/write` with `path:"../../../../tmp/blueprint-audit-poc.md"` using that key | ✅ **wrote a file to `/home/user/tmp/`, outside the repo** (F-02) |
| `docker build` | ⚠️ not run — no Docker daemon available in this sandbox; `Dockerfile`/`docker-compose.yml` reviewed statically only (see F-44 and CI gap F-46) |
| Windows / macOS execution | ⚠️ not run — this sandbox is Linux-only; `scripts/setup.ps1`/`setup.sh`/`setup.js` were reviewed for correctness (the JS setup script is genuinely shell-independent and idempotent — reruns cleanly, confirmed via a second `db/init` invocation reporting "already installed — skipping") but never executed on native Windows/macOS |

No test artefacts were committed: the `.env`, `data/blueprint.db*`, and the test business/API key created during verification are all covered by `.gitignore` and were not part of any commit.
