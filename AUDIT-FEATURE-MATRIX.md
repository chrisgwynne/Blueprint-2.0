# Blueprint — Feature Implementation Matrix

Every feature claim from `README.md` and `docs/content/**` classified against actual code. Status values: **Fully implemented** · **Partially implemented** · **Stubbed** · **Misleadingly documented** · **Missing** · **Implemented but unreliable** · **Implemented without adequate tests**. See [AUDIT-FINDINGS.md](./AUDIT-FINDINGS.md) for the finding IDs referenced in Notes.

## Core loop

| Claim | Location | Status | Tests | UI | BAP | Prod ready | Notes |
|---|---|---|---|---|---|---|---|
| Connectors collect business data | `server/connectors/*` (23 dirs) | Fully implemented (per-connector variance) | None (0/23) | Y | Partial (metrics only, no connector-status route) | Mostly — see connector table below | README undercounts by 6 real connectors (F-48) |
| Signal rules detect anomalies/opportunities | `server/signals/rules.ts` (~90 rules) + `ai-analysis.ts` | Fully implemented | 1 file (`rules.test.ts`) | Y | Y (read/create only) | Yes, with caveats | Confidence/severity hardcoded, not calibrated (F-35, F-36) |
| Agents investigate | `server/agents/agent-runner.ts`, `server/tasks/investigation/` | Fully implemented | Partial | Y | Y (trigger only) | Yes | Tool-loop capability scoping not enforced (F-30) |
| Agents propose tasks | `server/tasks/task-queue.ts` | Fully implemented | None | Y | Y | Yes | No dedup/search before propose (F-23) |
| Human approves via dashboard/Telegram | `server/routes/tasks.ts`, `server/notifications/telegram.ts` | Dashboard: fully implemented. Telegram: **implemented but unreliable** | None | Y | Y (dashboard/BAP) | Dashboard yes, Telegram **no** | Telegram approvals never execute (F-12); no sender auth (F-05) |
| Blueprint executes approved changes | `server/tasks/executor.ts` | Fully implemented, **not idempotent** | None | Y | Y | No | F-08, F-09, F-10 — duplicate/stuck-execution risk |
| Outcome tracking at 2/4 weeks | `server/tasks/outcomes.ts`, `server/jobs/scheduler.ts:432-441` | Fully implemented, methodology is naive | None | Y | Partial (no write endpoint) | Yes, with caveats | Single-metric delta, fixed 5% threshold (F-37) |
| Knowledge base compounds | `server/kb/kb-engine.ts`, `kb-agent.ts` | Fully implemented, **critical security gap** | None | Y | Y | **No** | Path traversal (F-02), no write locking (F-21) |
| Future decisions improve from results | `server/brain/calibration.ts`, `outcomes.ts:243-252` | Fully implemented | None | Y (partial) | No | Yes | Real statistical calibration, not cosmetic |

## Connectors (23 implemented, README claims 14)

| Connector | README claim | Code | Auth | Incremental sync | Retry | Freshness fields | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| GA4 | Y | Real | OAuth2 + refresh | No (relative windows) | No | fetchedAt only | 0 | — |
| GSC | Y | Real | OAuth2 + refresh | No | No | None in payload | 0 | — |
| PageSpeed | Y | Real | API key/OAuth hybrid | N/A | Status decode only | fetchedAt | 0 | — |
| Google Business Profile | Y (README only) | Real, best-in-class | OAuth2 + refresh | No | Yes (`withRetry`) | fetchedAt + `partial_failures[]` | 0 | Best pattern in the codebase — should be the template for others |
| Google Ads | Y | Real | OAuth2 + refresh | No | Partial | fetchedAt, no account id | 0 | Silently swallows per-section failures (F-49) |
| Shopify | Y | Real, best pagination | API key | Cursor-based (orders/products) | Yes, bespoke 429 handling | fetchedAt, no account id | 0 | Customers hard-capped at 250, silently |
| Stripe | Y | Real (SDK) | API key | No | **No — errors swallowed to `[]`** | fetchedAt | 0 | F-26 — doc/code cadence drift, fabricated metric names |
| Brevo | Y | Real | API key | No | Yes | fetchedAt + account | 0 | — |
| Todoist | Y | Real | OAuth2 | No (fixed 7d window) | Yes | fetchedAt, no account id | 0 | Doc lists metrics code doesn't produce |
| UptimeRobot | Y | Real | API key | N/A | Yes | fetchedAt + account | 0 | Most doc-accurate connector |
| GitHub | Y | Real | API key (PAT) | No | Yes | fetchedAt, no account id | 0 | Fabricated metrics/milestone claims in docs |
| WordPress | Y | Real (read-only) | Basic (app password) | No | Inconsistent | fetchedAt, no site id | 0 | **F-27 — doc invents write-back that doesn't exist** |
| Kirby | N (no doc page) | Real, dual-path | Basic | No | Partial | fetchedAt | 0 | Undocumented, fragile filesystem fallback |
| Stannp | Y | Real (read-only) | API key | No (page 1 only) | Yes | fetchedAt + partial account | 0 | **F-27 — doc invents mail-dispatch write-back that doesn't exist** |
| Meta Ads | Y | Real, best pagination | OAuth2, only real long-lived refresh in codebase | Cursor loop (capped 10) | Yes, no Retry-After | **no fetchedAt anywhere** | 0 | F-28 — doc's auth flow contradicts real OAuth implementation |
| Brave Search | N | Real (internal agent tool) | API key | No | No | fetchedAt only | 0 | Mistyped as connector; is an agent tool |
| Tavily | N | **`fetch()`/`extractMetrics()` are stubs** | API key | No | No | fetchedAt only (dead path) | 0 | F-29 — fails `ConnectorInterface` contract |
| Buffer | Y (doc exists, omitted from README count) | Real | OAuth2 | No | Yes | fetchedAt, no account id | 0 | F-48 — inverse mismatch |
| Klaviyo | Y (same) | Real | API key | No (cursor API unused) | Yes | fetchedAt, no account id | 0 | F-48 |
| Semrush | Y (same) | Real | API key | No | Yes | fetchedAt, domain only | 0 | F-48 |
| Server Access (SSH/FTP) | Y (same) | Real | SSH key/password, encrypted | N/A | N/A | n/a | 0 | F-51 — latent shell-quoting weakness, currently unreachable |
| Social (Meta pages/IG) | N (wired in UI, no doc page) | Real | OAuth2, real refresh | No | Inconsistent | fetchedAt + account id | 0 | F-50 — bypasses shared outbound allowlist |
| Wix | Y (same) | Real | API key | No (cursor unused) | Yes | fetchedAt, no account id | 0 | F-48 |

**Systemic connector gap (F-47):** no connector, however well-implemented, can emit a sync cursor, per-metric freshness flag, or structured source-account identity — those columns don't exist in `server/db/schema.sql`. `period_start`/`period_end` are set to the ingestion timestamp, not the actual upstream reporting window, for every connector.

## Internal agents (12 documented, all share one execution engine)

| Agent | Installed by default | BAP triggerable | Soul files loaded | Notes |
|---|---|---|---|---|
| Conductor | Y | Y | Y (verified: `assembleSystemPrompt()` reads live `IDENTITY.md`/`SOUL.md`/`HEARTBEAT.md`/`AGENTS.md`) | Central orchestrator, skips self-briefing |
| SEO Sentinel | Y | Y | Y | — |
| Quill | Y | Y | Y | — |
| Trend Spotter | Y | Y | Y | — |
| Reporter | Y | Y | Y | Only agent with bespoke email-dispatch behavior |
| Merchant | Y | Y | Y | — |
| Velocity | Y | Y | Y | — |
| Researcher | Y | Y | Y | — |
| Ledger | **N — template only, hire to activate** | Y once installed | Y once installed | Correctly documented as hireable (`docs/content/agents/overview.md:28-39`), not a stub |
| Sentinel | **N — template only** | Y once installed | Y once installed | Same |
| Dev | **N — template only** | Y once installed | Y once installed | Same |
| Outreach | **N — template only** | Y once installed | Y once installed | Same |

All 12 run through the identical `runAgent()` engine (`server/agents/agent-runner.ts:1053-1776`) — implementation completeness is identical once installed; there is no per-agent bespoke logic gap. **However**, the per-agent tool capability boundary (`tools_allowed`/`ROLE_SPECS`) is declared in the DB but never enforced by the tool-loop dispatcher, which hands every agent the same 5 read-only tools regardless of role (F-30) — this is decorative, not a security hole (tools are read-only), but the "specialist with a scoped toolkit" design claim is not real in the dispatch layer.

Durability: agent runs are persisted with status transitions (`running`→`complete`/`failed`), but there is **no cancel endpoint and no sweep for crash-orphaned `'running'` rows** (F-33).

## LLM providers (8 implemented, docs list 6)

| Provider | Documented | Code | Timeout | Retry | Notes |
|---|---|---|---|---|---|
| Ollama | Y | Real | No | No | Free/local default |
| Anthropic | Y | Real (SDK) | No | No | — |
| OpenAI | Y | Real | **Yes, 60s** | No | Only adapter with an explicit timeout |
| Google Gemini | Y | Real | No | No | — |
| LM Studio | Y | Real | No | No | — |
| Claude CLI | Y | Real (not deep-audited) | — | — | — |
| Custom (OpenAI-compatible) | **N** | Real | No | No | Undocumented (F-57) |
| MiniMax | **N** | Real | — | — | Undocumented (F-57) |

No-provider-configured behavior was traced end-to-end: agent runs fail cleanly per-run (logged, self-heal-triggered, non-fatal to the process), and **signal detection / connector sync are LLM-independent** — the system degrades gracefully at the data-collection layer, but produces zero autonomous task proposals while unconfigured, with no proactive alert beyond an optional Telegram notification.

## Intelligence layer / "Brain" (9 claimed features + "Why is this happening?")

| Feature | Location | Status | Notes |
|---|---|---|---|
| Goal Reasoning | `server/brain/goal-reasoner.ts` | Fully implemented | Real LLM call, merges strategy/milestones onto the goal row |
| Scenario Planning | `server/brain/scenario-engine.ts` | Fully implemented | Fails loudly on LLM error, doesn't fabricate |
| Conflict Detection | `server/brain/conflict-engine.ts` | Fully implemented | Persisted to a real `conflicts` table |
| Retrospectives | `server/brain/retrospective-engine.ts` | Fully implemented | Files learnings to Shared KB |
| Signal Attribution | `server/brain/attribution-engine.ts` | Fully implemented | Wired into the live signal pipeline |
| Agent Calibration | `server/brain/calibration.ts` | Fully implemented (statistical, non-LLM) | Auto-demotes overconfident agents to yellow trust tier |
| Proactive Goal Suggestions | `server/brain/goal-suggester.ts` | Fully implemented | Deterministic pattern-detection gates an LLM expansion step |
| Shared KB | `server/kb/shared-kb.ts` | Fully implemented | Own git-backed root, cross-business |
| Constraint-aware Scheduling | `server/brain/action-windows.ts`, `restraint.ts` | Fully implemented (rule table, non-LLM) | Real per-action min/expected/max-day windows |
| "Why is this happening?" | `server/brain/investigation-engine.ts`, `causal.ts` | Fully implemented | Gathers real timeline/metric data before the LLM call |

None of the ten are stubs, mocks, or UI-only — all perform real DB reads/writes and real LLM calls with real error propagation. The shared caveat across all ten: correctness of judgment calls (contradiction/conflict/causal attribution) depends entirely on LLM output quality with no deterministic cross-check — a quality/reliability caveat, not an implementation gap.

## Knowledge base

| Claim | Status | Notes |
|---|---|---|
| File-based markdown, git-backed | Fully implemented | Real `isomorphic-git` commits on every write |
| Three layers (raw/wiki/schema) | Fully implemented | — |
| Wikilinks + backlinks | Fully implemented | Real regex-computed backlinks at read time, not cosmetic |
| Contradiction detection | Fully implemented | LLM-driven, escalates to human-review tasks |
| Obsidian compatible | Not independently verified this audit | Plain markdown + frontmatter, plausible |
| Path safety | **Missing — Critical (F-02)** | No containment check; verified live escape outside KB_ROOT |
| Concurrent-write safety | **Missing (F-21)** | No locking/OCC; last-write-wins; git failures swallowed |
| Update (not just create) support | Fully implemented | `writeFile()` is an unconditional overwrite — updates work |
| Query grounding | Fully implemented | Genuine retrieval-then-synthesis; `sources_read` reflects real reads |

## Goals

| Claim | Status | Notes |
|---|---|---|
| Durable, first-class goal objects | Partially implemented | DB-backed but missing owner/confidence/dependency/measurement-window fields (F-39) |
| Progress tracking | Fully implemented | Real scheduled metric-based arithmetic |
| Milestones | Partially implemented | LLM-generated, stored, but never independently tracked to completion |
| Blocked-goal detection | Missing | No `blocked` status or dependency graph on goals |
| **BAP access to goals** | **Missing (F-20)** | No BAP route exists at all; `routes/goals.ts` is session-auth only |

## Write-back actions

| Action | Execution | Rollback | Idempotent on retry |
|---|---|---|---|
| GitHub issue | Real | **None** | **No — duplicates on retry (F-09)** |
| GitHub draft PR | Real | **None** | **No** |
| Shopify product create | Real (forced draft) | Real | **No** |
| Shopify product/description update | Real | Real | **No** |
| Shopify tag/collection update | Real | **None (no rollback_data stored)** | **No** |
| Shopify page create | Real | **Stub — stores rollback_data but no handler exists, fails at runtime** | **No** |
| Shopify blog post create | Real | **None** | **No** |
| KB writes-as-tasks | Real | **None (manual git only)** | N/A (overwrite semantics) |

"Every action can be undone" (README) is true for exactly 2 of 8 write-back action families.

## Human approval surfaces

| Channel | Auth | Payload preview | Executes on approval |
|---|---|---|---|
| Dashboard | Session cookie | Full task detail | Yes |
| BAP (`PATCH /tasks/:id`) | API key + permission | Caller-supplied | Yes, but cross-tenant (F-03) |
| Telegram | **None — any sender (F-05)** | Text summary only, no payload diff (F-40) | **No — never calls `executeTask()` (F-12)** |

## Testing & CI

| Area | Status |
|---|---|
| Server unit tests | 9 files, 85 tests, 100% pass — but only covers `agents/`, `signals/rules.ts`, `lib/` |
| `bap/`, `tasks/`, `connectors/`, `db/`, `kb/`, `routes/` tests | **0 files (F-15)** |
| Typecheck | Clean, both packages |
| CI OS matrix | `ubuntu-latest` only (F-46) |
| CI lint step | **None** |
| CI Docker build verification | **None** |
| Frontend tests | None found |

## Everything above verified against actual running behavior where feasible

`bun install`, `bun db/init.ts`, `bun test`, `bun run typecheck`, `bun run build`, and starting the production server were all executed directly during this audit (see AUDIT.md's evidence table), plus live reproduction of F-01 and F-02 against the running instance.
