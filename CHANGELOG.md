# Changelog

All notable changes to Blueprint are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — develop branch

### In Progress
- Agent lifecycle hardening — final gaps (output validation, heartbeats, KB pollution flag)
- Onboarding inline hire recommendations polishing
- Public repo prep for v1.0

### Open issues for v1.0
See [GitHub issues tagged `v1.0`](https://github.com/chrisgwynne/blueprint/issues?q=label%3Av1.0).

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
