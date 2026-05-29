/**
 * Activation service — the single bracket that turns an allowed activation into
 * an audited, lifecycle-tracked agent run.
 *
 * Responsibilities for every activation:
 *   1. Record an `agent_activations` row (trigger source, matched areas,
 *      selection reason, alternatives, confidence, evidence).
 *   2. Drive the lifecycle: standby → triggered → working → (verified|standby).
 *   3. On failure, route through blockAgent() so a cooldown is set and the
 *      agent does NOT retry endlessly. On a clean run, record success.
 *   4. Emit an SSE `agent_activated` event so the sidebar updates live.
 *
 * This is intentionally thin and dependency-injectable: the actual run is
 * delegated to a `runner` (defaults to agent-runner.runAgent) so tests can
 * exercise the lifecycle/guardrail behaviour without the LLM.
 */

import db from '../db/db.js';
import {
  getLifecycleState,
  transitionAgent,
  blockAgent,
  recordAgentSuccess,
  BUSY_STATES,
  type AgentLifecycleState,
} from './agentLifecycle.js';
import { recordActivation } from './agentMatcher.js';
import type { ActivationChannel } from './agentActivationRules.js';

export interface RunWithActivationInput {
  agentId: string;
  businessId: string;
  channel: ActivationChannel;
  /** Trigger string passed to the underlying runner (e.g. 'signal', 'manual'). */
  trigger: string;
  triggerRef?: string | null;
  matchedAreas: string[];
  selectionReason: string;
  alternatives?: Array<{ agent_id: string; reason: string }>;
  confidence?: number | null;
  evidence?: unknown[];
  /** Injected runner — defaults to agent-runner.runAgent. */
  runner?: (agentId: string, businessId: string, trigger: string, triggerId: string | null) => Promise<unknown>;
}

interface RunnerResult {
  runId?: string | null;
  skipped?: boolean;
  tasksProposed?: number;
  [key: string]: unknown;
}

/**
 * Whether the agent has gathered evidence in this activation. The spec requires
 * evidence before an agent can be considered to have completed real work; we
 * treat "produced at least one task or detected a signal, OR carried explicit
 * evidence into the activation" as the evidence bar.
 */
function hasEvidence(input: RunWithActivationInput, result: RunnerResult): boolean {
  if (Array.isArray(input.evidence) && input.evidence.length > 0) return true;
  if ((result.tasksProposed ?? 0) > 0) return true;
  if (typeof result['signalsDetected'] === 'number' && (result['signalsDetected'] as number) > 0) return true;
  return false;
}

export async function runWithActivation(input: RunWithActivationInput): Promise<RunnerResult> {
  const runner = input.runner
    ?? (async (a: string, b: string, t: string, id: string | null) => {
      const { runAgent } = await import('./agent-runner.js');
      return runAgent(a, b, t, id);
    });

  // 1. Move standby → triggered (if we're in standby). Other live states are
  //    tolerated (manual re-runs); only illegal transitions throw.
  const startState = getLifecycleState(input.agentId);
  if (startState === 'standby') {
    try {
      transitionAgent(input.agentId, 'triggered', `activation:${input.channel}`, {
        businessId: input.businessId,
        reason: input.selectionReason,
        patch: { last_activation_reason: input.selectionReason, confidence: input.confidence ?? null },
      });
    } catch (err) {
      console.warn('[activation] triggered transition failed (continuing):', (err as Error).message);
    }
  }

  // 2. Record the activation audit row.
  const activationId = recordActivation({
    agentId: input.agentId,
    businessId: input.businessId,
    triggerSource: input.channel,
    triggerRef: input.triggerRef ?? null,
    matchedAreas: input.matchedAreas,
    selectionReason: input.selectionReason,
    alternatives: input.alternatives,
    confidence: input.confidence ?? null,
    evidence: input.evidence ?? [],
  });

  // 3. Emit SSE so the sidebar reflects the activation immediately.
  try {
    const { pushDashboardEvent } = await import('../lib/sse-bus.js');
    pushDashboardEvent(input.businessId, 'agent_activated', {
      agentId: input.agentId, channel: input.channel, reason: input.selectionReason,
      matchedAreas: input.matchedAreas, confidence: input.confidence ?? null, activationId,
    });
  } catch { /* non-fatal */ }

  // 4. triggered → assigned → working (the matcher assigned the work; the
  //    agent now picks it up and begins). We walk the legal path step by step.
  try {
    if (getLifecycleState(input.agentId) === 'triggered') {
      transitionAgent(input.agentId, 'assigned', `activation:${input.channel}`, {
        businessId: input.businessId, reason: 'Work assigned by the matcher.',
        patch: { current_task_id: input.triggerRef ?? null },
      });
    }
    if (getLifecycleState(input.agentId) === 'assigned') {
      transitionAgent(input.agentId, 'working', `activation:${input.channel}`, {
        businessId: input.businessId, reason: 'Beginning work.',
      });
    }
  } catch (err) {
    console.warn('[activation] working transition failed (continuing):', (err as Error).message);
  }

  // 5. Run the agent.
  let result: RunnerResult;
  try {
    result = (await runner(input.agentId, input.businessId, input.trigger, input.triggerRef ?? null)) as RunnerResult;
  } catch (err) {
    // Failure → block + cooldown so it doesn't retry endlessly.
    blockAgent(input.agentId, `activation:${input.channel}`, `Run failed: ${(err as Error).message}`.slice(0, 300), {
      businessId: input.businessId,
    });
    // Link the activation to the (failed) run id if we have one — none here.
    throw err;
  }

  // 6. Settle the lifecycle. A skipped run (gated by readiness/work-check)
  //    returns to standby without counting as success or failure. A productive
  //    run with evidence → verified → standby; a productive run without
  //    evidence still returns to standby (no false "completed").
  try {
    if (result.runId) {
      db.prepare('UPDATE agent_activations SET run_id = ? WHERE id = ?').run(result.runId, activationId);
    }
    const s = getLifecycleState(input.agentId);
    if (s && (BUSY_STATES as readonly string[]).includes(s)) {
      if (result.skipped) {
        transitionAgent(input.agentId, 'standby', `activation:${input.channel}`, {
          businessId: input.businessId, reason: 'Run skipped (nothing actionable) — returning to standby.',
          patch: { current_task_id: null },
        });
      } else if (hasEvidence(input, result)) {
        // working → completed → verified → standby
        const transitions: AgentLifecycleState[] = ['completed', 'verified', 'standby'];
        for (const next of transitions) {
          const cur = getLifecycleState(input.agentId);
          if (!cur) break;
          try { transitionAgent(input.agentId, next, `activation:${input.channel}`, { businessId: input.businessId, reason: `Run finished (${next}).` }); }
          catch { break; }
        }
        recordAgentSuccess(input.agentId);
      } else {
        transitionAgent(input.agentId, 'standby', `activation:${input.channel}`, {
          businessId: input.businessId, reason: 'Run completed with no actionable evidence — returning to standby.',
          patch: { current_task_id: null },
        });
        recordAgentSuccess(input.agentId);
      }
    }
  } catch (err) {
    console.warn('[activation] settle transition failed (non-fatal):', (err as Error).message);
  }

  return result;
}
