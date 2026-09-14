/**
 * The first executable golden path: ecommerce traffic/conversion recovery.
 *
 * This creates a proposed typed action only. Approval, connector confidence,
 * execution receipts, rollback data, and outcome measurement remain owned by
 * their existing subsystems.
 */
import db, { generateId } from '../db/db.js';
import { getOrCreateBusinessProfile } from '../business/business-profile.js';
import { createTask, type TaskRow } from '../tasks/task-queue.js';
import { createTaskEvent } from '../tasks/task-events.js';

const TRAFFIC_TERMS = /traffic|session|conversion|bounce|search|seo|click|ranking/i;

export interface TrafficRecoveryInput {
  product_id: string;
  proposed_description: string;
  title?: string;
}

export interface TrafficRecoveryProposal {
  task: TaskRow;
  rationale: {
    signal_id: string;
    signal_title: string;
    signal_confidence: number | null;
    source_connector: string | null;
    target_metric: string;
    approval_required: true;
  };
  idempotent: boolean;
}

function signalQualifies(signal: { type: string; title: string; description: string | null }): boolean {
  const typeIsActionable = /anomaly|risk|opportunity|quick_win/i.test(signal.type);
  return typeIsActionable && TRAFFIC_TERMS.test(`${signal.type} ${signal.title} ${signal.description ?? ''}`);
}

export function createTrafficRecoveryProposal(
  businessId: string, signalId: string, input: TrafficRecoveryInput,
): TrafficRecoveryProposal | { error: string; code: string } {
  const signal = db.prepare(`
    SELECT s.id, s.business_id, s.type, s.title, s.description, s.confidence,
           c.type AS connector_type
    FROM signals s LEFT JOIN connectors c ON c.id = s.connector_id
    WHERE s.id = ? AND s.business_id = ?
  `).get(signalId, businessId) as {
    id: string; business_id: string; type: string; title: string;
    description: string | null; confidence: number | null; connector_type: string | null;
  } | null;
  if (!signal) return { code: 'signal_not_found', error: 'Signal not found.' };
  if (!signalQualifies(signal)) return { code: 'not_traffic_signal', error: 'This signal is not a traffic or conversion recovery candidate.' };

  const profile = getOrCreateBusinessProfile(businessId);
  if (profile?.business_type !== 'ecommerce') {
    return { code: 'business_type_not_supported', error: 'Traffic recovery actions are currently limited to ecommerce businesses.' };
  }
  if (input.product_id.trim().length < 1) return { code: 'product_id_required', error: 'product_id is required.' };
  if (input.proposed_description.trim().length < 3) return { code: 'description_required', error: 'proposed_description must be at least 3 characters.' };

  const existing = db.prepare(`
    SELECT * FROM tasks
    WHERE business_id = ? AND signal_id = ? AND action_type = 'shopify_description_update'
      AND status NOT IN ('rejected', 'cancelled')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(businessId, signalId) as TaskRow | null;
  if (existing) {
    return {
      task: existing,
      rationale: { signal_id: signal.id, signal_title: signal.title, signal_confidence: signal.confidence, source_connector: signal.connector_type, target_metric: 'ga4.sessions', approval_required: true },
      idempotent: true,
    };
  }

  const task = createTask({
    business_id: businessId,
    signal_id: signalId,
    title: input.title?.trim() || `Recover traffic: update Shopify product description`,
    description: `Proposed from signal "${signal.title}". Update product ${input.product_id.trim()} with the approved description, then measure GA4 sessions and Shopify conversion rate at 7, 14, and 28 days.`,
    proposed_by: 'blueprint:traffic-recovery',
    action_type: 'shopify_description_update',
    action_payload: {
      product_id: input.product_id.trim(),
      proposed_description: input.proposed_description.trim(),
      source_signal_id: signal.id,
    },
    trust_tier: 'yellow',
    priority: signal.confidence != null && signal.confidence >= 0.85 ? 'p1' : 'p2',
    confidence: signal.confidence,
    estimated_impact: 'Measure GA4 sessions and Shopify conversion rate after the product description change.',
    approval_mode: 'requires_approval',
  });
  if (!task) return { code: 'task_creation_failed', error: 'Could not create the traffic recovery task.' };

  createTaskEvent(task.id, 'created', 'blueprint:traffic-recovery', 'Traffic recovery action proposed from signal.', {
    signal_id: signal.id, action_type: 'shopify_description_update', target_metric: 'ga4.sessions', approval_required: true,
  });
  db.prepare(`UPDATE signals SET status = 'acknowledged' WHERE id = ? AND status = 'open'`).run(signal.id);

  return {
    task,
    rationale: { signal_id: signal.id, signal_title: signal.title, signal_confidence: signal.confidence, source_connector: signal.connector_type, target_metric: 'ga4.sessions', approval_required: true },
    idempotent: false,
  };
}
