# Blueprint Skill

A business intelligence system that monitors your connected tools,
detects signals in the data, and manages a task queue with human
approval. When you install this skill you become a participant in
Blueprint's signal → task → approval → outcome loop.

---

## Setup

You need three environment variables before any Blueprint tool works:

```
BLUEPRINT_URL=http://your-blueprint-instance:4000
BLUEPRINT_API_KEY=bap_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BLUEPRINT_BUSINESS_ID=biz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Get your API key (run once):**
```bash
curl -X POST $BLUEPRINT_URL/api/bap/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YourAgentName",
    "requested_permissions": [
      "signals:read", "signals:create",
      "tasks:read", "tasks:propose",
      "kb:read", "kb:write",
      "metrics:read", "agents:trigger"
    ],
    "business_access": ["*"]
  }'
```

Store the returned `api_key`. Shown once only.

**Find your business ID:**
```bash
curl $BLUEPRINT_URL/api/bap/v1/me \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

The response lists all businesses you have access to with their IDs.

---

## Tools

---

### BLUEPRINT_HEALTH

Get current business health — score, open signals, pending tasks,
key metrics from every connected source.

**When to use:**
- Start of every session
- Morning briefings
- Before proposing tasks
- Any time you need situational awareness

```bash
curl $BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/health \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response shape:**
```json
{
  "health_score": 74,
  "signals": {
    "total": 4,
    "critical": 1,
    "alert": 2,
    "warning": 1,
    "info": 0,
    "top_signals": [
      {
        "id": "sig_xxx",
        "title": "LCP regression on mobile",
        "severity": "critical",
        "connector": "pagespeed",
        "age_hours": 2
      }
    ]
  },
  "tasks": {
    "proposed": 3,
    "executing": 1,
    "pending_approval": 3,
    "completed_7d": 8
  },
  "metrics": {
    "ga4": { "sessions_7d": 4821, "sessions_change_pct": 12.3 },
    "gsc": { "total_clicks": 1204, "avg_position": 8.2 },
    "shopify": { "revenue_7d": 1840.50, "orders_7d": 23 }
  }
}
```

**Interpret the score:**
- 80–100: healthy, routine monitoring
- 60–79: some issues, review open signals
- 40–59: degraded, action likely needed
- below 40: critical, immediate attention

---

### BLUEPRINT_SIGNALS

Read signals Blueprint has detected — anomalies, opportunities,
risks, and AI-generated insights from all connected data sources.

**When to use:**
- Human asks "what's happening with the business"
- Health score is below 70
- Before proposing tasks — check if Blueprint already flagged the issue
- Any investigation into why a metric changed

```bash
# All open signals
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"

# Only urgent signals
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals?severity=critical,alert&status=open" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Filter params:** `severity`, `status`, `connector`, `type`, `limit`

**Response shape (array of signals):**
```json
{
  "signals": [
    {
      "id": "sig_xxx",
      "type": "anomaly",
      "severity": "alert",
      "title": "Ranking drop — door toppers uk",
      "description": "Position moved from 8 to 14 over 7 days.",
      "connector": "gsc",
      "confidence": 0.87,
      "status": "open",
      "created_at": "2026-01-15T07:23:41Z"
    }
  ],
  "total": 4
}
```

---

### BLUEPRINT_PROPOSE_TASK

Propose an action for the human to approve. Tasks you propose
enter the same approval queue as tasks from Blueprint's internal agents.

**When to use:**
- Human asks you to fix, improve, or action something
- You identify an issue that needs a specific action
- A signal you read suggests a clear next step

**When NOT to use:**
- Things you can do yourself without Blueprint (just do them)
- Vague intentions ("improve SEO") — be specific or don't propose
- Duplicating a task Blueprint has already proposed (check first)

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/tasks" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Rewrite meta description for /products/door-toppers",
    "description": "Current meta is 47 chars with no target keywords. GSC shows 0.8% CTR vs 3.2% category average.",
    "action_type": "meta_update",
    "priority": "p2",
    "confidence": 0.84,
    "estimated_impact": "Estimated +2.4% CTR based on similar pages",
    "signal_id": "sig_xxx",
    "action_payload": {
      "url": "/products/door-toppers",
      "current_meta": "Door toppers for sale",
      "suggested_meta": "Transform your doorway with handcrafted oak door toppers — personalised and made in Wales. From £29.99."
    }
  }'
```

**`action_type` values:**
| Value | What it does |
|-------|-------------|
| `investigation` | Research or analysis — no external action |
| `content_draft` | Write content for human review |
| `meta_update` | SEO title or description change |
| `github_issue` | Create a GitHub issue |
| `github_pr` | Create a GitHub pull request (draft) |
| `shopify_product_create` | Create a draft Shopify product |
| `shopify_description_update` | Update a product description |
| `shopify_page_create` | Create a draft Shopify page |
| `shopify_meta_update` | Update Shopify page SEO fields |

**`priority` values:** `p1` urgent · `p2` normal · `p3` low

**Response:**
```json
{
  "task_id": "tsk_xxx",
  "status": "proposed",
  "trust_tier": "yellow",
  "approval_required": true
}
```

After proposing, tell the human:
*"I've proposed [title] in Blueprint — it's waiting for your approval."*
Do not say you've done the thing. You've proposed it.

---

### BLUEPRINT_CREATE_SIGNAL

Tell Blueprint about something you detected that its connectors
wouldn't catch — conversations, external research, social media,
news, competitor activity.

**When to use:**
- You notice something relevant while browsing or researching
- Human mentions something that affects the business
- You find external information that suggests a risk or opportunity

**When NOT to use:**
- For things Blueprint already detects from its connectors
- Run BLUEPRINT_SIGNALS first — don't create duplicates

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/signals" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "opportunity",
    "severity": "info",
    "title": "Competitor out of stock on rustic wall signs",
    "description": "Main competitor showing out-of-stock on their rustic wall sign range. Potential to capture traffic.",
    "data": {
      "competitor_url": "https://competitor.com/rustic-signs",
      "opportunity": "target their keywords while they are stocked out"
    },
    "confidence": 0.72
  }'
```

**`type` values:** `anomaly` · `opportunity` · `risk` · `correlation`

**`severity` values:** `info` · `warning` · `alert` · `critical`

---

### BLUEPRINT_KB_QUERY

Ask a question answered from the business knowledge base.
The KB contains brand voice, strategy, decisions, research,
competitive intelligence, and everything agents have learned
over time. It compounds — the longer Blueprint has been running,
the more valuable it is.

**When to use:**
- Before writing any content — check brand voice and style first
- Before making recommendations — check existing strategy
- Human asks how something was decided or why something is the way it is
- You need business context before taking any action
- Any time you'd otherwise be guessing about the business

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/query" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is our brand voice and tone?",
    "context": "I am about to write a product description for door toppers"
  }'
```

**Response:**
```json
{
  "answer": "Based on brand-voice.md and style.md: direct, warm, craft-proud. Avoid corporate language. Lead with the product story, not features...",
  "sources_read": ["concepts/brand-voice.md", "concepts/style.md"],
  "filed_as": null
}
```

The `context` field is optional but improves answer quality.

---

### BLUEPRINT_KB_WRITE

Write a page to the knowledge base. Research, decisions, insights,
competitive intelligence — anything worth keeping.
Filed pages persist across all sessions and are read by every agent.

**When to use:**
- You've done research worth keeping
- Human shares something important that should be remembered
- You reach a conclusion that future agents should know

**Directory rules (follow these exactly):**
| Directory | Use for |
|-----------|---------|
| `research/` | External findings, competitor intel, market data |
| `decisions/` | Things the human decided, with context and rationale |
| `concepts/` | Strategic principles, brand guidelines, positioning |
| `signals/` | Do not write here — Blueprint writes this automatically |
| `raw/` | Do not write here — for source documents only |

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/write" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "research/competitor-rustic-signs-jan-2026.md",
    "content": "# Competitor Analysis — Rustic Signs\n\n## Finding\n\nMain competitor is out of stock on their rustic wall sign range as of 15 Jan 2026.\n\n## Opportunity\n\nTarget [[entities/rustic-signs]] keywords while stock is depleted.",
    "frontmatter": {
      "title": "Competitor Analysis — Rustic Signs Jan 2026",
      "tags": ["research", "competitors"],
      "written_by": "your-agent-name",
      "confidence": 0.72
    }
  }'
```

Use `[[wikilinks]]` to reference other KB pages.
Always include `written_by` in frontmatter with your agent name.

---

### BLUEPRINT_KB_SEARCH

Search the knowledge base for relevant pages by keyword.

**When to use:**
- Before querying — find which pages exist on a topic
- Before writing — check nothing similar already exists

```bash
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/kb/search?q=brand+voice&limit=5" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Response:**
```json
{
  "results": [
    {
      "path": "concepts/brand-voice.md",
      "matches": [{ "line": 3, "text": "direct, warm, craft-proud..." }]
    }
  ]
}
```

---

### BLUEPRINT_METRICS

Get raw connector data — actual numbers from GA4, GSC, Shopify,
Stripe, and every other connected source.

**When to use:**
- Human asks specific data questions ("how many visitors last week")
- You need numbers to support a recommendation
- You need a baseline before proposing a change

```bash
# Snapshot of all latest metrics
curl "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/metrics/snapshot" \
  -H "BAP-Key: $BLUEPRINT_API_KEY"
```

**Snapshot response:**
```json
{
  "snapshot_at": "2026-01-15T14:00:00Z",
  "connectors": {
    "gsc": { "total_clicks": 1204, "avg_position": 8.2 },
    "ga4": { "sessions": 4821, "bounce_rate": 0.42 },
    "shopify": { "revenue_30d": 13429.90, "orders_30d": 164 }
  }
}
```

---

### BLUEPRINT_TRIGGER_AGENT

Trigger an internal Blueprint agent to run immediately.

**When to use:**
- Human wants a specific agent to run now
- You've added new KB content an agent should incorporate

```bash
curl -X POST "$BLUEPRINT_URL/api/bap/v1/businesses/$BLUEPRINT_BUSINESS_ID/agents/seo-sentinel/run" \
  -H "BAP-Key: $BLUEPRINT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "User requested immediate SEO check"}'
```

**Available agents:**
`conductor` · `seo-sentinel` · `quill` · `velocity` ·
`trend-spotter` · `merchant` · `ledger` · `reporter`

**Response:**
```json
{ "run_id": "run_xxx", "agent_id": "seo-sentinel", "status": "queued" }
```

---

## Patterns

These are the standard sequences for common situations.
Follow these rather than deciding the order yourself.

---

### Morning briefing

When asked for a morning update, daily summary, or "what's happening":

```
1. BLUEPRINT_HEALTH → score, signal counts, pending tasks
2. BLUEPRINT_SIGNALS (severity=critical,alert, status=open) → urgent items
3. Compose summary:
   - One sentence on health (score + direction)
   - Any critical/alert signals, named specifically
   - Count of tasks waiting for approval
   - One key metric per connected source
4. If health_score < 60 or any critical signal:
   → flag that something needs attention today
```

---

### Investigate an issue

When asked why something is happening or what's wrong:

```
1. BLUEPRINT_SIGNALS → what Blueprint already knows
2. BLUEPRINT_METRICS → raw numbers for relevant connectors
3. BLUEPRINT_KB_QUERY → historical context
4. Synthesise: likely cause, impact, what should be done
5. BLUEPRINT_PROPOSE_TASK if a specific action follows
```

---

### Act on something

When asked to fix, improve, or sort something out:

```
1. BLUEPRINT_KB_QUERY → check existing strategy first
2. BLUEPRINT_SIGNALS → check if already flagged
3. BLUEPRINT_METRICS → get baseline data
4. BLUEPRINT_PROPOSE_TASK → specific title, description, payload
5. Tell the human: "I've proposed [title] — waiting for approval."
```

---

### Research and file

When doing research or gathering information:

```
1. Do the research
2. BLUEPRINT_KB_SEARCH → check if Blueprint already has this
3. BLUEPRINT_KB_WRITE → file to the correct directory
4. BLUEPRINT_CREATE_SIGNAL if the finding is actionable
5. Tell the human where it's filed
```

---

### Write content

When writing any content for the business:

```
1. BLUEPRINT_KB_QUERY ("What is our brand voice?") → always first
2. BLUEPRINT_KB_QUERY (topic-specific) → existing content
3. Write the content following what the KB says
4. BLUEPRINT_PROPOSE_TASK if it should be published
5. BLUEPRINT_KB_WRITE → file the draft for the record
```

---

## Rules

**Read before you write.**
Before proposing a task or creating a signal, check what Blueprint
already knows. BLUEPRINT_SIGNALS then BLUEPRINT_KB_QUERY first.

**Be specific or don't propose.**
A task proposal must say exactly what should happen.
Current state. Proposed state. Why. Expected outcome.

**Honest confidence scores.**
0.85+ → confident. 0.70–0.84 → note uncertainty. Below 0.50 → investigate more.

**You propose. The human approves.**
Never tell the human you've done something when you've proposed it.

**File valuable things.**
If you learn something worth keeping, write it to the KB.
The KB compounds across all sessions and all agents.

**Blueprint unavailable.**
If API calls fail, continue without Blueprint. Note what to do when it returns.

---

## Error reference

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Invalid or expired API key | Re-register |
| 403 | Permission denied | Re-register with required permission |
| 404 | Business or resource not found | Verify BLUEPRINT_BUSINESS_ID |
| 429 | Rate limited | Wait and retry |
| 503 | Blueprint unavailable | Continue without it |

---

## Quick reference

```
BLUEPRINT_HEALTH          → situational awareness — start here
BLUEPRINT_SIGNALS         → what Blueprint has detected
BLUEPRINT_PROPOSE_TASK    → suggest an action for human approval
BLUEPRINT_CREATE_SIGNAL   → tell Blueprint what you found externally
BLUEPRINT_KB_QUERY        → ask the knowledge base a question
BLUEPRINT_KB_WRITE        → file research or findings permanently
BLUEPRINT_KB_SEARCH       → find relevant KB pages by keyword
BLUEPRINT_METRICS         → raw connector data (GA4, GSC, Shopify...)
BLUEPRINT_TRIGGER_AGENT   → run an internal Blueprint agent now
```
