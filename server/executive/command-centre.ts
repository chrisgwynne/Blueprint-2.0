/**
 * Executive command centre — the cross-business decision view (issue #59).
 *
 * An executive assembling operating status today reads five surfaces and
 * does the joining by hand: the decision queue for what needs approving,
 * receipts for what actually changed, ROI for whether it was worth it,
 * connector health for whether any of it can be trusted, and the per-
 * business dashboard for everything else. This module does that join once,
 * for a selected set of businesses, and returns it in one shape.
 *
 * ─── What this is NOT ───────────────────────────────────────────────────────
 *
 * It computes almost nothing of its own. Every number here is produced by
 * the module that owns it, and this file only selects, ranks and labels:
 *
 *   listPendingDecisions()      #61  server/decisions/decision-queue.ts
 *   classifyOutcomeTaxonomy()   #63  server/tasks/outcome-taxonomy.ts
 *   computeROIReport()          #63  server/roi/attribution-engine.ts
 *   explainConnectorHealth()    #65  server/connectors/health.ts
 *   resolveOperatingPolicy()    #68  server/policy/operating-policy.ts
 *   listReceipts()              #70  server/tasks/action-receipts.ts
 *
 * Re-deriving any of those here would create a second opinion about the
 * same fact, and the command centre is precisely where two opinions would
 * be most damaging — this is the view an executive acts on.
 *
 * There is no new grouping concept either. A selection is an explicit list
 * of business ids; #68's existing policy portfolios can be named instead as
 * a shorthand, and are expanded to their member ids on the way in. No
 * "portfolio" is invented, stored or owned here.
 *
 * ─── Failure isolation ──────────────────────────────────────────────────────
 *
 * The rule this module exists to honour: loading one failed connector or
 * business must not hide unrelated results. That is enforced structurally,
 * not by convention — every section of every business is computed inside
 * section(), which converts a throw into a `status: 'failed'` envelope
 * carrying the error. A business whose ROI report throws still shows its
 * pending decisions; a business that is entirely unreadable still leaves
 * every other business in the selection intact.
 *
 * This mirrors what health.ts (#65) already does for connectors, one level
 * up: a single bad connector degrades its own row and nothing else.
 *
 * ─── Freshness ──────────────────────────────────────────────────────────────
 *
 * Every section carries two timestamps, deliberately distinct:
 *
 *   as_of       when this section was COMPUTED (always now)
 *   data_as_of  the newest SOURCE RECORD it is based on, or null
 *
 * Conflating them is how a dashboard comes to look current while showing
 * month-old data. A section computed one second ago from a receipt written
 * three weeks ago is three weeks old, and says so.
 *
 * ─── Evidence ───────────────────────────────────────────────────────────────
 *
 * Every item carries an EvidenceLink naming the real record it came from —
 * a task id, a receipt id, a connector id — and a route into the surface
 * that owns that record. Nothing here is a summary with no way back to the
 * thing it summarises.
 */
import db from '../db/db.js';
import { listPendingDecisions, type DecisionLane, type PendingDecision } from '../decisions/decision-queue.js';
import {
  classifyOutcomeTaxonomy, emptyTaxonomyCounts,
  type TaxonomyResult, type TaxonomyState,
} from '../tasks/outcome-taxonomy.js';
import { listReceipts, type ActionReceiptRow } from '../tasks/action-receipts.js';
import { computeROIReport } from '../roi/attribution-engine.js';
import { explainConnectorHealth, type ConnectorHealthState } from '../connectors/health.js';
import {
  getPolicyPortfolio, resolveOperatingPolicy, TIER_ORDER, tierRank,
  type ApprovalTier,
} from '../policy/operating-policy.js';
import type { Connector } from '../types/db.js';

// ─── Scope & authorization ───────────────────────────────────────────────────

/**
 * The businesses the current session may read.
 *
 * Blueprint's session model today is single-tenant: routes/auth.ts
 * authenticates one operator against one credential, and there is no
 * per-user business ACL table to consult (see server/db/schema.sql —
 * `businesses` has no owner column). So every business is accessible to an
 * authenticated session, and nothing is accessible without one.
 *
 * This is nonetheless funnelled through one function on purpose: when a
 * real ACL arrives, this is the single place that changes, and every
 * command-centre read is scoped by it already. Callers must never query
 * `businesses` directly to build a selection.
 */
export function listAccessibleBusinessIds(_actor: string): string[] {
  return (db.prepare('SELECT id FROM businesses ORDER BY name').all() as Array<{ id: string }>)
    .map((r) => r.id);
}

// ─── Envelopes ───────────────────────────────────────────────────────────────

export type SectionStatus = 'ok' | 'failed';

export interface SectionError {
  message: string;
  /** Stable-ish discriminator for the UI; never used for control flow here. */
  code: string;
}

/**
 * One independently-failing unit of the response. A failed section reports
 * why and leaves every sibling section untouched.
 */
export interface SectionEnvelope<T> {
  status: SectionStatus;
  /** When this section was computed. Always populated. */
  as_of: string;
  /** Newest source record this section is based on; null when it has none. */
  data_as_of: string | null;
  error: SectionError | null;
  data: T | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse a DB timestamp to epoch ms.
 *
 * Timestamp columns in this schema are one of two formats depending on
 * which migration wrote them: SQLite's `CURRENT_TIMESTAMP`
 * (`YYYY-MM-DD HH:MM:SS`, implicitly UTC, NO offset marker) or a JS
 * `toISOString()` value. Handing the first form to `new Date()` is
 * undefined behaviour — it is interpreted as LOCAL time, which silently
 * shifts every freshness figure by the host's UTC offset. A command centre
 * whose whole job is "how old is this?" cannot afford that, so every
 * comparison in this module goes through here.
 *
 * Same normalization as toIso() in server/bap/route-helpers.ts; not
 * imported from there because that module pulls in the BAP idempotency
 * middleware, and an executive read has no business depending on it.
 */
export function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw
    : raw.includes('T') ? `${raw}Z`
      : `${raw.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Newest of a set of DB timestamps, ignoring nulls and unparseable values. */
export function newestTimestamp(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = timestampMs(v);
    if (ms == null) continue;
    if (ms > bestMs) { bestMs = ms; best = v!; }
  }
  return best;
}

/**
 * Run one section's computation, converting any throw into a failed
 * envelope. This is the failure-isolation primitive the whole module rests
 * on: a section can only take itself down.
 */
export function section<T>(
  code: string,
  compute: () => { data: T; data_as_of: string | null },
): SectionEnvelope<T> {
  const as_of = nowIso();
  try {
    const { data, data_as_of } = compute();
    return { status: 'ok', as_of, data_as_of, error: null, data };
  } catch (err) {
    return {
      status: 'failed',
      as_of,
      data_as_of: null,
      error: {
        message: (err as Error)?.message ?? String(err),
        code,
      },
      data: null,
    };
  }
}

// ─── Evidence links ──────────────────────────────────────────────────────────

export type EvidenceKind =
  | 'decision' | 'task' | 'receipt' | 'connector' | 'roi_report' | 'outcome'
  // Added by #71's portfolio comparison, which drills into the same
  // business-scoped surfaces from a different framing. Kept in this one
  // builder so there is a single opinion about which route owns which record.
  | 'goal';

/**
 * A pointer back to the record a summary line was derived from. `id` is
 * always a real record id from the owning table — never synthesised, never
 * a composite — so a caller can fetch the record itself, and `href` opens
 * the surface that owns it.
 */
export interface EvidenceLink {
  kind: EvidenceKind;
  id: string;
  business_id: string;
  href: string;
  label: string;
}

export function evidenceLink(
  kind: EvidenceKind,
  id: string,
  businessId: string,
  label: string,
): EvidenceLink {
  const b = encodeURIComponent(businessId);
  const i = encodeURIComponent(id);
  const href =
    kind === 'decision' ? `/decision-centre?business=${b}&task=${i}`
      : kind === 'receipt' ? `/receipts?business=${b}&receipt=${i}`
        : kind === 'connector' ? `/connectors?business=${b}&connector=${i}`
          : kind === 'roi_report' ? `/roi?business=${b}`
            : kind === 'outcome' ? `/outcomes?business=${b}&task=${i}`
              : kind === 'goal' ? `/goals?business=${b}&goal=${i}`
                : `/tasks?business=${b}&task=${i}`;
  return { kind, id, business_id: businessId, href, label };
}

// ─── The five-state work ladder ──────────────────────────────────────────────

/**
 * The acceptance criterion is that the view "distinguishes proposed,
 * approved, executed, verified and outcome-measured work". Those five
 * states do not live in one table, and deliberately so:
 *
 *   proposed          a pending decision (#61) — no receipt exists yet
 *   approved          a receipt (#70) that reached `authorized` and no further
 *   executed          a receipt that ran; external acknowledgement counts here,
 *                     because an API accepting a write is NOT proof it took effect
 *   verified          a receipt whose `verified` stage was reached — an
 *                     independent later measurement confirmed the change
 *   outcome_measured  #63's taxonomy says a business outcome was actually
 *                     measured (improved, worsened or flat — all evidence)
 *
 * A task occupies exactly one bucket: the furthest state it has reached.
 * Collapsing "executed" into "verified" is the specific dishonesty #70
 * exists to prevent, and collapsing "verified" into "outcome_measured" is
 * the one #63 exists to prevent, so this ladder keeps all five apart.
 */
export type WorkState = 'proposed' | 'approved' | 'executed' | 'verified' | 'outcome_measured';

export const WORK_STATES: readonly WorkState[] = [
  'proposed', 'approved', 'executed', 'verified', 'outcome_measured',
];

export function emptyWorkStateCounts(): Record<WorkState, number> {
  return { proposed: 0, approved: 0, executed: 0, verified: 0, outcome_measured: 0 };
}

export interface WorkLadderItem {
  task_id: string;
  title: string;
  state: WorkState;
  /**
   * Which record put this task in this state. 'receipt' is stronger
   * evidence than 'task_status': a receipt records what actually happened
   * externally, a status is only what Blueprint believes. Reported so the
   * UI never presents the weaker one as if it were the stronger.
   */
  evidence_source: 'receipt' | 'task_status' | 'decision_queue' | 'outcome_measurement';
  reason: string;
  /** ISO timestamp of the event that put it here — the item's freshness. */
  occurred_at: string | null;
  evidence: EvidenceLink;
  /** #63's label for this task, kept alongside the ladder state, not merged into it. */
  taxonomy_state: TaxonomyState | null;
}

export interface WorkLadder {
  counts: Record<WorkState, number>;
  /**
   * #63's four-state taxonomy, reported in full and separately from the
   * ladder above. The two answer different questions ("how far did this
   * get?" vs "can a business outcome honestly be claimed?") and are never
   * summed together.
   */
  taxonomy_counts: Record<TaxonomyState, number>;
  /** Tasks that left the ladder without completing (rejected/cancelled/failed). */
  not_progressed: number;
  /** A bounded sample per state, newest first, each with an evidence link. */
  items: WorkLadderItem[];
  window_start: string;
  window_end: string;
}

interface LadderTaskRow {
  id: string;
  title: string;
  status: string;
  action_type: string | null;
  target_metric: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** Statuses that mean the task left the ladder without ever completing. */
const ABANDONED_STATUSES = new Set(['rejected', 'cancelled', 'failed']);

/**
 * The furthest ladder state a receipt attests to, read straight off the
 * stage timestamps #70 records. Returns null for receipts that never got
 * anywhere (rejected pre-execution, cancelled) — those are not ladder
 * progress and must not be counted as such.
 */
export function receiptLadderState(
  row: Pick<ActionReceiptRow, 'verified_at' | 'executed_at' | 'externally_acknowledged_at' | 'authorized_at' | 'state'>,
): { state: WorkState; at: string | null } | null {
  if (row.verified_at) return { state: 'verified', at: row.verified_at };
  if (row.executed_at) return { state: 'executed', at: row.executed_at };
  if (row.externally_acknowledged_at) return { state: 'executed', at: row.externally_acknowledged_at };
  if (row.authorized_at) return { state: 'approved', at: row.authorized_at };
  return null;
}

/**
 * Page through #70's receipt list until we pass the window boundary.
 *
 * listReceipts() orders by created_at DESC and caps a page at 200, so
 * walking pages until a row predates the window is both correct and
 * bounded. A hard page cap stops a business with an enormous receipt
 * history from turning one dashboard load into an unbounded scan — the
 * command centre is a bounded summary, and says so via the window.
 */
export function collectReceiptsSince(
  businessId: string,
  windowStart: string,
  maxPages = 5,
): ActionReceiptRow[] {
  const startMs = timestampMs(windowStart) ?? 0;
  const out: ActionReceiptRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { receipts, pages } = listReceipts(businessId, { page, limit: 200 });
    if (receipts.length === 0) break;
    let passedBoundary = false;
    for (const r of receipts) {
      const ms = timestampMs(r.created_at);
      if (ms != null && ms < startMs) { passedBoundary = true; continue; }
      out.push(r);
    }
    if (passedBoundary || page >= pages) break;
  }
  return out;
}

/**
 * Assemble the five-state ladder for one business over one window.
 *
 * Pending decisions are deliberately NOT window-filtered: a proposal that
 * has been waiting ninety days is more urgent than one filed this morning,
 * and windowing it out would hide exactly the thing an executive most needs
 * to see. Everything else is windowed, because "what changed recently" is
 * the question those states answer.
 */
export function buildWorkLadder(
  businessId: string,
  windowStart: string,
  windowEnd: string,
  samplePerState = 5,
): WorkLadder {
  // datetime() on both sides, not a raw string compare: the two timestamp
  // formats in this schema ('YYYY-MM-DD HH:MM:SS' and ISO-with-T-and-Z) do
  // not sort against each other lexicographically — ' ' < 'T' means a
  // same-day naive timestamp compares as older than an ISO one. datetime()
  // canonicalises both before comparing.
  const taskRows = db.prepare(`
    SELECT id, title, status, action_type, target_metric, completed_at, updated_at
      FROM tasks
     WHERE business_id = ? AND datetime(updated_at) >= datetime(?)
  `).all(businessId, windowStart) as LadderTaskRow[];

  const taskIds = new Set(taskRows.map((t) => t.id));

  // #63's taxonomy needs each task's outcome checks, ascending by window.
  const checkRows = taskIds.size === 0 ? [] : db.prepare(`
    SELECT o.id, o.task_id, o.weeks_after, o.verdict, o.check_date
      FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ?
     ORDER BY o.weeks_after ASC
  `).all(businessId) as Array<{ id: string; task_id: string; weeks_after: number; verdict: string | null; check_date: string }>;

  const checksByTask = new Map<string, typeof checkRows>();
  for (const c of checkRows) {
    if (!taskIds.has(c.task_id)) continue;
    const list = checksByTask.get(c.task_id) ?? [];
    list.push(c);
    checksByTask.set(c.task_id, list);
  }

  // Furthest receipt-attested state per task, from #70's records.
  const receiptStateByTask = new Map<string, { state: WorkState; at: string | null; receiptId: string }>();
  for (const r of collectReceiptsSince(businessId, windowStart)) {
    const attested = receiptLadderState(r);
    if (!attested) continue;
    const existing = receiptStateByTask.get(r.task_id);
    if (!existing || WORK_STATES.indexOf(attested.state) > WORK_STATES.indexOf(existing.state)) {
      receiptStateByTask.set(r.task_id, { ...attested, receiptId: r.id });
    }
  }

  // Which tasks are currently awaiting a human, per #61. Read from the
  // queue rather than from tasks.status so "pending" means exactly what the
  // Decision Centre says it means.
  const pendingTaskIds = new Set<string>();
  for (const d of listPendingDecisions(businessId, { limit: 500 }).decisions) {
    pendingTaskIds.add(d.task_id);
  }

  const counts = emptyWorkStateCounts();
  const taxonomyCounts = emptyTaxonomyCounts();
  const items: WorkLadderItem[] = [];
  let notProgressed = 0;

  for (const t of taskRows) {
    const taxonomy: TaxonomyResult = classifyOutcomeTaxonomy({
      task_id: t.id,
      task_status: t.status,
      action_type: t.action_type,
      target_metric: t.target_metric,
      completed_at: t.completed_at,
      checks: checksByTask.get(t.id) ?? [],
    });
    taxonomyCounts[taxonomy.state]++;

    const receiptState = receiptStateByTask.get(t.id);

    let state: WorkState | null = null;
    let evidenceSource: WorkLadderItem['evidence_source'] = 'task_status';
    let reason = '';
    let occurredAt: string | null = t.updated_at;
    let evidence: EvidenceLink = evidenceLink('task', t.id, businessId, t.title);

    if (taxonomy.state === 'outcome_measured') {
      // A measured business outcome is the furthest any work can get, and
      // #63 is the only module allowed to say so.
      state = 'outcome_measured';
      evidenceSource = 'outcome_measurement';
      reason = taxonomy.reason;
      occurredAt = taxonomy.citation.window_end ?? t.completed_at ?? t.updated_at;
      evidence = evidenceLink('outcome', t.id, businessId, t.title);
    } else if (receiptState) {
      state = receiptState.state;
      evidenceSource = 'receipt';
      reason = receiptState.state === 'verified'
        ? 'A receipt records an independent measurement confirming the change took effect.'
        : receiptState.state === 'executed'
          ? 'A receipt records the action running; nothing has independently verified the result yet.'
          : 'A receipt records the approval; execution has not started.';
      occurredAt = receiptState.at;
      evidence = evidenceLink('receipt', receiptState.receiptId, businessId, t.title);
    } else if (pendingTaskIds.has(t.id)) {
      state = 'proposed';
      evidenceSource = 'decision_queue';
      reason = 'Awaiting a human decision in the Decision Centre.';
      evidence = evidenceLink('decision', t.id, businessId, t.title);
    } else if (ABANDONED_STATUSES.has(t.status)) {
      notProgressed++;
    } else if (t.status === 'approved' || t.status === 'executing') {
      // No receipt exists (pre-#70 task, or one whose receipt write was
      // best-effort and lost). Fall back to the status, and say that the
      // evidence is weaker.
      state = 'approved';
      reason = `No receipt exists for this task; its status is "${t.status}".`;
    } else if (t.status === 'complete' || t.status === 'verified') {
      state = 'executed';
      reason = `No receipt exists for this task; its status is "${t.status}", so completion is Blueprint's own claim rather than an external record.`;
      occurredAt = t.completed_at ?? t.updated_at;
    } else if (t.status === 'proposed' || t.status === 'manual_review') {
      state = 'proposed';
      reason = `Task status is "${t.status}".`;
    }

    if (!state) continue;
    counts[state]++;
    items.push({
      task_id: t.id,
      title: t.title,
      state,
      evidence_source: evidenceSource,
      reason,
      occurred_at: occurredAt,
      evidence,
      taxonomy_state: taxonomy.state,
    });
  }

  // Bounded sample: newest first within each state, so every state that has
  // anything in it is represented rather than the largest one crowding out
  // the rest.
  const byState = new Map<WorkState, WorkLadderItem[]>();
  for (const item of items) {
    const list = byState.get(item.state) ?? [];
    list.push(item);
    byState.set(item.state, list);
  }
  const sampled: WorkLadderItem[] = [];
  for (const state of WORK_STATES) {
    const list = (byState.get(state) ?? []).sort(
      (a, b) => (timestampMs(b.occurred_at) ?? 0) - (timestampMs(a.occurred_at) ?? 0)
    );
    sampled.push(...list.slice(0, samplePerState));
  }

  return {
    counts,
    taxonomy_counts: taxonomyCounts,
    not_progressed: notProgressed,
    items: sampled,
    window_start: windowStart,
    window_end: windowEnd,
  };
}

// ─── Section payloads ────────────────────────────────────────────────────────

export interface DecisionSummaryItem {
  task_id: string;
  title: string;
  lane: DecisionLane;
  lane_reason: string;
  risk_tier: ApprovalTier;
  policy_recommendation: PendingDecision['policy_recommendation'];
  requires_override_reason: boolean;
  hold_reasons: string[];
  priority: string;
  proposed_by: string;
  /** How many evidence records #61 attached — the depth behind this line. */
  evidence_count: number;
  created_at: string;
  evidence: EvidenceLink;
}

export interface DecisionsSection {
  total: number;
  lanes: Record<DecisionLane, number>;
  by_risk_tier: Record<ApprovalTier, number>;
  /** The oldest pending item's age in hours — the queue's staleness. */
  oldest_pending_hours: number | null;
  policy: PendingDecision['policy'];
  items: DecisionSummaryItem[];
}

export interface VerifiedChangeItem {
  receipt_id: string;
  task_id: string;
  title: string | null;
  action_type: string | null;
  state: string;
  result_status: string;
  result_summary: string | null;
  /** The furthest ladder state this receipt attests to. */
  ladder_state: WorkState;
  external_system: string | null;
  external_id: string | null;
  external_permalink: string | null;
  /** true only when the `verified` stage was actually reached. */
  independently_verified: boolean;
  occurred_at: string | null;
  anomaly_count: number;
  evidence: EvidenceLink;
}

export interface VerifiedChangesSection {
  /** Receipts that reached `verified` — an independent measurement confirmed it. */
  verified_count: number;
  /** Receipts that ran but have NOT been independently verified. */
  executed_unverified_count: number;
  /** Receipts flagged ambiguous or carrying anomalies — these need a human. */
  needs_attention_count: number;
  items: VerifiedChangeItem[];
  window_start: string;
  window_end: string;
}

export interface OutcomesSection {
  confidence_level: string;
  outcomes_count: number;
  metrics_analysed: number;
  attributed_value_usd_per_month: number;
  attributed_decline_usd_per_month: number;
  total_cost_usd: number;
  roi_ratio: number | null;
  narrative: string;
  taxonomy_counts: Record<TaxonomyState, number>;
  /** Task-linked declines — the losses, reported as prominently as the wins. */
  declines: Array<{
    task_id: string;
    task_title: string | null;
    metric_name: string | null;
    change_pct: number | null;
    estimated_monthly_usd: number | null;
    checked_at: string | null;
    evidence: EvidenceLink;
  }>;
  period_start: string;
  period_end: string;
  evidence: EvidenceLink;
}

export interface ConnectorHealthItem {
  connector_id: string;
  type: string;
  name: string;
  state: ConnectorHealthState;
  summary: string;
  impact: string | null;
  next_step: string | null;
  last_success: string | null;
  evidence: EvidenceLink;
}

export interface ConnectorsSection {
  total: number;
  by_state: Record<string, number>;
  /** Connectors in a state that undermines trust in derived numbers. */
  unhealthy: ConnectorHealthItem[];
  /** Newest last_success across all connectors — how current this business's data is. */
  freshest_success: string | null;
  /** Oldest last_success among applicable connectors — the weakest link. */
  stalest_success: string | null;
}

// ─── Attention ranking ───────────────────────────────────────────────────────

export type AttentionSeverity = 'critical' | 'high' | 'medium';

export interface AttentionItem {
  id: string;
  business_id: string;
  business_name: string;
  severity: AttentionSeverity;
  /** Which section this came from, so the UI can group by cause. */
  source: 'decisions' | 'verified_changes' | 'outcomes' | 'connectors';
  headline: string;
  detail: string;
  occurred_at: string | null;
  evidence: EvidenceLink;
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, high: 1, medium: 2 };

// ─── Per-business assembly ───────────────────────────────────────────────────

export interface BusinessSummary {
  business_id: string;
  business_name: string;
  /**
   * ok        every section loaded
   * degraded  at least one section failed; the rest are real
   * unavailable  the business itself could not be read or is out of scope
   */
  status: 'ok' | 'degraded' | 'unavailable';
  /** Names of the sections that failed, for a one-glance degradation badge. */
  failed_sections: string[];
  unavailable_reason: string | null;
  decisions: SectionEnvelope<DecisionsSection>;
  work_states: SectionEnvelope<WorkLadder>;
  verified_changes: SectionEnvelope<VerifiedChangesSection>;
  outcomes: SectionEnvelope<OutcomesSection>;
  connectors: SectionEnvelope<ConnectorsSection>;
}

export interface CommandCentreOptions {
  /** Explicit selection. Ids outside the accessible set are reported, not silently dropped. */
  businessIds?: string[];
  /** #68 policy portfolio id, expanded to its member businesses. Not a new concept. */
  portfolioId?: string;
  /** Trailing window for "recent" sections, in days. Default 30. */
  windowDays?: number;
  /** Max items per bounded list. Default 5. */
  sampleSize?: number;
  /** Who is asking — scopes the selection. */
  actor: string;
  /**
   * The exact set of business ids this caller may read, overriding
   * listAccessibleBusinessIds(). Added for #79's BAP surface.
   *
   * listAccessibleBusinessIds() is honest for the dashboard — Blueprint's
   * session model is single-tenant, so an authenticated operator can read
   * every business (see its docstring). BAP is not: a `bap_agents` row
   * carries a real `business_access` grant, and that grant is the ACL this
   * module was always waiting for. Rather than teaching this module how to
   * read a BAP key, the caller that already knows who is asking passes the
   * resolved set in.
   *
   * This is deliberately an override of the SCOPE, not of the selection:
   * `businessIds` still means "what was asked for" and is still checked
   * against this set, so the truncation, `unavailable` and roll-up rules
   * below behave identically for both callers. Passing `[]` means the
   * caller may read nothing, and produces an `empty_selection` error rather
   * than quietly falling back to every business.
   */
  accessibleBusinessIds?: string[];
}

export interface CommandCentreSummary {
  generated_at: string;
  window_start: string;
  window_end: string;
  window_days: number;
  /** Echo of what was asked for, so the client can prove its selection took effect. */
  requested_business_ids: string[];
  /**
   * Set when the response covers less than the caller implicitly asked for
   * — currently only when a default (unselected) view was truncated to the
   * cap. Never null-and-truncated: if this is null, nothing was dropped.
   */
  selection_notice: string | null;
  portfolio: { id: string; name: string; business_ids: string[] } | null;
  businesses: BusinessSummary[];
  /** Cross-business rollup, computed only from sections that actually loaded. */
  portfolio_totals: {
    businesses_ok: number;
    businesses_degraded: number;
    businesses_unavailable: number;
    pending_decisions: number;
    decisions_by_lane: Record<DecisionLane, number>;
    decisions_by_risk_tier: Record<ApprovalTier, number>;
    work_states: Record<WorkState, number>;
    taxonomy_counts: Record<TaxonomyState, number>;
    verified_changes: number;
    executed_unverified: number;
    unhealthy_connectors: number;
    attributed_value_usd_per_month: number;
    attributed_decline_usd_per_month: number;
    /**
     * Which sections were missing from the totals above, and for which
     * business. A total computed over a partial set must never be presented
     * as complete — this is what lets the UI say "excluding 1 business".
     */
    excluded: Array<{ business_id: string; section: string; reason: string }>;
  };
  /** Ranked, cross-business — what to look at first. */
  attention: AttentionItem[];
}

function emptyLaneCounts(): Record<DecisionLane, number> {
  return { manual_review: 0, policy_gated: 0, routine: 0 };
}

function emptyTierCounts(): Record<ApprovalTier, number> {
  return { green: 0, yellow: 0, orange: 0, red: 0 };
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = timestampMs(iso);
  if (ms == null) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
}

/** Connector health states that should reduce trust in anything derived from them. */
const UNHEALTHY_CONNECTOR_STATES = new Set<ConnectorHealthState>([
  'failing', 'permission_required', 'partial', 'stale',
]);

/**
 * Build one business's summary. Every section is independently isolated, so
 * this function does not throw for a data problem inside a section — only
 * for a business that cannot be identified at all, which the caller turns
 * into an `unavailable` row.
 */
export function summariseBusiness(
  businessId: string,
  businessName: string,
  windowStart: string,
  windowEnd: string,
  sampleSize: number,
): BusinessSummary {
  const decisions = section<DecisionsSection>('decisions_unavailable', () => {
    const result = listPendingDecisions(businessId, { limit: 500 });
    const lanes = emptyLaneCounts();
    const byTier = emptyTierCounts();
    for (const d of result.decisions) {
      lanes[d.lane]++;
      byTier[d.risk_tier]++;
    }
    // Most-urgent-first is already #61's sort order; keep it rather than
    // re-sorting, so the executive view and the Decision Centre agree.
    const items: DecisionSummaryItem[] = result.decisions.slice(0, sampleSize).map((d) => ({
      task_id: d.task_id,
      title: d.title,
      lane: d.lane,
      lane_reason: d.lane_reason,
      risk_tier: d.risk_tier,
      policy_recommendation: d.policy_recommendation,
      requires_override_reason: d.requires_override_reason,
      hold_reasons: d.hold_reasons,
      priority: d.priority,
      proposed_by: d.proposed_by,
      evidence_count: d.evidence.length,
      created_at: d.created_at,
      evidence: evidenceLink('decision', d.task_id, businessId, d.title),
    }));
    const oldest = result.decisions.reduce<string | null>(
      (acc, d) => (acc == null || d.created_at < acc ? d.created_at : acc), null,
    );
    return {
      data: {
        total: result.counts.total,
        lanes,
        by_risk_tier: byTier,
        oldest_pending_hours: hoursSince(oldest),
        policy: result.policy,
        items,
      },
      // The queue is as fresh as its newest pending item.
      data_as_of: newestTimestamp(result.decisions.map((d) => d.updated_at)),
    };
  });

  const workStates = section<WorkLadder>('work_states_unavailable', () => {
    const ladder = buildWorkLadder(businessId, windowStart, windowEnd, sampleSize);
    return {
      data: ladder,
      data_as_of: newestTimestamp(ladder.items.map((i) => i.occurred_at)),
    };
  });

  const verifiedChanges = section<VerifiedChangesSection>('verified_changes_unavailable', () => {
    const receipts = collectReceiptsSince(businessId, windowStart);
    let verified = 0;
    let executedUnverified = 0;
    let needsAttention = 0;
    const candidates: VerifiedChangeItem[] = [];

    for (const r of receipts) {
      const attested = receiptLadderState(r);
      const anomalyCount = r.anomalies?.length ?? 0;
      if (r.state === 'ambiguous' || anomalyCount > 0) needsAttention++;
      if (!attested) continue;
      if (attested.state === 'verified') verified++;
      else if (attested.state === 'executed') executedUnverified++;
      // 'approved' receipts are real, but they are not a *change* — nothing
      // has happened externally yet, so they stay out of this section and
      // are counted in the work ladder instead.
      if (attested.state !== 'verified' && attested.state !== 'executed') continue;
      candidates.push({
        receipt_id: r.id,
        task_id: r.task_id,
        title: r.title,
        action_type: r.action_type,
        state: r.state,
        result_status: r.result_status,
        result_summary: r.result_summary,
        ladder_state: attested.state,
        external_system: r.external_system,
        external_id: r.external_id,
        external_permalink: r.external_permalink,
        independently_verified: attested.state === 'verified',
        occurred_at: attested.at,
        anomaly_count: anomalyCount,
        evidence: evidenceLink('receipt', r.id, businessId, r.title ?? r.task_id),
      });
    }

    // Verified first — an independently confirmed change outranks an
    // unverified one of the same age — then newest first.
    candidates.sort((a, b) =>
      Number(b.independently_verified) - Number(a.independently_verified)
      || (timestampMs(b.occurred_at) ?? 0) - (timestampMs(a.occurred_at) ?? 0)
    );

    return {
      data: {
        verified_count: verified,
        executed_unverified_count: executedUnverified,
        needs_attention_count: needsAttention,
        items: candidates.slice(0, sampleSize),
        window_start: windowStart,
        window_end: windowEnd,
      },
      data_as_of: newestTimestamp(receipts.map((r) => r.updated_at)),
    };
  });

  const outcomes = section<OutcomesSection>('outcomes_unavailable', () => {
    // computeROIReport returns null for an unknown business and is typed
    // `any` at its own boundary; treat a null as a section failure so the
    // envelope carries a real reason rather than an empty card.
    const report = computeROIReport(businessId);
    if (!report) throw new Error(`No ROI report could be produced for business '${businessId}'.`);
    const declines = (report.attributed_declines ?? []).slice(0, sampleSize).map((d: Record<string, unknown>) => ({
      task_id: String(d.task_id),
      task_title: (d.task_title as string | null) ?? null,
      metric_name: (d.metric_name as string | null) ?? null,
      change_pct: (d.change_pct as number | null) ?? null,
      estimated_monthly_usd: (d.estimated_monthly_usd as number | null) ?? null,
      checked_at: (d.checked_at as string | null) ?? null,
      evidence: evidenceLink('outcome', String(d.task_id), businessId, String(d.task_title ?? d.task_id)),
    }));
    return {
      data: {
        confidence_level: String(report.confidence_level),
        outcomes_count: Number(report.outcomes_count ?? 0),
        metrics_analysed: Number(report.metrics_analysed ?? 0),
        attributed_value_usd_per_month: Number(report.attributed_value_usd_per_month ?? 0),
        attributed_decline_usd_per_month: Number(report.attributed_decline_usd_per_month ?? 0),
        total_cost_usd: Number(report.total_cost_usd ?? 0),
        roi_ratio: report.roi_ratio == null ? null : Number(report.roi_ratio),
        narrative: String(report.narrative ?? ''),
        taxonomy_counts: report.taxonomy?.counts ?? emptyTaxonomyCounts(),
        declines,
        period_start: String(report.period_start),
        period_end: String(report.period_end),
        evidence: evidenceLink('roi_report', businessId, businessId, `ROI report for ${businessName}`),
      },
      // An ROI report is only as current as the measurements behind it.
      data_as_of: newestTimestamp([
        ...(report.attributed_improvements ?? []).map((r: Record<string, unknown>) => r.checked_at as string | null),
        ...(report.attributed_declines ?? []).map((r: Record<string, unknown>) => r.checked_at as string | null),
      ]),
    };
  });

  const connectors = section<ConnectorsSection>('connectors_unavailable', () => {
    const rows = db.prepare(
      'SELECT id, business_id, type, name, status, last_sync, last_error, config FROM connectors WHERE business_id = ?'
    ).all(businessId) as Connector[];

    const byState: Record<string, number> = {};
    const unhealthy: ConnectorHealthItem[] = [];
    const successes: Array<string | null> = [];

    for (const c of rows) {
      // One connector that cannot be explained must not take out the
      // connector section, let alone the business — the same principle
      // health.ts (#65) applies within a single connector's diagnostics.
      let health;
      try {
        health = explainConnectorHealth(c);
      } catch (err) {
        health = {
          state: 'failing' as ConnectorHealthState,
          last_success: c.last_sync ?? null,
          coverage_complete: null,
          summary: `Health for ${c.name || c.type} could not be evaluated: ${(err as Error).message}`,
          impact: 'Anything derived from this connector should be treated as unverified.',
          next_step: `Open Connectors → ${c.name || c.type} and run Health Check.`,
        };
      }
      byState[health.state] = (byState[health.state] ?? 0) + 1;
      if (health.state !== 'not_applicable') successes.push(health.last_success);
      if (UNHEALTHY_CONNECTOR_STATES.has(health.state)) {
        unhealthy.push({
          connector_id: c.id,
          type: c.type,
          name: c.name,
          state: health.state,
          summary: health.summary,
          impact: health.impact,
          next_step: health.next_step,
          last_success: health.last_success,
          evidence: evidenceLink('connector', c.id, businessId, c.name || c.type),
        });
      }
    }

    const parsed = successes.filter((s): s is string => timestampMs(s) != null);
    const sorted = [...parsed].sort((a, b) => (timestampMs(a) ?? 0) - (timestampMs(b) ?? 0));

    return {
      data: {
        total: rows.length,
        by_state: byState,
        unhealthy,
        freshest_success: sorted.length ? sorted[sorted.length - 1]! : null,
        stalest_success: sorted.length ? sorted[0]! : null,
      },
      data_as_of: sorted.length ? sorted[sorted.length - 1]! : null,
    };
  });

  const sections: Array<[string, SectionEnvelope<unknown>]> = [
    ['decisions', decisions],
    ['work_states', workStates],
    ['verified_changes', verifiedChanges],
    ['outcomes', outcomes],
    ['connectors', connectors],
  ];
  const failed = sections.filter(([, s]) => s.status === 'failed').map(([name]) => name);

  return {
    business_id: businessId,
    business_name: businessName,
    status: failed.length === 0 ? 'ok' : 'degraded',
    failed_sections: failed,
    unavailable_reason: null,
    decisions,
    work_states: workStates,
    verified_changes: verifiedChanges,
    outcomes,
    connectors,
  };
}

// ─── Attention ranking ───────────────────────────────────────────────────────

/**
 * Rank what an executive should look at first, across the whole selection.
 *
 * The ordering encodes a deliberate opinion: things that are stuck waiting
 * on a human outrank things that went wrong on their own, because the
 * former are the only ones a human reading this page can immediately
 * unblock. Within a severity, newest first.
 *
 * Only sections that actually loaded contribute. A failed section produces
 * its own attention item saying so, rather than silently contributing
 * nothing — an executive must be able to tell "nothing wrong" from "we
 * could not look".
 */
export function rankAttention(summaries: BusinessSummary[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const b of summaries) {
    if (b.status === 'unavailable') {
      items.push({
        id: `unavailable:${b.business_id}`,
        business_id: b.business_id,
        business_name: b.business_name,
        severity: 'high',
        source: 'decisions',
        headline: `${b.business_name} could not be loaded`,
        detail: b.unavailable_reason ?? 'This business is not readable in the current scope.',
        occurred_at: null,
        evidence: evidenceLink('task', b.business_id, b.business_id, b.business_name),
      });
      continue;
    }

    for (const name of b.failed_sections) {
      const env = (b as unknown as Record<string, SectionEnvelope<unknown>>)[name];
      items.push({
        id: `section_failed:${b.business_id}:${name}`,
        business_id: b.business_id,
        business_name: b.business_name,
        severity: 'high',
        source: name === 'connectors' ? 'connectors'
          : name === 'outcomes' ? 'outcomes'
            : name === 'verified_changes' ? 'verified_changes' : 'decisions',
        headline: `${b.business_name}: ${name.replace(/_/g, ' ')} could not be loaded`,
        detail:
          `${env?.error?.message ?? 'Unknown error.'} Everything else on this business is real; `
          + 'only this section is missing.',
        occurred_at: env?.as_of ?? null,
        evidence: evidenceLink('task', b.business_id, b.business_id, b.business_name),
      });
    }

    const dec = b.decisions.data;
    if (dec) {
      for (const d of dec.items) {
        // A held item and an investigation are the two things that cannot
        // proceed at all without a person; everything else in the queue is
        // work in progress.
        const severity: AttentionSeverity =
          d.lane === 'manual_review' || d.policy_recommendation === 'hold' ? 'critical'
            : tierRank(d.risk_tier) >= tierRank('orange') ? 'high'
              : 'medium';
        items.push({
          id: `decision:${d.task_id}`,
          business_id: b.business_id,
          business_name: b.business_name,
          severity,
          source: 'decisions',
          headline: d.title,
          detail: d.lane_reason,
          occurred_at: d.created_at,
          evidence: d.evidence,
        });
      }
    }

    const vc = b.verified_changes.data;
    if (vc) {
      for (const item of vc.items) {
        if (item.anomaly_count === 0 && item.state !== 'ambiguous') continue;
        items.push({
          id: `receipt_anomaly:${item.receipt_id}`,
          business_id: b.business_id,
          business_name: b.business_name,
          severity: 'critical',
          source: 'verified_changes',
          headline: `Unresolved outcome: ${item.title ?? item.task_id}`,
          detail: item.state === 'ambiguous'
            ? 'Blueprint could not determine what happened in the external system.'
            : `${item.anomaly_count} anomaly/anomalies recorded against this action.`,
          occurred_at: item.occurred_at,
          evidence: item.evidence,
        });
      }
    }

    const conn = b.connectors.data;
    if (conn) {
      for (const c of conn.unhealthy) {
        if (c.state === 'stale') continue; // reported on the card, not worth an alert
        items.push({
          id: `connector:${c.connector_id}`,
          business_id: b.business_id,
          business_name: b.business_name,
          severity: c.state === 'failing' || c.state === 'permission_required' ? 'high' : 'medium',
          source: 'connectors',
          headline: c.summary,
          detail: c.impact ?? c.next_step ?? '',
          occurred_at: c.last_success,
          evidence: c.evidence,
        });
      }
    }

    const out = b.outcomes.data;
    if (out) {
      for (const d of out.declines) {
        items.push({
          id: `decline:${d.task_id}`,
          business_id: b.business_id,
          business_name: b.business_name,
          severity: 'high',
          source: 'outcomes',
          headline: `Measured decline: ${d.task_title ?? d.task_id}`,
          detail:
            `${d.metric_name ?? 'A tracked metric'} moved ${d.change_pct == null ? 'unfavourably' : `${d.change_pct.toFixed(1)}%`} `
            + 'after this action, and the change is attributed to it.',
          occurred_at: d.checked_at,
          evidence: d.evidence,
        });
      }
    }
  }

  return items.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (timestampMs(b.occurred_at) ?? 0) - (timestampMs(a.occurred_at) ?? 0)
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export class CommandCentreError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'CommandCentreError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Exported so a caller can advertise the cap before a request is made
 * (bap-command-centre.ts's `/command-centre/scope` does), rather than
 * letting an agent discover it by being refused.
 */
export const MAX_SELECTION = 25;

/**
 * Assemble the cross-business command centre.
 *
 * The selection is resolved first and completely: an id the actor cannot
 * reach becomes an `unavailable` row rather than a 403 for the whole
 * request, because one bad id in a selection of eight must not cost the
 * executive the other seven.
 */
export function assembleCommandCentre(options: CommandCentreOptions): CommandCentreSummary {
  const windowDays = Math.min(365, Math.max(1, options.windowDays ?? 30));
  const sampleSize = Math.min(25, Math.max(1, options.sampleSize ?? 5));
  const windowEnd = nowIso();
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // `?? undefined`-free on purpose: an explicitly empty array is a real
  // answer ("this caller may read nothing"), not a missing option.
  const accessible = new Set(
    options.accessibleBusinessIds ?? listAccessibleBusinessIds(options.actor),
  );

  let portfolio: CommandCentreSummary['portfolio'] = null;
  let requested: string[] = [];
  // Whether the caller named a selection, as opposed to falling back to
  // "everything I can see". The cap is enforced differently for each.
  const explicitSelection = Boolean(options.portfolioId) || Boolean(options.businessIds?.length);

  if (options.portfolioId) {
    const p = getPolicyPortfolio(options.portfolioId);
    if (!p) {
      throw new CommandCentreError(
        `Policy portfolio '${options.portfolioId}' not found.`, 404, 'portfolio_not_found',
      );
    }
    portfolio = { id: p.id, name: p.name, business_ids: p.business_ids };
    requested = [...p.business_ids];
  }
  if (options.businessIds?.length) {
    requested = [...requested, ...options.businessIds];
  }
  // No selection at all means "everything I can see" — the natural default
  // for a portfolio-level view, and still bounded by the accessible set.
  if (requested.length === 0) requested = [...accessible];

  requested = Array.from(new Set(requested.map((id) => String(id).trim()).filter(Boolean)));

  if (requested.length === 0) {
    throw new CommandCentreError(
      'No businesses are in scope for this selection.', 404, 'empty_selection',
    );
  }

  // The cap treats an explicit selection and an implicit one differently on
  // purpose. Asking for 40 specific businesses is a request that cannot be
  // honoured as one view, and silently dropping 15 of them would be a lie —
  // so it is refused. But "no selection" is not a request for everything at
  // any size; it is a sensible default, and an operator with 40 businesses
  // must not be met with an error they can only escape by guessing. That
  // case is truncated, and the truncation is stated in the response.
  let notice: string | null = null;
  if (requested.length > MAX_SELECTION) {
    if (explicitSelection) {
      throw new CommandCentreError(
        `A command-centre selection is capped at ${MAX_SELECTION} businesses; ${requested.length} were requested. `
        + 'Narrow the selection — a summary spanning more than that is not something anyone reads as one view.',
        422, 'selection_too_large',
      );
    }
    notice =
      `Showing the first ${MAX_SELECTION} of ${requested.length} accessible businesses. `
      + 'Select the ones you care about to see a different set — this is a truncation, not a total.';
    requested = requested.slice(0, MAX_SELECTION);
  }

  const names = new Map<string, string>();
  for (const row of db.prepare('SELECT id, name FROM businesses').all() as Array<{ id: string; name: string }>) {
    names.set(row.id, row.name);
  }

  const businesses: BusinessSummary[] = requested.map((id) => {
    if (!accessible.has(id) || !names.has(id)) {
      // Deliberately one message for "does not exist" and "not yours".
      // Distinguishing them would confirm the id is real, which is itself a
      // cross-tenant leak — the same posture #61 takes on task ids.
      return unavailableBusiness(id, names.get(id) ?? id,
        `Business '${id}' is not available in the current scope.`);
    }
    try {
      return summariseBusiness(id, names.get(id)!, windowStart, windowEnd, sampleSize);
    } catch (err) {
      // summariseBusiness isolates per-section failures itself; reaching
      // here means the business as a whole could not be assembled. Even
      // then, only this row is lost.
      return unavailableBusiness(id, names.get(id) ?? id, (err as Error).message);
    }
  });

  const totals = rollUp(businesses);
  return {
    generated_at: nowIso(),
    window_start: windowStart,
    window_end: windowEnd,
    window_days: windowDays,
    requested_business_ids: requested,
    selection_notice: notice,
    portfolio,
    businesses,
    portfolio_totals: totals,
    attention: rankAttention(businesses),
  };
}

function unavailableBusiness(id: string, name: string, reason: string): BusinessSummary {
  const failedEnvelope = <T>(code: string): SectionEnvelope<T> => ({
    status: 'failed', as_of: nowIso(), data_as_of: null,
    error: { message: reason, code }, data: null,
  });
  return {
    business_id: id,
    business_name: name,
    status: 'unavailable',
    failed_sections: [],
    unavailable_reason: reason,
    decisions: failedEnvelope('business_unavailable'),
    work_states: failedEnvelope('business_unavailable'),
    verified_changes: failedEnvelope('business_unavailable'),
    outcomes: failedEnvelope('business_unavailable'),
    connectors: failedEnvelope('business_unavailable'),
  };
}

/**
 * Cross-business totals, summed only over sections that loaded.
 *
 * Every omission is recorded in `excluded`. A total that quietly skipped a
 * business would be worse than no total at all: it reads as complete, and
 * an executive would act on it.
 */
function rollUp(businesses: BusinessSummary[]): CommandCentreSummary['portfolio_totals'] {
  const totals: CommandCentreSummary['portfolio_totals'] = {
    businesses_ok: 0,
    businesses_degraded: 0,
    businesses_unavailable: 0,
    pending_decisions: 0,
    decisions_by_lane: emptyLaneCounts(),
    decisions_by_risk_tier: emptyTierCounts(),
    work_states: emptyWorkStateCounts(),
    taxonomy_counts: emptyTaxonomyCounts(),
    verified_changes: 0,
    executed_unverified: 0,
    unhealthy_connectors: 0,
    attributed_value_usd_per_month: 0,
    attributed_decline_usd_per_month: 0,
    excluded: [],
  };

  for (const b of businesses) {
    if (b.status === 'ok') totals.businesses_ok++;
    else if (b.status === 'degraded') totals.businesses_degraded++;
    else totals.businesses_unavailable++;

    if (b.status === 'unavailable') {
      totals.excluded.push({
        business_id: b.business_id, section: 'all',
        reason: b.unavailable_reason ?? 'Business unavailable.',
      });
      continue;
    }

    const record = (name: string, env: SectionEnvelope<unknown>) => {
      if (env.status === 'failed') {
        totals.excluded.push({
          business_id: b.business_id, section: name,
          reason: env.error?.message ?? 'Section failed.',
        });
        return false;
      }
      return true;
    };

    if (record('decisions', b.decisions) && b.decisions.data) {
      totals.pending_decisions += b.decisions.data.total;
      for (const lane of Object.keys(totals.decisions_by_lane) as DecisionLane[]) {
        totals.decisions_by_lane[lane] += b.decisions.data.lanes[lane] ?? 0;
      }
      for (const tier of TIER_ORDER) {
        totals.decisions_by_risk_tier[tier] += b.decisions.data.by_risk_tier[tier] ?? 0;
      }
    }
    if (record('work_states', b.work_states) && b.work_states.data) {
      for (const s of WORK_STATES) totals.work_states[s] += b.work_states.data.counts[s] ?? 0;
      for (const t of Object.keys(totals.taxonomy_counts) as TaxonomyState[]) {
        totals.taxonomy_counts[t] += b.work_states.data.taxonomy_counts[t] ?? 0;
      }
    }
    if (record('verified_changes', b.verified_changes) && b.verified_changes.data) {
      totals.verified_changes += b.verified_changes.data.verified_count;
      totals.executed_unverified += b.verified_changes.data.executed_unverified_count;
    }
    if (record('outcomes', b.outcomes) && b.outcomes.data) {
      totals.attributed_value_usd_per_month += b.outcomes.data.attributed_value_usd_per_month;
      totals.attributed_decline_usd_per_month += b.outcomes.data.attributed_decline_usd_per_month;
    }
    if (record('connectors', b.connectors) && b.connectors.data) {
      totals.unhealthy_connectors += b.connectors.data.unhealthy.length;
    }
  }

  totals.attributed_value_usd_per_month = Math.round(totals.attributed_value_usd_per_month * 100) / 100;
  totals.attributed_decline_usd_per_month = Math.round(totals.attributed_decline_usd_per_month * 100) / 100;
  return totals;
}
