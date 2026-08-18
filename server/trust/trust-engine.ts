import db, { audit, generateId } from '../db/db.js';
import {
  DEFAULT_OPERATING_POLICY, computeTierUnderPolicy, resolveOperatingPolicy,
  type OperatingPolicyDocument, type ResolvedOperatingPolicy,
} from '../policy/operating-policy.js';
import { evaluateDueMeasurements, prepareOutcomeMeasurement } from '../tasks/measurement-learning.js';

function sqlPrepare(query: string): any {
  return db.prepare(query);
}

export type EvidenceStatus = 'verified' | 'observed' | 'reproduced' | 'inferred' | 'expected' | 'attempted' | 'failed' | 'blocked' | 'unknown';
export type SignalLifecycleStatus = 'open' | 'acknowledged' | 'investigating' | 'actioned' | 'resolved' | 'stale' | 'superseded' | 'invalidated' | 'recurring';
export type ApprovalTier = 'green' | 'yellow' | 'orange' | 'red';

const CONNECTOR_CAPABILITY: Record<string, string> = {
  shopify: 'shopify', etsy: 'etsy', stripe: 'stripe', github: 'github', wordpress: 'wordpress', kirby: 'kirby',
  ga4: 'ga4', gsc: 'gsc', gbp: 'google_business_profile', 'google-merchant': 'google_merchant_center',
  'google-ads': 'google_ads', 'meta-ads': 'meta_ads', brevo: 'brevo', stannp: 'stannp', todoist: 'todoist',
  uptimerobot: 'uptimerobot', pagespeed: 'pagespeed', klaviyo: 'klaviyo', wix: 'wix', buffer: 'buffer',
};
const ACTION_CAPABILITIES: Record<string, string[]> = {
  shopify_product_create: ['shopify', 'ecommerce'], shopify_product_update: ['shopify', 'ecommerce'],
  shopify_description_update: ['shopify', 'ecommerce'], shopify_page_create: ['shopify', 'content_publishing'],
  shopify_page_update: ['shopify', 'content_publishing'], shopify_blog_post_create: ['shopify', 'content_publishing'],
  shopify_meta_update: ['shopify'], shopify_collection_update: ['shopify', 'ecommerce'], shopify_tag_update: ['shopify'],
  shopify_theme_edit: ['shopify'], meta_update: ['content_publishing'], content_draft: ['content_publishing'],
  github_issue: ['github'], github_pr: ['github', 'code_deployment'], github_review_deploy: ['github', 'code_deployment'],
  gbp_post: ['google_business_profile', 'local_service_delivery'], gbp_update: ['google_business_profile', 'local_service_delivery'],
  meta_ads_update: ['meta_ads', 'paid_advertising'], 'meta-ads-change': ['meta_ads', 'paid_advertising'],
  klaviyo_flow_update: ['customer_email'], email_campaign: ['customer_email'], customer_email: ['customer_email'],
};
const KEYWORD_CAPABILITIES: Array<[RegExp, string]> = [
  [/merchant center|google merchant/i, 'google_merchant_center'], [/etsy/i, 'etsy'], [/shopify/i, 'shopify'],
  [/google business profile|\bgbp\b|local pack/i, 'google_business_profile'], [/meta ads|facebook ads/i, 'meta_ads'],
  [/google ads/i, 'google_ads'], [/email campaign|newsletter|customer email/i, 'customer_email'],
  [/github|pull request|repository/i, 'github'], [/wordpress/i, 'wordpress'], [/kirby/i, 'kirby'],
];
function parseJson<T>(value: unknown, fallback: T): T { if (value == null) return fallback; if (typeof value === 'object') return value as T; try { return JSON.parse(String(value)) as T; } catch { return fallback; } }
function isoAfterDays(days: number): string { return new Date(Date.now() + days * 86400000).toISOString(); }
function candidateCapabilities(c: { action_type?: string | null; title?: string | null; description?: string | null; payload?: unknown }): string[] {
  const out = new Set<string>();
  (c.action_type ? ACTION_CAPABILITIES[c.action_type] ?? [] : []).forEach((x) => out.add(x));
  const text = `${c.title ?? ''} ${c.description ?? ''} ${JSON.stringify(c.payload ?? {})}`;
  for (const [rx, cap] of KEYWORD_CAPABILITIES) if (rx.test(text)) out.add(cap);
  return Array.from(out);
}
export function syncCapabilitiesFromConnectors(businessId: string): void {
  const connectors = sqlPrepare('SELECT id, type, name, status, last_sync, last_error FROM connectors WHERE business_id = ?').all(businessId) as Array<Record<string, unknown>>;
  const now = new Date().toISOString();
  const upsert = sqlPrepare(`INSERT INTO business_capabilities (id, business_id, capability_key, display_name, status, evidence_source, verified_at, last_checked_at, verification_method, connector_id, limitations, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connector_sync', ?, ?, ?, ?, ?) ON CONFLICT(business_id, capability_key) DO UPDATE SET display_name=excluded.display_name, status=excluded.status, evidence_source=excluded.evidence_source, verified_at=excluded.verified_at, last_checked_at=excluded.last_checked_at, verification_method=excluded.verification_method, connector_id=excluded.connector_id, limitations=excluded.limitations, confidence=excluded.confidence, updated_at=excluded.updated_at`);
  for (const c of connectors) {
    const key = CONNECTOR_CAPABILITY[String(c.type)] ?? String(c.type).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const status = c.status === 'connected' ? 'available' : c.status === 'stale' ? 'restricted' : c.status === 'error' ? 'disconnected' : 'unknown';
    upsert.run(generateId(), businessId, key, c.name ?? key, status, `connector:${c.id}`, status === 'available' ? (c.last_sync ?? now) : null, now, c.id, c.last_error ?? null, status === 'available' ? 0.95 : 0.35, now, now);
  }
}
export function listCapabilities(businessId: string): Array<Record<string, unknown>> { syncCapabilitiesFromConnectors(businessId); return sqlPrepare('SELECT * FROM business_capabilities WHERE business_id = ? ORDER BY capability_key').all(businessId) as Array<Record<string, unknown>>; }
export function upsertCapability(businessId: string, data: Record<string, unknown>, actor = 'dashboard:human'): Record<string, unknown> {
  const key = String(data.capability_key ?? '').trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_');
  if (!key) throw new Error('capability_key is required.');
  const status = String(data.status ?? 'unknown');
  if (!['available', 'unavailable', 'unknown', 'planned', 'disconnected', 'restricted'].includes(status)) throw new Error('Invalid capability status.');
  const now = new Date().toISOString();
  const before = sqlPrepare('SELECT * FROM business_capabilities WHERE business_id = ? AND capability_key = ?').get(businessId, key) as Record<string, unknown> | undefined;
  sqlPrepare(`INSERT INTO business_capabilities (id, business_id, capability_key, display_name, status, evidence_source, verified_at, last_checked_at, verification_method, connector_id, limitations, allowed_actions, prohibited_actions, confidence, corrected_by, correction_id, review_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(business_id, capability_key) DO UPDATE SET display_name=excluded.display_name, status=excluded.status, evidence_source=excluded.evidence_source, verified_at=excluded.verified_at, last_checked_at=excluded.last_checked_at, verification_method=excluded.verification_method, connector_id=excluded.connector_id, limitations=excluded.limitations, allowed_actions=excluded.allowed_actions, prohibited_actions=excluded.prohibited_actions, confidence=excluded.confidence, corrected_by=excluded.corrected_by, correction_id=excluded.correction_id, review_at=excluded.review_at, expires_at=excluded.expires_at, updated_at=excluded.updated_at`).run(
    data.id ?? generateId(), businessId, key, data.display_name ?? key, status, data.evidence_source ?? actor, data.verified_at ?? (status === 'available' ? now : null), data.last_checked_at ?? now, data.verification_method ?? 'manual', data.connector_id ?? null, data.limitations ?? null, JSON.stringify(data.allowed_actions ?? []), JSON.stringify(data.prohibited_actions ?? []), typeof data.confidence === 'number' ? data.confidence : 0.8, data.corrected_by ?? actor, data.correction_id ?? null, data.review_at ?? null, data.expires_at ?? null, now, now);
  const after = sqlPrepare('SELECT * FROM business_capabilities WHERE business_id = ? AND capability_key = ?').get(businessId, key) as Record<string, unknown>;
  if (before?.status !== after.status) sqlPrepare("UPDATE applicability_suppressions SET status = 'cleared', cleared_at = CURRENT_TIMESTAMP WHERE business_id = ? AND capability_key = ? AND status = 'active'").run(businessId, key);
  audit(businessId, 'capability', String(after.id), before ? 'update' : 'create', actor, before ?? null, after);
  return after;
}
export function recordSuppression(input: { businessId: string; sourceType: string; sourceId?: string | null; candidateType: string; candidateKey: string; capabilityKey?: string | null; reason: string; evidenceStatus?: EvidenceStatus }): void {
  const exists = sqlPrepare("SELECT id FROM applicability_suppressions WHERE business_id = ? AND candidate_type = ? AND candidate_key = ? AND status = 'active'").get(input.businessId, input.candidateType, input.candidateKey);
  if (exists) return;
  sqlPrepare('INSERT INTO applicability_suppressions (id, business_id, source_type, source_id, candidate_type, candidate_key, capability_key, reason, evidence_status, reconsider_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(generateId(), input.businessId, input.sourceType, input.sourceId ?? null, input.candidateType, input.candidateKey, input.capabilityKey ?? null, input.reason, input.evidenceStatus ?? 'observed', isoAfterDays(30));
}
export function evaluateApplicability(input: { businessId: string; candidateType: string; candidateKey?: string; actionType?: string | null; title?: string | null; description?: string | null; payload?: unknown; sourceType?: string; sourceId?: string | null; recordSuppression?: boolean }) {
  const caps = candidateCapabilities({ action_type: input.actionType, title: input.title, description: input.description, payload: input.payload });
  if (caps.length === 0) return { applicable: true, status: 'applicable', capability_keys: [], reason: 'No specific capability requirement detected.', evidence_status: 'inferred' as EvidenceStatus };
  const byKey = new Map(listCapabilities(input.businessId).map((r) => [String(r.capability_key), r]));
  const missing = caps.filter((k) => byKey.has(k) && ['unavailable', 'disconnected', 'restricted'].includes(String(byKey.get(k)?.status)));
  const unknown = caps.filter((k) => !byKey.has(k) || ['unknown', 'planned'].includes(String(byKey.get(k)?.status)));
  const status = missing.length ? 'not_applicable' : unknown.length ? 'unknown' : 'applicable';
  const reason = missing.length ? `Required capability unavailable or restricted: ${missing.join(', ')}.` : unknown.length ? `Required capability is unknown; create a verification task first: ${unknown.join(', ')}.` : `Applicable based on available capabilities: ${caps.join(', ')}.`;
  const evidence = status === 'applicable' ? 'verified' : status === 'unknown' ? 'unknown' : 'observed';
  if (status !== 'applicable' && input.recordSuppression !== false) recordSuppression({ businessId: input.businessId, sourceType: input.sourceType ?? 'applicability', sourceId: input.sourceId ?? null, candidateType: input.candidateType, candidateKey: input.candidateKey ?? input.actionType ?? input.title ?? 'unknown', capabilityKey: missing[0] ?? unknown[0] ?? null, reason, evidenceStatus: evidence as EvidenceStatus });
  return { applicable: status === 'applicable', status, capability_keys: caps, reason, evidence_status: evidence as EvidenceStatus };
}
export function transitionSignalLifecycle(signalId: string, toStatus: SignalLifecycleStatus, reason: string, opts: { evidenceStatus?: EvidenceStatus; relatedSignalId?: string | null; correctionId?: string | null } = {}): void {
  const row = sqlPrepare('SELECT id, business_id, status, lifecycle_status FROM signals WHERE id = ?').get(signalId) as Record<string, unknown> | undefined;
  if (!row) return;
  const from = String(row.lifecycle_status ?? row.status ?? 'open');
  if (from === toStatus) return;
  sqlPrepare('UPDATE signals SET lifecycle_status = ?, status = ?, lifecycle_reason = ?, lifecycle_updated_at = CURRENT_TIMESTAMP, superseded_by_signal_id = COALESCE(?, superseded_by_signal_id), invalidated_by_correction_id = COALESCE(?, invalidated_by_correction_id) WHERE id = ?').run(toStatus, toStatus, reason, opts.relatedSignalId ?? null, opts.correctionId ?? null, signalId);
  sqlPrepare('INSERT INTO signal_lifecycle_events (id, signal_id, business_id, from_status, to_status, reason, evidence_status, related_signal_id, correction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(generateId(), signalId, row.business_id, from, toStatus, reason, opts.evidenceStatus ?? 'observed', opts.relatedSignalId ?? null, opts.correctionId ?? null);
  audit(String(row.business_id), 'signal', signalId, `lifecycle:${from}->${toStatus}`, 'system:signal-lifecycle', { status: from }, { status: toStatus }, { reason });
}
export function createCorrection(input: Record<string, unknown>, actor = 'dashboard:human'): Record<string, unknown> {
  const businessId = String(input.business_id ?? input.businessId ?? '');
  if (!businessId) throw new Error('business_id is required.');
  const assertionKey = String(input.assertion_key ?? input.corrected_assertion ?? input.field ?? '').trim();
  if (!assertionKey) throw new Error('assertion_key is required.');
  const id = generateId();
  const now = new Date().toISOString();
  const requestedStatus = String(input.status ?? 'confirmed');
  if (!['proposed', 'confirmed', 'rejected', 'superseded'].includes(requestedStatus)) throw new Error('Invalid correction status.');
  const capabilityKey = String(input.affected_capability ?? assertionKey).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_');
  const previous = sqlPrepare('SELECT * FROM business_capabilities WHERE business_id = ? AND capability_key = ?').get(businessId, capabilityKey) as Record<string, unknown> | undefined;
  sqlPrepare(`INSERT INTO human_corrections (id, business_id, correction_type, assertion_key, previous_value, corrected_value, explanation, evidence_source, corrected_by, effective_at, confidence, permanence, review_at, affected_capability_id, suppression_behavior, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, businessId, String(input.correction_type ?? 'business_fact'), assertionKey, input.previous_value == null ? JSON.stringify(previous ?? null) : String(input.previous_value), String(input.corrected_value ?? ''), input.explanation ?? null, input.evidence_source ?? null, actor, input.effective_at ?? now, typeof input.confidence === 'number' ? input.confidence : 1, input.permanence ?? 'review_required', input.review_at ?? null, previous?.id ?? null, input.suppression_behavior ?? 'suppress_until_changed', requestedStatus, now);
  const correction = sqlPrepare('SELECT * FROM human_corrections WHERE id = ?').get(id) as Record<string, unknown>;
  if (requestedStatus !== 'confirmed') {
    audit(businessId, 'correction', id, 'propose', actor, null, correction, { status: requestedStatus });
    return { ...correction, impacts: [] };
  }
  const corrected = String(input.corrected_value ?? '').toLowerCase();
  const status = /no|not|false|unavailable|does not|never|disable|prohibit/.test(corrected) ? 'unavailable' : /unknown|unsure|check/.test(corrected) ? 'unknown' : 'available';
  const capability = upsertCapability(businessId, { capability_key: capabilityKey, status, evidence_source: `correction:${id}`, corrected_by: actor, correction_id: id, confidence: input.confidence ?? 1, limitations: input.explanation ?? null }, actor);
  sqlPrepare('UPDATE human_corrections SET affected_capability_id = ? WHERE id = ?').run(capability.id, id);
  const impacts = invalidateDependentEntities(businessId, id, capabilityKey, String(input.explanation ?? `Human correction changed ${capabilityKey} to ${status}.`));
  const confirmed = sqlPrepare('SELECT * FROM human_corrections WHERE id = ?').get(id) as Record<string, unknown>;
  audit(businessId, 'correction', id, 'create', actor, null, confirmed, { impacts });
  return { ...confirmed, impacts };
}
export function invalidateDependentEntities(businessId: string, correctionId: string, capabilityKey: string, reason: string): Array<Record<string, unknown>> {
  const impacts: Array<Record<string, unknown>> = [];
  const add = (entityType: string, entityId: string, previous: string | null, next: string) => { const id = generateId(); sqlPrepare('INSERT INTO correction_impacts (id, correction_id, business_id, entity_type, entity_id, previous_status, new_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(id, correctionId, businessId, entityType, entityId, previous, next, reason); impacts.push({ id, entity_type: entityType, entity_id: entityId, previous_status: previous, new_status: next, reason }); };
  const like = `%${capabilityKey.replace(/_/g, '%')}%`;
  const signals = sqlPrepare(`SELECT id, status FROM signals WHERE business_id = ? AND (lower(title) LIKE lower(?) OR lower(description) LIKE lower(?) OR lower(data) LIKE lower(?)) AND COALESCE(lifecycle_status, status, 'open') NOT IN ('resolved','invalidated')`).all(businessId, like, like, like) as Array<{ id: string; status: string }>;
  for (const s of signals) { transitionSignalLifecycle(s.id, 'invalidated', reason, { correctionId, evidenceStatus: 'verified' }); add('signal', s.id, s.status, 'invalidated'); }
  const tasks = sqlPrepare(`SELECT id, status FROM tasks WHERE business_id = ? AND (lower(title) LIKE lower(?) OR lower(description) LIKE lower(?) OR lower(action_type) LIKE lower(?) OR lower(action_payload) LIKE lower(?)) AND status IN ('proposed','approved','deferred','manual_review')`).all(businessId, like, like, like, like) as Array<{ id: string; status: string }>;
  for (const t of tasks) { const next = t.status === 'approved' ? 'manual_review' : 'cancelled'; sqlPrepare('UPDATE tasks SET status = ?, applicability_status = ?, applicability_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, 'not_applicable', reason, t.id); add('task', t.id, t.status, next); }
  recordSuppression({ businessId, sourceType: 'correction', sourceId: correctionId, candidateType: 'capability_assumption', candidateKey: capabilityKey, capabilityKey, reason, evidenceStatus: 'verified' });
  return impacts;
}
export function evaluateSignalLifecycle(businessId?: string): { evaluated: number; changed: number } {
  const params: unknown[] = [];
  const where = businessId ? 'WHERE s.business_id = ?' : '';
  if (businessId) params.push(businessId);
  const rows = sqlPrepare(`SELECT s.id, s.business_id, s.connector_id, s.created_at, s.lifecycle_status, c.status AS connector_status, c.last_sync FROM signals s LEFT JOIN connectors c ON c.id = s.connector_id ${where}`).all(...params) as Array<Record<string, unknown>>;
  let changed = 0;
  for (const s of rows) {
    const current = String(s.lifecycle_status ?? 'open');
    if (['resolved', 'invalidated', 'superseded'].includes(current)) continue;
    const lastSync = s.last_sync ? new Date(String(s.last_sync)).getTime() : 0;
    const ageHours = lastSync ? (Date.now() - lastSync) / 3600000 : null;
    const connectorStatus = String(s.connector_status ?? '');
    const connectorStale = connectorStatus === 'stale' || connectorStatus === 'disconnected' || connectorStatus === 'error' || (ageHours != null && ageHours > 48);
    if (connectorStale) {
      transitionSignalLifecycle(String(s.id), 'stale', 'Connector evidence is no longer fresh enough for actionable ranking.', { evidenceStatus: 'observed' });
      changed++;
      continue;
    }
    if (current === 'stale' && connectorStatus === 'connected' && ageHours != null && ageHours <= 48) {
      transitionSignalLifecycle(String(s.id), 'open', 'Connector evidence is fresh again; signal reopened for actionable re-evaluation.', { evidenceStatus: 'observed' });
      changed++;
      continue;
    }
    const newer = sqlPrepare(`SELECT id FROM signals WHERE business_id = ? AND rule_id = (SELECT rule_id FROM signals WHERE id = ?) AND id != ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`).get(s.business_id, s.id, s.id, s.created_at) as { id: string } | undefined;
    if (newer) {
      transitionSignalLifecycle(String(s.id), 'superseded', `Newer signal ${newer.id} describes the same condition.`, { relatedSignalId: newer.id, evidenceStatus: 'observed' });
      changed++;
    }
  }
  return { evaluated: rows.length, changed };
}
export function listRevenuePaths(businessId: string): Array<Record<string, unknown>> { return sqlPrepare('SELECT * FROM revenue_paths WHERE business_id = ? ORDER BY active DESC, role ASC, priority ASC, created_at DESC').all(businessId) as Array<Record<string, unknown>>; }
export function upsertRevenuePath(businessId: string, data: Record<string, unknown>, actor = 'dashboard:human'): Record<string, unknown> {
  const id = String(data.id ?? generateId()); const role = String(data.role ?? 'secondary');
  if (!data.name || !data.business_model_type) throw new Error('name and business_model_type are required.');
  const before = sqlPrepare('SELECT * FROM revenue_paths WHERE id = ? AND business_id = ?').get(id, businessId) as Record<string, unknown> | undefined;
  if (role === 'primary' && data.active !== false) sqlPrepare("UPDATE revenue_paths SET role = 'secondary', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND role = 'primary' AND id != ?").run(businessId, id);
  sqlPrepare(`INSERT INTO revenue_paths (id, business_id, name, role, business_model_type, sales_channel, target_customer, offer_category, acquisition_stage, conversion_mechanism, fulfilment_mechanism, retention_mechanism, primary_metric, leading_metrics, lagging_metrics, constraints, dependencies, verified_evidence, evidence_status, active, priority, target_contribution, time_horizon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, business_model_type=excluded.business_model_type, sales_channel=excluded.sales_channel, target_customer=excluded.target_customer, offer_category=excluded.offer_category, acquisition_stage=excluded.acquisition_stage, conversion_mechanism=excluded.conversion_mechanism, fulfilment_mechanism=excluded.fulfilment_mechanism, retention_mechanism=excluded.retention_mechanism, primary_metric=excluded.primary_metric, leading_metrics=excluded.leading_metrics, lagging_metrics=excluded.lagging_metrics, constraints=excluded.constraints, dependencies=excluded.dependencies, verified_evidence=excluded.verified_evidence, evidence_status=excluded.evidence_status, active=excluded.active, priority=excluded.priority, target_contribution=excluded.target_contribution, time_horizon=excluded.time_horizon, updated_at=CURRENT_TIMESTAMP`).run(id, businessId, data.name, role, data.business_model_type, data.sales_channel ?? null, data.target_customer ?? null, data.offer_category ?? null, data.acquisition_stage ?? null, data.conversion_mechanism ?? null, data.fulfilment_mechanism ?? null, data.retention_mechanism ?? null, data.primary_metric ?? null, JSON.stringify(data.leading_metrics ?? []), JSON.stringify(data.lagging_metrics ?? []), data.constraints ?? null, JSON.stringify(data.dependencies ?? []), data.verified_evidence ?? null, data.evidence_status ?? 'unknown', data.active === false ? 0 : 1, Number(data.priority ?? 50), data.target_contribution ?? null, data.time_horizon ?? null);
  const after = sqlPrepare('SELECT * FROM revenue_paths WHERE id = ?').get(id) as Record<string, unknown>; audit(businessId, 'revenue_path', id, before ? 'update' : 'create', actor, before ?? null, after); return after;
}
export function explainRevenueRelevance(businessId: string, candidate: { title?: string | null; description?: string | null; action_type?: string | null }) {
  const paths = listRevenuePaths(businessId).filter((p) => Number(p.active) === 1); if (paths.length === 0) return { score: 0.2, path_id: null, relationship: 'operational_enablement', explanation: 'No active revenue path is configured; ranking uses operational enablement only.' };
  const text = `${candidate.title ?? ''} ${candidate.description ?? ''} ${candidate.action_type ?? ''}`.toLowerCase(); let best = paths[0]; let score = 0.25;
  for (const p of paths) { const terms = [p.name, p.business_model_type, p.sales_channel, p.offer_category, p.primary_metric].filter(Boolean).map((v) => String(v).toLowerCase()); const hits = terms.filter((t) => t && text.includes(t)).length; const s = Math.min(1, (p.role === 'primary' ? 0.3 : 0.15) + hits * 0.25 + (100 - Number(p.priority ?? 50)) / 500); if (s > score) { score = s; best = p; } }
  const relationship = /security|auth|uptime|backup|risk|compliance|reliability|bug/i.test(text) ? 'protect_existing_revenue' : score >= 0.6 ? 'improve_conversion' : 'operational_enablement';
  return { score, path_id: best ? String(best.id) : null, relationship, explanation: best ? `Ranks with revenue relevance ${score.toFixed(2)} because it relates to ${best.role} path "${best.name}" as ${relationship.replace(/_/g, ' ')}.` : 'No matching revenue path.' };
}
/**
 * Risk tiering, now driven by the business's Operating Policy (#68) rather
 * than by hardcoded constants.
 *
 * Thresholds come from the effective policy; the keyword escalations
 * (publish/merge/price/payment/delete...) deliberately do not, because
 * "this action is customer-facing and irreversible" is a property of the
 * action, not an opinion a business is allowed to hold about it.
 *
 * Resolution order for the thresholds used:
 *   1. an explicitly passed `policy` (the caller already resolved it — the
 *      task queue does this so proposal and approval cite the same version),
 *   2. otherwise resolved from `businessId`,
 *   3. otherwise DEFAULT_OPERATING_POLICY, whose values are exactly the
 *      constants this function used before #68 — so a call with neither
 *      (as in unit tests and non-business-scoped callers) behaves
 *      identically to the pre-policy implementation.
 *
 * The returned evidence always names the policy version in force, which is
 * what gets persisted onto tasks.approval_risk_evidence.
 */
export function calculateApprovalTier(input: { actionType?: string | null; payload?: Record<string, unknown>; baseTier?: string | null; agentConfidence?: number | null; applicabilityStatus?: string | null; businessId?: string | null; policy?: ResolvedOperatingPolicy | null }): { tier: ApprovalTier; evidence: Record<string, unknown> } {
  const resolved: ResolvedOperatingPolicy | null = input.policy
    ?? (input.businessId ? resolveOperatingPolicy(input.businessId) : null);
  const document: OperatingPolicyDocument = resolved?.document ?? DEFAULT_OPERATING_POLICY;
  const action = input.actionType ?? ''; const payload = input.payload ?? {};
  const affected = Number(payload.affected_records ?? payload.count ?? 0); const exposure = Number(payload.financial_exposure_gbp ?? payload.spend_gbp ?? payload.budget_gbp ?? 0);
  const tier = computeTierUnderPolicy(document, { actionType: input.actionType, payload, baseTier: input.baseTier, agentConfidence: input.agentConfidence, applicabilityStatus: input.applicabilityStatus });
  return {
    tier,
    evidence: {
      action_type: action, affected_records: affected, financial_exposure_gbp: exposure,
      agent_confidence: input.agentConfidence ?? null, applicability_status: input.applicabilityStatus ?? null,
      calculated_tier: tier,
      policy_id: resolved?.policy_id ?? null,
      policy_version: resolved?.policy_version ?? 0,
      policy_scope: resolved?.policy_scope ?? 'system_default',
      policy_citation: resolved?.citation ?? 'system default operating policy (v0 — no business scope supplied)',
      thresholds_applied: { ...document.thresholds },
    },
  };
}
export function getMeasurementPolicy(businessId: string, actionType?: string | null): Record<string, unknown> { return (sqlPrepare(`SELECT * FROM measurement_policies WHERE active = 1 AND (business_id = ? OR business_id IS NULL) AND (action_type = ? OR action_type IS NULL) ORDER BY business_id IS NULL ASC, action_type IS NULL ASC LIMIT 1`).get(businessId, actionType ?? null) as Record<string, unknown> | undefined) ?? { id: 'policy_default_immediate_7_28_90', checkpoints_json: '[0,7,28,90]' }; }
export function scheduleOutcomeMeasurements(taskId: string): number {
  try {
    return prepareOutcomeMeasurement(taskId).scheduled;
  } catch {
    return 0;
  }
}
export function evaluateDueOutcomeMeasurements(): { evaluated: number; changed: number } {
  const result = evaluateDueMeasurements();
  return { evaluated: result.evaluated, changed: result.changed };
}
export function recordRunEvent(runId: string, eventType: string, summary: string, opts: Record<string, unknown> = {}): void {
  const run = sqlPrepare('SELECT id, agent_id, business_id FROM agent_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined; if (!run) return;
  sqlPrepare(`INSERT INTO agent_run_events (id, run_id, business_id, agent_id, event_type, status, summary, request_id, correlation_id, related_resource_type, related_resource_id, duration_ms, error_category, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(generateId(), runId, run.business_id, run.agent_id, eventType, opts.status ?? 'observed', summary, opts.request_id ?? null, opts.correlation_id ?? null, opts.related_resource_type ?? null, opts.related_resource_id ?? null, opts.duration_ms ?? null, opts.error_category ?? null, JSON.stringify(opts.metadata ?? {}));
}
export function requestRunCancellation(runId: string, actor = 'dashboard:human') {
  const row = sqlPrepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined; if (!row) throw new Error('Run not found.');
  if (!['queued', 'running', 'cancellation_requested', 'cancelling'].includes(String(row.status))) return { status: String(row.status), changed: false };
  const res = sqlPrepare("UPDATE agent_runs SET status = 'cancellation_requested', cancellation_requested_at = CURRENT_TIMESTAMP, terminal_reason = 'Cancellation requested' WHERE id = ? AND status IN ('queued','running')").run(runId);
  recordRunEvent(runId, 'cancellation_requested', `Cancellation requested by ${actor}.`, { status: 'attempted' }); audit(String(row.business_id), 'agent_run', runId, 'cancellation_requested', actor, row, { status: 'cancellation_requested' }); return { status: 'cancellation_requested', changed: (res.changes ?? 0) > 0 };
}
export function checkRunCancellation(runId: string): boolean { const row = sqlPrepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: string } | undefined; return !!row && ['cancellation_requested', 'cancelling', 'cancelled'].includes(row.status); }
export function markRunCancelled(runId: string, reason = 'Stopped at a cooperative cancellation checkpoint.'): void { sqlPrepare("UPDATE agent_runs SET status = 'cancelled', cancellation_acknowledged_at = COALESCE(cancellation_acknowledged_at, CURRENT_TIMESTAMP), cancellation_completed_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, terminal_reason = ? WHERE id = ? AND status IN ('running','cancellation_requested','cancelling')").run(reason, runId); recordRunEvent(runId, 'cancelled', reason, { status: 'cancelled' }); }
export function updateRunHeartbeat(runId: string, ttlMs = 120000): void { sqlPrepare('UPDATE agent_runs SET heartbeat_at = CURRENT_TIMESTAMP, heartbeat_expires_at = ? WHERE id = ?').run(new Date(Date.now() + ttlMs).toISOString(), runId); }
export function recordProviderPreflight(provider: string, model: string, status: 'passed' | 'failed' | 'blocked', evidence: Record<string, unknown>, ttlMs = 300000): Record<string, unknown> { const now = new Date().toISOString(); const expires = new Date(Date.now() + ttlMs).toISOString(); sqlPrepare(`INSERT INTO provider_preflight_cache (id, provider, model, status, evidence, checked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET status=excluded.status, evidence=excluded.evidence, checked_at=excluded.checked_at, expires_at=excluded.expires_at`).run(generateId(), provider, model, status, JSON.stringify(evidence), now, expires); return { provider, model, status, evidence, checked_at: now, expires_at: expires }; }
export function getProviderPreflight(provider?: string, model?: string): Array<Record<string, unknown>> { if (provider && model) return sqlPrepare('SELECT * FROM provider_preflight_cache WHERE provider = ? AND model = ?').all(provider, model) as Array<Record<string, unknown>>; return sqlPrepare('SELECT * FROM provider_preflight_cache ORDER BY checked_at DESC LIMIT 100').all() as Array<Record<string, unknown>>; }
export function calculateScorecard(agentId: string, businessId?: string | null, actionCategory = 'all', days = 90): Record<string, unknown> {
  const periodEnd = new Date(); const periodStart = new Date(Date.now() - days * 86400000);
  const runParams: unknown[] = [agentId, periodStart.toISOString(), periodEnd.toISOString()]; let runBiz = ''; if (businessId) { runBiz = 'AND ar.business_id = ?'; runParams.push(businessId); }
  const runs = sqlPrepare(`SELECT status, cost_usd FROM agent_runs ar WHERE ar.agent_id = ? AND ar.started_at BETWEEN ? AND ? ${runBiz}`).all(...runParams) as Array<Record<string, unknown>>;
  const taskParams: unknown[] = [agentId, periodStart.toISOString(), periodEnd.toISOString()]; let taskBiz = ''; if (businessId) { taskBiz = 'AND business_id = ?'; taskParams.push(businessId); }
  const tasks = sqlPrepare(`SELECT status, confidence, action_type, applicability_status FROM tasks WHERE proposed_by = ? AND created_at BETWEEN ? AND ? ${taskBiz}`).all(...taskParams) as Array<Record<string, unknown>>;
  const outParams: unknown[] = [agentId]; if (businessId) outParams.push(businessId);
  const outcomes = sqlPrepare(`SELECT omr.state FROM outcome_measurement_runs omr JOIN tasks t ON t.id = omr.task_id WHERE t.proposed_by = ? ${businessId ? 'AND t.business_id = ?' : ''}`).all(...outParams) as Array<Record<string, unknown>>;
  const completed = runs.filter((r) => r.status === 'complete').length; const failed = runs.filter((r) => r.status === 'failed').length; const cancelled = runs.filter((r) => String(r.status).includes('cancel')).length;
  const accepted = tasks.filter((t) => ['approved','executing','complete','verified'].includes(String(t.status))).length; const rejected = tasks.filter((t) => ['rejected','cancelled'].includes(String(t.status))).length; const invalidated = tasks.filter((t) => t.applicability_status === 'not_applicable').length;
  const positive = outcomes.filter((o) => o.state === 'successful').length; const negative = outcomes.filter((o) => o.state === 'unsuccessful').length; const inconclusive = outcomes.filter((o) => ['inconclusive','blocked_by_missing_data'].includes(String(o.state))).length;
  const avgConfidence = tasks.length ? tasks.reduce((s, t) => s + (Number(t.confidence) || 0), 0) / tasks.length : null; const observedSuccess = outcomes.length ? positive / outcomes.length : null; const sample = Math.max(runs.length, tasks.length, outcomes.length);
  const metrics = { runs_started: runs.length, runs_completed: completed, runs_failed: failed, runs_cancelled: cancelled, tasks_proposed: tasks.length, tasks_accepted: accepted, tasks_rejected: rejected, tasks_invalidated: invalidated, verified_positive_outcomes: positive, negative_outcomes: negative, inconclusive_outcomes: inconclusive, average_cost: runs.length ? runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) / runs.length : 0, cost_per_accepted_task: accepted ? runs.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) / accepted : null };
  const calibration = { avg_confidence: avgConfidence, observed_success_rate: observedSuccess, confidence_error: avgConfidence != null && observedSuccess != null ? avgConfidence - observedSuccess : null, buckets: ([[0,0.5],[0.5,0.7],[0.7,0.85],[0.85,1.01]] as Array<[number, number]>).map(([min,max]) => ({ range: `${min}-${Math.min(max,1)}`, count: tasks.filter((t) => typeof t.confidence === 'number' && Number(t.confidence) >= min && Number(t.confidence) < max).length })) };
  const uncertainty = { sample_size: sample, minimum_sample_size: 20, interval: sample < 20 ? 'wide' : 'moderate', note: sample < 20 ? 'Small sample; policy effects should be conservative.' : 'Sample large enough for directional calibration.' };
  const policyEffects = { approval_tier_adjustment: invalidated > 2 || (calibration.confidence_error ?? 0) > 0.25 ? 'increase_one_tier' : 'none', second_review_required: sample >= 5 && rejected > accepted, autonomous_scope: sample < 20 ? 'limited_by_uncertainty' : 'normal' };
  const id = generateId(); sqlPrepare(`INSERT OR REPLACE INTO agent_scorecard_snapshots (id, agent_id, business_id, action_category, period_start, period_end, metrics_json, calibration_json, uncertainty_json, policy_effects_json, calculated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(id, agentId, businessId ?? null, actionCategory, periodStart.toISOString(), periodEnd.toISOString(), JSON.stringify(metrics), JSON.stringify(calibration), JSON.stringify(uncertainty), JSON.stringify(policyEffects));
  return { id, agent_id: agentId, business_id: businessId ?? null, action_category: actionCategory, period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(), metrics, calibration, uncertainty, policy_effects: policyEffects };
}
