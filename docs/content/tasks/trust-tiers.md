---
title: "Trust Tiers"
description: "How Blueprint decides what to execute automatically vs require approval"
section: "Tasks"
order: 3
---

# Trust Tiers

Trust tiers control whether Blueprint executes a task automatically or waits for your approval. Every task has a tier, and every agent has a default tier. Understanding tiers is the key to calibrating how much autonomy Blueprint has in your workflow.

## The three tiers

### Green — auto-execute

Green tasks execute without requiring human approval. Blueprint completes the write-back action as soon as the task is proposed, then records the outcome.

Green tier is reserved for actions that are:

- **Fully reversible** — the change can be undone without consequence
- **Low-risk by nature** — e.g., creating a draft post (not publishing), not deleting or modifying live content
- **Performed by agents with a proven track record** — trust tier should only be raised to green after you have reviewed an agent's history and are confident in its judgement

Very few tasks should reach green tier. The default for everything is yellow.

### Yellow — requires approval

Yellow is the default tier for all agents and all tasks. When a task is yellow, it enters your approval queue and waits until you act on it. Nothing executes until you explicitly approve.

This is the recommended operating mode. Agents propose, you decide.

Yellow tier gives you:
- Full visibility into everything Blueprint wants to do
- The ability to edit tasks before approving
- A complete audit trail of agent proposals and your decisions

### Red — human only

Red tasks are surfaced as recommendations only. Blueprint will never attempt to execute a red-tier task, even if you approve it in the UI — the approval button shows you the recommendation, but execution is left entirely to you.

Red tier is used for:
- Sensitive operations: pricing changes, deleting content, customer communications
- Anything that requires human context Blueprint cannot fully evaluate
- Strategic decisions where AI execution would be inappropriate

The `strategic_review` action type is always red, regardless of the agent's configured trust tier.

## How trust tier is determined

Trust tier is evaluated in this order of precedence:

1. **Task-level override** — a specific task can have its tier set explicitly, overriding the agent default
2. **Agent YAML profile** — the `trust_tier` field in the agent's profile sets the default for all tasks from that agent
3. **System default** — if neither is set, yellow is used

Example agent YAML:

```yaml
name: quill
trust_tier: yellow
signal_triggers:
  - ctr_below_threshold
  - keyword_surge
```

## Raising an agent to green tier

Before setting an agent to green, you should:

1. Review the agent's task history — go to the agent detail view and check the outcome of its last 20+ proposals
2. Confirm that its write-back actions are scoped to reversible operations (e.g., drafts, not published content)
3. Update the agent YAML with `trust_tier: green`
4. Monitor the first few auto-executions in the Tasks view

You can revert to yellow at any time by updating the YAML and restarting the agent.

## Trust tier and the restraint system

Blueprint's restraint system tracks agent outcomes over time. If an agent's proposals consistently lead to negative results (as measured by connector metrics after the task executes), the restraint system flags this and Blueprint will surface a warning in the agent detail view. At that point you should review whether the agent's trust tier is appropriate.

See the Brain section for more on the restraint system and how outcome measurement works.
