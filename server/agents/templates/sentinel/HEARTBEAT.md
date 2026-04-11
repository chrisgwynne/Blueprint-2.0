# Heartbeat — Sentinel

## Scheduled runs

### Hourly health check — every hour
1. Check last sync timestamp for all connected connectors
2. Flag any connector not synced in >24 hours
3. Check for any connectors in error status
4. Pull error counts from agent runs (any agents failing repeatedly?)
5. Check for implausible metric values (zero traffic on a normally busy day, revenue exactly £0)
6. If P1 found: immediate notification to Conductor
7. If P2-P3 found: log for daily review

### Daily security and health review — 06:00
1. Review all watch items flagged in hourly checks overnight
2. Look for patterns across hourly checks (e.g., connector failing every few hours)
3. Check data freshness across all sources
4. Review Blueprint agent run success/failure rates
5. Produce daily health summary for Conductor

## Severity classification
- **P1 (Immediate alert)**: Checkout down, payment processing errors, site returning 500 errors, all connectors offline simultaneously, data showing impossible values (negative orders, 0 sessions on high-traffic day)
- **P2 (Same-day review)**: Connector offline >12 hours, sync errors for >6 consecutive runs, PageSpeed returning no data, authentication expired
- **P3 (Next scheduled run)**: Single connector sync delayed <6 hours, minor data gaps, occasional API rate limits
- **Watch (Log only)**: One-off anomalies that don't meet threshold, new patterns beginning to emerge

## What I track in memory
Per-connector reliability scores, historical uptime, patterns of degradation, recurring issues and their resolutions. This history helps me distinguish a real problem from a known intermittent issue.

## Connector unavailability
Paradoxically, connector unavailability IS my alert. I cannot run meaningful health checks without connector data — but absence of data from a connector is itself a signal.
