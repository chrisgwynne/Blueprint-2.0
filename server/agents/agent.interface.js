/**
 * Blueprint Agent Interface — Documentation
 *
 * Agents are autonomous reasoning units that observe business signals,
 * analyse context, and propose (or execute) tasks.
 *
 * Each agent is defined by a YAML profile file under agents/profiles/.
 * Agents do not implement a class — they are driven by agent-runner.js
 * which reads the YAML profile and builds a Claude prompt from it.
 *
 * ─── YAML Profile Structure ─────────────────────────────────────────────────
 *
 * id: string
 *   Unique identifier. Must match the DB agents.id.
 *
 * name: string
 *   Human-readable display name.
 *
 * title: string
 *   Role/specialisation shown in the UI.
 *
 * avatar: string
 *   Emoji or icon identifier.
 *
 * personality: string
 *   Describes the agent's tone, approach, and reasoning style.
 *   Injected into the system prompt.
 *
 * model:
 *   primary: string          Claude model ID to use
 *   fallback: string|null    Fallback model if primary is unavailable
 *   max_tokens: number       Max response tokens
 *   cost_cap_daily_usd: number  Hard daily cost cap in USD
 *
 * connectors_required: string[]
 *   Connector types that must be configured before this agent can run.
 *
 * connectors_optional: string[]
 *   Connector types that enrich context if available, but are not required.
 *
 * signal_triggers: string[]
 *   Signal rule IDs that will trigger this agent automatically.
 *   Empty array = only runs on schedule or manual trigger.
 *
 * capabilities:
 *   read: string[]           Connector types this agent can read from
 *   propose: string[]        Task action types this agent can propose
 *   write_gated: string[]    Connector types where writes require human approval
 *   never: string[]          Operations this agent is never permitted to touch
 *
 * trust_tier: 'green' | 'yellow' | 'red'
 *   green  = auto-approve and execute without human review
 *   yellow = requires human approval before execution
 *   red    = requires human approval + secondary confirmation
 *
 * approval_mode: 'auto' | 'requires_approval'
 *   Paired with trust_tier to determine approval flow.
 *
 * scheduled_jobs: Array
 *   id: string
 *   cron: string    Standard 5-part cron expression
 *   task: string    Natural language description of what to do this run
 *
 * notification_channels: string[]
 *   Where to send alerts: 'dashboard', 'telegram', 'email'
 *
 * status: 'active' | 'paused' | 'disabled'
 *
 * ─── Agent Run Lifecycle ────────────────────────────────────────────────────
 *
 * 1. Trigger: signal match, cron schedule, or manual via API
 * 2. agent-runner.js loads the YAML profile
 * 3. Cost cap check: sum today's spend for this agent
 * 4. Context building: business info, signals, metrics, tasks, KB docs
 * 5. Claude API call with structured system prompt
 * 6. Response parsing: extract tasks[] JSON array from response
 * 7. Task insertion: each proposed task → tasks table (status = proposed)
 * 8. Notification: approval request sent for yellow/red tasks
 * 9. Auto-execution: green tasks with approval_mode=auto → auto-approve
 * 10. agent_runs record created with token usage and cost
 *
 * ─── Response Format Expected from Claude ───────────────────────────────────
 *
 * Claude must respond with valid JSON:
 * {
 *   "reasoning": "string — agent's analysis and thinking",
 *   "tasks": [
 *     {
 *       "title": "string",
 *       "description": "string",
 *       "action_type": "content_brief|meta_edit|github_issue|investigation|notification",
 *       "action_payload": {},
 *       "trust_tier": "green|yellow|red",
 *       "priority": "p1|p2|p3",
 *       "confidence": 0.0-1.0,
 *       "estimated_impact": "string"
 *     }
 *   ],
 *   "signals_detected": number,
 *   "summary": "string"
 * }
 */

// This file is documentation only — no runtime exports required.
export {};
