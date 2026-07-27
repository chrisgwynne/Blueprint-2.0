# Database: Trust and Autonomy

Phase 4 startup migrations in `server/db/db.ts` add normalized tables for capabilities, suppressions, corrections, correction impacts, revenue paths, signal lifecycle events, measurement policies, measurement runs, provider preflight cache, run events and scorecard snapshots. They also add task, signal and agent-run columns needed for applicability, lifecycle, approval evidence, measurement, heartbeat, cancellation and provider accounting.

Foreign keys preserve tenant isolation. `business_capabilities.connector_id` uses `ON DELETE SET NULL` so capability history survives connector removal. `agent_run_events.run_id` uses `ON DELETE CASCADE` so run cleanup does not leave orphan event rows.
