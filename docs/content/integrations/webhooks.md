---
title: "Webhooks"
description: "Receive real-time Blueprint events at your own endpoint"
section: "Integrations"
order: 4
---

# Webhooks

Webhooks let you receive Blueprint events in real time at an HTTP endpoint you control. When something happens in Blueprint — a signal fires, a task is approved, a connector syncs — Blueprint sends an HTTP POST to your registered URL.

Webhooks are registered via the BAP API and require a BAP API key. They are the primary mechanism for building reactive integrations: monitoring tools, custom notification systems, downstream automation, and external approval flows.

## Registering a webhook

```bash
curl -X PUT https://your-blueprint-instance/api/bap/v1/me/webhook \
  -H "BAP-Key: bap_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/hooks/blueprint",
    "events": [
      "signal.created",
      "task.proposed",
      "task.approved",
      "connector.error"
    ]
  }'
```

You can update your webhook (URL or events) by calling `PUT` again. Only one webhook endpoint is supported per registered BAP agent. To receive events at multiple endpoints, register multiple agents.

## Available events

| Event | Fires when |
|-------|-----------|
| `signal.created` | A new signal is detected by the signal engine |
| `signal.acknowledged` | A signal is acknowledged (by human or agent) |
| `signal.resolved` | A signal is marked resolved |
| `task.proposed` | An agent proposes a new task |
| `task.approved` | A task is approved (by human or auto-approved via green tier) |
| `task.rejected` | A task is rejected |
| `task.completed` | A task finishes execution successfully |
| `connector.sync.complete` | A connector completes a data sync |
| `connector.error` | A connector sync fails |
| `agent.run.complete` | An internal Blueprint agent run completes |
| `agent.run.failed` | An internal Blueprint agent run fails |

## Payload format

Every event delivery is a JSON `POST` to your registered URL. The structure is consistent across all event types:

```json
{
  "event": "signal.created",
  "timestamp": "2026-04-14T09:32:17.412Z",
  "business_id": "biz_abc123",
  "data": {
    // Event-specific data
  }
}
```

The `data` object contains the full entity relevant to the event. For `signal.created`, this is the complete signal record. For `task.approved`, this is the complete task record including the approver and approval timestamp.

### Example: signal.created

```json
{
  "event": "signal.created",
  "timestamp": "2026-04-14T09:32:17.412Z",
  "business_id": "biz_abc123",
  "data": {
    "id": "sig_xyz789",
    "type": "shopify_no_orders",
    "severity": "alert",
    "status": "open",
    "title": "No orders received today",
    "description": "Zero orders in the last 24 hours. Prior 7-day average: 12/day.",
    "connector_type": "shopify",
    "confidence": 0.97,
    "created_at": "2026-04-14T09:32:16.000Z"
  }
}
```

## Signature verification

Every delivery includes a `Blueprint-Signature` header containing an HMAC-SHA256 signature of the raw request body, signed with your BAP key.

**Always verify the signature** before processing the payload to prevent spoofed deliveries.

```javascript
const crypto = require('crypto')

function verifyBlueprintSignature(rawBody, signature, bapKey) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', bapKey)
    .update(rawBody)
    .digest('hex')

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  )
}

// In your Express handler:
app.post('/hooks/blueprint', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['blueprint-signature']
  if (!verifyBlueprintSignature(req.body, sig, process.env.BAP_KEY)) {
    return res.status(401).send('Invalid signature')
  }
  const event = JSON.parse(req.body)
  // Handle event...
  res.status(200).send('ok')
})
```

Use `express.raw()` (not `express.json()`) to ensure you get the raw body for signature computation. Parsing the body before verifying will cause the signature check to fail.

## Retry policy

If Blueprint receives a non-2xx response (or a timeout) from your endpoint, it retries with exponential backoff:

| Attempt | Delay after previous failure |
|---------|------------------------------|
| 1st retry | 5 minutes |
| 2nd retry | 30 minutes |
| 3rd retry | 2 hours |
| 4th retry | 8 hours |

After 4 failed attempts, the delivery is marked **dead** and no further retries are made. Dead deliveries are visible in the delivery history (`GET /api/bap/v1/me/webhook/deliveries`) and can be retried manually:

```bash
curl -X POST https://your-blueprint-instance/api/bap/v1/me/webhook/deliveries/{deliveryId}/retry \
  -H "BAP-Key: bap_xxx"
```

## Responding to deliveries

Your endpoint must respond within **10 seconds** with a 2xx status code. Blueprint does not wait for your processing to complete — acknowledge the delivery immediately and process asynchronously:

```javascript
app.post('/hooks/blueprint', (req, res) => {
  res.status(200).send('ok') // Acknowledge first
  setImmediate(() => processEvent(req.body)) // Process after
})
```

## Delivery history

View recent delivery history and status for your webhook:

```bash
curl https://your-blueprint-instance/api/bap/v1/me/webhook/deliveries \
  -H "BAP-Key: bap_xxx"
```

Returns a list of recent deliveries with their event type, timestamp, HTTP status code returned by your endpoint, and whether they succeeded or are pending retry.
