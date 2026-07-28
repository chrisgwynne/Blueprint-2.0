# Business Capabilities

Capabilities are first-class rows in `business_capabilities`, keyed by business and `capability_key`. Supported state values are `available`, `unavailable`, `unknown`, `planned`, `disconnected`, and `restricted`.

Each capability stores evidence source, verification timestamps, verification method, related connector, limitations, allowed/prohibited actions, confidence, correction metadata, review and expiry dates. Connector sync maps known connector types such as Shopify, Etsy, GitHub, GA4, GSC, Merchant Center, GBP, ads, email and fulfilment tools into capability rows.

Applicability is evaluated before task creation and approval. Confirmed unavailable, disconnected or restricted capability blocks actionable task creation/approval. Missing registry data is treated as `unknown`, recorded for diagnostics, and escalates risk rather than being treated as available.

BAP:
- `GET /businesses/:businessId/capabilities`
- `POST /businesses/:businessId/capabilities/propose`
- `POST /businesses/:businessId/capabilities`
- `POST /businesses/:businessId/applicability/evaluate`
- `GET /businesses/:businessId/suppressions`
