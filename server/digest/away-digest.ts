/**
 * "What happened while I was away?" — the catch-up digest (issue #62).
 *
 * Blueprint already had a catch-up: server/routes/auth.ts fires a
 * `generateCatchUpNotification()` on login after a 24h absence, which
 * writes a sentence like "3 signals detected, 2 tasks completed by agents."
 * That sentence is exactly the failure mode this module exists to replace.
 * It is four `COUNT(*)`s rendered as prose: it cites nothing, so nothing in
 * it can be checked; it flattens "an action was verified to have moved a
 * metric" and "an agent was busy" into the same word; and it repeats the
 * same standing backlog every single time you log in.
 *
 * ─── The four sections, and why they are separate ───────────────────────────
 *
 * The sections are not a visual grouping — they are four different epistemic
 * claims, and merging any two of them would overstate what Blueprint knows:
 *
 *   verified_outcomes  — something was MEASURED. Sourced from #63's
 *       outcome taxonomy at `outcome_measured` specifically (a real
 *       task_outcomes row exists), plus #70 receipts that reached the
 *       `verified` state (verification evidence exists). Note what is NOT
 *       here: a completed task, or a receipt that only reached `executed`
 *       or `externally_acknowledged`. "GitHub accepted our issue" is not
 *       "the business improved" — that distinction is #70's whole point and
 *       collapsing it here would undo it.
 *
 *   pending_decisions  — something WAITS ON A HUMAN. Read from #61's
 *       decision queue, which derives lanes from the #68 operating policy.
 *       Not recomputed here; a second opinion about what needs review is
 *       precisely the fragmentation #61 removed.
 *
 *   failures_and_stale_data — something is BROKEN OR UNTRUSTWORTHY, so
 *       conclusions drawn from it may be wrong. Degraded connectors via
 *       #65's explainConnectorHealth(), plus open system issues. This
 *       section exists so a digest can never read as "all quiet" when the
 *       real reason it is quiet is that half the connectors stopped syncing.
 *
 *   informational_activity — everything else. Work happened; no outcome is
 *       claimed. Kept explicitly low-signal and last.
 *
 * ─── Never a claim without a citation ───────────────────────────────────────
 *
 * Every DigestItem carries a `source` naming the exact table and row id it
 * was built from, and every item is constructed by reading such a row —
 * there is no code path that synthesises an item from an aggregate. This is
 * the machine-checkable form of the issue's "do not claim an event occurred
 * without source evidence", and away-digest.test.ts asserts it by resolving
 * every emitted item's (table, row_id) back to a real row.
 *
 * ─── Deduplication vs. hiding a material change ─────────────────────────────
 *
 * Repetition is the main source of digest noise: one broken connector
 * produces an entry every scan. Items therefore collapse on `dedup_key`
 * into a single entry carrying occurrence_count and first/last occurrence.
 *
 * But collapsing on identity alone would hide the one thing that most
 * deserves attention — a repeat that got WORSE. So every item also has a
 * severity, and when the members of a dedup group do not share one, the
 * group is promoted to the highest severity seen and stamped with an
 * `escalation` describing the change and citing both the first and the
 * escalated occurrence. An escalation is never "just a duplicate".
 */
import db from '../db/db.js';
import { classifyOutcomeTaxonomy, type TaxonomyCheckLike } from '../tasks/outcome-taxonomy.js';
import { listPendingDecisions } from '../decisions/decision-queue.js';
import { explainConnectorHealth, type ConnectorHealthState } from '../connectors/health.js';
import { listSystemIssues } from '../system/system-issues.js';
import {
  getWatermark, normalizeScope, normalizeOperator, ALL_BUSINESSES,
} from './digest-watermark.js';

export const DIGEST_SCHEMA_VERSION = 1;

export type DigestSection =
  | 'verified_outcomes'
  | 'pending_decisions'
  | 'failures_and_stale_data'
  | 'informational_activity';

export const DIGEST_SECTIONS: DigestSection[] = [
  'verified_outcomes', 'pending_decisions', 'failures_and_stale_data', 'informational_activity',
];

/**
 * Ordered worst-first. Ranked comparably across sections so a dedup group
 * can be said to have "escalated" and so ordering within a section is
 * meaningful.
 */
export type DigestSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: DigestSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function severityRank(s: DigestSeverity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * Where an item came from, precisely enough to be re-read.
 *
 * `table` + `row_id` are the load-bearing pair: they make the claim
 * falsifiable. `href` is a convenience for the UI and is deliberately NOT
 * the evidence — a link can 404 without the underlying row being wrong.
 */
export interface DigestSource {
  /** Coarse kind, for icon/grouping purposes. */
  kind: string;
  /** The SQLite table the row lives in. */
  table: string;
  /** Primary key of that row. */
  row_id: string;
  /** In-app link to the surface that shows this item in full. */
  href: string;
  /** External permalink, when the underlying record has one (#70 receipts). */
  external_permalink?: string | null;
  /** Structured supporting facts, copied from the source row — never invented. */
  evidence: Record<string, unknown>;
}

export interface DigestEscalation {
  /** What got worse, in a sentence. */
  reason: string;
  from_severity: DigestSeverity;
  to_severity: DigestSeverity;
  /** Source of the earliest (lower-severity) occurrence. */
  from_source: DigestSource;
  /** Source of the occurrence that escalated. */
  to_source: DigestSource;
}

export interface DigestItem {
  /** Stable identity across digests — the dedup unit. */
  dedup_key: string;
  /** Hash of the MATERIAL fields only. Changing it replays the item. */
  change_fingerprint: string;
  section: DigestSection;
  business_id: string;
  business_name: string | null;
  /** Status/state within the section, used for the "grouped by status" view. */
  status: string;
  severity: DigestSeverity;
  title: string;
  detail: string | null;
  /** When this item's underlying event happened. */
  occurred_at: string;
  /** Primary source. */
  source: DigestSource;
  /** Every occurrence's source when this entry collapsed repeats (incl. primary). */
  occurrences: DigestSource[];
  occurrence_count: number;
  first_occurrence_at: string;
  last_occurrence_at: string;
  /** Set only when severity changed across a dedup group. */
  escalation: DigestEscalation | null;
  /** True when this item was in a previously acknowledged digest. */
  previously_seen: boolean;
  /** Why a previously-seen item is being replayed. Null when it is new. */
  replay_reason: string | null;
}

export interface DigestBusinessGroup {
  business_id: string;
  business_name: string | null;
  /** Section → items, already deduplicated and sorted. */
  sections: Record<DigestSection, DigestItem[]>;
  /** Section → status → count. The "grouped by business and status" view. */
  status_counts: Record<DigestSection, Record<string, number>>;
  total_items: number;
}

export interface DigestWindow {
  start: string;
  end: string;
  /** How `start` was chosen. */
  source: 'watermark' | 'explicit_since' | 'default_lookback';
  /** True when a watermark existed and was used to bound the window. */
  watermark_applied: boolean;
  /** The watermark instant, when one exists — reported even if overridden. */
  watermark_at: string | null;
}

export interface AwayDigest {
  digest_schema_version: number;
  /** Deterministic id for this digest request — cited by the acknowledgement. */
  digest_id: string;
  operator_key: string;
  /** '*' for the cross-business digest. */
  scope: string;
  window: DigestWindow;
  generated_at: string;
  businesses: DigestBusinessGroup[];
  totals: Record<DigestSection, number> & { total: number; suppressed_as_seen: number };
  /**
   * Items suppressed because they were acknowledged and are unchanged.
   * Reported as a count, never silently — "nothing new" and "nothing
   * happened" are different answers and the UI must be able to say which.
   */
  suppressed_as_seen: number;
  /** dedup_key → change_fingerprint for everything shown, for acknowledgement. */
  acknowledgeable: Record<string, string>;
}

// ─── Fingerprinting ──────────────────────────────────────────────────────────

/**
 * A small, stable, non-cryptographic string hash (FNV-1a). This is a change
 * detector, not a security primitive — collisions would at worst suppress a
 * changed item, and the inputs are short internal state strings, so a full
 * SHA is not worth the cost on every item of every digest.
 */
function fingerprint(parts: Array<string | number | null | undefined>): string {
  const input = parts.map((p) => (p == null ? '' : String(p))).join('␟');
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function businessNameOf(businessId: string): string | null {
  const row = db.prepare('SELECT name FROM businesses WHERE id = ?').get(businessId) as { name?: string } | undefined;
  return row?.name ?? null;
}

function listScopedBusinesses(scope: string): Array<{ id: string; name: string | null }> {
  if (scope !== ALL_BUSINESSES) {
    const row = db.prepare('SELECT id, name FROM businesses WHERE id = ?').get(scope) as
      { id: string; name: string | null } | undefined;
    return row ? [row] : [];
  }
  return db.prepare('SELECT id, name FROM businesses ORDER BY name').all() as Array<{ id: string; name: string | null }>;
}

/**
 * SQLite DATETIME columns are written both as ISO-8601 (application writes)
 * and as 'YYYY-MM-DD HH:MM:SS' (CURRENT_TIMESTAMP, which is UTC but carries
 * no zone marker). Comparing those two forms as strings, or letting
 * Date.parse() treat the space-separated form as local time, silently
 * shifts events across the window boundary by the host's UTC offset — which
 * would show or hide items depending on which timezone the server runs in.
 */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function inWindow(iso: string | null, start: string, end: string): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  // Half-open [start, end): an event exactly at the watermark instant was
  // already acknowledged, so including it would replay it on every digest.
  return t >= Date.parse(start) && t < Date.parse(end);
}

const DEFAULT_LOOKBACK_DAYS = 7;

// ─── Window resolution ───────────────────────────────────────────────────────

export interface DigestRequest {
  operator_key?: string | null;
  /** Business id, or '*'/empty for all businesses. */
  business_id?: string | null;
  /**
   * Explicit "show me since this instant" override. When set, the watermark
   * is IGNORED for both the window floor and the seen-item suppression —
   * the user has explicitly asked to re-see a period, and honouring a
   * watermark would defeat the request.
   */
  since?: string | null;
  /** Explicit window end. Defaults to now. */
  until?: string | null;
  /** Cap on items per section per business. */
  limit?: number;
}

export function resolveWindow(
  operatorKey: string,
  scope: string,
  request: DigestRequest,
  now: Date,
): DigestWindow {
  const end = toIso(request.until) ?? now.toISOString();
  const watermark = getWatermark(operatorKey, scope);
  const watermarkAt = watermark ? toIso(watermark.acknowledged_through) : null;

  const explicitSince = toIso(request.since);
  if (explicitSince) {
    return {
      start: explicitSince, end,
      source: 'explicit_since',
      watermark_applied: false,
      watermark_at: watermarkAt,
    };
  }

  if (watermarkAt) {
    return {
      start: watermarkAt, end,
      source: 'watermark',
      watermark_applied: true,
      watermark_at: watermarkAt,
    };
  }

  // No watermark and no explicit since: a first-ever digest. A bounded
  // lookback is the honest default — "everything since the dawn of this
  // install" is not a catch-up, it is an archive.
  const fallback = new Date(Date.parse(end) - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString();
  return {
    start: fallback, end,
    source: 'default_lookback',
    watermark_applied: false,
    watermark_at: null,
  };
}

// ─── Section builders ────────────────────────────────────────────────────────
//
// Each returns raw (pre-dedup) items. Every one reads real rows and copies
// facts out of them; none synthesises an item from an aggregate.

/**
 * Verified outcomes: a measurement exists.
 *
 * Two genuinely-verified sources, kept distinguishable by `status`:
 *   - #63 taxonomy at `outcome_measured` — a task_outcomes row was written.
 *   - #70 receipts in state `verified` — verification evidence was recorded.
 *
 * Deliberately excluded: tasks that merely completed, and receipts that
 * stopped at `executed`/`externally_acknowledged`. Those are activity.
 */
function buildVerifiedOutcomes(businessId: string, window: DigestWindow): DigestItem[] {
  const items: DigestItem[] = [];
  const name = businessNameOf(businessId);

  const tasks = db.prepare(`
    SELECT id, title, status, action_type, proposed_by, completed_at, target_metric
      FROM tasks
     WHERE business_id = ? AND status IN ('complete', 'verified') AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 500
  `).all(businessId) as Array<Record<string, unknown>>;

  for (const t of tasks) {
    const taskId = String(t.id);
    const checks = db.prepare(
      'SELECT * FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC'
    ).all(taskId) as TaxonomyCheckLike[];

    const taxonomy = classifyOutcomeTaxonomy({
      task_id: taskId,
      task_status: String(t.status ?? ''),
      action_type: (t.action_type as string | null) ?? null,
      target_metric: (t.target_metric as string | null) || null,
      completed_at: toIso(t.completed_at),
      checks,
    });

    // The whole point of this section: only a genuine measurement qualifies.
    if (taxonomy.state !== 'outcome_measured') continue;

    // Date the item by the measurement, not the task completion — the
    // measurement is the event being reported, and it can land weeks later.
    const measuredAt = toIso(taxonomy.citation.window_end) ?? toIso(t.completed_at);
    if (!inWindow(measuredAt, window.start, window.end)) continue;

    const outcomeId = taxonomy.citation.outcome_id;
    const check = outcomeId
      ? (db.prepare('SELECT * FROM task_outcomes WHERE id = ?').get(outcomeId) as Record<string, unknown> | undefined)
      : undefined;
    const verdict = String(check?.verdict ?? 'measured');

    // An outcome that came back WORSE is not good news to bury at the
    // bottom of a section sorted by recency.
    const severity: DigestSeverity = verdict === 'worsened' ? 'high'
      : verdict === 'improved' ? 'info' : 'low';

    // The citation identifies a task_outcomes row whenever one exists; fall
    // back to the task only when the taxonomy could not name one, so the
    // source always points at something that really exists.
    const source: DigestSource = outcomeId && check
      ? {
        kind: 'outcome_measurement',
        table: 'task_outcomes',
        row_id: String(check.id),
        href: `/outcomes?task=${encodeURIComponent(taskId)}`,
        evidence: {
          task_id: taskId,
          verdict: check.verdict ?? null,
          metric_value: check.metric_value ?? null,
          baseline_value: check.baseline_value ?? null,
          change_pct: check.change_pct ?? null,
          weeks_after: check.weeks_after ?? null,
          check_date: toIso(check.check_date),
          target_metric: (t.target_metric as string | null) || null,
          taxonomy_state: taxonomy.state,
          taxonomy_reason: taxonomy.reason,
          measurement_window: {
            start: taxonomy.citation.window_start,
            end: taxonomy.citation.window_end,
            end_is_expected: taxonomy.citation.window_end_is_expected,
          },
        },
      }
      : {
        kind: 'outcome_measurement',
        table: 'tasks',
        row_id: taskId,
        href: `/outcomes?task=${encodeURIComponent(taskId)}`,
        evidence: { taxonomy_state: taxonomy.state, taxonomy_reason: taxonomy.reason },
      };

    items.push({
      dedup_key: `outcome:${taskId}`,
      change_fingerprint: fingerprint(['outcome', taskId, verdict, String(check?.change_pct ?? ''), String(check?.weeks_after ?? '')]),
      section: 'verified_outcomes',
      business_id: businessId,
      business_name: name,
      status: verdict,
      severity,
      title: String(t.title ?? taskId),
      detail: taxonomy.reason,
      occurred_at: measuredAt as string,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: measuredAt as string,
      last_occurrence_at: measuredAt as string,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  // #70 receipts that reached `verified` — verification evidence exists.
  const receipts = db.prepare(`
    SELECT id, task_id, task_version, action_type, title, state, result_status, result_summary,
           verified_at, verification_evidence, external_system, external_id, external_permalink
      FROM action_receipts
     WHERE business_id = ? AND state = 'verified' AND verified_at IS NOT NULL
     ORDER BY verified_at DESC
     LIMIT 500
  `).all(businessId) as Array<Record<string, unknown>>;

  for (const r of receipts) {
    const verifiedAt = toIso(r.verified_at);
    if (!inWindow(verifiedAt, window.start, window.end)) continue;

    let evidence: unknown = null;
    try { evidence = r.verification_evidence ? JSON.parse(String(r.verification_evidence)) : null; }
    catch { evidence = null; }

    const source: DigestSource = {
      kind: 'action_receipt',
      table: 'action_receipts',
      row_id: String(r.id),
      href: `/receipts?receipt=${encodeURIComponent(String(r.id))}`,
      external_permalink: (r.external_permalink as string | null) ?? null,
      evidence: {
        task_id: r.task_id ?? null,
        task_version: r.task_version ?? null,
        action_type: r.action_type ?? null,
        result_status: r.result_status ?? null,
        result_summary: r.result_summary ?? null,
        external_system: r.external_system ?? null,
        external_id: r.external_id ?? null,
        verified_at: verifiedAt,
        verification_evidence: evidence,
      },
    };

    items.push({
      dedup_key: `receipt_verified:${String(r.id)}`,
      change_fingerprint: fingerprint(['receipt_verified', String(r.id), String(r.result_status ?? ''), verifiedAt]),
      section: 'verified_outcomes',
      business_id: businessId,
      business_name: name,
      status: 'verified_action',
      severity: 'info',
      title: String(r.title ?? r.action_type ?? `Receipt ${String(r.id)}`),
      detail: (r.result_summary as string | null) ?? 'Action verified against the external system.',
      occurred_at: verifiedAt as string,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: verifiedAt as string,
      last_occurrence_at: verifiedAt as string,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  return items;
}

const TIER_SEVERITY: Record<string, DigestSeverity> = {
  red: 'critical', amber: 'high', yellow: 'medium', green: 'low',
};

/**
 * Pending decisions, straight from #61's queue.
 *
 * Note the window is NOT applied to `created_at` here. A decision that has
 * been waiting three weeks is more urgent than one raised this morning, and
 * dropping it because it predates the watermark would make the digest's
 * "needs you" section silently incomplete. Suppression of already-seen
 * decisions is instead handled where it belongs — by the fingerprint check,
 * which replays the item the moment its lane or risk tier moves.
 */
function buildPendingDecisions(businessId: string): DigestItem[] {
  const name = businessNameOf(businessId);
  let queue;
  try {
    queue = listPendingDecisions(businessId, { limit: 200 });
  } catch {
    // A policy/queue failure must not take the whole digest down; the
    // failures section is where the operator would learn about it anyway.
    return [];
  }

  return queue.decisions.map((d) => {
    const occurredAt = toIso(d.created_at) ?? new Date(0).toISOString();
    const source: DigestSource = {
      kind: 'pending_decision',
      table: 'tasks',
      row_id: d.task_id,
      href: `/decision-centre?task=${encodeURIComponent(d.task_id)}`,
      evidence: {
        lane: d.lane,
        lane_reason: d.lane_reason,
        risk_tier: d.risk_tier,
        policy_recommendation: d.policy_recommendation,
        hold_reasons: d.hold_reasons,
        requires_override_reason: d.requires_override_reason,
        decision_class: d.decision_class,
        action_type: d.required_action.action_type,
        executable: d.required_action.executable,
        policy_citation: d.policy.citation,
        task_status: d.status,
        created_at: occurredAt,
      },
    };

    return {
      dedup_key: `decision:${d.task_id}`,
      // Lane and risk tier are the material fields: either moving means the
      // reviewer's job changed. `updated_at` deliberately is not included —
      // it ticks for reasons that do not change the decision.
      change_fingerprint: fingerprint(['decision', d.task_id, d.lane, d.risk_tier, d.policy_recommendation, d.status]),
      section: 'pending_decisions' as const,
      business_id: businessId,
      business_name: name,
      status: d.lane,
      severity: TIER_SEVERITY[d.risk_tier] ?? 'medium',
      title: d.title,
      detail: d.lane_reason,
      occurred_at: occurredAt,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: occurredAt,
      last_occurrence_at: occurredAt,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    };
  });
}

const HEALTH_SEVERITY: Record<ConnectorHealthState, DigestSeverity> = {
  failing: 'critical',
  permission_required: 'high',
  partial: 'medium',
  stale: 'medium',
  healthy: 'info',
  not_applicable: 'info',
};

const ISSUE_SEVERITY: Record<string, DigestSeverity> = {
  critical: 'critical', error: 'high', warning: 'medium', info: 'low',
};

/**
 * Failures and stale data.
 *
 * Like pending decisions, connector health is a CURRENT-STATE section, not
 * an event log: a connector that broke before the watermark and is still
 * broken is still the reason today's numbers are wrong. Time-filtering it
 * would produce the worst possible digest — one that says "all clear"
 * precisely because the breakage is old news.
 */
function buildFailures(businessId: string, window: DigestWindow): DigestItem[] {
  const items: DigestItem[] = [];
  const name = businessNameOf(businessId);

  const connectors = db.prepare(
    'SELECT id, business_id, type, name, status, last_sync, last_error, config FROM connectors WHERE business_id = ?'
  ).all(businessId) as Array<Record<string, unknown>>;

  for (const c of connectors) {
    let health;
    try {
      health = explainConnectorHealth(c as never);
    } catch {
      continue;
    }
    if (health.state === 'healthy' || health.state === 'not_applicable') continue;

    const occurredAt = toIso(c.last_sync) ?? toIso(c.created_at) ?? window.start;
    const source: DigestSource = {
      kind: 'connector_health',
      table: 'connectors',
      row_id: String(c.id),
      href: `/connectors?connector=${encodeURIComponent(String(c.id))}`,
      evidence: {
        connector_type: c.type ?? null,
        health_state: health.state,
        summary: health.summary,
        impact: health.impact,
        next_step: health.next_step,
        last_success: health.last_success,
        coverage_complete: health.coverage_complete,
        last_error: c.last_error ?? null,
      },
    };

    items.push({
      // Keyed on the connector, not on the state: successive scans of the
      // same broken connector must collapse — and a state change within
      // that group is exactly what the escalation logic must surface.
      dedup_key: `connector:${String(c.id)}`,
      change_fingerprint: fingerprint(['connector', String(c.id), health.state, String(health.last_success ?? ''), String(health.coverage_complete ?? '')]),
      section: 'failures_and_stale_data',
      business_id: businessId,
      business_name: name,
      status: health.state,
      severity: HEALTH_SEVERITY[health.state] ?? 'medium',
      title: `${String(c.name ?? c.type ?? 'Connector')} — ${health.state.replace(/_/g, ' ')}`,
      detail: health.summary,
      occurred_at: occurredAt,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: occurredAt,
      last_occurrence_at: occurredAt,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  // Open system issues — "why didn't Blueprint act".
  let issues: ReturnType<typeof listSystemIssues>;
  try {
    issues = listSystemIssues({ business_id: businessId, status: 'open', limit: 200 });
  } catch {
    issues = [];
  }

  for (const issue of issues) {
    const occurredAt = toIso(issue.created_at) ?? window.start;
    const source: DigestSource = {
      kind: 'system_issue',
      table: 'system_issues',
      row_id: issue.id,
      href: `/health?issue=${encodeURIComponent(issue.id)}`,
      evidence: {
        issue_type: issue.issue_type,
        severity: issue.severity,
        description: issue.description,
        related_task_id: issue.related_task_id,
        related_connector_id: issue.related_connector_id,
        related_action_type: issue.related_action_type,
        status: issue.status,
        created_at: occurredAt,
      },
    };

    items.push({
      // Grouped by issue TYPE, not id: the same rule tripping fifty times is
      // one thing an operator needs to know about, not fifty.
      dedup_key: `system_issue:${issue.issue_type}`,
      change_fingerprint: fingerprint(['system_issue', issue.issue_type, issue.severity, issue.status]),
      section: 'failures_and_stale_data',
      business_id: businessId,
      business_name: name,
      status: issue.issue_type,
      severity: ISSUE_SEVERITY[issue.severity] ?? 'medium',
      title: issue.title,
      detail: issue.description,
      occurred_at: occurredAt,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: occurredAt,
      last_occurrence_at: occurredAt,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  // Executions that actually failed, from #70 receipts.
  const failed = db.prepare(`
    SELECT id, task_id, action_type, title, state, result_status, result_summary,
           executed_at, updated_at, external_permalink
      FROM action_receipts
     WHERE business_id = ? AND (state = 'failed' OR result_status = 'failure')
     ORDER BY updated_at DESC
     LIMIT 200
  `).all(businessId) as Array<Record<string, unknown>>;

  for (const r of failed) {
    const occurredAt = toIso(r.executed_at) ?? toIso(r.updated_at);
    if (!inWindow(occurredAt, window.start, window.end)) continue;

    const source: DigestSource = {
      kind: 'failed_action',
      table: 'action_receipts',
      row_id: String(r.id),
      href: `/receipts?receipt=${encodeURIComponent(String(r.id))}`,
      external_permalink: (r.external_permalink as string | null) ?? null,
      evidence: {
        task_id: r.task_id ?? null,
        action_type: r.action_type ?? null,
        state: r.state ?? null,
        result_status: r.result_status ?? null,
        result_summary: r.result_summary ?? null,
        executed_at: occurredAt,
      },
    };

    items.push({
      dedup_key: `failed_action:${String(r.action_type ?? 'unknown')}`,
      change_fingerprint: fingerprint(['failed_action', String(r.id), String(r.state ?? ''), String(r.result_status ?? '')]),
      section: 'failures_and_stale_data',
      business_id: businessId,
      business_name: name,
      status: 'failed_execution',
      severity: 'high',
      title: String(r.title ?? r.action_type ?? 'Action failed'),
      detail: (r.result_summary as string | null) ?? 'Execution failed.',
      occurred_at: occurredAt as string,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: occurredAt as string,
      last_occurrence_at: occurredAt as string,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  return items;
}

/**
 * Informational activity — work happened, no outcome is claimed.
 *
 * Everything here is explicitly `severity: 'info'` and every title is
 * phrased as activity. This section must never read as achievement; that is
 * what verified_outcomes is for.
 */
function buildInformational(businessId: string, window: DigestWindow): DigestItem[] {
  const items: DigestItem[] = [];
  const name = businessNameOf(businessId);

  // Completed tasks that did NOT produce a measured outcome.
  const tasks = db.prepare(`
    SELECT id, title, status, action_type, proposed_by, completed_at, target_metric
      FROM tasks
     WHERE business_id = ? AND status IN ('complete', 'verified') AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 500
  `).all(businessId) as Array<Record<string, unknown>>;

  for (const t of tasks) {
    const completedAt = toIso(t.completed_at);
    if (!inWindow(completedAt, window.start, window.end)) continue;

    const taskId = String(t.id);
    const checks = db.prepare(
      'SELECT * FROM task_outcomes WHERE task_id = ? ORDER BY weeks_after ASC'
    ).all(taskId) as TaxonomyCheckLike[];

    const taxonomy = classifyOutcomeTaxonomy({
      task_id: taskId,
      task_status: String(t.status ?? ''),
      action_type: (t.action_type as string | null) ?? null,
      target_metric: (t.target_metric as string | null) || null,
      completed_at: completedAt,
      checks,
    });

    // Measured outcomes belong in verified_outcomes, and must not be
    // double-counted here as generic activity.
    if (taxonomy.state === 'outcome_measured') continue;

    const source: DigestSource = {
      kind: 'task_activity',
      table: 'tasks',
      row_id: taskId,
      href: `/tasks?task=${encodeURIComponent(taskId)}`,
      evidence: {
        status: t.status ?? null,
        action_type: t.action_type ?? null,
        proposed_by: t.proposed_by ?? null,
        completed_at: completedAt,
        target_metric: (t.target_metric as string | null) || null,
        taxonomy_state: taxonomy.state,
        taxonomy_reason: taxonomy.reason,
      },
    };

    items.push({
      dedup_key: `task_activity:${taskId}`,
      change_fingerprint: fingerprint(['task_activity', taskId, String(t.status ?? ''), taxonomy.state]),
      section: 'informational_activity',
      business_id: businessId,
      business_name: name,
      // Status carries the honest taxonomy label, so even in the low-signal
      // section a reader can see this was activity rather than a result.
      status: taxonomy.state,
      severity: 'info',
      title: String(t.title ?? taskId),
      detail: taxonomy.reason,
      occurred_at: completedAt as string,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: completedAt as string,
      last_occurrence_at: completedAt as string,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  // Agent runs that completed in the window.
  const runs = db.prepare(`
    SELECT id, agent_id, status, tasks_proposed, signals_detected, started_at, completed_at
      FROM agent_runs
     WHERE business_id = ? AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 300
  `).all(businessId) as Array<Record<string, unknown>>;

  for (const r of runs) {
    const completedAt = toIso(r.completed_at);
    if (!inWindow(completedAt, window.start, window.end)) continue;

    const source: DigestSource = {
      kind: 'agent_run',
      table: 'agent_runs',
      row_id: String(r.id),
      href: `/timeline?run=${encodeURIComponent(String(r.id))}`,
      evidence: {
        agent_id: r.agent_id ?? null,
        status: r.status ?? null,
        tasks_proposed: r.tasks_proposed ?? 0,
        signals_detected: r.signals_detected ?? 0,
        started_at: toIso(r.started_at),
        completed_at: completedAt,
      },
    };

    items.push({
      // Keyed per agent: twelve hourly Conductor runs are one line
      // ("Conductor ran 12 times"), not twelve.
      dedup_key: `agent_run:${String(r.agent_id ?? 'unknown')}`,
      change_fingerprint: fingerprint(['agent_run', String(r.id), String(r.status ?? '')]),
      section: 'informational_activity',
      business_id: businessId,
      business_name: name,
      status: String(r.status ?? 'unknown'),
      severity: 'info',
      title: `${String(r.agent_id ?? 'Agent')} ran`,
      detail: `Proposed ${Number(r.tasks_proposed ?? 0)} task(s), detected ${Number(r.signals_detected ?? 0)} signal(s).`,
      occurred_at: completedAt as string,
      source,
      occurrences: [source],
      occurrence_count: 1,
      first_occurrence_at: completedAt as string,
      last_occurrence_at: completedAt as string,
      escalation: null,
      previously_seen: false,
      replay_reason: null,
    });
  }

  return items;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/**
 * Collapse items sharing a dedup_key into one entry.
 *
 * The entry reports occurrence_count and the first/last occurrence times,
 * and keeps EVERY occurrence's source in `occurrences` — so collapsing
 * never destroys the evidence trail, it only stops repeating it visually.
 *
 * When the group's members disagree on severity, the group takes the worst
 * severity seen and is stamped with an `escalation` citing both ends. A
 * repeat that got worse is a material change, and reporting it as "×3"
 * alongside the other duplicates would bury exactly the thing worth reading.
 */
export function deduplicateItems(items: DigestItem[]): DigestItem[] {
  const groups = new Map<string, DigestItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.dedup_key);
    if (bucket) bucket.push(item);
    else groups.set(item.dedup_key, [item]);
  }

  const out: DigestItem[] = [];
  for (const [, members] of groups) {
    if (members.length === 1) { out.push(members[0]!); continue; }

    const byTime = [...members].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const earliest = byTime[0]!;
    const latest = byTime[byTime.length - 1]!;

    // Representative = worst severity, tie-broken by most recent, so the
    // collapsed entry's title/detail describe the state that matters now.
    const representative = [...members].sort((a, b) =>
      severityRank(a.severity) - severityRank(b.severity)
      || Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
    )[0]!;

    const worstRank = severityRank(representative.severity);
    const earliestRank = severityRank(earliest.severity);

    const escalation: DigestEscalation | null = worstRank < earliestRank
      ? {
        reason:
          `Severity escalated from ${earliest.severity} to ${representative.severity} across `
          + `${members.length} occurrence(s): "${earliest.status}" → "${representative.status}". `
          + 'This is a material change, not a repeat.',
        from_severity: earliest.severity,
        to_severity: representative.severity,
        from_source: earliest.source,
        to_source: representative.source,
      }
      : null;

    out.push({
      ...representative,
      // Fold every member's fingerprint in, so a change to ANY occurrence in
      // the group replays the collapsed entry rather than staying hidden
      // behind the representative's unchanged fingerprint.
      change_fingerprint: fingerprint([
        'group', representative.dedup_key,
        ...byTime.map((m) => m.change_fingerprint),
      ]),
      occurrences: byTime.map((m) => m.source),
      occurrence_count: members.length,
      first_occurrence_at: earliest.occurred_at,
      last_occurrence_at: latest.occurred_at,
      occurred_at: latest.occurred_at,
      escalation,
    });
  }

  return out;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function sortItems(items: DigestItem[]): DigestItem[] {
  return [...items].sort((a, b) =>
    // An escalation outranks a same-severity item: it is the thing most
    // likely to be missed in a section the reader has skimmed before.
    severityRank(a.severity) - severityRank(b.severity)
    || Number(!!b.escalation) - Number(!!a.escalation)
    || Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
  );
}

function emptySections(): Record<DigestSection, DigestItem[]> {
  return {
    verified_outcomes: [], pending_decisions: [],
    failures_and_stale_data: [], informational_activity: [],
  };
}

/**
 * Build the digest.
 *
 * Suppression rule, in one place: an item is hidden iff a watermark applies
 * (i.e. the caller did NOT explicitly ask for a period) AND the item's
 * dedup_key was acknowledged AND its fingerprint is unchanged. Anything
 * else is shown — a changed fingerprint is shown and flagged as changed,
 * never presented as new.
 */
export function buildAwayDigest(request: DigestRequest = {}): AwayDigest {
  const now = new Date();
  const operator = normalizeOperator(request.operator_key);
  const scope = normalizeScope(request.business_id);
  const window = resolveWindow(operator, scope, request, now);
  const limit = Math.min(Math.max(request.limit ?? 100, 1), 500);

  const watermark = getWatermark(operator, scope);
  const acknowledged = window.watermark_applied ? (watermark?.acknowledged_items ?? {}) : {};

  const businesses: DigestBusinessGroup[] = [];
  const totals = {
    verified_outcomes: 0, pending_decisions: 0,
    failures_and_stale_data: 0, informational_activity: 0,
    total: 0, suppressed_as_seen: 0,
  };
  const acknowledgeable: Record<string, string> = {};
  let suppressed = 0;

  for (const business of listScopedBusinesses(scope)) {
    const raw: DigestItem[] = [
      ...buildVerifiedOutcomes(business.id, window),
      ...buildPendingDecisions(business.id),
      ...buildFailures(business.id, window),
      ...buildInformational(business.id, window),
    ];

    const deduped = deduplicateItems(raw);

    const sections = emptySections();
    const statusCounts: Record<DigestSection, Record<string, number>> = {
      verified_outcomes: {}, pending_decisions: {},
      failures_and_stale_data: {}, informational_activity: {},
    };

    for (const item of deduped) {
      const previousFingerprint = acknowledged[item.dedup_key];
      if (previousFingerprint !== undefined) {
        if (previousFingerprint === item.change_fingerprint) {
          suppressed++;
          continue;
        }
        item.previously_seen = true;
        item.replay_reason = item.escalation
          ? item.escalation.reason
          : 'This item was in a digest you acknowledged, and has materially changed since.';
      }
      sections[item.section].push(item);
    }

    let businessTotal = 0;
    for (const section of DIGEST_SECTIONS) {
      sections[section] = sortItems(sections[section]).slice(0, limit);
      for (const item of sections[section]) {
        statusCounts[section][item.status] = (statusCounts[section][item.status] ?? 0) + 1;
        acknowledgeable[item.dedup_key] = item.change_fingerprint;
        totals[section]++;
        businessTotal++;
      }
    }

    // A business with nothing to report is omitted rather than rendered as
    // an empty shell — but only in the cross-business digest. Asking about
    // one business must always answer about that business.
    if (businessTotal === 0 && scope === ALL_BUSINESSES) continue;

    businesses.push({
      business_id: business.id,
      business_name: business.name,
      sections,
      status_counts: statusCounts,
      total_items: businessTotal,
    });
  }

  totals.total = totals.verified_outcomes + totals.pending_decisions
    + totals.failures_and_stale_data + totals.informational_activity;
  totals.suppressed_as_seen = suppressed;

  return {
    digest_schema_version: DIGEST_SCHEMA_VERSION,
    // Deterministic in its inputs, so an acknowledgement can be checked
    // against the digest it claims to be acknowledging.
    digest_id: `digest_${fingerprint([operator, scope, window.start, window.end])}_${Date.parse(window.end)}`,
    operator_key: operator,
    scope,
    window,
    generated_at: now.toISOString(),
    businesses,
    totals,
    suppressed_as_seen: suppressed,
    acknowledgeable,
  };
}
