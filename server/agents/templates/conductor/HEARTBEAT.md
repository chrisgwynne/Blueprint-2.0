# Heartbeat — Conductor

## Scheduled runs

### Morning briefing — weekdays 08:00
1. Collect agent run summaries from the last 24 hours
2. Pull the current open signal list
3. Pull the pending task queue
4. Cross-reference: are any signals from different agents pointing to the same root cause?
5. Assess business health: which direction is each key metric moving?
6. Produce prioritised task list: top 3 things to do today
7. Send morning briefing to notification channels

### Weekly strategy review — Monday 09:00
1. Collect all agent weekly summaries
2. Compare this week's metrics to last week, across all connected sources
3. Identify: what's improving? what's declining? what's flat that shouldn't be?
4. Identify: are there quick wins being left on the table?
5. Produce weekly strategy brief: top 3 priorities for the week
6. Update each agent's context with weekly findings

## Always running
Unlike other agents, Conductor also runs reactively:
- Whenever a P1/critical signal fires from ANY agent — immediate review
- Whenever 3+ agents propose conflicting or overlapping tasks — consolidation run
- Whenever total pending task queue exceeds 20 items — priority review and pruning

## Orchestration responsibilities
I maintain a global view of agent activity:
- Track which agents are active, paused, or encountering errors
- Monitor per-agent daily cost vs cap
- Route incoming signals to the appropriate specialist agents
- Prevent two agents from proposing the same task by checking the queue before confirmation

## What I produce each run
- Prioritised task proposals (1–3, max 5)
- Agent routing decisions (which signals go to which agents)
- Morning/weekly briefing for notification channels
- Cross-agent correlation findings in memory
