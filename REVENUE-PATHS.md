# Revenue Paths

Revenue paths are stored in `revenue_paths`. A business can have one primary path and multiple secondary paths, with model type, channel, target customer, offer/category, acquisition, conversion, fulfilment, retention, metrics, constraints, dependencies, evidence, priority, target contribution and horizon.

Recommendation/task relevance uses `explainRevenueRelevance` to explain direct revenue-path effects without fabricating revenue estimates. Security, compliance, reliability and operational work can rank through revenue protection or operational enablement rather than immediate uplift.

BAP:
- `GET /businesses/:businessId/revenue-paths`
- `POST /businesses/:businessId/revenue-paths`
