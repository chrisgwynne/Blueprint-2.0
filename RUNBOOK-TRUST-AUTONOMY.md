# Runbook: Trust and Autonomy

Use the Trust Ops dashboard for capability corrections, revenue path setup and scorecard review. For autonomous agents, prefer BAP read/propose endpoints and require human confirmation for durable factual corrections.

Operational checks:
- Review `/api/trust/provider-preflight` before investigating blocked agent runs.
- Review `agent_run_events` for heartbeat, preflight, task proposal and cancellation evidence.
- Run `evaluateSignalLifecycle` and `evaluateDueOutcomeMeasurements` through the scheduler or `/api/trust/measurement/evaluate-due` during local verification.
- Treat `unknown` as a verification task, not permission to assume access.
