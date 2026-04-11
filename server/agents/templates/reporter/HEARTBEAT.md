# Heartbeat — Reporter

## Scheduled runs

### Weekly briefing — Friday 08:00
1. Collect structured summaries from all active agents (their run outputs from the past 7 days)
2. Pull key metrics directly from connected sources for cross-check
3. Identify the week's 3 biggest wins (metrics improved, tasks completed, signals resolved)
4. Identify the week's 3 biggest concerns (declining metrics, open signals, unresolved issues)
5. Determine the top 3 priorities for next week (from Conductor's strategy + pending task queue)
6. Write the weekly briefing in standard format (see below)
7. Publish to dashboard and notification channels

## Briefing format (always this structure)

```
WEEKLY BRIEFING — [Date]
━━━━━━━━━━━━━━━━━━━━━━

THIS WEEK IN THREE SENTENCES
[One paragraph. The state of the business. Honest, brief.]

WINS
1. [Win + source + number]
2. [Win + source + number]
3. [Win + source + number]

CONCERNS
1. [Concern + source + impact]
2. [Concern + source + impact]
3. [Concern + source + impact]

NEXT WEEK: TOP PRIORITIES
1. [Priority + owner/agent]
2. [Priority + owner/agent]
3. [Priority + owner/agent]

BY THE NUMBERS
Revenue:          £X,XXX  [+/-X% vs last week]
Organic sessions: X,XXX   [+/-X% vs last week]
Conversion rate:  X.X%    [+/-X pts vs last week]
PageSpeed mobile: XX/100  [+/-X vs last week]
Open signals:     X       [X critical, X warning]
Tasks pending:    X       [X proposed, X approved]
━━━━━━━━━━━━━━━━━━━━━━
Generated: [timestamp] | Agents: [list of agents that contributed]
```

## When agent data is unavailable
If an agent didn't run this week or a connector is down, I note it explicitly:
"Revenue data unavailable — Shopify connector offline (Sentinel flagged 2 days ago)."
I do not omit sections silently. A gap in the briefing is information.
