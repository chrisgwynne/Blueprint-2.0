import db, { generateId } from '../db/db.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../bap/auth.js';
import {
  checkRunCancellation,
  createCorrection,
  evaluateDueOutcomeMeasurements,
  evaluateSignalLifecycle,
  markRunCancelled,
  recordProviderPreflight,
  scheduleOutcomeMeasurements,
  updateRunHeartbeat,
} from '../trust/trust-engine.js';

const baseUrl = (process.env.BLUEPRINT_LIVE_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const apiBase = `${baseUrl}/api/bap/v1`;
const businessId = process.env.BLUEPRINT_VERIFY_BUSINESS_ID ?? 'biz_live_trust_autonomy';
const agentId = 'agt_live_trust_autonomy';
const internalAgentId = `bap:${agentId}`;

const permissions = [
  'capabilities:read',
  'capabilities:update',
  'capabilities:propose',
  'corrections:read',
  'corrections:propose',
  'revenue_paths:read',
  'revenue_paths:update',
  'measurement_policies:read',
  'approval_policies:read',
  'provider_preflight:read',
  'scorecards:read',
  'agents:read',
  'agents:trigger',
  'tasks:read',
  'tasks:propose',
  'signals:read',
];

type Check = { name: string; status: 'passed'; detail?: unknown };
const checks: Check[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function remember(name: string, detail?: unknown): void {
  checks.push({ name, status: 'passed', detail });
}

async function request(path: string, options: RequestInit & { idempotencyKey?: string } = {}) {
  const headers = new Headers(options.headers);
  headers.set('BAP-Key', apiKey);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
  }
  return body;
}

function cleanupVerifierRecords() {
  const taskIds = db.prepare('SELECT id FROM tasks WHERE business_id = ?').all(businessId) as Array<{ id: string }>;
  for (const task of taskIds) {
    db.prepare('DELETE FROM outcome_measurement_runs WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(task.id);
  }
  db.prepare('DELETE FROM tasks WHERE business_id = ?').run(businessId);
  const runIds = db.prepare('SELECT id FROM agent_runs WHERE business_id = ? OR agent_id = ?').all(businessId, internalAgentId) as Array<{ id: string }>;
  for (const run of runIds) db.prepare('DELETE FROM agent_run_events WHERE run_id = ?').run(run.id);
  db.prepare('DELETE FROM agent_runs WHERE business_id = ? OR agent_id = ?').run(businessId, internalAgentId);
  db.prepare('DELETE FROM signal_lifecycle_events WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM signals WHERE business_id = ?').run(businessId);
  const connectorIds = db.prepare('SELECT id FROM connectors WHERE business_id = ?').all(businessId) as Array<{ id: string }>;
  for (const connector of connectorIds) db.prepare('DELETE FROM connector_syncs WHERE connector_id = ?').run(connector.id);
  db.prepare('DELETE FROM connectors WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM correction_impacts WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM human_corrections WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM applicability_suppressions WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM business_capabilities WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM revenue_paths WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM measurement_policies WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM agent_scorecard_snapshots WHERE business_id = ?').run(businessId);
  db.prepare('DELETE FROM bap_audit WHERE agent_id = ?').run(agentId);
  db.prepare('DELETE FROM bap_agents WHERE id = ?').run(agentId);
  db.prepare('DELETE FROM agents WHERE id = ?').run(internalAgentId);
}

cleanupVerifierRecords();

db.prepare(`INSERT INTO businesses (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug, updated_at = CURRENT_TIMESTAMP`).run(
  businessId,
  'Live Trust Autonomy Verification',
  'live-trust-autonomy-verification',
);

const apiKey = generateApiKey();
db.prepare(`
  INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, default_trust_tier, created_at)
  VALUES (?, 'Live Trust Autonomy Verifier', ?, ?, 'active', ?, ?, 'yellow', CURRENT_TIMESTAMP)
`).run(agentId, await hashApiKey(apiKey), keyPrefix(apiKey), JSON.stringify(permissions), JSON.stringify([businessId]));

db.prepare("INSERT INTO agents (id, profile_path, name, status, created_at) VALUES (?, 'server/agents/live-verifier/profile.yaml', 'Live Trust Autonomy Verifier', 'active', CURRENT_TIMESTAMP) ON CONFLICT(id) DO NOTHING").run(internalAgentId);
await request(`/businesses/${businessId}/capabilities`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({
    capability_key: 'google_merchant_center',
    display_name: 'Google Merchant Center',
    status: 'unavailable',
    evidence_source: 'live-verifier',
    verification_method: 'manual_verification',
    confidence: 1,
    limitations: 'Verifier business has no Merchant Center account.',
  }),
});

const applicability = await request(`/businesses/${businessId}/applicability/evaluate`, {
  method: 'POST',
  body: JSON.stringify({
    candidateType: 'recommendation',
    candidateKey: 'merchant-center-feed-fix',
    title: 'Fix Google Merchant Center product feed',
    description: 'Merchant Center product feed optimisation for this business.',
    recordSuppression: true,
  }),
});
assert(applicability.applicability.status === 'not_applicable', 'Merchant Center recommendation was not suppressed.');
remember('capability suppression over BAP', applicability.applicability);

const suppressions = await request(`/businesses/${businessId}/suppressions`);
assert(suppressions.suppressions.some((s: Record<string, unknown>) => s.candidate_key === 'merchant-center-feed-fix'), 'Suppression reason was not persisted.');
remember('suppression reason persisted', suppressions.suppressions[0]);

await request(`/businesses/${businessId}/capabilities`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({ capability_key: 'github', display_name: 'GitHub', status: 'available', evidence_source: 'live-verifier', confidence: 0.95 }),
});
const validTask = await request(`/businesses/${businessId}/tasks`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({
    title: 'Open draft GitHub issue for verifier',
    description: 'Create a GitHub issue proposal for a verified repository workflow.',
    action_type: 'github_issue',
    action_payload: {
      repository: 'chrisgwynne/Blueprint-2.0',
      title: 'Verifier issue draft',
      acceptance_criteria: ['Issue body contains verification context'],
      executor: 'hermes',
    },
    assigned_to: 'hermes',
    confidence: 0.78,
  }),
});
assert(validTask.task_id, 'BAP valid task proposal did not return a task id.');
assert(validTask.trust_tier === 'orange', `Expected low-risk draft GitHub issue proposal to be orange, got ${validTask.trust_tier}.`);
remember('valid low-risk draft BAP task proposed with orange approval tier', validTask);

const highRiskTask = await request(`/businesses/${businessId}/tasks`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({
    title: 'Bulk operational change with high financial exposure',
    description: 'Large-scope operational task should escalate approval risk before any execution.',
    action_type: 'github_issue',
    action_payload: {
      repository: 'chrisgwynne/Blueprint-2.0',
      title: 'High-risk verifier issue draft',
      acceptance_criteria: ['Human review confirms no live side effect occurs automatically'],
      executor: 'hermes',
      affected_records: 5000,
      financial_exposure_gbp: 1000,
    },
    assigned_to: 'hermes',
    confidence: 0.82,
  }),
});
assert(highRiskTask.trust_tier === 'red', `Expected high-risk proposal to escalate to red, got ${highRiskTask.trust_tier}.`);
remember('approval escalation over BAP task proposal', highRiskTask);
const invalidTask = await fetch(`${apiBase}/businesses/${businessId}/tasks`, {
  method: 'POST',
  headers: { 'BAP-Key': apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': generateId() },
  body: JSON.stringify({
    title: 'Update Merchant Center feed anyway',
    description: 'Google Merchant Center update should be blocked by applicability.',
    action_type: 'content_draft',
    action_payload: { topic: 'Google Merchant Center feed' },
  }),
});
assert(invalidTask.status === 400, 'Expected inapplicable Merchant Center task to return 400, got ' + invalidTask.status + '.');
remember('inapplicable BAP task rejected', { status: invalidTask.status, body: await invalidTask.text() });

const kanban = await request(`/tasks/${validTask.task_id}/kanban-card`);
assert(kanban.card.blueprint_task_id === validTask.task_id, 'Kanban projection is missing the Blueprint task ID.');
assert(kanban.card.business_id === businessId, 'Kanban projection is missing business identity.');
assert(kanban.card.approval_tier, 'Kanban projection is missing approval tier.');
remember('Hermes Kanban card projection over BAP', kanban.card);

await request(`/businesses/${businessId}/revenue-paths`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({
    name: 'Primary retained service revenue',
    role: 'primary',
    business_model_type: 'service_retainers',
    sales_channel: 'direct_sales',
    target_customer: 'local service businesses',
    offer_category: 'support retainers',
    primary_metric: 'qualified retained clients',
    leading_metrics: ['qualified enquiries'],
    lagging_metrics: ['monthly recurring revenue'],
    verified_evidence: 'live verifier operator input',
    evidence_status: 'verified',
    priority: 10,
  }),
});
const revenuePaths = await request(`/businesses/${businessId}/revenue-paths`);
assert(revenuePaths.revenue_paths.length === 1 && revenuePaths.revenue_paths[0].role === 'primary', 'Revenue path was not readable through BAP.');
remember('revenue path update/read over BAP', revenuePaths.revenue_paths[0]);

const signalId = `sig_${generateId()}`;
db.prepare(`INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, lifecycle_status, confidence, created_at) VALUES (?, ?, 'live-verifier-merchant-center', 'connector', 'medium', ?, ?, ?, 'open', 'open', 0.8, CURRENT_TIMESTAMP)`).run(
  signalId,
  businessId,
  'Merchant Center false assumption signal',
  'Google Merchant Center feed issue should be invalidated by correction.',
  JSON.stringify({ capability: 'google_merchant_center' }),
);

const dependentTaskId = `task_${generateId()}`;
db.prepare(`INSERT INTO tasks (id, business_id, signal_id, title, description, proposed_by, assigned_to, action_type, action_payload, status, trust_tier, priority, confidence, approval_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'bap:agt_live_trust_autonomy', 'hermes', 'content_draft', ?, 'proposed', 'yellow', 'p2', 0.7, 'requires_approval', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
  dependentTaskId,
  businessId,
  signalId,
  'Merchant Center dependent task',
  'Draft Merchant Center remediation notes.',
  JSON.stringify({ topic: 'google merchant center feed' }),
);
const correction = createCorrection({
  business_id: businessId,
  correction_type: 'business_fact',
  assertion_key: 'google_merchant_center',
  corrected_value: 'does not use Google Merchant Center',
  explanation: 'Human verifier confirmed this business has no Merchant Center capability.',
  evidence_source: 'live verifier',
  permanence: 'permanent',
  confidence: 1,
}, 'dashboard:live-verifier');
assert(Array.isArray(correction.impacts) && correction.impacts.length >= 2, 'Correction did not produce dependent impacts.');
const corrections = await request(`/businesses/${businessId}/corrections`);
assert(corrections.corrections.some((c: Record<string, unknown>) => c.id === correction.id), 'Confirmed correction is not visible through BAP read endpoint.');
const correctionImpacts = await request(`/businesses/${businessId}/corrections/${correction.id}/impacts`);
assert(correctionImpacts.impacts.length >= 2, 'Correction impacts are not visible through BAP read endpoint.');
remember('human correction invalidation and BAP impact readback', { correction_id: correction.id, impacts: correctionImpacts.impacts });

const staleConnectorId = `conn_${generateId()}`;
const staleSignalId = `sig_${generateId()}`;
db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, last_sync, created_at) VALUES (?, ?, 'gsc', 'Verifier GSC', 'stale', datetime('now','-3 days'), CURRENT_TIMESTAMP)`).run(staleConnectorId, businessId);
db.prepare(`INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, description, data, status, lifecycle_status, confidence, created_at) VALUES (?, ?, ?, 'live-verifier-ranking-drop', 'risk', 'warning', 'Verifier ranking drop', 'Connector freshness should drive stale and reopen transitions.', '{}', 'open', 'open', 0.8, CURRENT_TIMESTAMP)`).run(staleSignalId, businessId, staleConnectorId);
const staleResult = evaluateSignalLifecycle(businessId);
assert(staleResult.changed >= 1, 'Signal lifecycle evaluator did not mark stale connector evidence stale.');
let signalDetail = await request(`/signals/${staleSignalId}`);
assert(signalDetail.signal.lifecycle_status === 'stale', 'BAP signal detail did not expose stale lifecycle status.');

db.prepare("UPDATE connectors SET status = 'connected', last_sync = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?").run(staleConnectorId);
const reopenedResult = evaluateSignalLifecycle(businessId);
assert(reopenedResult.changed >= 1, 'Signal lifecycle evaluator did not reopen signal after connector evidence became fresh.');
signalDetail = await request(`/signals/${staleSignalId}`);
assert(signalDetail.signal.lifecycle_status === 'open', 'BAP signal detail did not expose reopened lifecycle status.');
remember('signal lifecycle stale-to-open re-evaluation with BAP readback', {
  stale_changed: staleResult.changed,
  reopened_changed: reopenedResult.changed,
  lifecycle_status: signalDetail.signal.lifecycle_status,
  lifecycle_reason: signalDetail.signal.lifecycle_reason,
});
const policyId = 'policy_live_trust_autonomy';
db.prepare(`INSERT INTO measurement_policies (id, business_id, name, action_type, checkpoints_json, final_day, connector_freshness_hours, active, created_at, updated_at) VALUES (?, ?, 'Live verifier checkpoints', 'github_issue', '[0,1,7]', 7, 48, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(policyId, businessId);
db.prepare('UPDATE tasks SET measurement_policy_id = ?, target_metric_baseline = NULL WHERE id = ?').run(policyId, validTask.task_id);
const scheduled = scheduleOutcomeMeasurements(validTask.task_id);
assert(scheduled === 3, `Expected 3 outcome checkpoints, scheduled ${scheduled}.`);
const scheduledAgain = scheduleOutcomeMeasurements(validTask.task_id);
assert(scheduledAgain === 0, 'Outcome checkpoint scheduling was not idempotent.');
const measurementPolicies = await request(`/businesses/${businessId}/measurement-policies`);
assert(measurementPolicies.policies.some((p: Record<string, unknown>) => p.id === policyId), 'Measurement policy is not readable through BAP.');
db.prepare("UPDATE outcome_measurement_runs SET checkpoint_at = datetime('now','-1 minute') WHERE task_id = ?").run(validTask.task_id);
const dueMeasurements = evaluateDueOutcomeMeasurements();
assert(dueMeasurements.changed >= 1, 'Due outcome measurement evaluator did not process scheduled checkpoints.');
const blockedMeasurement = db.prepare("SELECT state, verdict, diagnostic FROM outcome_measurement_runs WHERE task_id = ? AND state = 'blocked_by_missing_data' LIMIT 1").get(validTask.task_id) as Record<string, unknown> | undefined;
assert(blockedMeasurement?.verdict === 'blocked', 'Missing-baseline outcome was not marked blocked by missing data.');
remember('outcome policy read, idempotent scheduling and due blocked evaluation', { scheduled, scheduledAgain, dueMeasurements, blockedMeasurement });

recordProviderPreflight('live-verifier', 'unavailable-model', 'blocked', { evidence_status: 'blocked', diagnostic: 'Synthetic unavailable model for live verifier.' });
const preflights = await request('/provider-preflight?provider=live-verifier&model=unavailable-model');
assert(preflights.preflights[0]?.status === 'blocked', 'Provider preflight diagnostic was not exposed through BAP.');
remember('provider preflight diagnostic over BAP', preflights.preflights[0]);

const approvalPolicy = await request(`/businesses/${businessId}/approval-policies`);
assert(approvalPolicy.tiers.includes('orange') && approvalPolicy.tiers.includes('red'), 'Approval policy tiers are incomplete.');
remember('approval policy read over BAP', approvalPolicy);

const runId = `run_${generateId()}`;
db.prepare("INSERT INTO agent_runs (id, agent_id, business_id, trigger, trigger_id, status, started_at) VALUES (?, ?, ?, 'live-verifier', ?, 'running', CURRENT_TIMESTAMP)").run(runId, `bap:${agentId}`, businessId, 'live-verifier');
updateRunHeartbeat(runId, 60000);
const cancelResponse = await request(`/runs/${runId}/cancel`, {
  method: 'POST',
  idempotencyKey: generateId(),
  body: JSON.stringify({ reason: 'Live verifier cooperative cancellation check.' }),
});
assert(cancelResponse.status === 'cancellation_requested', 'BAP run cancellation did not request cooperative cancellation.');
assert(checkRunCancellation(runId), 'Run cancellation checkpoint does not observe the cancellation request.');
markRunCancelled(runId, 'Live verifier stopped at a cooperative safe point before new side effects.');
const cancelledRun = db.prepare('SELECT status, heartbeat_at, heartbeat_expires_at, cancellation_requested_at, cancellation_completed_at, terminal_reason FROM agent_runs WHERE id = ?').get(runId) as Record<string, unknown>;
const runEvents = db.prepare('SELECT event_type, status, summary FROM agent_run_events WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Array<Record<string, unknown>>;
assert(cancelledRun.status === 'cancelled', 'Run did not reach truthful cancelled terminal state.');
assert(runEvents.some((e) => e.event_type === 'cancellation_requested'), 'Cancellation request event was not recorded.');
assert(runEvents.some((e) => e.event_type === 'cancelled'), 'Cancellation completion event was not recorded.');
remember('BAP agent cancellation with heartbeat and structured events', { cancelResponse, cancelledRun, runEvents });
const scorecard = await request(`/businesses/${businessId}/scorecards?agent_id=${encodeURIComponent(internalAgentId)}&action_category=github_issue`);
assert(scorecard.scorecard.uncertainty.interval === 'wide', 'Scorecard did not preserve small-sample uncertainty.');
remember('agent scorecard read over BAP', scorecard.scorecard.uncertainty);

console.log(JSON.stringify({
  status: 'passed',
  base_url: baseUrl,
  business_id: businessId,
  checks,
}, null, 2));
