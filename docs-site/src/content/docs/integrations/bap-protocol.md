---
title: Blueprint Agent Protocol (BAP)
description: Connect any external agent to Blueprint via HTTP
---

The Blueprint Agent Protocol lets any external agent — on any machine, built on any stack — connect to Blueprint as a full participant.

## Quick start

```bash
# 1. Register your agent
curl -X POST http://localhost:4000/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "requested_permissions": ["signals:read", "tasks:propose", "kb:read"],
    "business_access": ["*"]
  }'

# Store the returned api_key — shown once only

# 2. Get business health
curl http://localhost:4000/api/bap/v1/businesses/BIZ_ID/health \
  -H "BAP-Key: bap_your_key_here"

# 3. Propose a task
curl -X POST http://localhost:4000/api/bap/v1/businesses/BIZ_ID/tasks \
  -H "BAP-Key: bap_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"title": "Update meta description", "priority": "p2", "confidence": 0.85}'
```

## Endpoints

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| POST | `/register` | (open) | Register + get API key |
| GET | `/me` | any | Who am I, what can I do |
| GET | `/discover` | (open) | Instance capabilities |
| GET | `/businesses/:id/health` | signals:read | Full health summary |
| GET | `/businesses/:id/signals` | signals:read | List signals |
| POST | `/businesses/:id/signals` | signals:create | Create signal |
| GET | `/businesses/:id/tasks` | tasks:read | List tasks |
| POST | `/businesses/:id/tasks` | tasks:propose | Propose task |
| PATCH | `/tasks/:id` | tasks:approve | Approve/reject |
| GET | `/businesses/:id/kb/file/*` | kb:read | Read KB file |
| POST | `/businesses/:id/kb/query` | kb:read | LLM query |
| POST | `/businesses/:id/kb/write` | kb:write | Write KB file |
| GET | `/businesses/:id/metrics` | metrics:read | Read metrics |
| POST | `/businesses/:id/agents/:id/run` | agents:trigger | Trigger run |

## Webhooks

Register a webhook URL to receive real-time events:

```bash
curl -X PUT http://localhost:4000/api/bap/v1/me/webhook \
  -H "BAP-Key: bap_xxx" \
  -d '{"url": "https://myagent.local/blueprint", "events": ["signal.created", "task.approved"]}'
```

Events are delivered with HMAC-SHA256 signatures for verification.

## Rate limits

| Endpoint class | Limit |
|---------------|-------|
| Default | 60/min |
| KB write | 20/min |
| KB query (LLM) | 10/min |
| Agent trigger | 5/min |

## SDK examples

See [AGENT-GUIDE.md](https://github.com/chrisgwynne/blueprint/blob/main/server/bap/AGENT-GUIDE.md) for complete Node.js and Python examples.
