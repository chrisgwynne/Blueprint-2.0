---
title: "Stannp"
description: "Connect Stannp to track direct mail campaigns and trigger postcards from approved Blueprint tasks."
---

# Stannp

Stannp is a direct mail platform for sending postcards and letters. Blueprint connects via the Stannp API to track campaign activity and trigger mail sends from approved tasks.

## Prerequisites

- A Stannp account (any plan)
- API key from your Stannp account settings

## Getting your API key

1. Log in to [stannp.com](https://www.stannp.com)
2. Go to **Account → API**
3. Copy your API key

## Adding the connector

1. Open Blueprint → **Connectors → Add connector**
2. Select **Stannp**
3. Enter your API key
4. Save

Blueprint will run a test request to verify the key is valid and display your current credit balance.

## What Blueprint tracks

| Metric | Description |
|--------|-------------|
| `campaigns_sent_30d` | Campaigns dispatched in the last 30 days |
| `campaigns_sent_90d` | Campaigns dispatched in the last 90 days |
| `total_recipients_30d` | Total mail pieces sent in last 30 days |
| `credit_balance` | Current credit balance |
| `pending_campaigns` | Campaigns created but not yet dispatched |

## Signal rules

| Signal ID | Trigger | Severity |
|-----------|---------|----------|
| `stannp_credit_low` | Credit balance < 500 and no auto-top-up | warning |

When credits run low, Blueprint raises a warning so you can top up before an approved campaign fails to dispatch.

## Write-back: triggering mail sends

Blueprint can trigger Stannp campaigns when an approved task includes a `stannp_send` action. This is typically proposed by the Outreach agent.

When a campaign task is approved:

1. Blueprint calls the Stannp API to create or dispatch a campaign
2. The campaign ID is stored in `action_memory` for rollback
3. The task status updates to `executed` with the Stannp campaign reference

> [!WARNING]
> Mail sends are not reversible once dispatched. Blueprint will only trigger campaigns for tasks in **Approved** status — it will not auto-approve and send.

## Rollback

If a campaign was created but not yet dispatched, Blueprint can delete it via the API. Once dispatched, rollback creates an audit log entry but cannot recall physical mail.

## Stale threshold

6 hours. Stannp data changes infrequently — Blueprint checks credit balance and campaign status every 6 hours.

## Troubleshooting

**"Invalid API key"**  
Check that you copied the full key from Stannp → Account → API. Keys are case-sensitive.

**"Insufficient credits"**  
The `stannp_credit_low` signal should have warned you. Top up credits in your Stannp account, then re-approve the task.

**"Campaign not found"**  
The campaign may have been deleted in the Stannp dashboard. Check the Stannp campaigns list and update the task status to `failed` in Blueprint.
