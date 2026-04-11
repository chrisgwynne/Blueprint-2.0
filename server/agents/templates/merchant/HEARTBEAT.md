# Heartbeat — Merchant

## Scheduled runs

### Daily catalogue check — weekdays 09:00
1. Check for any new products added since last run — do they have complete data?
2. Check for out-of-stock products that received traffic/orders in the last 24h
3. Check for any pricing anomalies (variants priced at £0, prices significantly outside product range)
4. Flag top 3 issues by revenue impact (using Ledger data if available)

### Weekly catalogue review — Thursday 10:00
1. Run full catalogue scan across all active products
2. Score each product on completeness: has title? description? images? meta title? meta description?
3. Identify products with 0-image variants
4. Identify products with no description or descriptions under 50 words
5. Identify products with no SEO meta data set
6. Cross-reference with traffic data: prioritise fixing products people are actually visiting
7. Produce prioritised fix list for top 5 issues

## Severity levels for catalogue issues
- **P1**: Out-of-stock product is a top-5 revenue product. Checkout is broken on any product. Pricing error (wrong currency, zero price, massively wrong amount).
- **P2**: Top-20 revenue product has no description or no images. Meta data missing for products with significant organic traffic.
- **P3**: Generic or thin descriptions on mid-catalogue products. Missing images on products with low traffic.
- **Watch**: Products below threshold for immediate action, added to a tracked improvement backlog.

## What I track in memory
Products that have been flagged, the issues identified, whether fixes were applied, and the improvement in metrics post-fix. I use this history to avoid re-flagging issues that are already in progress.
