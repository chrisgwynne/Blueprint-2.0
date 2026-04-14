---
title: "API Reference"
description: "Blueprint's HTTP API for building integrations"
section: "Integrations"
order: 2
---

# API Reference

This page documents Blueprint's core HTTP API — the endpoints used by the browser client and available to any integration that needs direct API access.

For building external agents with full two-way access (signals, tasks, KB, metrics, webhooks), use the [BAP Protocol](/integrations/bap-protocol) instead. BAP provides a structured permission model and is the recommended integration path for autonomous agents and third-party services.

## Authentication

Three authentication methods are supported depending on the client type:

**Session cookie** — used automatically by the Blueprint browser client after login. No additional setup required for browser-based usage.

**BAP key** — for external agents registered via the BAP protocol:
```
BAP-Key: bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Public API key** — for lightweight integrations that need read access without full BAP registration:
```
X-Blueprint-Key: bp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Public API keys are generated in Settings → API Keys. They support read-only operations on endpoints that do not require write permissions.

## Core endpoints

### Server

```
GET /api/health
```

Returns server status and version. No authentication required. Useful for health checks and uptime monitoring.

Response:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 86423
}
```

### Businesses

```
GET /api/businesses
```

List all businesses on this Blueprint instance that the authenticated user or key has access to.

### Signals

```
GET /api/signals?businessId=xxx
```

List signals for a business. Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `status` | Filter by status: `open`, `acknowledged`, `resolved` |
| `severity` | Filter by severity: `info`, `warning`, `alert` |
| `type` | Filter by signal type (e.g., `shopify_no_orders`) |
| `limit` | Number of results (default: 50, max: 200) |
| `offset` | Pagination offset |

```
POST /api/signals
```

Create a signal. Body:

```json
{
  "businessId": "biz_xxx",
  "type": "custom_signal_type",
  "severity": "warning",
  "title": "Signal title",
  "description": "Signal description",
  "data": {}
}
```

### Tasks

```
GET /api/tasks?businessId=xxx
```

List tasks for a business. Optional query parameters:

| Parameter | Description |
|-----------|-------------|
| `status` | Filter by status: `proposed`, `approved`, `in_progress`, `complete` |
| `priority` | Filter by priority: `p1`, `p2`, `p3`, `p4` |
| `action_type` | Filter by action type |
| `trust_tier` | Filter by trust tier: `green`, `yellow`, `red` |

```
PATCH /api/tasks/:id
```

Update a task. Used for approvals, rejections, and deferrals. Body examples:

```json
// Approve
{ "status": "approved" }

// Reject
{ "status": "rejected" }

// Defer
{ "status": "deferred", "defer_until": "2026-04-21T09:00:00.000Z" }
```

### Connectors

```
GET /api/connectors?businessId=xxx
```

List all connectors for a business, including their type, status, and last sync timestamp.

```
POST /api/connectors/:id/sync
```

Trigger a manual sync for a connector. Returns a sync job ID. The sync runs asynchronously — poll the connector endpoint or subscribe to `connector.sync.complete` via webhook to know when it finishes.

### Metrics

```
GET /api/metrics/:businessId
```

Get the latest metric snapshot for a business. Returns one value per metric, from the most recent sync of each connector.

Response shape:

```json
{
  "ga4_sessions": 4821,
  "ga4_conversions": 143,
  "shopify_orders": 28,
  "shopify_revenue": 4320.50,
  "pagespeed_mobile": 74,
  "gsc_clicks": 1203,
  "updated_at": "2026-04-14T08:45:00.000Z"
}
```

### Agents

```
GET /api/agents?businessId=xxx
```

List all agents configured for a business, including their current status (idle / running / error), last run timestamp, and linked connectors.

## Error responses

All errors follow a consistent format:

```json
{
  "error": "not_found",
  "message": "Signal sig_abc123 not found",
  "status": 404
}
```

Common error codes:

| Status | Error code | Meaning |
|--------|-----------|---------|
| 400 | `validation_error` | Request body failed validation |
| 401 | `unauthorized` | Missing or invalid credentials |
| 403 | `forbidden` | Valid credentials but insufficient permissions |
| 404 | `not_found` | Resource does not exist |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Server error |

## Pagination

Endpoints that return lists support cursor-based pagination via `limit` and `offset` parameters. The response includes a `total` count and `has_more` boolean:

```json
{
  "data": [...],
  "total": 143,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

## Building integrations

For lightweight read-only integrations (dashboards, status pages, monitoring scripts), a public API key and the core endpoints above are sufficient.

For integrations that need to create signals, propose tasks, write to the knowledge base, or receive real-time events, use the [BAP Protocol](/integrations/bap-protocol). BAP provides a richer permission model, client SDKs, webhook delivery with retry, and is designed specifically for agent-to-agent communication.
