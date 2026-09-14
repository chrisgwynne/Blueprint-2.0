/**
 * Signal-to-outcome read model.
 *
 * Blueprint already stores each part of the evidence loop in its own
 * subsystem. This module deliberately does not create a second source of
 * truth; it joins those records into one auditable journey for a signal.
 */
import db from '../db/db.js';
import { listReceiptsForTask, toReceiptView } from '../tasks/action-receipts.js';
import { getCurrentWorldModel } from '../world-model/world-model.js';

export type EvidencePhase = 'detected' | 'proposed' | 'approved' | 'executed' | 'measured';

interface SignalRow {
  id: string;
  business_id: string;
  connector_id: string | null;
  connector_type: string | null;
  rule_id: string;
  type: string;
  severity: string;
  title: string;
  description: string | null;
  data: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
  resolved_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  proposed_by: string;
  action_type: string | null;
  status: string;
  priority: string | null;
  confidence: number | null;
  approval_mode: string | null;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  target_metric: string | null;
  target_metric_baseline: number | null;
  created_at: string;
  updated_at: string;
}

interface OutcomeRow {
  id: string;
  check_date: string;
  weeks_after: number;
  metric_value: number | null;
  baseline_value: number | null;
  change_pct: number | null;
  verdict: string | null;
  verdict_detail: string | null;
}

function parseJSON(value: string | null, fallback: unknown): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function hasExecutionReceipt(taskId: string): boolean {
  return listReceiptsForTask(taskId).some((receipt) =>
    ['executed', 'externally_acknowledged', 'verified'].includes(receipt.state)
  );
}

function phaseForTask(task: TaskRow, receipts: ReturnType<typeof listReceiptsForTask>, outcomes: OutcomeRow[]): EvidencePhase {
  if (outcomes.length > 0 || receipts.some((receipt) => receipt.state === 'verified')) return 'measured';
  if (hasExecutionReceipt(task.id) || task.completed_at || task.status === 'complete' || task.status === 'verified') return 'executed';
  if (task.approved_at || !['proposed', 'rejected'].includes(task.status)) return 'approved';
  return 'proposed';
}

export interface SignalJourney {
  signal: Record<string, unknown>;
  phases: Record<EvidencePhase, { reached: boolean; at: string | null }>;
  current_phase: EvidencePhase;
  next_step: string;
  tasks: Array<Record<string, unknown>>;
  world_model: ReturnType<typeof getCurrentWorldModel>;
  provenance: Array<{ kind: 'signal' | 'task' | 'receipt' | 'outcome' | 'world_model'; id: string; recorded_at: string | null }>;
}

export function getSignalJourney(businessId: string, signalId: string): SignalJourney | null {
  const signal = db.prepare(`
    SELECT s.*, c.type AS connector_type
    FROM signals s
    LEFT JOIN connectors c ON c.id = s.connector_id
    WHERE s.id = ? AND s.business_id = ?
  `).get(signalId, businessId) as SignalRow | null;
  if (!signal) return null;

  const tasks = db.prepare(`
    SELECT id, title, description, proposed_by, action_type, status, priority,
           confidence, approval_mode, approved_by, approved_at, started_at,
           completed_at, target_metric, target_metric_baseline, created_at, updated_at
    FROM tasks WHERE signal_id = ? AND business_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(signalId, businessId) as TaskRow[];

  const journeyTasks = tasks.map((task) => {
    const receipts = listReceiptsForTask(task.id);
    const outcomes = db.prepare(`
      SELECT id, check_date, weeks_after, metric_value, baseline_value,
             change_pct, verdict, verdict_detail
      FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC, rowid ASC
    `).all(task.id) as OutcomeRow[];
    const phase = phaseForTask(task, receipts, outcomes);
    return {
      ...task,
      receipts: receipts.map(toReceiptView),
      outcomes,
      phase,
      latest_outcome: outcomes.length ? outcomes[outcomes.length - 1] : null,
    };
  });

  const phaseOrder: EvidencePhase[] = ['detected', 'proposed', 'approved', 'executed', 'measured'];
  let currentPhase: EvidencePhase = 'detected';
  for (const phase of journeyTasks.map((task) => task.phase as EvidencePhase)) {
    if (phaseOrder.indexOf(phase) > phaseOrder.indexOf(currentPhase)) currentPhase = phase;
  }

  const phases = Object.fromEntries(phaseOrder.map((phase) => {
    const reached = phase === 'detected' || phaseOrder.indexOf(phase) <= phaseOrder.indexOf(currentPhase);
    const at = phase === 'detected'
      ? signal.created_at
      : journeyTasks
        .filter((task) => phaseOrder.indexOf(task.phase as EvidencePhase) >= phaseOrder.indexOf(phase))
        .map((task) => phase === 'proposed' ? task.created_at : phase === 'approved' ? task.approved_at : phase === 'executed' ? (task.completed_at ?? task.started_at) : task.latest_outcome?.check_date)
        .find(Boolean) ?? null;
    return [phase, { reached, at }];
  })) as Record<EvidencePhase, { reached: boolean; at: string | null }>;

  const nextStep = currentPhase === 'detected' ? 'Propose a task' :
    currentPhase === 'proposed' ? 'Review and approve a task' :
    currentPhase === 'approved' ? 'Execute the approved task' :
    currentPhase === 'executed' ? 'Wait for the scheduled measurement' :
    'Review the measured outcome';
  const worldModel = getCurrentWorldModel(businessId);
  const provenance: SignalJourney['provenance'] = [{ kind: 'signal', id: signal.id, recorded_at: signal.created_at }];
  for (const task of journeyTasks) {
    provenance.push({ kind: 'task', id: task.id, recorded_at: task.created_at });
    for (const receipt of task.receipts as Array<{ id: string; created_at?: string | null }>) provenance.push({ kind: 'receipt', id: receipt.id, recorded_at: receipt.created_at ?? null });
    for (const outcome of task.outcomes as OutcomeRow[]) provenance.push({ kind: 'outcome', id: outcome.id, recorded_at: outcome.check_date });
  }
  if (worldModel) provenance.push({ kind: 'world_model', id: `world-model:${businessId}`, recorded_at: worldModel.created_at ?? null });

  return {
    signal: { ...signal, data: parseJSON(signal.data, {}) },
    phases,
    current_phase: currentPhase,
    next_step: nextStep,
    tasks: journeyTasks,
    world_model: worldModel,
    provenance,
  };
}
