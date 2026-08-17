/**
 * Retrospective evidence analysis (issue #73).
 *
 * The deterministic half of "retrospectives that produce operating changes".
 * retrospective-engine.ts already produces an honest LLM narrative about a
 * period. This module answers the narrower question that must be answered
 * from records rather than prose:
 *
 *   For this business and this period, which action types and which agents
 *   have ENOUGH measured outcomes to justify changing how Blueprint
 *   operates — and where do the records disagree?
 *
 * Three rules govern everything here, because a retrospective that proposes
 * operating changes is exactly the place where a plausible-sounding causal
 * story does the most damage:
 *
 *  1. NO SAMPLE, NO PROPOSAL. Below MIN_OUTCOME_SAMPLE measured outcomes the
 *     result is an EvidenceGap, never a low-confidence proposal. "We do not
 *     have enough data to say" is a finding; a guess dressed up with a
 *     confidence score is not.
 *
 *  2. DISAGREEMENT IS NOT AN AVERAGE. When a meaningful minority of outcomes
 *     point the other way — or another business's outcomes for the same
 *     action type point the other way — that is reported as a Conflict and
 *     the direction is NOT collapsed into a mean. Averaging "helped here,
 *     hurt there" into "mildly helped" is how a system talks itself into a
 *     change nobody's data supports.
 *
 *  3. EVIDENCE IS NOT CAUSATION. A clean directional signal earns
 *     'evidence_backed', which means "the records show this pattern" — never
 *     "changing this will fix it". Anything without that sample earns
 *     'hypothesis', which is a proposal to TRY something, and says so.
 *
 * Every number produced here carries the record ids it came from, so a
 * proposal downstream can cite them.
 */
import db from '../db/db.js';
import {
  knownField, unknownField, type ComparableField,
} from './comparison-engine.js';

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Minimum measured outcomes before a directional claim may be made at all.
 * Three is not a statistical bar — it is the point below which a single
 * unlucky measurement flips the conclusion, which is the failure mode that
 * matters when the output is a change to how the system operates.
 */
export const MIN_OUTCOME_SAMPLE = 3;

/**
 * Share of outcomes pointing the opposite way at or above which the evidence
 * is treated as CONFLICTING rather than as a clear direction with noise.
 * One in three is deliberately strict: the cost of proposing a change on
 * genuinely mixed data is higher than the cost of saying "these disagree".
 */
export const CONFLICT_MINORITY_SHARE = 1 / 3;

/** Share of outcomes that must point one way for a direction to be claimed. */
export const DIRECTION_MAJORITY_SHARE = 0.6;

// ─── Cited records ───────────────────────────────────────────────────────────

export type CitedRecordKind =
  | 'task' | 'task_outcome' | 'decision' | 'agent_trial' | 'agent_installation'
  | 'playbook_version' | 'operating_policy';

export interface CitedRecord {
  kind: CitedRecordKind;
  /** Primary key in that table. A reader can go and look at the row. */
  id: string;
  /** What this specific row says, in one line. */
  summary: string;
}

// ─── Outcome direction ───────────────────────────────────────────────────────

export type OutcomeDirection = 'positive' | 'negative' | 'neutral';

/** task_outcomes.verdict vocabulary — see server/tasks/outcome-status.ts. */
function directionOfVerdict(verdict: string | null): OutcomeDirection | null {
  switch (verdict) {
    case 'improved': return 'positive';
    case 'worsened': return 'negative';
    case 'no_change': return 'neutral';
    default: return null;
  }
}

export interface OutcomeTally {
  positive: CitedRecord[];
  negative: CitedRecord[];
  neutral: CitedRecord[];
  /** Only outcomes with a usable verdict. Unmeasured rows are excluded. */
  measured_total: number;
  /** Mean change_pct across rows that recorded one, or null. */
  mean_change_pct: number | null;
  change_pct_sample: number;
}

function emptyTally(): OutcomeTally {
  return {
    positive: [], negative: [], neutral: [],
    measured_total: 0, mean_change_pct: null, change_pct_sample: 0,
  };
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

export type ConflictKind = 'within_business_outcomes' | 'cross_business_outcomes';

export interface EvidenceConflict {
  kind: ConflictKind;
  subject: string;
  /** Why these records cannot honestly be reduced to one direction. */
  detail: string;
  /** Records supporting each side, so a reader can judge for themselves. */
  supporting: CitedRecord[];
  opposing: CitedRecord[];
  /** Set for cross_business_outcomes: the other business that disagrees. */
  other_business_id: string | null;
}

// ─── Evidence gaps ───────────────────────────────────────────────────────────

export type EvidenceGapReason =
  | 'no_measured_outcomes'
  | 'below_minimum_sample'
  | 'no_clear_direction'
  | 'no_installed_agents'
  | 'no_active_playbook'
  | 'subject_already_covered';

export interface EvidenceGap {
  subject: string;
  reason: EvidenceGapReason;
  /** Plain English, naming the numbers — never a bare "insufficient data". */
  detail: string;
  measured_outcomes: number;
  required_outcomes: number;
}

// ─── Per-subject verdict ─────────────────────────────────────────────────────

export type EvidenceBasis = 'evidence_backed' | 'hypothesis' | 'conflicting_evidence';

export interface SubjectEvidence {
  subject: string;
  tally: OutcomeTally;
  /** null when there is no honest direction to report. */
  direction: OutcomeDirection | null;
  basis: EvidenceBasis;
  basis_reason: string;
  conflicts: EvidenceConflict[];
  cited_records: CitedRecord[];
  /**
   * The measured effect, #66-style: known with a citation, or unknown with
   * a specific reason. Never a fabricated zero.
   *
   * Kept as a bag of named counts rather than a fixed shape because the
   * countable thing differs by subject — outcome verdicts for an action
   * type, trial results for an agent — and forcing both into one struct
   * would mean writing zeroes for fields that were never measured, which is
   * exactly the fabrication ComparableField exists to prevent.
   */
  measured_effect: ComparableField<Record<string, number | null>>;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

interface OutcomeRow {
  outcome_id: string;
  task_id: string;
  business_id: string;
  title: string | null;
  action_type: string | null;
  proposed_by: string | null;
  verdict: string | null;
  change_pct: number | null;
  target_metric: string | null;
  check_date: string | null;
}

function loadOutcomes(businessId: string, startIso: string, endIso: string): OutcomeRow[] {
  return db.prepare(`
    SELECT o.id AS outcome_id, o.task_id, t.business_id, t.title, t.action_type,
           t.proposed_by, o.verdict, o.change_pct, t.target_metric, o.check_date
      FROM task_outcomes o
      JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ? AND o.check_date BETWEEN ? AND ?
     ORDER BY o.check_date ASC
  `).all(businessId, startIso, endIso) as OutcomeRow[];
}

/**
 * The same query for every OTHER business, used only to detect cross-business
 * disagreement. Deliberately not used to strengthen a conclusion: another
 * business's outcomes can contradict this one's, never vouch for it.
 */
function loadOtherBusinessOutcomes(
  businessId: string, startIso: string, endIso: string,
): OutcomeRow[] {
  return db.prepare(`
    SELECT o.id AS outcome_id, o.task_id, t.business_id, t.title, t.action_type,
           t.proposed_by, o.verdict, o.change_pct, t.target_metric, o.check_date
      FROM task_outcomes o
      JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id != ? AND o.check_date BETWEEN ? AND ?
  `).all(businessId, startIso, endIso) as OutcomeRow[];
}

function citeOutcome(row: OutcomeRow): CitedRecord {
  const pct = row.change_pct == null
    ? 'no change_pct recorded'
    : `${row.change_pct > 0 ? '+' : ''}${row.change_pct.toFixed(1)}%`;
  return {
    kind: 'task_outcome',
    id: row.outcome_id,
    summary:
      `task "${row.title ?? row.task_id}" (${row.action_type ?? 'no action_type'}) ` +
      `measured '${row.verdict ?? 'no verdict'}' (${pct}) on ` +
      `${row.target_metric ?? 'no target metric'} at ${row.check_date ?? 'unknown date'}`,
  };
}

function tallyOf(rows: OutcomeRow[]): OutcomeTally {
  const tally = emptyTally();
  let pctSum = 0;
  for (const row of rows) {
    const direction = directionOfVerdict(row.verdict);
    if (direction === null) continue;
    tally[direction].push(citeOutcome(row));
    tally.measured_total++;
    if (row.change_pct != null && Number.isFinite(row.change_pct)) {
      pctSum += row.change_pct;
      tally.change_pct_sample++;
    }
  }
  tally.mean_change_pct = tally.change_pct_sample > 0
    ? pctSum / tally.change_pct_sample
    : null;
  return tally;
}

/**
 * Turn a tally into an honest verdict. This is the single place the
 * insufficient-evidence and conflicting-evidence rules are applied, so no
 * caller can accidentally reach a stronger conclusion than the records
 * support.
 */
function assessTally(
  subject: string,
  tally: OutcomeTally,
  crossBusinessConflicts: EvidenceConflict[],
): SubjectEvidence {
  const cited = [...tally.negative, ...tally.positive, ...tally.neutral];
  const conflicts = [...crossBusinessConflicts];

  if (tally.measured_total === 0) {
    return {
      subject, tally, direction: null,
      basis: 'hypothesis',
      basis_reason:
        `No outcome for ${subject} was measured in this period, so nothing here is evidence. ` +
        'Any change on this subject is a hypothesis to test, not a finding.',
      conflicts, cited_records: cited,
      measured_effect: unknownField(
        `No task_outcomes row with a usable verdict exists for ${subject} in this period.`,
      ),
    };
  }

  const effect = knownField(
    {
      positive: tally.positive.length,
      negative: tally.negative.length,
      neutral: tally.neutral.length,
      measured_total: tally.measured_total,
      mean_change_pct: tally.mean_change_pct,
    },
    `task_outcomes (${tally.measured_total} measured verdict(s) for ${subject})`,
  );

  if (tally.measured_total < MIN_OUTCOME_SAMPLE) {
    return {
      subject, tally, direction: null,
      basis: 'hypothesis',
      basis_reason:
        `Only ${tally.measured_total} measured outcome(s) for ${subject}; ` +
        `${MIN_OUTCOME_SAMPLE} are required before a direction is claimed. ` +
        'Treated as a hypothesis, not evidence.',
      conflicts, cited_records: cited, measured_effect: effect,
    };
  }

  const positiveShare = tally.positive.length / tally.measured_total;
  const negativeShare = tally.negative.length / tally.measured_total;
  const minorityShare = Math.min(positiveShare, negativeShare);

  // Genuine disagreement inside this business's own records.
  if (tally.positive.length > 0 && tally.negative.length > 0
      && minorityShare >= CONFLICT_MINORITY_SHARE) {
    conflicts.push({
      kind: 'within_business_outcomes',
      subject,
      detail:
        `${tally.positive.length} of ${tally.measured_total} measured outcomes for ${subject} improved ` +
        `while ${tally.negative.length} worsened. These are reported as a conflict rather than averaged: ` +
        'the records genuinely disagree about whether this helps.',
      supporting: tally.positive,
      opposing: tally.negative,
      other_business_id: null,
    });
    return {
      subject, tally, direction: null,
      basis: 'conflicting_evidence',
      basis_reason:
        `Outcomes for ${subject} point both ways (${tally.positive.length} improved, ` +
        `${tally.negative.length} worsened, ${tally.neutral.length} unchanged) and were not averaged into a single direction.`,
      conflicts, cited_records: cited, measured_effect: effect,
    };
  }

  if (conflicts.length > 0) {
    return {
      subject, tally,
      direction: null,
      basis: 'conflicting_evidence',
      basis_reason:
        `This business's own outcomes for ${subject} lean one way, but another business's outcomes for the ` +
        'same action type point the other way. Surfaced as a conflict rather than resolved by this retrospective.',
      conflicts, cited_records: cited, measured_effect: effect,
    };
  }

  if (negativeShare >= DIRECTION_MAJORITY_SHARE) {
    return {
      subject, tally, direction: 'negative',
      basis: 'evidence_backed',
      basis_reason:
        `${tally.negative.length} of ${tally.measured_total} measured outcomes for ${subject} worsened ` +
        `(${(negativeShare * 100).toFixed(0)}%). This is what the records show; it is not a claim about why.`,
      conflicts, cited_records: cited, measured_effect: effect,
    };
  }

  if (positiveShare >= DIRECTION_MAJORITY_SHARE) {
    return {
      subject, tally, direction: 'positive',
      basis: 'evidence_backed',
      basis_reason:
        `${tally.positive.length} of ${tally.measured_total} measured outcomes for ${subject} improved ` +
        `(${(positiveShare * 100).toFixed(0)}%). This is what the records show; it is not a claim about why.`,
      conflicts, cited_records: cited, measured_effect: effect,
    };
  }

  return {
    subject, tally, direction: 'neutral',
    basis: 'evidence_backed',
    basis_reason:
      `Outcomes for ${subject} were mostly unchanged (${tally.neutral.length} of ${tally.measured_total}); ` +
      'no direction is claimed in either direction.',
    conflicts, cited_records: cited, measured_effect: effect,
  };
}

/**
 * Dominant direction of a set of rows, or null when there isn't one. Used
 * only for the cross-business comparison, where the question is narrow:
 * "does somebody else's data point the other way?"
 */
function dominantDirection(rows: OutcomeRow[]): { direction: OutcomeDirection; records: CitedRecord[] } | null {
  const tally = tallyOf(rows);
  if (tally.measured_total < MIN_OUTCOME_SAMPLE) return null;
  const positiveShare = tally.positive.length / tally.measured_total;
  const negativeShare = tally.negative.length / tally.measured_total;
  if (negativeShare >= DIRECTION_MAJORITY_SHARE) return { direction: 'negative', records: tally.negative };
  if (positiveShare >= DIRECTION_MAJORITY_SHARE) return { direction: 'positive', records: tally.positive };
  return null;
}

// ─── Period evidence ─────────────────────────────────────────────────────────

export interface PeriodEvidence {
  business_id: string;
  period_start: string;
  period_end: string;
  /** Keyed by action_type. */
  by_action_type: Map<string, SubjectEvidence>;
  /** Keyed by agent id (proposed_by with any 'agent:' prefix stripped). */
  by_agent: Map<string, SubjectEvidence>;
  /** Subjects that were looked at and could not support a proposal. */
  gaps: EvidenceGap[];
  /** Every conflict found, across all subjects. */
  conflicts: EvidenceConflict[];
  total_measured_outcomes: number;
  total_completed_tasks: number;
}

/**
 * Gather and assess everything this period offers, with no writes.
 */
export function gatherPeriodEvidence(
  businessId: string, periodStart: Date, periodEnd: Date,
): PeriodEvidence {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const outcomes = loadOutcomes(businessId, startIso, endIso);
  const otherOutcomes = loadOtherBusinessOutcomes(businessId, startIso, endIso);

  const completed = (db.prepare(
    'SELECT COUNT(*) AS n FROM tasks WHERE business_id = ? AND completed_at BETWEEN ? AND ?',
  ).get(businessId, startIso, endIso) as { n: number } | undefined)?.n ?? 0;

  // Group this business's outcomes.
  const byActionRows = new Map<string, OutcomeRow[]>();
  const byAgentRows = new Map<string, OutcomeRow[]>();
  for (const row of outcomes) {
    const actionType = (row.action_type ?? '').trim();
    if (actionType !== '') {
      const list = byActionRows.get(actionType) ?? [];
      list.push(row);
      byActionRows.set(actionType, list);
    }
    const agent = (row.proposed_by ?? '').replace(/^agent:/, '').trim();
    if (agent !== '') {
      const list = byAgentRows.get(agent) ?? [];
      list.push(row);
      byAgentRows.set(agent, list);
    }
  }

  // Group other businesses' outcomes as action_type -> business -> rows, for
  // the cross-business conflict check. Nested rather than a composite string
  // key: business ids and action types are both free-form, so any separator
  // character could in principle appear inside one of them.
  const otherByAction = new Map<string, Map<string, OutcomeRow[]>>();
  for (const row of otherOutcomes) {
    const actionType = (row.action_type ?? '').trim();
    if (actionType === '') continue;
    let byBusiness = otherByAction.get(actionType);
    if (!byBusiness) { byBusiness = new Map(); otherByAction.set(actionType, byBusiness); }
    const list = byBusiness.get(row.business_id) ?? [];
    list.push(row);
    byBusiness.set(row.business_id, list);
  }

  const gaps: EvidenceGap[] = [];
  const allConflicts: EvidenceConflict[] = [];

  const byActionType = new Map<string, SubjectEvidence>();
  for (const [actionType, rows] of byActionRows) {
    const ownTally = tallyOf(rows);
    const ownDominant = dominantDirection(rows);

    // Cross-business disagreement: another business measured the SAME action
    // type going the other way with its own sufficient sample.
    const crossConflicts: EvidenceConflict[] = [];
    if (ownDominant && ownDominant.direction !== 'neutral') {
      for (const [otherBusinessId, otherRows] of otherByAction.get(actionType) ?? []) {
        const otherDominant = dominantDirection(otherRows);
        if (!otherDominant || otherDominant.direction === 'neutral') continue;
        if (otherDominant.direction === ownDominant.direction) continue;
        crossConflicts.push({
          kind: 'cross_business_outcomes',
          subject: actionType,
          detail:
            `For '${actionType}', this business's ${ownTally.measured_total} measured outcome(s) point ` +
            `'${ownDominant.direction}', while business '${otherBusinessId}' measured the same action type ` +
            `pointing '${otherDominant.direction}'. The two are reported side by side rather than pooled: ` +
            'what works for one business is not evidence about another.',
          supporting: ownDominant.records,
          opposing: otherDominant.records,
          other_business_id: otherBusinessId,
        });
      }
    }

    const assessment = assessTally(actionType, ownTally, crossConflicts);
    byActionType.set(actionType, assessment);
    allConflicts.push(...assessment.conflicts);

    if (assessment.basis === 'hypothesis') {
      gaps.push({
        subject: actionType,
        reason: ownTally.measured_total === 0 ? 'no_measured_outcomes' : 'below_minimum_sample',
        detail: assessment.basis_reason,
        measured_outcomes: ownTally.measured_total,
        required_outcomes: MIN_OUTCOME_SAMPLE,
      });
    } else if (assessment.basis === 'evidence_backed' && assessment.direction === 'neutral') {
      gaps.push({
        subject: actionType,
        reason: 'no_clear_direction',
        detail: assessment.basis_reason,
        measured_outcomes: ownTally.measured_total,
        required_outcomes: MIN_OUTCOME_SAMPLE,
      });
    }
  }

  const byAgent = new Map<string, SubjectEvidence>();
  for (const [agentId, rows] of byAgentRows) {
    const assessment = assessTally(`agent '${agentId}'`, tallyOf(rows), []);
    byAgent.set(agentId, assessment);
    for (const conflict of assessment.conflicts) {
      if (!allConflicts.includes(conflict)) allConflicts.push(conflict);
    }
  }

  return {
    business_id: businessId,
    period_start: startIso,
    period_end: endIso,
    by_action_type: byActionType,
    by_agent: byAgent,
    gaps,
    conflicts: allConflicts,
    total_measured_outcomes: outcomes.filter((o) => directionOfVerdict(o.verdict) !== null).length,
    total_completed_tasks: completed,
  };
}
