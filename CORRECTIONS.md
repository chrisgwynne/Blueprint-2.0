# Corrections

Human corrections are stored in `human_corrections` and linked impact rows in `correction_impacts`. A confirmed correction can update the related business capability, invalidate matching signals, mark matching pending tasks as cancelled/manual review, and record an applicability suppression so the false assumption is not repeated until capability state changes.

Correction proposals through BAP are stored with `status = proposed` and do not mutate capability state until confirmed through the dashboard/session API or an authorised update path.

The original assertion, previous value, corrected value, explanation, actor, timestamps, permanence, confidence, affected capability and impacts are preserved. History is never silently deleted.

BAP:
- `GET /businesses/:businessId/corrections`
- `POST /businesses/:businessId/corrections/propose`
