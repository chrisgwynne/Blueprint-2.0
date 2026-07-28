# Phase 4: Trust, Applicability and Autonomous Operations

Implemented in this branch:
- Capability registry and connector-to-capability sync
- Applicability evaluation and suppression history
- Human correction capture with invalidation impacts
- Revenue path model and relevance explanation
- Signal lifecycle statuses and scheduled stale/superseded evaluation
- Provider/model preflight with adapter credential validation, model listing and minimal completion probe
- Outcome measurement policies and durable checkpoint scheduling
- Risk-tier evidence on task creation/approval
- Cooperative cancellation request/heartbeat/run-event recording
- Agent scorecard snapshots and BAP read access
- Dashboard Trust Ops page
- BAP Hermes/Kanban card projection endpoints

Verification performed:
- `bun run typecheck` passed
- Focused trust engine tests: 9 pass
- Action registry/task gate tests: 35 pass
- BAP run tests: 11 pass
- Agent stale-run tests: 5 pass
- Agent lifecycle tests: 22 pass in isolation
- Agent activation tests: 5 pass
- GitHub executor safety tests pass in isolation
- Research connector executor tests: 6 pass
- Full server suite: 626 pass, 0 fail, 2036 assertions
- Live HTTP/BAP verifier: `bun server/scripts/verify-trust-autonomy-live.ts` passed against `http://127.0.0.1:4100`, including stale-to-open signal lifecycle re-evaluation through BAP readback

Incomplete from the original broad goal:
- No real external Hermes Kanban connector exists in this repository; Blueprint now exposes canonical BAP card projections for Hermes to mirror, but remote card creation remains outside this codebase.
- Provider preflight now uses provider adapters for credential validation, model-listing evidence and a minimal completion probe. Capability descriptors are still static for some local/BYO providers where the runtime cannot advertise exact tool/structured-output support.
- Live browser workflow verification was not completed in this run because the Browser runtime failed on this Windows workspace with `EPERM` while reading `C:\Users\admin\AppData`; live HTTP/BAP workflow verification is covered by `server/scripts/verify-trust-autonomy-live.ts`.
