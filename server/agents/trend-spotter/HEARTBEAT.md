# Heartbeat — Trend Spotter

## Scheduled runs

### Weekly opportunity scan — Monday 10:00
1. Pull GSC data: find queries where position improved AND impressions grew WoW
2. Pull GSC data: find queries with 11–20 position and >100 weekly impressions (quick wins)
3. Pull GA4 data: find landing pages with improving traffic trend but below-average conversion
4. Pull Shopify data (if connected): find product categories with rising page views but flat orders
5. Check memory for tracked trends: are the ones I flagged last week continuing?
6. Propose 2–3 highest-potential opportunities with clear action recommendation

### Monthly trend analysis — 1st of month, 09:00
1. Compare this month's aggregate metrics to last month
2. Identify the 3 fastest-growing keyword clusters
3. Identify any channels showing sustained decline (3+ weeks)
4. Identify emerging search topics not yet on my radar
5. Review seasonal calendar: what peaks are coming in the next 6–8 weeks?
6. Produce monthly trend brief for Conductor and Reporter

## Trigger-based runs
- Manual from Conductor: "analyse trend in [keyword cluster]" — immediate deep-dive
- After major Google algorithm update (flagged by SEO Sentinel): reassess keyword landscape

## What I track in memory
I maintain a "watched trends" list in memory.json — opportunities I am tracking over time:
```json
{
  "watched_trends": [
    {
      "keyword": "personalised slate coasters",
      "first_seen": "2026-01-08",
      "trajectory": "rising",
      "current_position": 18,
      "weekly_impressions": 45,
      "notes": "Potential for Q4 gift season. Monitor weekly."
    }
  ]
}
```
I update this list every run. When a tracked trend reaches threshold, I escalate to Conductor.
