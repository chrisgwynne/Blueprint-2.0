# Agent Scorecards

Agent scorecards are calculated by agent, business and action category from agent runs and tasks. Metrics include started/completed/failed/timed-out/cancelled runs, tasks proposed/accepted/rejected/invalidated/completed, outcome buckets, cost totals, evidence completeness approximation and unsupported/inapplicable signals where available.

Calibration is bucketed by confidence and includes minimum-sample uncertainty. Policy effects are conservative: small samples can require human review but do not automatically disable an agent.

BAP:
- `GET /businesses/:businessId/scorecards?agent_id=&action_category=&period_days=`
