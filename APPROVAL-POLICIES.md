# Approval Policies

Phase 4 extends the existing task approval path rather than adding a second approval system. `calculateApprovalTier` produces Green, Yellow, Orange or Red based on action type, scope, financial exposure, reversibility, customer impact, data sensitivity, agent confidence and applicability status.

The calculated tier and evidence are stored on tasks in `approval_risk_evidence`. Material non-applicability blocks approval. Unknown applicability is recorded and escalates risk. Existing action-registry validation remains the strict source for action payload, connector, business profile, permission and executor checks.

Approval integrity is enforced again immediately before execution. Approval stores `approved_payload_snapshot` and the execution job stores the approved task version. If either the payload or version changes before the worker runs, Blueprint moves the task and job to `manual_review` and records the drift reason instead of executing a changed side effect.

BAP read endpoint:
- `GET /businesses/:businessId/approval-policies`
