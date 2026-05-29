/**
 * Agent activation rules — the gate that decides WHETHER, and WHY, a specific
 * agent is allowed to wake up for a given trigger.
 *
 * This is section 2 of the lifecycle redesign. The core complaint was that
 * agents "activate merely because some signal exists". An agent may now
 * activate ONLY through one of five explicit channels, and only if the trigger
 * intersects the agent's knowledge scope:
 *
 *   (a) signal    — a signal whose knowledge area matches the agent's kb_scope
 *   (b) schedule   — a scheduled task for the agent's role is due
 *   (c) manual     — a human explicitly assigns/triggers it
 *   (d) workflow   — a workflow explicitly calls this agent's type
 *   (e) escalation — another agent escalates to it WITH evidence
 *
 * Agents must NOT: work random tasks, self-hire, claim work without evidence,
 * activate just because a signal exists, duplicate another agent's in-flight
 * scope, or run outside their permission scope. evaluateActivation() encodes
 * each of those refusals as an explicit, named decision.
 *
 * Pure functions where possible (knowledge-area derivation, scope matching) so
 * they can be unit-tested without the DB.
 */

export type ActivationChannel = 'signal' | 'schedule' | 'manual' | 'workflow' | 'escalation';

/**
 * Knowledge areas — the vocabulary that links signals/tasks to agents. Each
 * agent owns a set of these (its kb_scope). A signal is mapped to areas via its
 * rule_id / connector type, and an agent activates only if the intersection is
 * non-empty.
 */
export type KnowledgeArea =
  | 'shopify' | 'product' | 'conversion' | 'collection' | 'inventory'   // commerce
  | 'gsc' | 'indexing' | 'ranking' | 'content' | 'metadata'             // seo
  | 'brevo' | 'klaviyo' | 'campaign' | 'deliverability' | 'flow' | 'email' // email/outreach
  | 'speed' | 'cwv' | 'pagespeed' | 'server' | 'code' | 'performance'   // performance
  | 'build' | 'deploy' | 'error' | 'log' | 'github' | 'devops'          // devops
  | 'stripe' | 'revenue' | 'finance' | 'mrr'                            // finance/ledger
  | 'uptime' | 'availability' | 'incident'                              // uptime/sentinel
  | 'traffic' | 'ga4' | 'trend' | 'analytics'                          // analytics/trend
  | 'research' | 'writing' | 'report' | 'general';                      // generalists

/**
 * Per-role knowledge scope + permissions. This is the seed used by the
 * installer to populate the agent's scope columns, and the source of truth for
 * scope-based activation. Roles mirror server/agents/templates/<role>.
 */
export interface RoleSpec {
  role: string;
  purpose: string;
  /** Knowledge areas this agent owns. */
  kb_scope: KnowledgeArea[];
  /** Connector types whose signals this agent reacts to. */
  data_sources: string[];
  /** Tool ids this agent may use (read-only investigation tools by default). */
  tools: string[];
  /** action_types this agent is allowed to propose/own. */
  task_types: string[];
  /** Does work by this agent always require human approval before execution? */
  requires_approval: boolean;
}

export const ROLE_SPECS: Record<string, RoleSpec> = {
  conductor: {
    role: 'orchestrator',
    purpose: 'Routes signals to specialists, monitors the mesh, proposes hires. Never executes domain work itself.',
    kb_scope: ['general'],
    data_sources: [],
    tools: ['list_signals', 'list_tasks', 'list_agents'],
    task_types: ['hire_agent', 'notification', 'strategic_review'],
    requires_approval: true,
  },
  merchant: {
    role: 'Ecommerce Operations Specialist',
    purpose: 'Owns Shopify catalogue health: products, collections, inventory, conversion.',
    kb_scope: ['shopify', 'product', 'conversion', 'collection', 'inventory'],
    data_sources: ['shopify', 'stripe', 'ga4', 'klaviyo'],
    tools: ['get_product', 'list_products', 'get_collection', 'get_inventory'],
    task_types: [
      'shopify_product_update', 'shopify_description_update', 'shopify_meta_update',
      'shopify_collection_update', 'shopify_tag_update', 'product_suggestion', 'investigation',
    ],
    requires_approval: true,
  },
  'seo-sentinel': {
    role: 'Search Intelligence Specialist',
    purpose: 'Owns search: indexing, rankings, metadata, content gaps, internal linking.',
    kb_scope: ['gsc', 'indexing', 'ranking', 'content', 'metadata'],
    data_sources: ['gsc', 'ga4', 'pagespeed', 'semrush'],
    tools: ['get_gsc_pages', 'get_rankings', 'get_page_metadata'],
    task_types: ['meta_update', 'content_brief', 'content_draft', 'page_optimisation', 'investigation'],
    requires_approval: true,
  },
  velocity: {
    role: 'Performance Specialist',
    purpose: 'Owns site speed, Core Web Vitals, render performance.',
    kb_scope: ['speed', 'cwv', 'pagespeed', 'performance'],
    data_sources: ['pagespeed'],
    tools: ['get_pagespeed', 'get_cwv'],
    task_types: ['page_optimisation', 'investigation', 'github_issue'],
    requires_approval: true,
  },
  'trend-spotter': {
    role: 'Analytics & Trend Specialist',
    purpose: 'Owns traffic patterns, behavioural trends, anomaly detection in GA4.',
    kb_scope: ['traffic', 'ga4', 'trend', 'analytics', 'conversion'],
    data_sources: ['ga4', 'gsc'],
    tools: ['get_ga4_report', 'get_trends'],
    task_types: ['investigation', 'strategic_review', 'notification'],
    requires_approval: true,
  },
  ledger: {
    role: 'Finance Specialist',
    purpose: 'Owns revenue, MRR, payment health from Stripe.',
    kb_scope: ['stripe', 'revenue', 'finance', 'mrr'],
    data_sources: ['stripe'],
    tools: ['get_revenue', 'get_subscriptions'],
    task_types: ['investigation', 'notification', 'strategic_review'],
    requires_approval: true,
  },
  sentinel: {
    role: 'Uptime & Reliability Specialist',
    purpose: 'Owns availability, uptime monitoring, incident detection.',
    kb_scope: ['uptime', 'availability', 'incident', 'server'],
    data_sources: ['uptimerobot'],
    tools: ['get_uptime', 'get_incidents'],
    task_types: ['investigation', 'notification', 'github_issue'],
    requires_approval: true,
  },
  dev: {
    role: 'DevOps Specialist',
    purpose: 'Owns builds, deploys, errors, logs, repository health.',
    kb_scope: ['build', 'deploy', 'error', 'log', 'github', 'code', 'devops', 'server'],
    data_sources: ['github', 'server-access'],
    tools: ['get_build_status', 'get_logs', 'get_repo'],
    task_types: ['github_issue', 'github_pr', 'server_file_write', 'server_file_rollback', 'investigation'],
    requires_approval: true,
  },
  outreach: {
    role: 'Outreach & Email Specialist',
    purpose: 'Owns email campaigns, deliverability, flows, local presence.',
    kb_scope: ['brevo', 'klaviyo', 'campaign', 'deliverability', 'flow', 'email'],
    data_sources: ['gbp', 'stannp', 'meta-ads', 'klaviyo', 'brevo'],
    tools: ['get_campaigns', 'get_deliverability', 'get_flows'],
    task_types: ['klaviyo_flow_update', 'meta_ads_update', 'gbp_update', 'investigation', 'notification'],
    requires_approval: true,
  },
  quill: {
    role: 'Content Writer',
    purpose: 'Drafts content on assignment. Activates on assigned tasks/mentions, not signals.',
    kb_scope: ['content', 'writing'],
    data_sources: [],
    tools: ['search_web'],
    task_types: ['content_draft', 'content_brief'],
    requires_approval: true,
  },
  researcher: {
    role: 'Research Specialist',
    purpose: 'Investigates questions on assignment. Activates on assigned tasks/mentions.',
    kb_scope: ['research', 'general'],
    data_sources: [],
    tools: ['search_web', 'deep_investigation'],
    task_types: ['investigation', 'deep_investigation', 'research_connector'],
    requires_approval: true,
  },
  reporter: {
    role: 'Reporting Specialist',
    purpose: 'Produces scheduled briefings. Primarily schedule-driven.',
    kb_scope: ['report', 'general'],
    data_sources: [],
    tools: ['list_signals', 'list_tasks'],
    task_types: ['notification', 'strategic_review'],
    requires_approval: true,
  },
};

/**
 * Map a signal (by rule_id and connector type) to the knowledge areas it
 * touches. Pure & deterministic so the matcher's reasoning is explainable.
 */
export function deriveSignalKnowledgeAreas(input: {
  rule_id?: string | null;
  connector_type?: string | null;
  type?: string | null;
}): KnowledgeArea[] {
  const areas = new Set<KnowledgeArea>();
  const rule = (input.rule_id ?? '').toLowerCase();
  const conn = (input.connector_type ?? '').toLowerCase();
  const hay = `${rule} ${conn} ${(input.type ?? '').toLowerCase()}`;

  const add = (...a: KnowledgeArea[]): void => { for (const x of a) areas.add(x); };

  // Connector-type → area (the strongest, most reliable signal).
  if (conn === 'shopify') add('shopify', 'product', 'collection', 'inventory', 'conversion');
  if (conn === 'gsc') add('gsc', 'indexing', 'ranking', 'content', 'metadata');
  if (conn === 'pagespeed') add('speed', 'cwv', 'pagespeed', 'performance');
  if (conn === 'ga4') add('traffic', 'ga4', 'trend', 'analytics', 'conversion');
  if (conn === 'stripe') add('stripe', 'revenue', 'finance', 'mrr');
  if (conn === 'uptimerobot') add('uptime', 'availability', 'incident', 'server');
  if (conn === 'github' || conn === 'server-access') add('build', 'deploy', 'error', 'log', 'github', 'code', 'devops', 'server');
  if (conn === 'brevo' || conn === 'klaviyo') add('email', 'campaign', 'deliverability', 'flow');
  if (conn === 'gbp' || conn === 'stannp' || conn === 'meta-ads') add('campaign', 'email');
  if (conn === 'semrush') add('ranking', 'content', 'gsc');

  // Keyword scan of the rule_id for cases where the connector is absent.
  const kw: Array<[RegExp, KnowledgeArea[]]> = [
    [/index|crawl|sitemap/, ['indexing', 'gsc']],
    [/rank|position|keyword|serp/, ['ranking', 'gsc']],
    [/meta|title|description|schema/, ['metadata', 'content']],
    [/content|blog|article/, ['content']],
    [/product|sku|variant/, ['product', 'shopify']],
    [/collection|catalog/, ['collection', 'shopify']],
    [/stock|inventory/, ['inventory', 'shopify']],
    [/conversion|cart|checkout|cvr/, ['conversion']],
    [/speed|lcp|cls|inp|fcp|ttfb|web.?vital|cwv/, ['speed', 'cwv', 'performance']],
    [/deploy|build|ci|pipeline/, ['deploy', 'build', 'devops']],
    [/error|exception|crash|500|trace|log/, ['error', 'log']],
    [/uptime|down|outage|incident|availab/, ['uptime', 'availability', 'incident']],
    [/revenue|mrr|payment|charge|refund|stripe/, ['revenue', 'finance', 'stripe']],
    [/campaign|email|deliver|bounce|open.?rate|flow/, ['campaign', 'email', 'deliverability', 'flow']],
    [/traffic|sessions|users|bounce/, ['traffic', 'analytics']],
  ];
  for (const [re, a] of kw) if (re.test(hay)) add(...a);

  if (areas.size === 0) areas.add('general');
  return [...areas];
}

/** Intersection of two area lists (used for "matched knowledge areas"). */
export function intersectAreas(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  return [...new Set(a)].filter((x) => setB.has(x));
}

export interface ActivationContext {
  agentId: string;
  channel: ActivationChannel;
  /** The agent's knowledge scope (areas). */
  agentScope: string[];
  /** The agent's allowed data sources (connector types). */
  agentDataSources: string[];
  /** Knowledge areas implied by the trigger (signals/tasks). */
  triggerAreas?: string[];
  /** Connector type behind the trigger, if any. */
  triggerConnectorType?: string | null;
  /** Is the agent currently cooling down after a failure? */
  inCooldown: boolean;
  /** Is the agent currently busy with in-flight work? */
  busy: boolean;
  /** Is another agent already working this exact scope/task? */
  duplicateScopeInFlight: boolean;
  /** For escalation: did the escalator attach evidence? */
  hasEvidence?: boolean;
  /** Is the agent live (hired/standby/etc.) rather than pre-hire/archived? */
  isLive: boolean;
}

export interface ActivationDecision {
  allowed: boolean;
  channel: ActivationChannel;
  /** Machine-readable refusal/acceptance code. */
  code:
    | 'ok'
    | 'not_live'
    | 'in_cooldown'
    | 'already_busy'
    | 'duplicate_scope'
    | 'out_of_scope'
    | 'no_evidence';
  /** Human-readable explanation (rendered in the sidebar / activation record). */
  reason: string;
  matchedAreas: string[];
}

/**
 * The central activation gate. Returns an explicit, explainable allow/deny.
 * This is where each "agents must NOT…" rule is enforced.
 */
export function evaluateActivation(ctx: ActivationContext): ActivationDecision {
  const matchedAreas = ctx.triggerAreas
    ? intersectAreas(ctx.agentScope, ctx.triggerAreas)
    : [];

  // 0. Pre-hire / archived agents never activate. (No self-hire, no zombie runs.)
  if (!ctx.isLive) {
    return { allowed: false, channel: ctx.channel, code: 'not_live', matchedAreas,
      reason: 'Agent is not hired/standby — it cannot be activated.' };
  }

  // 1. Cooling down after a failure — must NOT retry endlessly.
  if (ctx.inCooldown) {
    return { allowed: false, channel: ctx.channel, code: 'in_cooldown', matchedAreas,
      reason: 'Agent is in cooldown after a recent failure; will not retry until the cooldown expires.' };
  }

  // 2. No duplicate agent for the same in-flight scope.
  if (ctx.duplicateScopeInFlight) {
    return { allowed: false, channel: ctx.channel, code: 'duplicate_scope', matchedAreas,
      reason: 'Another agent already owns this scope in-flight; refusing to duplicate work.' };
  }

  // 3. Already busy — one active task per agent.
  if (ctx.busy) {
    return { allowed: false, channel: ctx.channel, code: 'already_busy', matchedAreas,
      reason: 'Agent is already working an in-flight task; refusing to start a second.' };
  }

  switch (ctx.channel) {
    case 'manual':
      // A human explicitly chose this agent — bypasses scope matching by design,
      // but still respects cooldown/busy/duplicate above.
      return { allowed: true, channel: ctx.channel, code: 'ok', matchedAreas,
        reason: 'Manually assigned by a human operator.' };

    case 'workflow':
      // A workflow explicitly named this agent's type.
      return { allowed: true, channel: ctx.channel, code: 'ok', matchedAreas,
        reason: 'Explicitly invoked by a workflow step.' };

    case 'escalation':
      // Another agent escalated — REQUIRES evidence.
      if (!ctx.hasEvidence) {
        return { allowed: false, channel: ctx.channel, code: 'no_evidence', matchedAreas,
          reason: 'Escalation arrived without evidence; refusing to claim work without it.' };
      }
      // Escalations should still be in-scope to avoid cross-domain dumping.
      if (ctx.triggerAreas && matchedAreas.length === 0) {
        return { allowed: false, channel: ctx.channel, code: 'out_of_scope', matchedAreas,
          reason: 'Escalation is outside this agent\'s knowledge scope.' };
      }
      return { allowed: true, channel: ctx.channel, code: 'ok', matchedAreas,
        reason: 'Escalated from another agent with supporting evidence.' };

    case 'schedule':
      // A scheduled task for this role is due — always in-scope by definition.
      return { allowed: true, channel: ctx.channel, code: 'ok', matchedAreas,
        reason: 'A scheduled task for this role is due.' };

    case 'signal':
    default: {
      // A signal exists — but the agent activates ONLY if the signal's
      // knowledge areas intersect its scope. "Some signal exists" is NOT enough.
      if (!ctx.triggerAreas || ctx.triggerAreas.length === 0) {
        return { allowed: false, channel: ctx.channel, code: 'out_of_scope', matchedAreas,
          reason: 'Signal has no derivable knowledge area; not routed to this agent.' };
      }
      if (matchedAreas.length === 0) {
        return { allowed: false, channel: ctx.channel, code: 'out_of_scope', matchedAreas,
          reason: `Signal areas [${ctx.triggerAreas.join(', ')}] do not intersect this agent's scope [${ctx.agentScope.join(', ')}].` };
      }
      return { allowed: true, channel: ctx.channel, code: 'ok', matchedAreas,
        reason: `Signal matched knowledge area(s): ${matchedAreas.join(', ')}.` };
    }
  }
}

/**
 * Persist an activation record (the per-activation audit trail required by the
 * spec). Returns the new activation id. Kept DB-touching but tiny so it can be
 * stubbed in tests; pure decision logic lives in evaluateActivation above.
 */
export interface ActivationRecordInput {
  agentId: string;
  businessId: string;
  triggerSource: ActivationChannel | string;
  triggerRef?: string | null;
  matchedAreas: string[];
  selectionReason: string;
  alternatives?: Array<{ agent_id: string; reason: string }>;
  confidence?: number | null;
  taskId?: string | null;
  evidence?: unknown[];
  runId?: string | null;
}
