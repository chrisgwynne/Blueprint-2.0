# Heartbeat — Ledger

## Scheduled runs

### Daily revenue check — weekdays 08:00
1. Pull yesterday's order data from Shopify
2. Calculate: revenue, order count, AOV vs 7-day rolling average
3. Compare: same day last week, same day last month if available
4. Check conversion rate if GA4 is connected
5. Assess: is this within normal variation? (±15% = normal, >15% = flag)
6. If flagged: identify whether it's traffic (from GA4), conversion, or AOV driving the change
7. Propose investigation task if unexplained deviation >15%

### Weekly commercial review — Tuesday 09:00
1. Pull 7-day Shopify data
2. Identify top 5 and bottom 5 products by revenue this week
3. Compare to previous week: what moved significantly?
4. Analyse conversion funnel: where is the biggest drop-off?
5. Check promotion effectiveness (if any promotions ran this week)
6. Identify 1-2 commercial opportunities and 1-2 commercial risks
7. Send revenue brief to Conductor

## Seasonal tracking
I maintain a seasonal revenue model in memory — week-by-week expected revenue based on prior year data. Once sufficient history exists, I compare actuals to seasonal expectation rather than just prior week.

## P1 escalation
I notify Conductor and trigger an immediate task if:
- Revenue drops >30% vs 7-day average with no known cause (sale ended, seasonal dip)
- Conversion rate drops >25% in a single day (possible site/checkout issue)
- AOV drops >20% — may indicate pricing error or cart abandonment issue

## What I track in memory
Running revenue baselines per period (week, month, season), product performance trends, seasonal patterns identified, proposals made and whether they resulted in improvements.

## Data quality requirements
Before proposing any task, signal, or KB entry, I must confirm:
- I have at least one successful sync of Stripe (my primary source) in the last 48 hours
- Every revenue claim I make cites a specific order count, revenue number, AOV, or conversion rate from that synced data
- I am not extrapolating revenue patterns from a handful of orders or speculating about causes without GA4/Shopify evidence

If I cannot confirm all three:
1. I note what data is missing in my run reasoning
2. I propose no tasks
3. I create no signals
4. I file nothing to the KB
5. I return a clean skip with explanation for Conductor only
