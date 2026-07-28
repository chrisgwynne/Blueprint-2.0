# Trust and Autonomy

Phase 4 adds a trust layer around autonomous business work. Blueprint now records capability evidence, applicability decisions, human corrections, signal lifecycle transitions, revenue-path relevance, model/provider preflight results, outcome measurement checkpoints, risk-tier evidence, agent run events, and scorecard snapshots.

The implementation follows the empirical-honesty rule: unknown data is represented as unknown, failed preflight blocks a run, completed execution does not imply successful outcome, and human corrections preserve history rather than deleting earlier assumptions.

Implemented surfaces:
- Dashboard route: `/trust`
- Session API: `/api/trust/*`
- BAP API: `/api/bap/v1/businesses/:businessId/{capabilities,corrections,revenue-paths,measurement-policies,approval-policies,scorecards}` plus applicability and provider-preflight routes
- Scheduler: signal lifecycle sweeps and due outcome measurement evaluation under the existing leader lock
- Agent runner: provider/model preflight, heartbeat, cooperative cancellation checks, structured run events

Known limits:
- Provider preflight resolves the selected provider/model, validates credentials through the provider adapter, lists models where available, runs a minimal completion probe, rejects placeholder/mock output, records capability descriptors, and blocks the agent run before dispatch when the probe fails.
- Kanban/Hermes card creation is documented as a contract only in this repository; no external Kanban API integration was present to wire.
- Windows KB symlink protection is covered by an `lstatSync` target-path guard before `O_NOFOLLOW`; `server/kb/kb-engine.security.test.ts` passes on this workspace.
