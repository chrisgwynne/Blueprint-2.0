/**
 * Retention rules — the other half of the learning loop (#56).
 *
 * gates.ts uses measured outcomes to decide whether to HIRE. This module uses
 * the same business-scoped evidence to decide whether an agent already hired
 * is still worth keeping, so a persistently low- or negative-value agent is
 * surfaced rather than quietly accumulating cost forever.
 *
 * Deliberately advisory: it produces an explainable verdict per installed
 * agent, exposed on the hiring status contract. It does NOT auto-retire
 * anything — retiring an agent is a human decision, and the whole point of
 * this cluster of fixes is that autonomous actions need evidence and a
 * control plane, not more autonomy.
 */

import db from '../../db/db.js';
import { assertBusiness, getOutcomeHistory } from './store.js';
import type { OutcomeHistory } from './store.js';

export type RetentionVerdict = 'retain' | 'monitor' | 'downgrade' | 'retire';

export interface RetentionAssessment {
  agent_id: string;
  verdict: RetentionVerdict;
  reason: string;
  evidence: {
    installed_at: string | null;
    trials_total: number;
    successful: number;
    neutral: number;
    unsuccessful: number;
    insufficient_data: number;
    open: number;
    total_cost_usd: number;
    mean_calibration_error: number | null;
  };
}

/** Grace period before an agent with no measured outcome is even assessed. */
const GRACE_PERIOD_DAYS = 30;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / 86_400_000;
}

export function verdictFor(history: OutcomeHistory, ageDays: number | null): { verdict: RetentionVerdict; reason: string } {
  // Persistently negative: repeated measured failures with nothing to show.
  if (history.unsuccessful >= 2 && history.successful === 0) {
    return {
      verdict: 'retire',
      reason: `${history.unsuccessful} measured trials were unsuccessful and none succeeded — the evidence says this role does not pay off for this business.`,
    };
  }
  // Repeatedly produced nothing measurable at all.
  if (history.insufficient_data >= 3 && history.successful === 0) {
    return {
      verdict: 'retire',
      reason: `${history.insufficient_data} trials produced no measurable evidence and none succeeded.`,
    };
  }
  if (history.unsuccessful >= 1 && history.successful === 0) {
    return {
      verdict: 'downgrade',
      reason: `A measured trial was unsuccessful and none has succeeded yet — worth narrowing its scope before renewing it.`,
    };
  }
  if (history.successful > 0 && history.successful >= history.unsuccessful) {
    return {
      verdict: 'retain',
      reason: `${history.successful} measured trial${history.successful === 1 ? '' : 's'} succeeded (${history.unsuccessful} unsuccessful).`,
    };
  }
  if (history.open > 0) {
    return { verdict: 'monitor', reason: 'A trial is still inside its measurement window.' };
  }
  if (history.total === 0) {
    if (ageDays != null && ageDays > GRACE_PERIOD_DAYS) {
      return {
        verdict: 'downgrade',
        reason: `Hired ${Math.round(ageDays)} days ago with no trial on record — there is no evidence it has done anything useful.`,
      };
    }
    return { verdict: 'monitor', reason: 'Recently hired; inside the grace period, no outcome measured yet.' };
  }
  return { verdict: 'monitor', reason: 'Outcomes so far are neutral — not clearly valuable, not clearly harmful.' };
}

/**
 * Assess every agent THIS business has installed. Business-scoped throughout:
 * another business's outcomes can never influence this verdict.
 */
export function evaluateRetention(businessId: string): RetentionAssessment[] {
  assertBusiness(businessId);
  const installed = db.prepare(`
    SELECT agent_id, installed_at FROM agent_installations
     WHERE business_id = ? AND status = 'installed'
     ORDER BY installed_at ASC
  `).all(businessId) as Array<{ agent_id: string; installed_at: string | null }>;

  return installed.map((row) => {
    const history = getOutcomeHistory(businessId, row.agent_id);
    const { verdict, reason } = verdictFor(history, daysSince(row.installed_at));
    return {
      agent_id: row.agent_id,
      verdict,
      reason,
      evidence: {
        installed_at: row.installed_at,
        trials_total: history.total,
        successful: history.successful,
        neutral: history.neutral,
        unsuccessful: history.unsuccessful,
        insufficient_data: history.insufficient_data,
        open: history.open,
        total_cost_usd: history.total_cost_usd,
        mean_calibration_error: history.mean_calibration_error,
      },
    };
  });
}
