# Trust and Autonomy

Phase 4 adds a trust layer around autonomous business work. Blueprint now records capability evidence, applicability decisions, human corrections, signal lifecycle transitions, revenue-path relevance, model/provider preflight results, outcome measurement checkpoints, risk-tier evidence, agent run events, and scorecard snapshots.

The implementation follows the empirical-honesty rule: unknown data is represented as unknown, failed preflight blocks a run, completed execution does not imply successful outcome, and human corrections preserve history rather than deleting earlier assumptions.

Implemented surfaces:
- Dashboard route: `/trust`
- Session API: `/api/trust/*`
- BAP API: `/api/bap/v1/businesses/:businessId/{capabilities,corrections,revenue-paths,measurement-policies,approval-policies,scorecards,kanban-cards}` plus applicability, single-task Kanban-card and provider-preflight routes
- Scheduler: signal lifecycle sweeps and due outcome measurement evaluation under the existing leader lock
- Agent runner: provider/model preflight, heartbeat, cooperative cancellation checks, structured run events

Live verification:
- Start Blueprint locally, for example with `$env:PORT='4100'; bun run --cwd server start` in PowerShell.
- Run `bun server/scripts/verify-trust-autonomy-live.ts` from the repository root. Set `BLUEPRINT_LIVE_URL` to target a different local URL.
- The verifier seeds a scoped BAP agent and business, then exercises capability suppression, persisted suppression diagnostics, valid and inapplicable task proposal paths, Hermes Kanban-card projection, revenue-path update/read, confirmed correction invalidation with BAP readback, stale-to-open signal lifecycle re-evaluation with BAP readback, idempotent outcome checkpoint scheduling, provider-preflight diagnostics, approval-policy readback, and scorecard uncertainty.

Known limits:
- Provider preflight resolves the selected provider/model, validates credentials through the provider adapter, lists models where available, runs a minimal completion probe, rejects placeholder/mock output, records capability descriptors, and blocks the agent run before dispatch when the probe fails.
- Hermes/Kanban handoff is exposed as read-only BAP card projections (`/tasks/:taskId/kanban-card` and `/businesses/:businessId/kanban-cards`). No external Kanban write API exists in this repository, so actual remote card creation remains an integration outside Blueprint.
- Windows KB symlink protection is covered by an `lstatSync` target-path guard before `O_NOFOLLOW`; `server/kb/kb-engine.security.test.ts` passes on this workspace.
