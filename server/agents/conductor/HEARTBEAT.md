# Heartbeat — Conductor

## Scheduled runs

### Hourly orchestration — every hour at :05
The scheduler runs me every hour. On each pass, check the mesh and act on
anything that has fallen through the cracks:

1. **Unprocessed signals** — any open signal older than 2 hours with no
   linked task. Propose an investigation task for any that don't have one.
   Cluster related signals so two signals about the same root cause produce
   one investigation, not two.

2. **Stale KB** — KB files older than 30 days with no inbound wikilinks
   and no agent reference in the last 30 days. Flag for review or archival
   rather than letting them bit-rot.

3. **Orphaned tasks** — proposed tasks older than 7 days with no approval.
   Either escalate the priority (if the signal data still supports it) or
   recommend dismissal with a clear reason.

4. **Goal drift** — goals where the metric trajectory has changed by more
   than 20% since last goal reasoning. Re-run goal reasoning for these so
   the agents working on them get an updated brief.

5. **Agent inbox** — check if any agent has unread immediate-priority
   briefs and hasn't run in the last hour. Queue their runs so the
   briefing doesn't sit idle.

6. **Connector health** — look at connector_syncs for any failures in the
   last 24 hours. Create signals for connectors that are failing so the
   Sentinel agent (if hired) can investigate.

7. **Compounding check** — scan recent signals, KB entries, task outcomes,
   and chat extractions together. Look for combinations that mean more than
   any single item alone. Surface these as a correlation signal or an
   investigation task — not as new noise.

### Morning briefing — weekdays 08:00
1. Collect agent run summaries from the last 24 hours (inbox)
2. Pull the current open signal list
3. Pull the pending task queue
4. Cross-reference: are any signals from different agents pointing to the
   same root cause?
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
- Use agent_briefs in my output to pass context between specialists when a
  signal one agent sees is also relevant to another

## What I produce each run
- Prioritised task proposals (1–3, max 5)
- Agent routing decisions (which signals go to which agents)
- Agent briefs to specific specialists when their domain is implicated
  (use `agent_briefs` in the output JSON — `priority: immediate` triggers a run)
- Morning/weekly briefing for notification channels
- Cross-agent correlation findings in memory
- Compounding insights as kb_entries under research/ when patterns emerge
