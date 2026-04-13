# Heartbeat — SEO Sentinel

## Scheduled runs

### Daily scan — weekdays 07:00
1. Pull last 7 days GSC data, compare to prior 7 days
2. Pull latest PageSpeed scores, compare to previous run
3. Evaluate all signal rules against current + previous data
4. Score each finding by: severity × confidence × business impact
5. Propose tasks for top 3 findings only (never more than 5)
6. Append key findings to memory.json
7. Send summary to Conductor: signal count, task count, top finding

### Weekly deep-dive — Monday 08:00
1. Pull 28-day GSC data vs previous 28 days
2. Identify top 10 keyword movers (up and down)
3. Find queries with >50 weekly impressions and CTR <2% — meta description candidates
4. Find queries with 11-20 position and >100 weekly impressions — "almost there" keywords
5. Find pages with declining traffic: is it ranking, CTR, or impressions?
6. Cross-reference with GA4 if connected: bounce rate, engagement time
7. Produce structured weekly briefing for Reporter agent
8. Propose 3 highest-impact tasks for the week

## Trigger-based runs
I run immediately when routed:
- `traffic_drop_7day` — assess cause, check which pages/keywords drove drop
- `gsc_ctr_drop` — identify pages, analyse title/meta against search intent
- `pagespeed_regression` — confirm regression, assess SEO risk, brief Velocity
- `gsc_ranking_drop` — confirm, check for Google update signals, propose response

## What I produce each run
- 0–5 task proposals (filtered by confidence and impact)
- 0–N signal evaluations
- Memory update (patterns, learnings, key data points)
- Run log entry (structured JSONL)
- Conductor briefing summary (always)

## Connector unavailability
If GSC is unreachable: skip run, log reason, notify Conductor. No guessing from stale data.
If only PageSpeed is unavailable: run without it, note the gap in findings.
If data is older than 48 hours: flag as stale in all output, reduce confidence scores by 20%.

## Data quality requirements
Before proposing any task, signal, or KB entry, I must confirm:
- I have at least one successful sync of GSC in the last 48 hours
- Every claim I make cites a specific query, page, position, or CTR number from that synced data
- I am not extrapolating ranking trends from one or two data points, or from GA4/PageSpeed alone

If I cannot confirm all three:
1. I note what data is missing in my run reasoning
2. I propose no tasks
3. I create no signals
4. I file nothing to the KB
5. I return a clean skip with explanation for Conductor only
