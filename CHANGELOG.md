# Changelog

All notable changes to Blueprint are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — develop branch

### 2026-08-17 — Production-readiness fixes, a rewritten README, and eight new trust/visibility features

Prompted by a competitive review (Cabinet, Paperclip) and a month of real
Hermes usage across 3 businesses. Two kinds of change:

**Real bugs fixed, not just documented:**
- 4 tests (`agent-runner.provider-failure`/`search-fallback`) had been
  silently short-circuiting since before this pass — a CWD-dependent path
  bug meant they never reached the behavior they were meant to test. Fixed
  at the root (resolve relative to the test file's own location, matching
  #41's pattern) — server suite is genuinely green for the first time this
  cycle, not just reported as such.
- Docker deployment was broken outright: a build-breaking `COPY` of a
  nonexistent directory, a port mismatch that made `docker compose up -d`
  (the README's own documented quick-start) unreachable, and a lockfile
  glob that never matched. Fixed all three, added the missing
  `.dockerignore`.
- The repo URL (`chrisgwynne/blueprint`, which doesn't exist) was silently
  404-ing in README, CONTRIBUTING, CHANGELOG, and the marketing landing
  page. Fixed everywhere.

**Eight new features, each answering a specific gap found by comparing
Blueprint against peer products or real operating experience:**
- **Budget visibility** — both cost caps (per-agent daily, global monthly)
  now raise a `system_issues` warning at 80% and again at 100%, instead of
  a server-only `console.warn` nobody was watching.
- **Run Event Trace** — the per-run `agent_run_events` timeline (already
  collected, never surfaced) is now visible on the dashboard's Agent
  Detail page and over BAP (`GET /runs/:runId/events`).
- **SECURITY.md** — an explicit, code-verified data-handling policy:
  self-hosted only, AES-256-GCM credentials at rest, outbound network
  access restricted to a hardcoded allowlist, no telemetry anywhere in
  the codebase.
- **`npx github:chrisgwynne/Blueprint-2.0`** — a genuine one-command path
  to a running local instance (`bin/blueprint.js`), alongside the existing
  Docker/native install paths.
- **Operating Policy Backtest** — replay a draft policy patch against real
  task history (default 30 days) before activating it, showing exactly
  which historical approvals would flip either direction, evidence-cited
  by task id.
- **Proactive Blueprint-health alerting** — `system_issues` now dispatches
  a notification (dashboard + Telegram) for severity ≥ `error` by default,
  and three new checks catch problems with Blueprint's own operation
  (an agent failing repeatedly, a connector critically stale, an LLM
  provider stuck on fallback) that were previously invisible.
- **Cross-Business Pattern detection** — a new Executive Command Centre
  section flags correlated signals or metric movement across 2+
  businesses in a portfolio — explicitly marked as correlation, never a
  causal claim.

Full technical detail for every item in
[server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md).

### 2026-08-17 — Every dashboard feature from the backlog clearance now has a BAP surface

PR #88 closed issues #77–#86, the follow-up filed against the entry below
once its "Not yet BAP-facing" list was reviewed. Full technical detail in
[server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md).

**New read-only BAP surfaces:**
- **Decision Queue** (`/businesses/:id/decision-queue`, #77) — the pending
  review queue, distinct from the pre-existing decision-memory log at
  `/businesses/:id/decisions`.
- **Comparisons** (`POST /businesses/:id/comparisons`, #78) — explicit
  side-by-side of caller-named candidates, distinct from the pre-existing
  ranked auto-generated list at `/businesses/:id/recommendations`.
- **Command Centre** (`/command-centre`, #79) — cross-business executive
  summary, scoped to the agent's `business_access` grant.
- **Portfolios** (`/portfolios`, #80) — saved multi-business groupings and
  their comparative view, distinct from #68's policy-scoped portfolios.
- **Digest** (`/businesses/:id/digest`, #81) — the "while you were away"
  catch-up feed, with a BAP-agent watermark kept separate from the
  dashboard operator's.
- **Explanations** (`/businesses/:id/explanations/:kind/:id`, #82) — "why
  did Blueprint do this?", the same engine and redaction pass the
  dashboard panel uses.
- **Audit Search** (`POST /businesses/:id/audit-search`, #83) —
  natural-language, cited history search, distinct from the pre-existing
  structured listing at `audit:read`.
- **Retrospective Proposals** (`/businesses/:id/retrospective-proposals`,
  #84) — the typed, reviewable operating-policy-change proposals a
  retrospective can raise; the retrospectives themselves were already
  BAP-facing via `retrospectives:read`/`:trigger`.
- **Simulation** (`POST /businesses/:id/simulate/task-approval`, #86) —
  zero-side-effect preview of a task approval, enforced by #67's
  simulation guard at the DB-write layer.
- **Playbooks** (`/businesses/:id/playbooks`, #85) — read, simulate, and
  (uniquely among this batch) a real trigger endpoint: a triggered run's
  steps still clear the normal Typed Action Registry + Operating Policy
  approval gate, the same as any directly-proposed task.

### 2026-08-17 — 38-issue backlog clearance: bug fixes, autonomous hiring redesign, and 16 new dashboard features

Two PRs (#75, #76) closed every open issue in the repository. Summary for
agents/integrators — full technical detail in
[server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md).

**BAP-facing changes (see AGENT-GUIDE.md for details):**
- New `scheduled_workflow` action type for recurring, externally-executed
  automation (#37) — Blueprint tracks these, it doesn't run them.
- Task approval now routes registered-but-unimplemented action types
  straight to `manual_review` instead of retrying to dead-letter (#39).
- Unsafe (SSRF-failing) agent webhooks are now auto-quarantined instead of
  generating endless failed deliveries; clears on your next valid
  `PUT /me/webhook` (#40).
- `GET /businesses/:id/connectors` now carries `health_state` (including a
  distinct `permission_required` state) and never claims fresh data from a
  partial sync (#65).
- `GET /goals/:id/timeline` now surfaces explicit gaps instead of omitting
  them, and labels each event `correlation` vs. `verified_attribution` (#64).
- New read-only BAP surfaces: **Operating Policy**
  (`/businesses/:id/operating-policy`, #68) and **Action Receipts**
  (`/businesses/:id/receipts`, #70).
- Goals, Outcomes, and Connectors endpoints (pre-existing but undocumented)
  are now documented in AGENT-GUIDE.md.

**Not yet BAP-facing at the time of this entry** (dashboard-session only —
tracked in issues #77–#86): Decision Centre, Recommendation Comparison,
Executive Command Centre, Multi-Business Portfolio View, "While You Were
Away" Digest, Explanation Panels, Natural-Language Audit Search, Automated
Retrospectives, Reusable Playbooks, Safe Simulation/Preview Mode. All ten
now have BAP surfaces — see the entry above.

**Autonomous hiring engine — full redesign (#44-58):** business-scoped
installed-agent lookup, durable rejection suppression, per-business
coordination/dedup, safe LLM-failure fallback (no more confident-looking
proposal bursts), freshness/evidence/goal/WIP/ROI gates before hiring,
outcome-gated retention/retirement, terminal/recoverable provider failures,
a versioned BAP lifecycle contract (#53), business-scoped observability,
a kill switch + enforced dry-run mode, and hiring-test isolation from
production state.

**Other fixes:** GitHub connector private-repo discovery (#34); Google
Merchant connector 5,000-offer cap removed, destination-scoped disapproval
reporting (#42); investigation tasks can no longer complete at unsupported
confidence without gathered evidence (#43); `DATABASE_PATH` no longer
resolves against invocation CWD (#41).

**New dashboard-only features:** Outcome/ROI taxonomy (#63), Agent Lifecycle
Cockpit (#69), Decision Centre (#61), Recommendation Comparison (#66),
Executive Command Centre (#59), "While You Were Away" Digest (#62),
Multi-Business Portfolio View (#71), Explainable "why did Blueprint do
this?" Panels (#60), Reusable Bounded Playbooks (#74), Natural-Language
Audit Search (#72), Automated Retrospectives that produce reviewable
operating changes (#73), Safe Simulation/Preview Mode as a shared primitive
enforced at the DB-write layer (#67).

### In Progress
- Agent lifecycle hardening — final gaps (output validation, heartbeats, KB pollution flag)
- Onboarding inline hire recommendations polishing
- Public repo prep for v1.0

### Open issues for v1.0
See [GitHub issues tagged `v1.0`](https://github.com/chrisgwynne/Blueprint-2.0/issues?q=label%3Av1.0).

---

## [2.0.0-typescript] — 2026-04-16

Full TypeScript migration. All JavaScript source files converted to TypeScript with zero runtime changes.

### Changed
- All 200+ server files migrated from `.js` → `.ts` with full type annotations
- All 41 client files migrated from `.jsx`/`.js` → `.tsx`/`.ts`
- `server/index.ts` replaces `index.js` as the entry point — Bun runs it natively
- `server/db:init` script updated to `db/init.ts`
- `tsconfig.json` added for server (NodeNext module resolution) and client (Vite bundler resolution)
- `server/types/` directory added with shared interfaces for agents, connectors, signals, LLM providers, DB, and action payloads
- `client/src/types/index.ts` added with shared client-side interfaces
- `server/types/vendor.d.ts` added for untyped packages (node-cron)
- `client/src/vite-env.d.ts` added for CSS module and `import.meta.env` types

### Notes
- `server/signals/rules.ts` and `client/src/pages/ConnectorDataPage.tsx` use `// @ts-nocheck` due to highly dynamic connector-specific data shapes — both compile and run correctly
- Both `bun run --cwd server typecheck` and `bun run --cwd client typecheck` pass with zero errors

---

## [0.9.0-beta] — 2026-04-14

First tagged pre-release. The core loop works end-to-end on real data:
connectors → signals → agents → tasks → approval → execution → outcomes.
Not yet suitable for production multi-user deployments. Known issues for
v1.0 are tracked on the issue tracker.

### Added — Brain & Intelligence Layer
- Goal Reasoning Engine — financial modelling, path decomposition,
  constraint identification, timeline reality-checking.
- Temporal Knowledge Base — `action_windows` table with 9 action types
  and their measurement windows.
- Action Memory — every completed task recorded with do-not-touch dates.
- Restraint System — blocks re-action during measurement windows, creates
  deferred tasks with wake dates.
- Causal Reasoning — attributes metric changes to recent actions, suppresses
  signals caused by known in-flight changes; Buffer post correlation
  folded into the reasoning pass.
- Intent Extraction — extracts goals, decisions, concerns, and context
  from chat conversations.
- Seasonal Pattern Detection — day-of-week and monthly variation aware.
- Temporal context injected into agent prompts so agents know what's
  in-flight before proposing.

### Added — Five Interconnected Features
- Workflow Templates — reusable multi-step agent pipelines with approval
  gates, versioning, and signal triggers.
- Goals System — measurable business goals with progress tracking,
  milestone generation, and agent assignment.
- Projects — group related work within a business.
- Agent Chat + @mentions — direct conversation with agents, agent-to-agent
  chaining, KB auto-filing every 10 messages.
- Outcome Attribution UI — impact timeline chart, agent performance
  table, task outcome cards.

### Added — Connectors
Seventeen connectors in total:
- **Google suite:** GA4, GSC, PageSpeed, GBP, Google Ads
- **Commerce:** Shopify, Stripe
- **Code:** GitHub, SSH/FTP server access (read + approved write)
- **Email:** Brevo, Klaviyo
- **Productivity:** Todoist
- **Infrastructure:** UptimeRobot
- **CMS:** WordPress, Kirby, Wix
- **Direct mail:** Stannp
- **Advertising:** Meta Ads
- **SEO intelligence:** SEMrush
- **Organic social:** Facebook + Instagram
- **Scheduling:** Buffer

### Added — Agent Lifecycle
- Conductor-only seeding on fresh install. All other agents must be
  explicitly hired after connector analysis.
- `checkAgentReadiness()` gate in `server/agents/agent-runner.js` blocks
  runs when required connectors are missing/stale. Skipped runs file
  nothing to the KB — they're silent by design.
- `installAgent()` + `uninstallAgent()` + hiring task action type
  `hire_agent` with post-hire first-run queueing.
- `analyseAndProposeHires()` fires after each successful connector sync;
  pending agents promoted to active when their connectors come online.
- Per-agent readiness labels (Active / Pending / Paused / Retired) in
  System Health.
- Degraded-data flag on tasks: when preferred connectors are missing or
  data is aging, confidence is capped at 0.3 and `trust_tier=red`.
- KB pollution flagging migration: `server/scripts/flag-pre-connector-kb.js`
  marks KB entries written before their source agents' connectors synced.

### Added — Agent System
- 12 agent templates with soul files
  (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `AGENTS.md`, `profile.yaml`).
- Every data-dependent heartbeat includes a "Data quality requirements"
  section instructing the LLM to refuse speculative output.
- LLM-agnostic: Ollama (free/local), Anthropic, OpenAI, Gemini, LM Studio,
  any OpenAI-compatible endpoint.
- Cost tracking per agent with daily and monthly budget caps.
- Agent Chat with @mention routing and agent-to-agent chaining.
- SKILL.md for external agent integration (BAP protocol).

### Added — Knowledge Base
- Karpathy LLM wiki pattern: git-backed, compounding KB.
- Obsidian vault compatibility.
- KB quality layer: `review_status`, `review_reason`, `created_by`,
  confidence, contradiction detection.
- Auto-filing from chat sessions, signal clusters, outcomes, workflow
  runs, goal achievements, and agent briefings.
- Cross-business shared KB namespace.

### Added — Public API & Integration
- Blueprint Agent Protocol (BAP): external agent registration, full CRUD
  via HTTP, HMAC webhook delivery.
- Public API v1 with API key auth.
- Zapier ingest endpoint.
- SKILL.md drop-in skill file for any LLM agent.

### Added — Infrastructure
- SQLite schema with 30+ tables (agents, connectors, signals, tasks,
  goals, projects, workflows, retrospectives, KB, action_memory, brain,
  file_backups, server_file_cache, and more).
- AES-256-GCM credential encryption.
- Signal clustering — Conductor groups related signals intelligently.
- Connector Health Dashboard with live sync status and stale detection.
- Persistent Agent Status Panel with live SSE updates.
- Timeline View — merged chronological history.
- Weekly Email Report (HTML) with outcome data and briefing.
- System Health page with brain status section and per-agent readiness.
- Docker Compose deployment; beta `npx blueprint-os` installer.

### Added — Write-back safety (server-access connector)
- `isPathSafe()` / `scanForSecrets()` gate every file op. Traversal,
  `wp-config.php`, `.env`, private keys, and credential-containing
  content are all refused. 24 security-audit tests pass.
- Every write takes a backup into `file_backups` before touching the
  remote file. `server_file_rollback` replays any backup as a new
  approved task. No delete operations exist.

### Fixed
- All 69 signal rules handle null/empty data without throwing.
- `connector_syncs` table now wired to actual sync runs (was never
  populated previously).
- LLM provider: Ollama listed first, no provider required at install.
- Git hygiene: `node_modules`, `dist`, runtime DB files untracked.
- Dashboard: Avg Position NaN fix, redundant Agent Activity card removed.

---

## [0.1.0] — Initial build

### Added
- SQLite schema: core 23 tables.
- 14 connectors (initial set): GA4, GSC, PageSpeed, GBP, Shopify,
  Stripe, GitHub, Brevo, Todoist, UptimeRobot, WordPress, Kirby,
  Google Ads, Stannp.
- Signal engine with 45 rules.
- Agent runner with LLM provider abstraction.
- Task system with state transitions.
- Approval flow (dashboard + Telegram).
- Shopify + GitHub write-back with rollback.
- Docker Compose deployment.
- Basic dashboard, signals, tasks, agents pages.
