/**
 * Shared agent-activity recorder.
 *
 * Every LLM call Blueprint makes — chat, AI analysis, investigation,
 * scenarios, retrospectives, hiring analysis, goal reasoning — represents
 * work an agent did. They should all count towards that agent's "last seen"
 * timestamp and show up in the run history.
 *
 * Previously only scheduled cron-triggered agent runs got recorded, so the
 * sidebar showed "Conductor idle 2hrs ago" even though Conductor had just
 * run five strategic operations in the last minute.
 *
 * Usage:
 *   import { recordAgentActivity } from '../agents/activity.js';
 *   recordAgentActivity({
 *     agentId: 'conductor',
 *     businessId,
 *     trigger: 'scenario_modeling',
 *     reasoning: 'Modelled 4 scenarios for Q4 strategy question',
 *     usage: { input_tokens, output_tokens },
 *     cost_usd,
 *     status: 'complete',       // or 'failed'
 *     tasks_proposed: 0,
 *     signals_detected: 0,
 *     error: null,
 *   });
 *
 * Always returns the runId so callers can reference it in child records
 * (e.g. tasks link back via trigger_id).
 */

import db, { generateId } from '../db/db.js';
import type { ActivityRecord } from './agent.interface.js';

export function recordAgentActivity({
  agentId = 'conductor',
  businessId,
  trigger,
  triggerId = null,
  reasoning = null,
  usage = {},
  cost_usd = 0,
  status = 'complete',
  tasks_proposed = 0,
  signals_detected = 0,
  error = null,
  startedAt = null,
}: ActivityRecord & { agentId?: string }): string | null {
  if (!businessId || !trigger) return null;

  const runId = generateId();
  const started = startedAt || new Date().toISOString();

  try {
    // Only record against agents that exist in the DB; silently no-op
    // otherwise so brain modules can be called for any business safely.
    const agentExists = db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId) as { 1: number } | null;
    if (!agentExists) return null;

    db.prepare(`
      INSERT INTO agent_runs (
        id, agent_id, business_id, trigger, trigger_id, status, reasoning,
        signals_detected, tasks_proposed,
        prompt_tokens, completion_tokens, cost_usd,
        error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      runId, agentId, businessId, trigger, triggerId, status, reasoning,
      signals_detected, tasks_proposed,
      usage.input_tokens ?? 0, usage.output_tokens ?? 0, cost_usd,
      error,
      started,
    );

    if (status === 'complete') {
      db.prepare('UPDATE agents SET last_run = CURRENT_TIMESTAMP WHERE id = ?').run(agentId);
    }
  } catch (err) {
    console.warn(`[activity] Failed to record run for ${agentId} trigger=${trigger}:`, (err as Error).message);
    return null;
  }

  return runId;
}
