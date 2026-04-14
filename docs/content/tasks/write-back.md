---
title: "Write-Back Actions"
description: "When Blueprint can write directly to connected services"
section: "Tasks"
order: 4
---

# Write-Back Actions

A write-back is when Blueprint executes a change in an external service on your behalf. Rather than just telling you what to do, Blueprint does it — after you approve.

Write-backs are the most powerful part of Blueprint's task system. They close the loop between insight and action, removing the manual step of opening another tool to implement a change.

## How write-backs work

1. An agent proposes a task with `action_type: write_back`
2. The task enters your queue with a complete description of what will change, including before/after previews where available
3. You review and approve (or reject, or edit)
4. Blueprint executes the change in the target service using the connected connector's credentials
5. The result is recorded in `action_memory` — the brain's log of what was changed and when

You always see exactly what will be written before approving. Blueprint does not execute write-backs speculatively.

## Supported write-backs

### Shopify

| Action | What happens |
|--------|-------------|
| Update product description | Rewrites the product body HTML in your Shopify admin |
| Update product title | Changes the product title |

Requires the Shopify connector with write permissions enabled. The connector must have the `write_products` scope in its API credentials.

### WordPress

| Action | What happens |
|--------|-------------|
| Create post | Creates a new post as a draft (not published by default) |
| Update post | Edits the content of an existing post |

Requires the WordPress connector configured with a user account that has the Editor or Administrator role. Posts are created as drafts unless the task metadata specifies `status: publish` and you have approved that explicitly.

### Kirby

| Action | What happens |
|--------|-------------|
| Create page | Creates a new page in your Kirby site's content directory |
| Update page content | Edits the text content of an existing Kirby page |

Requires the Kirby connector with file-system write access configured. Changes are written to the content directory on disk.

### Google Business Profile

| Action | What happens |
|--------|-------------|
| Update business description | Updates the description shown on your Google Maps/Search listing |
| Post an update | Publishes a Google Business Profile post (announcement, offer, event) |

Requires the GBP connector with a Google account that has Owner or Manager role for the business listing.

### GitHub

| Action | What happens |
|--------|-------------|
| Create pull request | Opens a PR with suggested code changes on the target repository |

Requires the GitHub connector (or the Server Access connector if using SSH). The agent generates a diff, creates a branch, commits the changes, and opens a PR for your review — it does not merge automatically. The PR is the approval gate.

## Enabling write-backs

Write-backs are gated on two things:

1. **Connector with write permissions** — the relevant connector must be connected and configured to allow writes. Read-only connector configurations cannot perform write-backs. Check the connector's settings page to confirm write access is enabled.

2. **Trust tier yellow or green** — write-back tasks require at minimum yellow tier (your approval). Red-tier agents will never execute write-backs.

To enable write-backs for a connector, go to Settings → Connectors → [connector name] → enable write access, then re-authorise if required by the service.

## What happens after a write-back executes

After execution, Blueprint:

- Records the action in `action_memory` with a timestamp, the agent that proposed it, and what was changed
- Links the action back to the originating signal or goal
- Monitors subsequent connector syncs to measure whether the change had the intended effect
- Updates the agent's outcome record in the restraint system

This tracking is how Blueprint builds a picture of which agents and which types of actions actually move metrics. Over time, agents with strong write-back track records can be considered for green trust tier.

## Reverting a write-back

Blueprint does not provide a one-click undo for write-backs (that would require API support from every connected service). If you need to revert:

- **Shopify / WordPress / Kirby / GBP**: go to the relevant service and restore the previous content manually. The task detail view shows what was written so you have the before-state.
- **GitHub**: close or revert the PR using GitHub's standard tools.

This is intentional. Write-backs are designed to be reviewed before approval. If you find yourself frequently reverting, consider adjusting the agent's `trust_tier` back to yellow or reviewing its prompt configuration.
