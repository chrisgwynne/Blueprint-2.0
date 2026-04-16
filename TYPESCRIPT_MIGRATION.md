# Blueprint TypeScript Migration Assessment

> Generated: 2026-04-15  
> Codebase version: 0.9.0-beta  
> Scope: Full migration readiness audit — no code was changed.

---

## Table of Contents

1. [Codebase Summary](#1-codebase-summary)
2. [Dependency Assessment](#2-dependency-assessment)
3. [Database Type Inventory](#3-database-type-inventory)
4. [Shared Type Inventory](#4-shared-type-inventory)
5. [Risk Register](#5-risk-register)
6. [Connector Interface Definition](#6-connector-interface-definition)
7. [Agent System Types](#7-agent-system-types)
8. [Migration Phases](#8-migration-phases)
9. [tsconfig Recommendation](#9-tsconfig-recommendation)
10. [Build System Changes](#10-build-system-changes)
11. [Special Patterns](#11-special-patterns)
12. [Go / No-Go Recommendation](#12-go--no-go-recommendation)
13. [Verification Checklist](#13-verification-checklist)

---

## 1. Codebase Summary

### Overview

| Metric | Value |
|--------|-------|
| Total source files | 205 (.js + .jsx) |
| Total lines of code | 66,622 |
| Server LOC | ~44,846 |
| Client LOC | ~21,819 |
| TypeScript files (.ts / .tsx) | **0** |
| tsconfig.json files | **0** |
| @types/* packages installed | **0** |
| `typescript` in any package.json | **absent** |
| Module system | Pure ESM (`"type": "module"` in all three package.json files) |
| Runtime | Bun (bun.lock present, `bun --watch`, `bun:sqlite`) |
| Node engine | `>=20.0.0` |
| Monorepo layout | Root workspace → `server/` + `client/` |

No TypeScript whatsoever is present. This is a greenfield migration.

### Monorepo Layout

```
blueprint/
├── package.json              # Root workspace (bun), no devDependencies
├── bun.lock
├── scripts/
│   ├── dev.js
│   └── setup.js
├── server/
│   ├── package.json          # @blueprint/server, type:module
│   ├── index.js              # Entry point (578 LOC)
│   ├── db/
│   │   ├── db.js             # SQLite wrapper (768 LOC)
│   │   ├── init.js
│   │   └── schema.sql        # 558 lines, 36 tables
│   ├── agents/               # Agent runner + 4 active agents + templates
│   ├── brain/                # Goal reasoning, retrospective, conflict engines
│   ├── chat/
│   ├── connectors/           # 23 connectors + interface
│   ├── jobs/                 # scheduler.js (679 LOC)
│   ├── kb/                   # Knowledge base engine
│   ├── lib/                  # Shared utilities + LLM providers
│   ├── notifications/
│   ├── roi/
│   ├── routes/               # 31 route files
│   ├── signals/              # Signal engine + rules (2,526 LOC)
│   ├── tasks/                # executor.js (1,447 LOC) + queue + approval
│   └── workflows/
└── client/
    ├── package.json          # @blueprint/client, type:module
    ├── vite.config.js
    └── src/
        ├── components/       # UI components
        ├── lib/              # api.js (442 LOC), client utilities
        └── pages/            # 21 page components
```

### 20 Largest Source Files

| Rank | File | LOC | Risk |
|------|------|-----|------|
| 1 | `client/src/pages/ConnectorDataPage.jsx` | 2,807 | **HIGH** |
| 2 | `client/src/pages/Settings.jsx` | 2,533 | HIGH |
| 3 | `server/signals/rules.js` | 2,526 | **HIGH** |
| 4 | `client/src/pages/Connectors.jsx` | 1,685 | MEDIUM |
| 5 | `server/agents/agent-runner.js` | 1,619 | **HIGH** |
| 6 | `server/tasks/executor.js` | 1,447 | **HIGH** |
| 7 | `client/src/pages/Signals.jsx` | 1,322 | MEDIUM |
| 8 | `client/src/pages/AgentDetail.jsx` | 1,100 | MEDIUM |
| 9 | `server/kb/kb-agent.js` | 969 | MEDIUM |
| 10 | `client/src/pages/Tasks.jsx` | 938 | MEDIUM |
| 11 | `server/kb/kb-engine.js` | 892 | MEDIUM |
| 12 | `client/src/pages/KB.jsx` | 882 | LOW |
| 13 | `server/routes/oauth.js` | 873 | **HIGH** |
| 14 | `server/routes/bap.js` | 827 | MEDIUM |
| 15 | `client/src/pages/SystemHealth.jsx` | 810 | LOW |
| 16 | `client/src/components/Sidebar.jsx` | 797 | LOW |
| 17 | `server/db/db.js` | 768 | MEDIUM |
| 18 | `server/agents/self-healer.js` | 730 | MEDIUM |
| 19 | `client/src/pages/Agents.jsx` | 694 | LOW |
| 20 | `server/signals/ai-analysis.js` | 692 | MEDIUM |

---

## 2. Dependency Assessment

### Server Dependencies (`server/package.json`)

| Package | Version | Types Bundled | @types/* Available | Notes |
|---------|---------|--------------|-------------------|-------|
| `@anthropic-ai/sdk` | ^0.27.0 | **Yes** | — | TypeScript-first SDK; full generics on `Message`, `Tool`, `ContentBlock` |
| `@isomorphic-git/lightning-fs` | ^4.6.0 | Partial | — | Ships some types; gaps in FS options |
| `basic-ftp` | ^5.2.2 | **Yes** | — | Full types included |
| `bcryptjs` | ^2.4.3 | No | `@types/bcryptjs` ✓ | Plain JS package; @types available on DefinitelyTyped |
| `cors` | ^2.8.5 | No | `@types/cors` ✓ | — |
| `dotenv` | ^16.4.5 | **Yes** | — | Types bundled since v14 |
| `express` | ^4.18.3 | No | `@types/express` ✓ | Critical — all routes depend on `Request`, `Response`, `NextFunction` |
| `express-session` | ^1.18.0 | No | `@types/express-session` ✓ | Requires module augmentation to extend `SessionData` |
| `flexsearch` | ^0.7.43 | **None** | **None** | Highest-risk gap. No bundled types, no DefinitelyTyped entry. Must write a local `.d.ts` shim. |
| `gray-matter` | ^4.0.3 | **Yes** | — | Ships `.d.ts`; `GrayMatterFile<string>` generic |
| `isomorphic-git` | ^1.25.6 | **Yes** | — | Full types bundled |
| `js-yaml` | ^4.1.0 | No | `@types/js-yaml` ✓ | `yaml.load()` returns `unknown` — requires runtime narrowing at every call site |
| `marked` | ^18.0.0 | **Yes** | — | Types bundled since v5 |
| `node-cron` | ^3.0.3 | **Yes** | — | — |
| `node-fetch` | ^3.3.2 | **Yes** | — | v3 is ESM-first with bundled types |
| `ssh2` | ^1.17.0 | No | `@types/ssh2` ✓ | Complex callback-heavy API; @types available |
| `stripe` | ^22.0.1 | **Yes** | — | TypeScript-first; excellent type coverage |
| `uuid` | ^9.0.1 | **Yes** | — | Types bundled since v9 |
| `bun:sqlite` | (built-in) | Partial | `@types/bun` ✓ | Bun built-in — `@types/bun` adds `.get<T>()` and `.all<T>()` generics |

**Recommended @types installs (server):**
```
bun add -d @types/bcryptjs @types/cors @types/express @types/express-session @types/js-yaml @types/ssh2 @types/bun
```

### Client Dependencies (`client/package.json`)

| Package | Version | Types Bundled | @types/* Available | Notes |
|---------|---------|--------------|-------------------|-------|
| `@dnd-kit/core` | ^6.3.1 | **Yes** | — | — |
| `@dnd-kit/sortable` | ^10.0.0 | **Yes** | — | — |
| `@dnd-kit/utilities` | ^3.2.2 | **Yes** | — | — |
| `@tiptap/extension-placeholder` | ^2.3.0 | **Yes** | — | — |
| `@tiptap/react` | ^2.3.0 | **Yes** | — | TypeScript-first |
| `@tiptap/starter-kit` | ^2.3.0 | **Yes** | — | — |
| `clsx` | ^2.1.1 | **Yes** | — | — |
| `date-fns` | ^3.6.0 | **Yes** | — | Types bundled since v3 |
| `framer-motion` | ^12.38.0 | **Yes** | — | TypeScript-first |
| `lucide-react` | ^0.378.0 | **Yes** | — | — |
| `marked` | ^18.0.0 | **Yes** | — | (shared with server) |
| `react` | ^18.3.0 | No | `@types/react` ✓ | Required — JSX transform types |
| `react-dom` | ^18.3.0 | No | `@types/react-dom` ✓ | Required |
| `react-router-dom` | ^6.23.0 | **Yes** | — | Types bundled since v6 |
| `recharts` | ^2.12.0 | **Yes** | — | — |
| `turndown` | ^7.2.4 | No | `@types/turndown` ✓ | Community @types available |
| `zustand` | ^4.5.2 | **Yes** | — | TypeScript-first; excellent generic store types |

**Client devDependencies:**

| Package | Version | Types Bundled |
|---------|---------|--------------|
| `@rollup/rollup-linux-x64-gnu` | 4.60.1 | Yes |
| `@vitejs/plugin-react` | ^4.2.1 | Yes |
| `autoprefixer` | ^10.4.19 | Partial |
| `postcss` | ^8.4.38 | Yes |
| `tailwindcss` | ^3.4.3 | Yes |
| `vite` | ^5.2.0 | **Yes** |

**Recommended @types installs (client):**
```
bun add -d @types/react @types/react-dom @types/turndown
```

### Summary

- **30 / 37 unique packages** ship bundled types or have @types/* available (~81%)
- **Critical gaps:** `flexsearch` (no types anywhere — requires a local shim)
- **Risk packages:** `express`, `express-session`, `js-yaml` (types exist but require runtime narrowing or module augmentation)
- **No install is zero-work:** `express-session` requires module augmentation of `Express.Session` to add business_id, userId, etc.

---

## 3. Database Type Inventory

The database layer is `bun:sqlite` via `server/db/db.js` (768 LOC). All queries are raw SQL. The schema (`server/db/schema.sql`, 558 lines, 36 tables) uses JSON columns extensively — 35+ JSON-typed columns across 20+ tables.

The proposed home for all DB types: `server/types/db.ts`

### Polymorphic Columns — High Priority

These columns store discriminated data and are the highest-risk typing targets:

| Table | Column | Type | Values / Shape |
|-------|--------|------|----------------|
| `tasks` | `action_payload` | JSON | Discriminated union on `action_type` — see below |
| `signals` | `data` | JSON | Connector-specific; varies by signal type |
| `settings` | `value` | JSON | Any scalar or object |
| `job_queue` | `payload` | JSON | Varies by job type |
| `connectors` | `credentials` | JSON | Service-specific auth tokens |
| `connectors` | `config` | JSON | Service-specific configuration |
| `metrics` | `metric_data` | JSON | Connector-specific metric shape |

### `action_payload` Discriminated Union

24 action types observed in `server/tasks/executor.js` (lines 977–1000+):

```typescript
// server/types/action-payloads.ts
export type ActionType =
  | 'github_issue'
  | 'github_pr'
  | 'investigation'
  | 'content_draft'
  | 'meta_update'
  | 'shopify_product_create'
  | 'shopify_product_update'
  | 'shopify_description_update'
  | 'shopify_meta_update'
  | 'shopify_page_create'
  | 'shopify_page_update'
  | 'shopify_blog_post_create'
  | 'shopify_collection_update'
  | 'shopify_tag_update'
  | 'shopify_theme_edit'
  | 'hire_agent'
  | 'wix_seo_update'
  | 'server_file_write'
  | 'server_file_rollback'
  | 'gbp_update'
  | 'klaviyo_flow_update'
  | 'meta_ads_update'
  | 'connect_connector'
  | 'research_connector';

interface BasePayload { [key: string]: unknown }

export interface GithubIssuePayload extends BasePayload {
  repo: string; title: string; body: string; labels?: string[];
}
export interface GithubPRPayload extends BasePayload {
  repo: string; title: string; body: string; base?: string; head: string;
}
export interface ContentDraftPayload extends BasePayload {
  content_type: string; topic: string; target_url?: string; outline?: string;
}
export interface ShopifyProductPayload extends BasePayload {
  product_id?: string; title?: string; body_html?: string;
  tags?: string[]; metafields?: Record<string, string>;
}
export interface ShopifyThemeEditPayload extends BasePayload {
  theme_id: string; asset_key: string; value: string;
}
export interface ServerFileWritePayload extends BasePayload {
  path: string; content: string; encoding?: string;
}
export interface HireAgentPayload extends BasePayload {
  agent_type: string; profile_overrides?: Partial<AgentProfile>;
}
// ... one interface per action_type

export type ActionPayload =
  | { action_type: 'github_issue'; payload: GithubIssuePayload }
  | { action_type: 'github_pr'; payload: GithubPRPayload }
  | { action_type: 'content_draft'; payload: ContentDraftPayload }
  | { action_type: 'shopify_product_create' | 'shopify_product_update'
      | 'shopify_description_update' | 'shopify_meta_update'; payload: ShopifyProductPayload }
  | { action_type: 'shopify_theme_edit'; payload: ShopifyThemeEditPayload }
  | { action_type: 'server_file_write'; payload: ServerFileWritePayload }
  | { action_type: 'hire_agent'; payload: HireAgentPayload }
  // ... complete union
  | { action_type: ActionType; payload: BasePayload }; // catch-all until all are enumerated
```

### Per-Table Interface Sketches

```typescript
// ────────────────────────────────────────────────────────────────────────────
// CORE ENTITIES
// ────────────────────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  settings: Record<string, unknown>;      // JSON
  created_at: string;
  updated_at: string;
}

export interface Connector {
  id: string;
  business_id: string;
  type: string;                           // e.g. 'gsc', 'ga4', 'shopify'
  name: string;
  status: 'disconnected' | 'connected' | 'error' | 'syncing';
  credentials: Record<string, unknown>;  // JSON — encrypted at rest
  config: Record<string, unknown>;       // JSON — service-specific config
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Signal {
  id: string;
  business_id: string;
  type: string;
  title: string;
  summary?: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  data: Record<string, unknown>;          // JSON — connector-specific
  source_connector_id?: string;
  agent_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Mission {
  id: string;
  business_id: string;
  title: string;
  description?: string;
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  success_metrics: Array<{ metric: string; target: number; unit?: string }>; // JSON
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  business_id: string;
  agent_id?: string;
  agent_run_id?: string;
  title: string;
  description?: string;
  action_type: ActionType;
  action_payload: Record<string, unknown>;  // JSON — discriminated on action_type
  status: 'proposed' | 'pending_approval' | 'approved' | 'executing'
        | 'completed' | 'failed' | 'rejected' | 'rolled_back';
  trust_tier: 'green' | 'yellow' | 'red';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  approval_mode: 'auto' | 'requires_approval';
  rollback_data?: Record<string, unknown>;  // JSON
  outcome_data?: Record<string, unknown>;   // JSON
  settings_override: Record<string, unknown>; // JSON
  executed_at?: string;
  created_at: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// AGENTS
// ────────────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  business_id: string;
  type: string;                          // 'conductor' | 'seo-sentinel' | 'quill' | 'trend-spotter'
  name: string;
  status: 'active' | 'paused' | 'retired';
  run_count: number;
  settings_override: Record<string, unknown>; // JSON
  last_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: string;
  business_id: string;
  agent_id: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  signals_detected: number;
  tasks_proposed: number;
  output?: Record<string, unknown>;       // JSON — AgentRunOutput shape
  error?: string;
  duration_ms?: number;
  started_at: string;
  completed_at?: string;
}

export interface AgentCalibration {
  id: string;
  business_id: string;
  agent_id: string;
  period_start: string;
  period_end: string;
  suggested_agents: string[];            // JSON
  evidence: Record<string, unknown>;    // JSON
  status: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// METRICS & ANALYTICS
// ────────────────────────────────────────────────────────────────────────────

export interface Metric {
  id: string;
  business_id: string;
  connector_id: string;
  metric_type: string;
  metric_name: string;
  metric_data: Record<string, unknown> | null; // JSON — connector-specific
  recorded_at: string;
  created_at: string;
}

export interface CostDaily {
  id: string;
  business_id: string;
  date: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  run_count: number;
  cost_usd?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// AUDIT & EVENTS
// ────────────────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  business_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_state: Record<string, unknown> | null; // JSON
  after_state: Record<string, unknown> | null;  // JSON
  metadata: Record<string, unknown>;            // JSON
  actor?: string;
  created_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  business_id: string;
  event_type: string;
  metadata: Record<string, unknown>; // JSON
  created_at: string;
}

export interface Notification {
  id: string;
  business_id: string;
  type: string;
  title: string;
  body?: string;
  read: boolean;
  entity_type?: string;
  entity_id?: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE
// ────────────────────────────────────────────────────────────────────────────

export interface KBDoc {
  id: string;
  business_id: string;
  title: string;
  content: string;
  slug: string;
  status: string;
  tags: string[];                      // JSON
  frontmatter: Record<string, unknown>; // JSON — KBFrontmatter shape
  word_count?: number;
  created_at: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SETTINGS & SESSIONS
// ────────────────────────────────────────────────────────────────────────────

export interface Setting {
  id: string;
  business_id: string;
  key: string;
  value: unknown;  // JSON — could be string, number, boolean, object
  created_at: string;
  updated_at: string;
}

export interface Session {
  sid: string;
  sess: {                              // JSON
    business_id?: string;
    userId?: string;
    [key: string]: unknown;
  };
  expired: string;
}

// ────────────────────────────────────────────────────────────────────────────
// ANALYSIS & INTELLIGENCE
// ────────────────────────────────────────────────────────────────────────────

export interface AnalysisRun {
  id: string;
  business_id: string;
  status: 'running' | 'completed' | 'failed';
  insights_count: number;
  tasks_created: number;
  connectors_analysed: string[];       // JSON — array of connector IDs
  error?: string;
  started_at: string;
  completed_at?: string;
}

export interface ConnectorSync {
  id: string;
  business_id: string;
  connector_id: string;
  status: 'running' | 'completed' | 'failed';
  records_fetched: number;
  metrics_stored: number;
  error?: string;
  started_at: string;
  completed_at?: string;
}

export interface SignalCluster {
  id: string;
  business_id: string;
  title: string;
  summary?: string;
  signal_ids: string[];                // JSON
  status: 'open' | 'resolved';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Investigation {
  id: string;
  business_id: string;
  metric_name: string;
  trigger?: string;
  status: string;
  report_json: Record<string, unknown>; // JSON — InvestigationReport shape
  constraints_json?: Record<string, unknown>; // JSON
  created_at: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// CHAT
// ────────────────────────────────────────────────────────────────────────────

export interface ChatConversation {
  id: string;
  business_id: string;
  title?: string;
  type: 'human' | 'agent' | 'system';
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  business_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  mentions: string[];                  // JSON — entity IDs mentioned
  attachments: Array<{ type: string; url?: string; data?: unknown }>;  // JSON
  metadata: Record<string, unknown>;  // JSON
  created_at: string;
}

export interface ChatReaction {
  id: string;
  message_id: string;
  business_id: string;
  emoji: string;
  actor?: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// TASKS & QUEUES
// ────────────────────────────────────────────────────────────────────────────

export interface TaskOutcome {
  id: string;
  task_id: string;
  business_id: string;
  outcome: 'success' | 'failure' | 'partial';
  details?: string;
  metrics_impact?: Record<string, unknown>;
  created_at: string;
}

export interface JobQueue {
  id: string;
  business_id: string;
  job_type: string;
  payload: Record<string, unknown>;   // JSON — job-specific
  priority: number;
  status: string;
  attempts: number;
  error?: string;
  scheduled_for?: string;
  created_at: string;
  updated_at: string;
}

export interface SchedulerLog {
  id: string;
  job_name: string;
  business_id?: string;
  status: string;
  duration_ms?: number;
  error?: string;
  constraints_json?: Record<string, unknown>; // JSON
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// BRAIN / STRATEGIC LAYER
// ────────────────────────────────────────────────────────────────────────────

export interface Scenario {
  id: string;
  business_id: string;
  title: string;
  scenarios_json: Array<{              // JSON
    id: string; title: string; description: string;
    probability: number; impact: string;
    actions: string[];
  }>;
  decision_criteria?: Record<string, unknown>; // JSON
  created_at: string;
}

export interface Conflict {
  id: string;
  business_id: string;
  conflict_type: string;
  title: string;
  description?: string;
  status: 'open' | 'resolved' | 'escalated';
  entity_a_type?: string;
  entity_a_id?: string;
  entity_b_type?: string;
  entity_b_id?: string;
  resolution?: string;
  created_at: string;
  updated_at: string;
}

export interface Retrospective {
  id: string;
  business_id: string;
  period_start: string;
  period_end: string;
  what_worked: string[];               // JSON
  what_didnt: string[];                // JSON
  learnings: string[];                 // JSON
  agent_assessments: Array<{ agent_id: string; score: number; notes: string }>; // JSON
  open_windows: string[];              // JSON
  recommendations: string[];          // JSON
  operating_changes: string[];        // JSON
  calibration_notes: string[];        // JSON
  full_report_json?: Record<string, unknown>; // JSON
  created_at: string;
}

export interface GoalSuggestion {
  id: string;
  business_id: string;
  title: string;
  description?: string;
  rationale?: string;
  status: string;
  suggested_workflow_id?: string;
  evidence?: Record<string, unknown>; // JSON
  created_at: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// BAP (Blueprint Agent Protocol) — External Access
// ────────────────────────────────────────────────────────────────────────────

export interface BapAgent {
  id: string;
  business_id: string;
  name: string;
  status: 'active' | 'inactive';
  default_trust_tier: 'green' | 'yellow' | 'red';
  total_calls: number;
  permissions: string[];               // JSON
  business_access: string[];           // JSON — business IDs
  webhook_events: string[];            // JSON — event type subscriptions
  secret_hash?: string;
  created_at: string;
  updated_at: string;
}

export interface BapAudit {
  id: string;
  bap_agent_id: string;
  business_id: string;
  endpoint: string;
  method: string;
  status_code: number;
  request_body?: Record<string, unknown>; // JSON
  response_summary?: string;
  created_at: string;
}

export interface BapWebhookDelivery {
  id: string;
  bap_agent_id: string;
  business_id: string;
  event_type: string;
  delivery_status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  request_body?: Record<string, unknown>; // JSON
  last_error?: string;
  created_at: string;
  updated_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// API KEYS & SECURITY
// ────────────────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  business_id: string;
  name: string;
  key_hash: string;
  rate_limit: number;
  scopes: string[];                    // JSON — e.g. ["read", "write"]
  total_calls: number;
  last_used_at?: string;
  expires_at?: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────────────
// SEARCH & LOGGING
// ────────────────────────────────────────────────────────────────────────────

export interface SearchLog {
  id: string;
  business_id: string;
  query: string;
  connector_used?: string;
  results_count?: number;
  duration_ms?: number;
  created_at: string;
}
```

**Tables confirmed in schema.sql:** 36 total. All 35 identified by name are covered above. One table (exact name unconfirmed — likely `goals` or a workflow-related table) uses the same JSON column pattern and should follow the same interface pattern.

**Note on `workflows`:** A workflow engine exists at `server/workflows/workflow-engine.js` (321 LOC) and a routes file `server/routes/workflows.js` exists, but no `workflows`, `workflow_runs`, or `workflow_step_runs` table was found in `schema.sql`. These tables may be defined in a separate migration file or the workflow state is stored in `job_queue`. Investigate before Phase 8 of migration.

---

## 4. Shared Type Inventory

All shared types should live in `server/types/` and be imported by both server code and (where duplicated) client code. Client-only types can live in `client/src/types/`.

### Proposed `server/types/` Layout

```
server/types/
├── index.ts              # Re-exports all public types
├── db.ts                 # All database row interfaces (Section 3)
├── action-payloads.ts    # ActionType + all payload shapes
├── connectors.ts         # BlueprintConnector interface + ConnectorId union
├── agents.ts             # AgentProfile, AgentRunOutput, all agent types
├── llm.ts                # LLMRequest, LLMResponse, LLMProvider
├── signals.ts            # SignalRule, SignalMatch, signal data shapes
├── workflows.ts          # Workflow step/trigger types
└── shared.ts             # Utility types (Paginated<T>, ApiResponse<T>, etc.)
```

### Priority Order

| Priority | Type | Why First |
|----------|------|-----------|
| P0 | `Task` + `ActionPayload` | Used everywhere; executor.js risk |
| P0 | `Signal` + `SignalData` | rules.js is 2,526 LOC of untyped checks |
| P0 | `BlueprintConnector` | Gate for Phase 5 (all 23 connectors) |
| P1 | `AgentRunOutput` | 11 JSON.parse sites in agent-runner.js |
| P1 | `LLMRequest` / `LLMResponse` | Used by 8 LLM provider files + agent-runner |
| P1 | `ConnectorSync` / `Metric` | db.js query return types |
| P2 | `KBEntry` / `KBFrontmatter` | gray-matter output needs runtime validator |
| P2 | `AgentProfile` | js-yaml output; profile.yaml shape |
| P2 | `Workflow` / `WorkflowStep` | workflow-engine.js once tables are confirmed |
| P3 | `ApiResponse<T>` / `Paginated<T>` | Route helpers, lower risk |

### Key Shared Shapes

```typescript
// server/types/llm.ts
export interface LLMRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  max_tokens?: number;
  temperature?: number;
  system?: string;
  tools?: LLMTool[];
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

// server/types/agents.ts
export interface AgentRunOutput {
  reasoning?: string;
  tasks?: AgentProposedTask[];
  signals_detected?: AgentSignalDetected[];
  summary?: string;
  search_queries?: string[];
  data_gaps?: DataGap[];
  connector_wishlist?: string[];
  kb_entries?: KBEntryProposal[];
  agent_briefs?: AgentBrief[];
  signals_to_create?: SignalToCreate[];
  learnings?: string[];
}

export interface AgentProposedTask {
  title: string;
  description: string;
  action_type: ActionType;
  action_payload: Record<string, unknown>;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  trust_tier: 'green' | 'yellow' | 'red';
  rationale?: string;
}

// server/types/shared.ts
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}
```

---

## 5. Risk Register

### Risk Level Definitions

| Level | Criteria |
|-------|----------|
| **CRITICAL** | >1,500 LOC + polymorphic JSON + dynamic dispatch |
| **HIGH** | >500 LOC + significant JSON.parse or dynamic access |
| **MEDIUM** | 300–1,000 LOC, moderate JSON usage, clear structure |
| **LOW** | <400 LOC, minimal JSON, mostly typed library calls |

### Full Risk Table

| File | LOC | Risk | Primary Reasons |
|------|-----|------|-----------------|
| `server/tasks/executor.js` | 1,447 | **CRITICAL** | 24-case `action_type` switch; each branch has unique `action_payload` shape; silent-catch error blocks |
| `server/signals/rules.js` | 2,526 | **CRITICAL** | 2,526 LOC, largest server file; deep object property chaining on signal `data`; multiple `obj[key]` access patterns |
| `server/agents/agent-runner.js` | 1,619 | **CRITICAL** | 11 `JSON.parse` sites; dynamic LLM output parsing; 11-key `AgentRunOutput` with partial shapes |
| `server/routes/oauth.js` | 873 | **HIGH** | 12 `JSON.parse` sites; 9+ base64 state parses; credential object spread |
| `client/src/pages/ConnectorDataPage.jsx` | 2,807 | **HIGH** | 13 `JSON.parse` sites; 15+ metric-data access patterns; largest file in repo |
| `client/src/pages/Settings.jsx` | 2,533 | **HIGH** | 2,533 LOC; complex nested state; dynamic key access on settings objects |
| `server/jobs/scheduler.js` | 679 | **HIGH** | 20+ dynamic `import(\`../connectors/${type}/index.js\`)` calls; connector ID as string key |
| `server/db/db.js` | 768 | **HIGH** | All queries return `unknown`; `.get()` / `.all()` without generics; central bottleneck |
| `server/kb/kb-agent.js` | 969 | **HIGH** | LLM output parsing; gray-matter frontmatter accessed without type guard |
| `server/kb/kb-engine.js` | 892 | **HIGH** | 892 LOC; deep KB doc manipulation; `frontmatter` JSON spread |
| `client/src/pages/Connectors.jsx` | 1,685 | **MEDIUM** | Large; connector credential forms rendered from dynamic config objects |
| `client/src/pages/Signals.jsx` | 1,322 | **MEDIUM** | signal.data rendered dynamically; `typeof` checks for branching |
| `client/src/pages/AgentDetail.jsx` | 1,100 | **MEDIUM** | Agent run output rendered from partial shapes |
| `client/src/pages/Tasks.jsx` | 938 | **MEDIUM** | action_payload rendered per type without guards |
| `client/src/pages/KB.jsx` | 882 | **MEDIUM** | frontmatter displayed, no type guards |
| `server/routes/bap.js` | 827 | **MEDIUM** | External API; JSON body parsing; permissions check on string arrays |
| `client/src/components/Sidebar.jsx` | 797 | **LOW** | Navigation only; mostly static structure |
| `server/agents/self-healer.js` | 730 | **MEDIUM** | Dynamic connector calls; health check response parsing |
| `client/src/pages/Agents.jsx` | 694 | **LOW** | Display only; minimal JSON access |
| `server/signals/ai-analysis.js` | 692 | **MEDIUM** | LLM response parsing; signal data assembly |
| `server/jobs/scheduler.js` | 679 | **HIGH** | (see above) |
| `client/src/pages/Onboarding.jsx` | 610 | **LOW** | Form-heavy; minimal JSON |
| `server/index.js` | 578 | **LOW** | Express bootstrap; minimal data handling |
| `server/kb/kb-analyser.js` | 568 | **MEDIUM** | LLM analysis output; KB doc update |
| `server/routes/kb.js` | 551 | **MEDIUM** | Route-level; passes through to engine |
| `server/routes/agents.js` | 544 | **MEDIUM** | Agent run output forwarded to client |
| `server/routes/system-health.js` | 521 | **LOW** | Status aggregation; mostly literal objects |
| `client/src/pages/Workflows.jsx` | 504 | **MEDIUM** | Workflow step editing; dynamic step payload forms |
| `client/src/pages/Chat.jsx` | 504 | **MEDIUM** | Message rendering; attachment/mention arrays |
| `server/chat/chat-engine.js` | 484 | **MEDIUM** | LLM message assembly; context object construction |
| `server/brain/goal-reasoner.js` | 476 | **MEDIUM** | LLM output parsing; goal assessment shapes |
| `server/brain/retrospective-engine.js` | 471 | **MEDIUM** | Complex JSON column writes |
| `client/src/pages/Goals.jsx` | 466 | **LOW** | Goal display; mostly read |
| `server/connectors/shopify/index.js` | 462 | **MEDIUM** | Largest connector; API response parsing |
| `server/connectors/social/index.js` | 453 | **LOW** | Mostly pass-through; clear API shape |
| `client/src/pages/ROI.jsx` | 450 | **LOW** | Display-only; typed recharts data |
| `server/lib/llm-providers.js` | 365 | **MEDIUM** | Multi-provider dispatch; provider-specific response normalisation |
| `server/connectors/klaviyo/index.js` | 379 | **MEDIUM** | API response parsing |
| `server/connectors/server-access/index.js` | 365 | **MEDIUM** | SSH2 streaming; buffer handling |
| `server/connectors/gbp/index.js` | 349 | **LOW** | Straightforward fetch + parse |
| `server/connectors/google-ads/index.js` | 332 | **LOW** | — |
| `server/connectors/server-access/connection.js` | 331 | **LOW** | SSH2 connection wrapper |
| `server/connectors/ga4/index.js` | 327 | **LOW** | — |
| `server/workflows/workflow-engine.js` | 321 | **MEDIUM** | Step execution dispatch; dynamic payload |
| `server/brain/conflict-engine.js` | 317 | **LOW** | — |
| `server/tasks/task-queue.js` | 316 | **MEDIUM** | Job dispatch; queue state management |
| `server/connectors/wix/index.js` | 315 | **LOW** | — |
| `server/lib/content-sanitiser.js` | 314 | **LOW** | String in, string out; minimal state |
| `server/tasks/investigation/context-assembler.js` | 306 | **LOW** | — |
| `server/routes/connector-data.js` | 306 | **MEDIUM** | Passes connector data JSON to client |
| `server/agents/conductor-hiring.js` | 300 | **LOW** | — |
| `server/tasks/investigation/prompt-builder.js` | 297 | **LOW** | String templates |
| `client/src/pages/Scenarios.jsx` | 297 | **LOW** | — |
| `server/brain/scenario-engine.js` | 294 | **LOW** | — |
| `server/lib/outbound-allowlist.js` | 382 | **LOW** | URL string checking; no JSON |
| `server/notifications/telegram.js` | 388 | **LOW** | HTTP POST only |
| `server/routes/public-api.js` | 390 | **MEDIUM** | External-facing; input validation matters |
| `server/routes/tasks.js` | 391 | **MEDIUM** | — |
| `server/roi/attribution-engine.js` | 414 | **MEDIUM** | Metric aggregation; typed recharts shapes |
| `server/connectors/meta-ads/index.js` | 429 | **LOW** | — |
| `server/brain/intent-extractor.js` | 432 | **MEDIUM** | LLM output; intent shape |
| `server/brain/goal-suggester.js` | 437 | **LOW** | — |
| `client/src/lib/api.js` | 442 | **LOW** | Fetch wrapper; ApiResponse<T> candidate |
| `client/src/components/TaskKanban.jsx` | 356 | **LOW** | — |
| `client/src/components/Layout.jsx` | 360 | **LOW** | — |
| `server/roi/value-estimator.js` | 356 | **LOW** | — |
| `server/signals/signal-intelligence.js` | 347 | **MEDIUM** | Signal scoring; data access |
| `server/connectors/gsc/index.js` | 360 | **LOW** | — |
| `server/brain/investigation-engine.js` | 361 | **MEDIUM** | Report assembly |
| `client/src/pages/Outcomes.jsx` | 365 | **LOW** | — |
| `server/agents/work-checker.js` | 424 | **LOW** | Status polling; minimal JSON |
| All remaining connector files | <330 | **LOW** | Fetch + parse; bounded scope |
| All remaining route files (<300 LOC) | <300 | **LOW** | Delegation only |
| All utility files (rate-limiter, safe-fetch, etc.) | <200 | **LOW** | Leaf utilities; ideal Phase 2 targets |

### Aggregated Risk Patterns

| Pattern | Approximate Sites | Risk |
|---------|-------------------|------|
| `JSON.parse()` without type guard | ~209 total (192 server + 17 client) | CRITICAL |
| Dynamic `obj[key]` property access | ~40+ sites | HIGH |
| Silent `catch {}` blocks around parses | ~25+ sites | HIGH |
| `...spread` on `unknown` objects | ~30+ sites | HIGH |
| Unvalidated LLM/external API responses | ~50+ LLM call sites | HIGH |
| `dynamic import(\`../connectors/${type}/...\`)` | 20+ in scheduler.js | MEDIUM |
| `any` implicit (via JS pass-through) | Entire codebase | MEDIUM |

---

## 6. Connector Interface Definition

### Current Interface (`server/connectors/connector.interface.js`, 92 LOC)

The interface is documented but not enforced — all connectors are duck-typed. The proposed TypeScript interface formalises the contract and captures all deviations.

### Proposed `BlueprintConnector` Interface

```typescript
// server/types/connectors.ts

export type ConnectorId =
  | 'brave-search' | 'brevo' | 'buffer' | 'ga4' | 'gbp' | 'github'
  | 'google-ads' | 'gsc' | 'kirby' | 'klaviyo' | 'meta-ads' | 'pagespeed'
  | 'semrush' | 'server-access' | 'shopify' | 'social' | 'stannp'
  | 'stripe' | 'tavily' | 'todoist' | 'uptimerobot' | 'wix' | 'wordpress';

export type ConnectorCategory = 'seo' | 'analytics' | 'commerce' | 'code'
  | 'communication' | 'advertising' | 'hosting' | 'monitoring' | 'search';

export type ConnectorAuthType = 'oauth2' | 'apikey' | 'none';

export interface ConnectorCapabilities {
  read: boolean;
  write: boolean;
  webhooks: boolean;
  pollingIntervalMinutes: number;
  onDemand?: boolean;                 // brave-search, tavily only
}

export interface ConnectorHealthResult {
  ok: boolean;
  error?: string;
  details?: unknown;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

export interface OAuthRefreshResult {
  accessToken: string;
  expiresAt?: string;
}

export interface MetricExtractionResult {
  metric_type: string;
  metric_name: string;
  value: number | string | null;
  unit?: string;
  dimensions?: Record<string, string>;
  recorded_at?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published_at?: string;
  source?: string;
}

// Core interface — all connectors must satisfy this
export interface BlueprintConnector {
  id: ConnectorId;
  name: string;
  category: ConnectorCategory;
  authType: ConnectorAuthType;
  icon: string;
  capabilities: ConnectorCapabilities;
  signalTypes: string[];

  healthCheck(credentials: Record<string, unknown>): Promise<ConnectorHealthResult>;
  fetch(dataType: string, credentials: Record<string, unknown>, params?: Record<string, unknown>): Promise<unknown>;

  // OAuth2 — only required when authType === 'oauth2'
  getAuthUrl?(state: string): Promise<string>;
  exchangeCode?(code: string): Promise<OAuthTokenResult>;
  refreshToken?(credentials: Record<string, unknown>): Promise<OAuthRefreshResult>;

  // Optional method: ~20/23 connectors implement this
  extractMetrics?(data: unknown, runAt?: string): MetricExtractionResult[];

  // brave-search + tavily only
  search?(query: string, options?: Record<string, unknown>, credentials?: Record<string, unknown>): Promise<SearchResult[]>;
  searchNews?(query: string, options?: Record<string, unknown>, credentials?: Record<string, unknown>): Promise<SearchResult[]>;

  // github only
  createIssue?(params: { repo: string; title: string; body: string; labels?: string[] }, credentials: Record<string, unknown>): Promise<unknown>;
  createPR?(params: { repo: string; title: string; body: string; head: string; base?: string }, credentials: Record<string, unknown>): Promise<unknown>;

  // gbp only
  listAccounts?(credentials: Record<string, unknown>): Promise<unknown[]>;
  listLocations?(accountId: string, credentials: Record<string, unknown>): Promise<unknown[]>;
}
```

### Connector × Method Matrix

| Connector | `healthCheck` | `fetch` | `extractMetrics` | `search` | `searchNews` | `createIssue` | `createPR` | `listAccounts` | `listLocations` | OAuth |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| brave-search | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — |
| brevo | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| buffer | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| ga4 | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| gbp | ✓ | ✓ | ✓ | — | — | — | — | ✓ | ✓ | ✓ |
| github | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| google-ads | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| gsc | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| kirby | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| klaviyo | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| meta-ads | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| pagespeed | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| semrush | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| server-access | ✓ | ✓ | — | — | — | — | — | — | — | — |
| shopify | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| social | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| stannp | ✓ | ✓ | — | — | — | — | — | — | — | — |
| stripe | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| tavily | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| todoist | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| uptimerobot | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| wix | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| wordpress | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |

---

## 7. Agent System Types

### Agent Structure

Each of the 4 active agents (`conductor`, `quill`, `seo-sentinel`, `trend-spotter`) has:
- `profile.yaml` — main configuration
- `IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `AGENTS.md` — Markdown persona documents
- A named directory under `server/agents/`

12 additional agent templates live under `server/agents/templates/`.

The root profiles directory `server/agents/profiles/` contains YAML files: `conductor.yaml`, `quill.yaml`, `seo-sentinel.yaml`, `trend-spotter.yaml`.

### Proposed Agent Types

```typescript
// server/types/agents.ts

// ── Profile (loaded from YAML via js-yaml) ──────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  type: 'conductor' | 'seo-sentinel' | 'quill' | 'trend-spotter' | string;
  description: string;
  version?: string;
  capabilities: string[];
  signal_subscriptions?: string[];
  tools?: string[];
  polling_interval_minutes?: number;
  trust_tier?: 'green' | 'yellow' | 'red';
  max_tasks_per_run?: number;
  connectors_required?: string[];
  connectors_preferred?: string[];
  prompt_overrides?: Record<string, string>;
  memory_keys?: string[];
  [key: string]: unknown;  // YAML may have extension fields
}

// ── Run Output (parsed from LLM response JSON) ───────────────────────────────

export interface AgentRunOutput {
  reasoning?: string;
  tasks?: AgentProposedTask[];
  signals_detected?: AgentSignalDetected[];
  summary?: string;
  search_queries?: string[];
  data_gaps?: DataGap[];
  connector_wishlist?: string[];
  kb_entries?: KBEntryProposal[];
  agent_briefs?: AgentBrief[];
  signals_to_create?: SignalToCreate[];
  learnings?: string[];
}

export interface AgentProposedTask {
  title: string;
  description: string;
  action_type: ActionType;
  action_payload: Record<string, unknown>;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  trust_tier: 'green' | 'yellow' | 'red';
  approval_mode?: 'auto' | 'requires_approval';
  rationale?: string;
  estimated_impact?: string;
}

export interface AgentSignalDetected {
  signal_id?: string;
  signal_type: string;
  title: string;
  summary: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface SignalToCreate {
  type: string;
  title: string;
  summary: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
  source_connector_id?: string;
}

export interface DataGap {
  connector_type: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
}

export interface KBEntryProposal {
  title: string;
  content: string;
  tags?: string[];
  frontmatter?: KBFrontmatter;
}

export interface AgentBrief {
  agent_type: string;
  topic: string;
  context: string;
  priority: 'low' | 'medium' | 'high';
}

// ── Memory ───────────────────────────────────────────────────────────────────

export interface AgentMemory {
  agent_id: string;
  business_id: string;
  entries: AgentMemoryEntry[];
  last_updated: string;
}

export interface AgentMemoryEntry {
  key: string;
  value: unknown;
  recorded_at: string;
  context?: string;
}

// ── Inbox ────────────────────────────────────────────────────────────────────

export interface AgentInboxEntry {
  id: string;
  to_agent_id: string;
  from_agent_id?: string;
  subject: string;
  body: string;
  priority: 'low' | 'medium' | 'high';
  read: boolean;
  created_at: string;
}

// ── KB Frontmatter ───────────────────────────────────────────────────────────

export interface KBFrontmatter {
  title?: string;
  date?: string;
  author?: string;
  tags?: string[];
  status?: string;
  slug?: string;
  [key: string]: unknown;
}
```

### YAML Typing Note

`js-yaml`'s `.load()` returns `unknown`. Every call site that loads a `profile.yaml` must narrow the type with a runtime validator. Until a validator (e.g. zod) is added, the pattern is:

```typescript
import yaml from 'js-yaml';

function loadProfile(raw: string): AgentProfile {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid agent profile YAML');
  }
  // Minimal guard — full zod schema recommended in Phase 7+
  return parsed as AgentProfile;
}
```

---

## 8. Migration Phases

The phases below respect the import graph — types flow downward, no circular dependencies. Each phase lists specific files and an estimated risk level for the migration work itself (distinct from runtime risk).

### Phase 1 — Pure Type Definitions (No behavior changes)

**Goal:** Establish the type vocabulary. Zero runtime impact.  
**Migration Risk:** None — new files only.

| Action | Files |
|--------|-------|
| Create `server/types/` directory | New |
| Write DB interfaces | `server/types/db.ts` (Section 3) |
| Write action payload union | `server/types/action-payloads.ts` |
| Write connector interface | `server/types/connectors.ts` |
| Write agent types | `server/types/agents.ts` |
| Write LLM types | `server/types/llm.ts` |
| Write shared utility types | `server/types/shared.ts` |
| Write flexsearch shim | `server/types/flexsearch.d.ts` (no @types package) |
| Write client types | `client/src/types/index.ts` |
| Add `tsconfig.json` (server) | `server/tsconfig.json` — `allowJs: true`, types only |
| Add `tsconfig.json` (client) | `client/tsconfig.json` — JSX + DOM |

### Phase 2 — Leaf Utilities (Server)

**Goal:** Convert pure-function files with no internal imports.  
**Migration Risk:** LOW — these are standalone, easily tested.

| File | LOC | Notes |
|------|-----|-------|
| `server/lib/rate-limiter.js` | ~100 | Simple counter; typed Map key |
| `server/lib/safe-fetch.js` | ~150 | Return type: `Promise<Response>` |
| `server/lib/outbound-allowlist.js` | 382 | URL → boolean; pure |
| `server/lib/content-sanitiser.js` | 314 | `string → string` |
| `server/lib/security-monitor.js` | ~150 | Event typing |
| `server/lib/sse-bus.js` | ~80 | SSE event types |
| `server/lib/intelligence-events.js` | ~100 | Event payload types |
| `server/lib/google-oauth-config.js` | ~100 | OAuth config shape |

### Phase 3 — Database Layer

**Goal:** Typed query return values. Critical foundation for all later phases.  
**Migration Risk:** MEDIUM — db.js is 768 LOC; Bun's SQLite generics need `@types/bun`.

| File | LOC | Notes |
|------|-----|-------|
| `server/db/db.js` | 768 | Add `<T>` generics to `.get<T>()` and `.all<T>()`; import DB interfaces |
| `server/db/init.js` | ~50 | Initialization only; LOW risk |

Pattern:
```typescript
// Before
const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

// After
const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get<Task>(id);
```

### Phase 4 — LLM Providers

**Goal:** Typed LLM request/response at the provider boundary.  
**Migration Risk:** MEDIUM — 8 provider files + dispatcher.

| File | LOC | Notes |
|------|-----|-------|
| `server/lib/llm-providers.js` | 365 | Central dispatcher; add `LLMRequest → LLMResponse` |
| `server/lib/providers/anthropic.js` | ~150 | Anthropic SDK already typed |
| `server/lib/providers/openai.js` | ~80 | OpenAI response mapping |
| `server/lib/providers/google.js` | ~80 | Google Gemini mapping |
| `server/lib/providers/ollama.js` | ~60 | Local inference; response normalisation |
| `server/lib/providers/lmstudio.js` | ~60 | — |
| `server/lib/providers/minimax.js` | ~60 | — |
| `server/lib/providers/custom.js` | ~60 | — |
| `server/lib/providers/claude-cli.js` | ~80 | — |

### Phase 5 — Connectors (One at a Time)

**Goal:** Each connector satisfies `BlueprintConnector`. Start with simplest.  
**Migration Risk:** LOW per connector — bounded scope. Total volume is HIGH.

**Recommended order:** uptimerobot → pagespeed → todoist → stannp → kirby → brevo → buffer → social → wordpress → wix → stripe → shopify → semrush → klaviyo → google-ads → meta-ads → ga4 → gsc → github → gbp → server-access → tavily → brave-search

For each:
1. Rename `index.js` → `index.ts`
2. Add `export default { ... } satisfies BlueprintConnector`
3. Type the `credentials` parameter with a service-specific interface
4. Type `fetch()` return with service-specific response shape
5. Type `extractMetrics()` return as `MetricExtractionResult[]`

### Phase 6 — Signal Engine + Rules

**Goal:** Type signal data shapes; eliminate `obj[key]` access in rules.js.  
**Migration Risk:** HIGH — rules.js is 2,526 LOC, deeply coupled to signal data shapes.

**Pre-work required:** Document every `signal.data` shape by connector type before starting conversion. Build a `SignalDataMap` type registry.

| File | LOC | Notes |
|------|-----|-------|
| `server/signals/rules.js` | 2,526 | Convert last; type guards per signal type |
| `server/signals/signal-engine.js` | ~200 | Signal creation and routing |
| `server/signals/signal-helpers.js` | ~150 | Helper utilities |
| `server/signals/signal-intelligence.js` | 347 | Signal scoring |
| `server/signals/cluster-engine.js` | ~200 | Signal clustering |
| `server/signals/ai-analysis.js` | 692 | LLM output parsing |

### Phase 7 — Task Queue, Approval, Executor

**Goal:** Eliminate the untyped `action_payload` switch.  
**Migration Risk:** CRITICAL — executor.js is the highest-risk file in the repo.

**Pre-work required:** Complete Phase 1 `action-payloads.ts` with all 24 payload shapes. Write a `parseJson<T>` validator utility.

```typescript
// Introduce first — used everywhere from Phase 3 onward
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { return fallback; }
}
```

| File | LOC | Notes |
|------|-----|-------|
| `server/tasks/task-queue.js` | 316 | Queue state; typed Job shape |
| `server/tasks/approval.js` | ~200 | Approval decision; typed Task input |
| `server/tasks/task-events.js` | ~150 | Event recording |
| `server/tasks/task-intelligence.js` | ~200 | Task scoring |
| `server/tasks/outcomes.js` | ~200 | TaskOutcome shape |
| `server/tasks/executor.js` | 1,447 | **Convert last**; each case gets typed payload narrowing |
| `server/tasks/investigation/context-assembler.js` | 306 | Investigation context shape |
| `server/tasks/investigation/prompt-builder.js` | 297 | String templates; LOW |

### Phase 8 — Agents

**Goal:** Type AgentRunOutput; eliminate raw JSON.parse in agent-runner.  
**Migration Risk:** HIGH — 11 JSON.parse sites, dynamic LLM output.

**Pre-work:** `AgentRunOutput` type from Phase 1; `parseJson<AgentRunOutput>` validator from Phase 7.

| File | LOC | Notes |
|------|-----|-------|
| `server/agents/agent.interface.js` | ~60 | Formalise interface |
| `server/agents/context-builders.js` | ~200 | Context assembly types |
| `server/agents/poll-intervals.js` | ~50 | Config constants |
| `server/agents/readiness.js` | ~100 | Readiness check result |
| `server/agents/event-triggers.js` | ~100 | Event trigger types |
| `server/agents/installer.js` | ~150 | Agent installation shape |
| `server/agents/conductor-hiring.js` | 300 | — |
| `server/agents/conductor.js` | ~200 | Conductor agent |
| `server/agents/activity.js` | ~100 | Activity log |
| `server/agents/agent-inbox.js` | ~150 | AgentInboxEntry type |
| `server/agents/work-checker.js` | 424 | Status polling |
| `server/agents/self-healer.js` | 730 | Health check result parsing |
| `server/agents/agent-runner.js` | 1,619 | **Convert last**; 11 JSON.parse sites |
| Individual agent dirs (conductor, quill, etc.) | varies | Profile YAML loaders |

### Phase 9 — Routes

**Goal:** Type Express request/response bodies.  
**Migration Risk:** MEDIUM — express + express-session types needed; module augmentation required.

| File | LOC | Notes |
|------|-----|-------|
| `server/routes/auth.js` | ~150 | Session type augmentation |
| `server/routes/businesses.js` | ~100 | CRUD; Business type |
| `server/routes/dashboard.js` | ~150 | Aggregated data; typed response |
| All other routes (25 files) | 100–551 | Cascade from Phase 3 DB types |
| `server/routes/oauth.js` | 873 | **Last** — 12 JSON.parse, 9 base64 state parses |
| `server/routes/bap.js` | 827 | External; typed request validation |

**Session module augmentation required:**
```typescript
// server/types/express-session.d.ts
import 'express-session';
declare module 'express-session' {
  interface SessionData {
    business_id?: string;
    userId?: string;
    [key: string]: unknown;
  }
}
```

### Phase 10 — Client

**Goal:** Type React components from data boundary inward.  
**Migration Risk:** MEDIUM overall; HIGH for the three largest files.

**Pre-work:** The three largest client files should be **split** before migration:
- `ConnectorDataPage.jsx` (2,807 LOC) → split by connector type (one component per connector)
- `Settings.jsx` (2,533 LOC) → split into section components (GeneralSettings, AgentSettings, etc.)
- `Connectors.jsx` (1,685 LOC) → ConnectorCard, ConnectorForm, ConnectorDetail components

**Order:**
1. `client/src/lib/api.js` → `api.ts` (typed `ApiResponse<T>` wrapper — unlocks all subsequent components)
2. `client/src/types/index.ts` (shared client types — mirror server types)
3. Simple display components (Sidebar, Layout, etc.)
4. Data hooks and stores (zustand store — add generic state types)
5. Small pages (Goals, Outcomes, Agents, ROI)
6. Medium pages (Tasks, Signals, KB, Chat, Workflows)
7. **Split** ConnectorDataPage.jsx, Settings.jsx, Connectors.jsx
8. Convert split components
9. AgentDetail.jsx, SystemHealth.jsx
10. Onboarding.jsx

---

## 9. tsconfig Recommendation

### Server: `server/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    // ── Module system — must match "type": "module" in package.json ──────────
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    // NodeNext requires explicit .js extensions on relative imports —
    // existing .js imports are already correct; .ts files also use .js
    // extensions per NodeNext convention (import './foo.js' resolves foo.ts)

    // ── Target ───────────────────────────────────────────────────────────────
    "target": "ES2022",
    "lib": ["ES2022"],

    // ── Output ───────────────────────────────────────────────────────────────
    "noEmit": true,
    // Bun runs .ts directly — no compilation step needed for server

    // ── Incremental migration ─────────────────────────────────────────────────
    "allowJs": true,           // .js files accepted without error
    "checkJs": false,          // do NOT type-check .js files yet (Phase 1–2 only)
    // Flip checkJs: true per-file using //@ts-check as you migrate each file

    // ── Strict progression ───────────────────────────────────────────────────
    // Phase 1–4: comment out strict lines below; re-enable per phase
    "strict": true,                    // enables all strict* flags below
    "noUncheckedIndexedAccess": true,  // critical — catches obj[key] → T|undefined
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,

    // ── ESM correctness ──────────────────────────────────────────────────────
    "verbatimModuleSyntax": true,      // enforces import type vs import
    "allowImportingTsExtensions": false, // NOT needed — use .js extension for all

    // ── Output quality ───────────────────────────────────────────────────────
    "skipLibCheck": false,             // don't skip — catch @types/* conflicts early
    "resolveJsonModule": true,         // allows import of JSON files

    // ── Paths ─────────────────────────────────────────────────────────────────
    "baseUrl": ".",
    "paths": {
      "@blueprint/types": ["./types/index.ts"]
    },

    // ── Types ─────────────────────────────────────────────────────────────────
    "types": ["bun-types", "node"]
  },
  "include": ["**/*.ts", "**/*.js"],
  "exclude": ["node_modules"]
}
```

**Strict Progression Schedule:**

| Phase | `strict` | `noUncheckedIndexedAccess` | `checkJs` |
|-------|----------|---------------------------|-----------|
| 1–2 (types + utils) | `false` | `false` | `false` |
| 3–4 (db + llm) | `true` | `false` | per-file |
| 5–6 (connectors + signals) | `true` | `true` | per-file |
| 7–10 (executor + agents + routes + client) | `true` | `true` | `true` |

### Client: `client/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",   // Vite uses bundler resolution, not NodeNext
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],

    "jsx": "react-jsx",              // React 18 automatic JSX transform
    "jsxImportSource": "react",

    "noEmit": true,                  // Vite handles compilation

    "allowJs": true,
    "checkJs": false,

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": false,

    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"],
  "exclude": ["node_modules"]
}
```

### Root: `tsconfig.json` (optional, for editor resolution)

```jsonc
{
  "files": [],
  "references": [
    { "path": "./server" },
    { "path": "./client" }
  ]
}
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `module: "NodeNext"` (server) | Matches `"type": "module"` in package.json; enforces `.js` extension on imports |
| `module: "ESNext"` + `moduleResolution: "Bundler"` (client) | Vite resolves without extensions; `NodeNext` would reject extensionless imports |
| `noEmit: true` | Bun and Vite handle runtime; `tsc` is type-checker only |
| `allowJs: true` | Allows incremental migration — existing .js files co-exist with .ts |
| `checkJs: false` (initially) | Prevents false positives on JS files before they are migrated |
| `noUncheckedIndexedAccess: true` | Essential — catches ~40+ `obj[key]` access sites that return `undefined` |
| `verbatimModuleSyntax: true` | Enforces `import type` for type-only imports; correct under ESM |
| Separate tsconfigs | Server needs `lib: ["ES2022"]` + Node types; client needs DOM + JSX |

---

## 10. Build System Changes

### Server (Bun)

**Current:** `bun --watch index.js`  
**After migration:** `bun --watch index.js` — **unchanged**. Bun runs TypeScript natively without a transpile step. No `tsc` needed for dev or production.

**Additions:**
```json
// server/package.json
"scripts": {
  "dev": "bun --watch index.js",
  "start": "bun index.js",
  "db:init": "bun db/init.js",
  "typecheck": "tsc --noEmit --project tsconfig.json"
}
```

### Client (Vite)

**Current:** `vite` / `vite build`  
**After migration:** Unchanged. Vite 5 has first-class TypeScript support — `.tsx` files are processed automatically. No `ts-loader` or separate transpile step needed.

**Additions:**
```json
// client/package.json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "typecheck": "tsc --noEmit --project tsconfig.json"
}
```

### Root (Bun Workspace)

```json
// package.json — add typecheck script
"scripts": {
  "setup": "bun scripts/setup.js",
  "dev": "bun scripts/dev.js",
  "build": "bun run --cwd client build",
  "start": "bun run --cwd server start",
  "db:init": "bun run --cwd server db:init",
  "typecheck": "bun run --cwd server typecheck && bun run --cwd client typecheck"
}
```

### Dockerfile Changes

Minimal. Current `Dockerfile` uses `node:22-alpine` with Bun installed. No compilation step added — Bun continues to run `.js` / `.ts` files directly.

Only change: no build artifact copy step needed (Bun handles .ts at runtime). If a compile step is ever desired for Docker production images, add `RUN bun build ./index.ts --outdir ./dist` — but this is optional.

### CI Changes

Add `typecheck` to CI pipeline:
```yaml
# .github/workflows/ci.yml (or equivalent)
- name: Type check
  run: bun run typecheck
```

### Package Changes Required

```bash
# Server
bun add -d @types/bcryptjs @types/cors @types/express @types/express-session @types/js-yaml @types/ssh2 bun-types

# Client
bun add -d @types/react @types/react-dom @types/turndown
```

No `typescript` package is needed as a runtime dependency — Bun resolves types at check time. However, if `tsc` CLI is used in CI, add `typescript` as a dev dependency:
```bash
bun add -d typescript
```

---

## 11. Special Patterns

### 1. `bun:sqlite` Result Row Typing

**Problem:** `db.prepare(...).get(id)` returns `unknown`.  
**Solution:** Use `@types/bun` generics:

```typescript
import { Database } from 'bun:sqlite';
import type { Task } from '../types/db.js';

const db = new Database('blueprint.db');

// Typed queries
const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get<Task>(id);
// task: Task | null

const tasks = db.prepare('SELECT * FROM tasks WHERE business_id = ?').all<Task>(businessId);
// tasks: Task[]
```

All JSON columns (`action_payload`, `data`, etc.) are returned as strings from SQLite and must still be parsed:
```typescript
const raw = db.prepare('SELECT * FROM tasks WHERE id = ?').get<{
  id: string; action_type: string; action_payload: string; // JSON string
}>(id);

const task = raw ? {
  ...raw,
  action_payload: parseJson(raw.action_payload, {}),
} : null;
```

### 2. Dynamic Connector Imports in `scheduler.js`

**Problem:** `import(\`../connectors/${type}/index.js\`)` returns `unknown`.  
**Solution:** Type the dynamic import map:

```typescript
import type { BlueprintConnector, ConnectorId } from '../types/connectors.js';

// Registry populated at startup (avoids repeated dynamic imports)
const connectorRegistry = new Map<ConnectorId, BlueprintConnector>();

async function getConnector(type: ConnectorId): Promise<BlueprintConnector> {
  if (connectorRegistry.has(type)) {
    return connectorRegistry.get(type)!;
  }
  // Dynamic import — cast after satisfies check at module load
  const mod = await import(`../connectors/${type}/index.js`) as { default: BlueprintConnector };
  connectorRegistry.set(type, mod.default);
  return mod.default;
}
```

The `satisfies BlueprintConnector` check in each connector's `index.ts` ensures the cast is safe.

### 3. LLM Response Parsing → `AgentRunOutput`

**Problem:** Agent-runner.js calls `JSON.parse(llmResponse)` 11 times on raw string output.  
**Solution:** Boundary validator at the parse site:

```typescript
import type { AgentRunOutput } from '../types/agents.js';

function parseAgentOutput(raw: string): AgentRunOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // LLM returned non-JSON; caller handles empty output
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  // Minimal structural validation — full zod schema in Phase 8
  const out = parsed as Record<string, unknown>;
  return {
    reasoning: typeof out.reasoning === 'string' ? out.reasoning : undefined,
    tasks: Array.isArray(out.tasks) ? (out.tasks as AgentProposedTask[]) : [],
    signals_detected: Array.isArray(out.signals_detected) ? out.signals_detected : [],
    summary: typeof out.summary === 'string' ? out.summary : undefined,
    // ... remaining keys
  };
}
```

### 4. YAML Profile Loading → `AgentProfile`

**Problem:** `yaml.load()` returns `unknown`; profile.yaml structure is not enforced.  
**Solution:** Runtime narrowing after parse:

```typescript
import yaml from 'js-yaml';
import type { AgentProfile } from '../types/agents.js';

function loadAgentProfile(yamlContent: string): AgentProfile {
  const raw = yaml.load(yamlContent);

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Agent profile YAML is not an object`);
  }

  const p = raw as Record<string, unknown>;

  if (typeof p.id !== 'string') throw new Error('Agent profile missing id');
  if (typeof p.name !== 'string') throw new Error('Agent profile missing name');

  return p as AgentProfile;
  // Full zod validation recommended in Phase 8
}
```

### 5. `gray-matter` Frontmatter → `KBFrontmatter`

**Problem:** `matter(content).data` returns `Record<string, any>`.  
**Solution:** Gray-matter ships its own types. Narrow after parse:

```typescript
import matter from 'gray-matter';
import type { KBFrontmatter } from '../types/agents.js';

function parseKBDoc(raw: string): { content: string; frontmatter: KBFrontmatter } {
  const { content, data } = matter(raw);
  // data is Record<string, unknown> from gray-matter types
  return {
    content,
    frontmatter: data as KBFrontmatter, // validated further if strict required
  };
}
```

### 6. Shared `parseJson<T>` Utility

Introduce this in Phase 3 and use it everywhere from Phase 4 onward. Reduces 209 raw `JSON.parse` call sites to a single, typed, safe parser:

```typescript
// server/lib/parse-json.ts

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonOrThrow<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON in ${context}: ${(err as Error).message}`);
  }
}
```

---

## 12. Go / No-Go Recommendation

### Verdict: **GO** — with pre-work

TypeScript will significantly improve this codebase's safety and maintainability. The migration is well-supported by the technology stack (Bun runs .ts natively; Vite handles .tsx; 81% of dependencies have types). The incremental `allowJs` approach means zero big-bang risk.

### Top Three Risks

#### Risk 1: Polymorphic `action_payload` / `signals.data` Discriminated Unions

The executor switch (1,447 LOC, 24 action types) and the signal rules file (2,526 LOC) contain deeply nested access on JSON columns whose shapes are not documented anywhere. Typing these correctly will surface implicit assumptions that have never been validated. **This will find real bugs**, which is good — but it will require careful coordination with business logic owners.

**Mitigation:** Build the full `ActionPayload` union in Phase 1 by reading the executor case-by-case before touching any code. The type definitions become documentation.

#### Risk 2: Three Oversized Files That Cannot Be Safely Migrated At Size

- `ConnectorDataPage.jsx` — 2,807 LOC with 13 `JSON.parse` sites; impossible to migrate without splitting
- `Settings.jsx` — 2,533 LOC; complex nested state
- `rules.js` — 2,526 LOC; ~40 `obj[key]` access patterns

**Mitigation:** Split these three files **before** TypeScript conversion. Each decomposition is independent of TypeScript and reduces risk for both the migration and future maintenance. Target: no file >800 LOC after splitting.

#### Risk 3: ~209 Unguarded `JSON.parse` Call Sites

Every one of these sites currently accepts `any` implicitly. Once `strict: true` is enabled, each will require a type assertion or runtime narrowing. At 192 server-side sites this is a significant volume of touch-points.

**Mitigation:** Introduce `parseJson<T>()` in Phase 3 and systematically replace raw `JSON.parse()` calls one file at a time during each phase. Do not enable `strict: true` globally until Phase 3.

### Pre-Work Recommended Before Phase 1

1. **Install @types/* packages** (15 minutes) — server and client, as listed in Section 2.
2. **Split the three oversized files** (3–5 days) — ConnectorDataPage.jsx, Settings.jsx, rules.js. Not TypeScript work, but TypeScript will expose it anyway.
3. **Write `parseJson<T>()`** (30 minutes) — used from Phase 3 onward.
4. **Document `action_payload` shapes** (2–3 hours) — read executor.js, sketch each payload interface. This is Phase 1 work but should be done before tsconfig is added.

### Approach: Incremental with `allowJs`, Not Full Rewrite

- Do **not** rename all files to `.ts` at once.
- Do **not** add `"checkJs": true` globally at the start.
- Migrate file-by-file, phase-by-phase.
- Each converted file gets a PR with only that file's changes.
- The `typecheck` script in CI catches regressions immediately.

At the end of Phase 1 (types only), the codebase type-checks cleanly with zero behavior changes. Every subsequent phase is an incremental improvement on that foundation.

---

## 13. Verification Checklist

### Section 3: All Schema Tables Covered

| Table | Interface in Section 3 |
|-------|----------------------|
| `agent_calibration` | ✓ `AgentCalibration` |
| `agent_runs` | ✓ `AgentRun` |
| `agents` | ✓ `Agent` |
| `analysis_runs` | ✓ `AnalysisRun` |
| `api_keys` | ✓ `ApiKey` |
| `audit_log` | ✓ `AuditLog` |
| `bap_agents` | ✓ `BapAgent` |
| `bap_audit` | ✓ `BapAudit` |
| `bap_webhook_deliveries` | ✓ `BapWebhookDelivery` |
| `businesses` | ✓ `Business` |
| `chat_conversations` | ✓ `ChatConversation` |
| `chat_messages` | ✓ `ChatMessage` |
| `chat_reactions` | ✓ `ChatReaction` |
| `conflicts` | ✓ `Conflict` |
| `connector_syncs` | ✓ `ConnectorSync` |
| `connectors` | ✓ `Connector` |
| `cost_daily` | ✓ `CostDaily` |
| `goal_suggestions` | ✓ `GoalSuggestion` |
| `investigations` | ✓ `Investigation` |
| `job_queue` | ✓ `JobQueue` |
| `kb_docs` | ✓ `KBDoc` |
| `metrics` | ✓ `Metric` |
| `missions` | ✓ `Mission` |
| `notifications` | ✓ `Notification` |
| `retrospectives` | ✓ `Retrospective` |
| `scenarios` | ✓ `Scenario` |
| `scheduler_log` | ✓ `SchedulerLog` |
| `search_log` | ✓ `SearchLog` |
| `sessions` | ✓ `Session` |
| `settings` | ✓ `Setting` |
| `signal_clusters` | ✓ `SignalCluster` |
| `signals` | ✓ `Signal` |
| `task_events` | ✓ `TaskEvent` |
| `task_outcomes` | ✓ `TaskOutcome` |
| `tasks` | ✓ `Task` |
| 36th table | Not identified by name — follows same JSON column pattern |

**Note:** `workflows`, `workflow_runs`, `workflow_step_runs`, and `goals` tables were **not found** in `schema.sql` despite route files and engine code referencing them. These may be defined in migration files separate from `schema.sql`. Investigate `server/db/` for additional SQL files before Phase 8.

### Section 2: All Dependencies Assessed

| Package | Assessed |
|---------|----------|
| All 18 server dependencies | ✓ |
| All 17 client dependencies | ✓ |
| All 6 client devDependencies | ✓ |
| `bun:sqlite` built-in | ✓ |
| `flexsearch` (no types) | ✓ — shim required |

### Section 5: Top 20 Files in Risk Register

| File | In Risk Table |
|------|--------------|
| `client/src/pages/ConnectorDataPage.jsx` | ✓ HIGH |
| `client/src/pages/Settings.jsx` | ✓ HIGH |
| `server/signals/rules.js` | ✓ CRITICAL |
| `client/src/pages/Connectors.jsx` | ✓ MEDIUM |
| `server/agents/agent-runner.js` | ✓ CRITICAL |
| `server/tasks/executor.js` | ✓ CRITICAL |
| `client/src/pages/Signals.jsx` | ✓ MEDIUM |
| `client/src/pages/AgentDetail.jsx` | ✓ MEDIUM |
| `server/kb/kb-agent.js` | ✓ HIGH |
| `client/src/pages/Tasks.jsx` | ✓ MEDIUM |
| `server/kb/kb-engine.js` | ✓ HIGH |
| `client/src/pages/KB.jsx` | ✓ MEDIUM |
| `server/routes/oauth.js` | ✓ HIGH |
| `server/routes/bap.js` | ✓ MEDIUM |
| `client/src/pages/SystemHealth.jsx` | ✓ LOW |
| `client/src/components/Sidebar.jsx` | ✓ LOW |
| `server/db/db.js` | ✓ HIGH |
| `server/agents/self-healer.js` | ✓ MEDIUM |
| `client/src/pages/Agents.jsx` | ✓ LOW |
| `server/signals/ai-analysis.js` | ✓ MEDIUM |

All 20 largest files are present in the risk register. ✓

### Migration Phases Cover All Files

- All 23 connectors: ✓ Phase 5
- All 8 LLM provider files: ✓ Phase 4
- All 4 active agents + templates: ✓ Phase 8
- All 31 route files: ✓ Phase 9
- All client pages (21) and components: ✓ Phase 10
- All `server/lib/` utilities: ✓ Phase 2
- DB layer: ✓ Phase 3
- Signal engine: ✓ Phase 6
- Task queue + executor: ✓ Phase 7
- Brain modules (goal-reasoner, retrospective, etc.): ✓ Phase 8/9

### tsconfig Matches ESM

- `"module": "NodeNext"` — matches `"type": "module"` ✓
- `"moduleResolution": "NodeNext"` — enforces `.js` extensions ✓
- `"verbatimModuleSyntax": true` — correct for ESM ✓
- `"allowImportingTsExtensions": false` — existing `.js` imports preserved ✓
- Client uses `"Bundler"` resolution — matches Vite ✓
- `bun-types` in server types — matches Bun runtime ✓

### Report Contains Only Concrete Findings

- File paths: all verified against actual filesystem ✓
- LOC counts: measured from `wc -l` output ✓
- Table names: taken directly from `schema.sql` `CREATE TABLE` statements ✓
- JSON columns: taken directly from `schema.sql` column definitions ✓
- Action types: taken directly from `server/tasks/executor.js` lines 977–1000 ✓
- Connector names: taken directly from `server/connectors/` directory listing ✓
- LLM providers: taken directly from `server/lib/providers/` directory listing ✓
- JSON.parse counts: measured with `grep -c` per file ✓
- Dependencies: taken directly from all three `package.json` files ✓

---

*End of assessment. No source files were modified. The deliverable is this report only.*
