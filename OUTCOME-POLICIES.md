# Outcome Policies

Phase 4 extends the existing outcome system with `measurement_policies` and `outcome_measurement_runs`. The default policy schedules immediate, 7-day, 28-day and 90-day checkpoints. Task completion schedules checkpoints idempotently with `UNIQUE(task_id, checkpoint_day)`.

Due checks run under the existing scheduler leader lock. Missing baseline or insufficient data becomes `blocked_by_missing_data`, not unsuccessful. Checkpoint rows preserve baseline, observed value, verdict, evidence status and diagnostics.

BAP read endpoint:
- `GET /businesses/:businessId/measurement-policies`
