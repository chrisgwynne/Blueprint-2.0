/**
 * Grounded retrieval over Blueprint's audit history (issue #72).
 *
 * ── What this file is ────────────────────────────────────────────────────
 *
 * The RETRIEVAL half of natural-language audit search. It answers one
 * question and only one question: "given these structured filters, which
 * REAL ROWS match?" There is no model in this file, no scoring heuristic
 * that invents a fact, and no code path that returns a record Blueprint did
 * not already write.
 *
 * The interpretation half (query-interpretation.ts) turns a sentence into
 * the filters. It is deliberately a separate module with a separate failure
 * mode, because the two must never be confused: a bad interpretation
 * returns the WRONG rows, which is recoverable and visible; a retrieval
 * layer that could synthesise a row would make the whole feature unusable
 * as evidence.
 *
 * ── Every result is a row, and says which row ────────────────────────────
 *
 * Each AuditRecord carries a citation — `{record_type}#{record_id}` plus
 * the SQLite table it came from — which is enough to re-read the source and
 * check the claim. The snippet is copied VERBATIM out of designated columns
 * of that row (then redacted); it is never paraphrased or generated. That is
 * what makes "cites underlying records and supports drill-down" a
 * structural property rather than a promise.
 *
 * ── Business scoping is a property of the SQL, not of the caller ─────────
 *
 * Every fetcher takes the permitted business id and filters on it inside the
 * query. There is no fetcher that returns rows for a business and then
 * relies on someone else to filter them out. Types whose own table has no
 * business_id (task_outcomes, task_events, connector_syncs) are joined back
 * to the table that does, so the scoping is still done by the database.
 *
 * ── Matching is lexical, and says so ─────────────────────────────────────
 *
 * Matching is SQL LIKE over that record type's searchable columns. It is
 * not semantic and does not pretend to be: a record matches because a term
 * literally occurs in it, `matched_terms` reports which terms did, and the
 * score is a documented arithmetic of those hits. A user reading a result
 * can always see exactly why it is in the list.
 */
import db from '../db/db.js';
import { redactSensitive, redactSensitiveText } from '../lib/redaction.js';

/** Bump when the record shape changes in a way a reader must know about. */
export const AUDIT_SEARCH_SCHEMA_VERSION = 'audit_search.v1';

// ─── Record types ────────────────────────────────────────────────────────────

/**
 * The kinds of history that can be searched. Each maps to exactly one
 * durable table — there is no synthetic or derived record type, because a
 * search result that does not correspond to a stored row cannot be
 * drilled into.
 */
export type AuditRecordType =
  /** decisions (#61) — why a call was made, with its policy citation (#68). */
  | 'decision'
  /** tasks — what was proposed, approved, rejected, executed. */
  | 'task'
  /** action_receipts (#70) — what was actually done and what proves it. */
  | 'receipt'
  /** task_outcomes (#63) — what a later measurement found. */
  | 'outcome'
  /** operating_policy_events (#68) — which policy changed, when, and why. */
  | 'policy_event'
  /** connector_syncs — connector activity, including sync failures. */
  | 'connector_event'
  /** signals — what was detected. */
  | 'signal'
  /** agent_runs — an agent's reasoning pass. */
  | 'agent_run'
  /** audit_log — the generic entity-change trail. */
  | 'audit_event';

export const AUDIT_RECORD_TYPES: AuditRecordType[] = [
  'decision', 'task', 'receipt', 'outcome',
  'policy_event', 'connector_event', 'signal', 'agent_run', 'audit_event',
];

export const RECORD_TYPE_MEANING: Record<AuditRecordType, string> = {
  decision: 'A recorded decision, with the reasoning, evidence and operating-policy version behind it.',
  task: 'A proposed, approved, rejected or executed piece of work.',
  receipt: 'A verified action receipt — what was actually executed and what acknowledged or verified it.',
  outcome: 'A measured outcome check against a task, taken some weeks after the action.',
  policy_event: 'A change to an operating policy — activation, edit, rollback or schedule.',
  connector_event: 'A connector sync attempt, including its failures.',
  signal: 'Something Blueprint detected in connected data.',
  agent_run: 'One reasoning pass by an agent, including its failures.',
  audit_event: 'A generic entity-change entry in the audit log.',
};

// ─── Citations ───────────────────────────────────────────────────────────────

export interface AuditCitation {
  /**
   * The canonical citation token, e.g. `decision#dec_17`. This exact string
   * is what a generated summary must use, and what grounding.ts resolves
   * back to a retrieved record. Its format is load-bearing.
   */
  ref: string;
  record_type: AuditRecordType;
  record_id: string;
  /** The SQLite table the row lives in, so the claim can be re-checked. */
  table: string;
}

export function citationRef(type: AuditRecordType, id: string): string {
  return `${type}#${id}`;
}

// ─── Freshness ───────────────────────────────────────────────────────────────

/**
 * How current a record is. Separate from whether it MATCHED: a perfectly
 * relevant record can be six weeks old, and a search that hides that is
 * how an operator ends up acting on a dead trail.
 */
export type RecordFreshness = 'fresh' | 'recent' | 'ageing' | 'stale' | 'unknown';

/** Hours after which a record stops being described as current. */
export const FRESH_HOURS = 48;
export const RECENT_HOURS = 24 * 7;
export const AGEING_HOURS = 24 * 30;

export function ageHours(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (now - parsed) / 3_600_000);
}

export function freshnessOf(iso: string | null, now = Date.now()): RecordFreshness {
  const age = ageHours(iso, now);
  if (age === null) return 'unknown';
  if (age <= FRESH_HOURS) return 'fresh';
  if (age <= RECENT_HOURS) return 'recent';
  if (age <= AGEING_HOURS) return 'ageing';
  return 'stale';
}

// ─── The record ──────────────────────────────────────────────────────────────

export interface AuditRecord {
  citation: AuditCitation;
  business_id: string;
  /** Copied from the row, never composed from several rows. */
  title: string;
  /**
   * Verbatim text from the row's own columns, redacted. NOT a paraphrase,
   * NOT model output. `snippet_fields` names the columns it came from so a
   * reader can go and check it.
   */
  snippet: string;
  snippet_fields: string[];
  /** The row's own status/state value, when it has one. */
  status: string | null;
  /** When this record's event happened, per the row's own timestamp column. */
  occurred_at: string | null;
  age_hours: number | null;
  freshness: RecordFreshness;
  /** Who or what did it, when the row records that. */
  actor: string | null;
  /** Facts copied out of the row. Nothing here is computed. */
  fields: Record<string, unknown>;
  /** Dashboard route for drill-down into the surface that owns this record. */
  href: string;
  /**
   * The #60 explanation subject for this record, when one exists — so
   * "why did this happen?" is one click away and answered by the module
   * that already owns that question, not re-derived here.
   */
  explainable: { kind: string; id: string } | null;
  /** Which of the query's terms literally occur in this record. */
  matched_terms: string[];
  /** Documented lexical score. See scoreRecord(). */
  score: number;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface RetrievalFilters {
  /** The one business these rows may come from. Enforced in SQL. */
  business_id: string;
  /** Empty means "every type". */
  record_types: AuditRecordType[];
  /** Empty means "every status". Matched case-insensitively against the row's own status. */
  statuses: string[];
  /** Inclusive ISO lower bound on the record's occurred_at. */
  from: string | null;
  /** Exclusive ISO upper bound on the record's occurred_at. */
  to: string | null;
  /** Lexical terms. Empty means "no keyword constraint". */
  terms: string[];
  /** Cap on rows fetched PER TYPE before merging and ranking. */
  per_type_limit: number;
}

export const DEFAULT_PER_TYPE_LIMIT = 60;

// ─── SQL helpers ─────────────────────────────────────────────────────────────

/**
 * SQLite DATETIME columns hold two forms: ISO-8601 from application writes
 * and 'YYYY-MM-DD HH:MM:SS' (UTC, unmarked) from CURRENT_TIMESTAMP.
 * Comparing those as raw strings silently mis-orders records, so every
 * timestamp is normalised on the way out — the same approach
 * digest/away-digest.ts takes.
 */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function inRange(iso: string | null, from: string | null, to: string | null): boolean {
  // A record with no timestamp cannot be shown to fall inside a requested
  // window. It is excluded when a window was asked for, rather than
  // included on the assumption that it is probably recent.
  if (!from && !to) return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (from && t < Date.parse(from)) return false;
  if (to && t >= Date.parse(to)) return false;
  return true;
}

/** Escape LIKE metacharacters so a user's `%` searches for a literal `%`. */
function likeArg(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Build `(colA LIKE ? ESCAPE '\' OR colB LIKE ? ...)` for every term, ANDed
 * across terms: a record must contain EVERY term somewhere, in at least one
 * of its searchable columns. AND rather than OR because an audit search
 * that widens as you add words is useless for narrowing an investigation.
 */
function termClause(columns: string[], terms: string[]): { sql: string; params: string[] } {
  if (!terms.length || !columns.length) return { sql: '', params: [] };
  const params: string[] = [];
  const perTerm = terms.map((term) => {
    const arg = likeArg(term);
    return `(${columns.map((c) => { params.push(arg); return `COALESCE(${c}, '') LIKE ? ESCAPE '\\'`; }).join(' OR ')})`;
  });
  return { sql: ` AND ${perTerm.join(' AND ')}`, params };
}

function statusClause(column: string, statuses: string[]): { sql: string; params: string[] } {
  if (!statuses.length) return { sql: '', params: [] };
  const placeholders = statuses.map(() => '?').join(', ');
  return {
    sql: ` AND LOWER(COALESCE(${column}, '')) IN (${placeholders})`,
    params: statuses.map((s) => s.toLowerCase()),
  };
}

function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Assemble the verbatim snippet from the row's own columns, preferring the
 * columns that actually contain a query term so the user sees WHY the row
 * matched. Copied and redacted — never rewritten.
 */
function buildSnippet(
  parts: Array<{ field: string; value: unknown }>,
  terms: string[],
  maxChars = 320,
): { snippet: string; fields: string[] } {
  const populated = parts
    .map((p) => ({ field: p.field, value: text(p.value).trim() }))
    .filter((p) => p.value.length > 0);
  if (!populated.length) return { snippet: '', fields: [] };

  const lowerTerms = terms.map((t) => t.toLowerCase());
  const hits = populated.filter((p) => lowerTerms.some((t) => p.value.toLowerCase().includes(t)));
  const ordered = hits.length ? [...hits, ...populated.filter((p) => !hits.includes(p))] : populated;

  const chosen: string[] = [];
  const fields: string[] = [];
  let used = 0;
  for (const p of ordered) {
    if (used >= maxChars) break;
    const room = maxChars - used;
    const slice = p.value.length > room ? `${p.value.slice(0, room)}…` : p.value;
    chosen.push(slice);
    fields.push(p.field);
    used += slice.length;
  }
  return { snippet: redactSensitiveText(chosen.join(' · ')), fields };
}

/**
 * Which of the query's terms literally occur in this record's searchable
 * text. Reported per result so relevance is auditable rather than asserted.
 */
function matchedTerms(haystack: string, terms: string[]): string[] {
  const lower = haystack.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

/**
 * Documented, deterministic lexical score. Not a relevance model:
 *
 *   +4  per query term occurring in the title
 *   +1  per query term occurring anywhere else in the record's text
 *   +1  when the record is fresh, +0.5 when recent
 *
 * The recency component is a tie-break only — it is deliberately far too
 * small to float an irrelevant recent record above a relevant old one,
 * because "what happened last March" must still be answerable.
 */
function scoreRecord(title: string, body: string, terms: string[], freshness: RecordFreshness): number {
  let score = 0;
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  for (const term of terms) {
    const t = term.toLowerCase();
    if (lowerTitle.includes(t)) score += 4;
    if (lowerBody.includes(t)) score += 1;
  }
  if (freshness === 'fresh') score += 1;
  else if (freshness === 'recent') score += 0.5;
  return score;
}

interface AssembleInput {
  type: AuditRecordType;
  table: string;
  id: string;
  business_id: string;
  title: string;
  status: string | null;
  occurred_at: unknown;
  actor: string | null;
  href: string;
  explainable: { kind: string; id: string } | null;
  snippetParts: Array<{ field: string; value: unknown }>;
  fields: Record<string, unknown>;
  terms: string[];
  now: number;
}

/**
 * The single construction point for every AuditRecord, so redaction and
 * citation-stamping cannot be forgotten by an individual fetcher — the same
 * choke-point discipline explain/explanation.ts uses for explanations.
 */
function assemble(input: AssembleInput): AuditRecord {
  const occurredAt = toIso(input.occurred_at);
  const freshness = freshnessOf(occurredAt, input.now);
  const { snippet, fields } = buildSnippet(input.snippetParts, input.terms);
  const title = redactSensitiveText(input.title || input.id);
  const haystack = `${title} ${input.snippetParts.map((p) => text(p.value)).join(' ')}`;

  return {
    citation: {
      ref: citationRef(input.type, input.id),
      record_type: input.type,
      record_id: input.id,
      table: input.table,
    },
    business_id: input.business_id,
    title,
    snippet,
    snippet_fields: fields,
    status: input.status,
    occurred_at: occurredAt,
    age_hours: ageHours(occurredAt, input.now),
    freshness,
    actor: input.actor ? redactSensitiveText(input.actor) : null,
    fields: redactSensitive<Record<string, unknown>>(input.fields, { maxDepth: 4, maxStringLength: 300 }),
    href: input.href,
    explainable: input.explainable,
    matched_terms: matchedTerms(haystack, input.terms),
    score: scoreRecord(title, haystack, input.terms, freshness),
  };
}

// ─── Per-type fetchers ───────────────────────────────────────────────────────
//
// One function per record type. Each is a plain SQL read scoped to the
// business by the query itself. None of them writes, and none of them
// derives a value the row does not contain.

type Row = Record<string, unknown>;

function fetchDecisions(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['title', 'decision', 'reasoning', 'decision_type', 'author'];
  const t = termClause(cols, f.terms);
  const s = statusClause('decision_type', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM decisions WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'decision', table: 'decisions',
    id: String(r.id), business_id: String(r.business_id),
    title: text(r.title),
    // decision_type IS the status of a decision row: it is what
    // distinguishes an approval from a deferral from a dismissal.
    status: r.decision_type == null ? null : String(r.decision_type),
    occurred_at: r.created_at,
    actor: r.author == null ? null : String(r.author),
    href: '/decisions',
    explainable: { kind: 'decision', id: String(r.id) },
    snippetParts: [
      { field: 'decision', value: r.decision },
      { field: 'reasoning', value: r.reasoning },
    ],
    fields: {
      decision_type: r.decision_type,
      decision: r.decision,
      confidence: r.confidence,
      author: r.author,
      related_task_id: r.related_task_id,
      related_goal_id: r.related_goal_id,
      related_signal_id: r.related_signal_id,
      // The #68 policy citation, carried through verbatim: "which policy
      // applied" is answerable from the decision row itself.
      effective_policy_id: r.effective_policy_id,
      effective_policy_version: r.effective_policy_version,
      effective_policy_scope: r.effective_policy_scope,
    },
    terms: f.terms, now,
  }));
}

function fetchTasks(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['title', 'description', 'action_type', 'proposed_by', 'assigned_to', 'rejection_reason', 'outcome'];
  const t = termClause(cols, f.terms);
  const s = statusClause('status', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'task', table: 'tasks',
    id: String(r.id), business_id: String(r.business_id),
    title: text(r.title),
    status: r.status == null ? null : String(r.status),
    // A task's own timeline instant is when it last moved, not when it was
    // first proposed — that is what "what happened last week" means for it.
    occurred_at: r.updated_at ?? r.created_at,
    actor: r.approved_by == null ? (r.proposed_by == null ? null : String(r.proposed_by)) : String(r.approved_by),
    href: '/tasks',
    explainable: { kind: 'task', id: String(r.id) },
    snippetParts: [
      { field: 'description', value: r.description },
      { field: 'rejection_reason', value: r.rejection_reason },
      { field: 'outcome', value: r.outcome },
    ],
    fields: {
      action_type: r.action_type,
      priority: r.priority,
      trust_tier: r.trust_tier,
      confidence: r.confidence,
      proposed_by: r.proposed_by,
      approved_by: r.approved_by,
      approved_at: toIso(r.approved_at),
      completed_at: toIso(r.completed_at),
      rejection_reason: r.rejection_reason,
      review_override_reason: r.review_override_reason,
      deferred_by: r.deferred_by,
      amended_by: r.amended_by,
      created_at: toIso(r.created_at),
    },
    terms: f.terms, now,
  }));
}

function fetchReceipts(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['title', 'action_type', 'result_summary', 'external_system', 'external_id', 'rejection_reason'];
  const t = termClause(cols, f.terms);
  const s = statusClause('state', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM action_receipts WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'receipt', table: 'action_receipts',
    id: String(r.id), business_id: String(r.business_id),
    title: text(r.title) || `${text(r.action_type) || 'action'} receipt`,
    status: r.state == null ? null : String(r.state),
    occurred_at: r.updated_at ?? r.created_at,
    actor: r.authorized_by == null ? null : String(r.authorized_by),
    href: '/receipts',
    // A receipt is explained through its task: #60 owns the "why", the
    // receipt owns the "what actually happened".
    explainable: r.task_id == null ? null : { kind: 'task', id: String(r.task_id) },
    snippetParts: [
      { field: 'result_summary', value: r.result_summary },
      { field: 'rejection_reason', value: r.rejection_reason },
    ],
    fields: {
      task_id: r.task_id,
      task_version: r.task_version,
      action_type: r.action_type,
      result_status: r.result_status,
      external_system: r.external_system,
      external_id: r.external_id,
      external_permalink: r.external_permalink,
      authorized_by: r.authorized_by,
      executed_at: toIso(r.executed_at),
      externally_acknowledged_at: toIso(r.externally_acknowledged_at),
      verified_at: toIso(r.verified_at),
      attempt_count: r.attempt_count,
    },
    terms: f.terms, now,
  }));
}

function fetchOutcomes(f: RetrievalFilters, now: number): AuditRecord[] {
  // task_outcomes has no business_id of its own, so the join to tasks IS
  // the scoping. Never filtered in application code afterwards.
  const cols = ['t.title', 'o.verdict', 'o.verdict_detail'];
  const term = termClause(cols, f.terms);
  const s = statusClause('o.verdict', f.statuses);
  const rows = db.prepare(
    `SELECT o.*, t.title AS task_title, t.business_id AS business_id, t.target_metric AS target_metric
     FROM task_outcomes o JOIN tasks t ON t.id = o.task_id
     WHERE t.business_id = ?${term.sql}${s.sql}
     ORDER BY o.check_date DESC LIMIT ?`,
  ).all(f.business_id, ...term.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'outcome', table: 'task_outcomes',
    id: String(r.id), business_id: String(r.business_id),
    title: text(r.task_title) ? `Outcome check: ${text(r.task_title)}` : `Outcome check ${String(r.id)}`,
    status: r.verdict == null ? null : String(r.verdict),
    occurred_at: r.check_date ?? r.created_at,
    actor: null,
    href: '/outcomes',
    explainable: r.task_id == null ? null : { kind: 'task', id: String(r.task_id) },
    snippetParts: [{ field: 'verdict_detail', value: r.verdict_detail }],
    fields: {
      task_id: r.task_id,
      verdict: r.verdict,
      weeks_after: r.weeks_after,
      metric_value: r.metric_value,
      baseline_value: r.baseline_value,
      change_pct: r.change_pct,
      target_metric: r.target_metric,
    },
    terms: f.terms, now,
  }));
}

function fetchPolicyEvents(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['event_type', 'reason', 'actor', 'scope_key', 'changed_fields'];
  const t = termClause(cols, f.terms);
  const s = statusClause('event_type', f.statuses);
  // Portfolio-scoped policy events carry no business_id, so they are
  // matched by their scope_key instead — a portfolio policy that governs
  // this business is genuinely part of its history, and omitting it would
  // make "which policy applied" unanswerable for portfolio-governed rows.
  const rows = db.prepare(
    `SELECT e.* FROM operating_policy_events e
     WHERE (e.business_id = ?
            OR (e.scope = 'portfolio' AND e.scope_key IN (
                  SELECT scope_key FROM operating_policies
                  WHERE scope = 'portfolio' AND portfolio_id IN (
                    SELECT portfolio_id FROM operating_policies WHERE business_id = ?
                  ))))${t.sql}${s.sql}
     ORDER BY e.created_at DESC LIMIT ?`,
  ).all(f.business_id, f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'policy_event', table: 'operating_policy_events',
    id: String(r.id),
    // A portfolio event has no business_id column value; it is attributed to
    // the business it was retrieved for, and `scope` says it is portfolio-wide.
    business_id: r.business_id == null ? f.business_id : String(r.business_id),
    title: `Operating policy ${text(r.event_type)} — ${text(r.scope)} v${text(r.version)}`,
    status: r.event_type == null ? null : String(r.event_type),
    occurred_at: r.created_at,
    actor: r.actor == null ? null : String(r.actor),
    href: '/policy',
    explainable: null,
    snippetParts: [
      { field: 'reason', value: r.reason },
      { field: 'changed_fields', value: r.changed_fields },
    ],
    fields: {
      policy_id: r.policy_id,
      scope: r.scope,
      scope_key: r.scope_key,
      version: r.version,
      event_type: r.event_type,
      changed_fields: r.changed_fields,
      reason: r.reason,
    },
    terms: f.terms, now,
  }));
}

function fetchConnectorEvents(f: RetrievalFilters, now: number): AuditRecord[] {
  // connector_syncs is scoped through connectors, in SQL.
  const cols = ['c.name', 'c.type', 's.status', 's.error'];
  const t = termClause(cols, f.terms);
  const st = statusClause('s.status', f.statuses);
  const rows = db.prepare(
    `SELECT s.*, c.name AS connector_name, c.type AS connector_type, c.business_id AS business_id
     FROM connector_syncs s JOIN connectors c ON c.id = s.connector_id
     WHERE c.business_id = ?${t.sql}${st.sql}
     ORDER BY s.created_at DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...st.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'connector_event', table: 'connector_syncs',
    id: String(r.id), business_id: String(r.business_id),
    title: `${text(r.connector_name) || text(r.connector_type) || 'Connector'} sync ${text(r.status)}`,
    status: r.status == null ? null : String(r.status),
    occurred_at: r.created_at,
    actor: null,
    href: '/connectors',
    explainable: null,
    snippetParts: [{ field: 'error', value: r.error }],
    fields: {
      connector_id: r.connector_id,
      connector_name: r.connector_name,
      connector_type: r.connector_type,
      records_fetched: r.records_fetched,
      metrics_stored: r.metrics_stored,
      duration_ms: r.duration_ms,
      error: r.error,
    },
    terms: f.terms, now,
  }));
}

function fetchSignals(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['title', 'description', 'type', 'rule_id', 'severity'];
  const t = termClause(cols, f.terms);
  const s = statusClause('status', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM signals WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'signal', table: 'signals',
    id: String(r.id), business_id: String(r.business_id),
    title: text(r.title),
    status: r.status == null ? null : String(r.status),
    occurred_at: r.created_at,
    actor: r.agent_id == null ? null : String(r.agent_id),
    href: '/signals',
    explainable: null,
    snippetParts: [{ field: 'description', value: r.description }],
    fields: {
      type: r.type,
      severity: r.severity,
      rule_id: r.rule_id,
      confidence: r.confidence,
      connector_id: r.connector_id,
      resolved_at: toIso(r.resolved_at),
    },
    terms: f.terms, now,
  }));
}

function fetchAgentRuns(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['agent_id', 'trigger', 'reasoning', 'error', 'status'];
  const t = termClause(cols, f.terms);
  const s = statusClause('status', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM agent_runs WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY started_at DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'agent_run', table: 'agent_runs',
    id: String(r.id), business_id: String(r.business_id),
    title: `${text(r.agent_id) || 'agent'} run (${text(r.trigger) || 'unknown trigger'})`,
    status: r.status == null ? null : String(r.status),
    occurred_at: r.completed_at ?? r.started_at,
    actor: r.agent_id == null ? null : String(r.agent_id),
    href: '/agents',
    explainable: null,
    snippetParts: [
      { field: 'reasoning', value: r.reasoning },
      { field: 'error', value: r.error },
    ],
    fields: {
      agent_id: r.agent_id,
      trigger: r.trigger,
      trigger_id: r.trigger_id,
      signals_detected: r.signals_detected,
      tasks_proposed: r.tasks_proposed,
      cost_usd: r.cost_usd,
      error: r.error,
      started_at: toIso(r.started_at),
    },
    terms: f.terms, now,
  }));
}

function fetchAuditEvents(f: RetrievalFilters, now: number): AuditRecord[] {
  const cols = ['entity_type', 'entity_id', 'action', 'actor'];
  const t = termClause(cols, f.terms);
  const s = statusClause('action', f.statuses);
  const rows = db.prepare(
    `SELECT * FROM audit_log WHERE business_id = ?${t.sql}${s.sql}
     ORDER BY created_at DESC LIMIT ?`,
  ).all(f.business_id, ...t.params, ...s.params, f.per_type_limit) as Row[];

  return rows.map((r) => assemble({
    type: 'audit_event', table: 'audit_log',
    id: String(r.id), business_id: String(r.business_id ?? f.business_id),
    title: `${text(r.action)} on ${text(r.entity_type)} ${text(r.entity_id)}`,
    status: r.action == null ? null : String(r.action),
    occurred_at: r.created_at,
    actor: r.actor == null ? null : String(r.actor),
    href: '/health',
    explainable: null,
    // before_state/after_state are deliberately NOT snippet material: they
    // are raw entity payloads and the most likely place a credential is
    // hiding. They are reported as presence flags in `fields` instead.
    snippetParts: [{ field: 'action', value: `${text(r.action)} ${text(r.entity_type)}` }],
    fields: {
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      action: r.action,
      actor: r.actor,
      has_before_state: r.before_state != null,
      has_after_state: r.after_state != null,
    },
    terms: f.terms, now,
  }));
}

const FETCHERS: Record<AuditRecordType, (f: RetrievalFilters, now: number) => AuditRecord[]> = {
  decision: fetchDecisions,
  task: fetchTasks,
  receipt: fetchReceipts,
  outcome: fetchOutcomes,
  policy_event: fetchPolicyEvents,
  connector_event: fetchConnectorEvents,
  signal: fetchSignals,
  agent_run: fetchAgentRuns,
  audit_event: fetchAuditEvents,
};

// ─── Status vocabulary ───────────────────────────────────────────────────────

/**
 * The status values that actually occur in this business's history, read
 * from the rows themselves rather than hardcoded.
 *
 * This is what lets the interpreter (and the UI's filter chips) offer only
 * statuses that exist, and lets an unrecognised status from a model be
 * REJECTED with a specific reason instead of silently matching nothing.
 */
export function statusVocabulary(businessId: string): Record<AuditRecordType, string[]> {
  const distinct = (sql: string, ...params: string[]): string[] => {
    try {
      const rows = db.prepare(sql).all(...params) as Array<{ v: unknown }>;
      return rows.map((r) => (r.v == null ? '' : String(r.v))).filter(Boolean).sort();
    } catch {
      return [];
    }
  };
  return {
    decision: distinct('SELECT DISTINCT decision_type AS v FROM decisions WHERE business_id = ?', businessId),
    task: distinct('SELECT DISTINCT status AS v FROM tasks WHERE business_id = ?', businessId),
    receipt: distinct('SELECT DISTINCT state AS v FROM action_receipts WHERE business_id = ?', businessId),
    outcome: distinct('SELECT DISTINCT o.verdict AS v FROM task_outcomes o JOIN tasks t ON t.id = o.task_id WHERE t.business_id = ?', businessId),
    policy_event: distinct('SELECT DISTINCT event_type AS v FROM operating_policy_events WHERE business_id = ?', businessId),
    connector_event: distinct('SELECT DISTINCT s.status AS v FROM connector_syncs s JOIN connectors c ON c.id = s.connector_id WHERE c.business_id = ?', businessId),
    signal: distinct('SELECT DISTINCT status AS v FROM signals WHERE business_id = ?', businessId),
    agent_run: distinct('SELECT DISTINCT status AS v FROM agent_runs WHERE business_id = ?', businessId),
    audit_event: distinct('SELECT DISTINCT action AS v FROM audit_log WHERE business_id = ?', businessId),
  };
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

export interface RetrievalResult {
  records: AuditRecord[];
  /** Per-type row counts BEFORE the overall cap, so "13 of 60 shown" is honest. */
  counts_by_type: Partial<Record<AuditRecordType, number>>;
  /** Types whose per-type limit was hit — results may be incomplete, and say so. */
  truncated_types: AuditRecordType[];
  /** Newest and oldest occurred_at across everything matched. */
  newest_at: string | null;
  oldest_at: string | null;
}

/**
 * Run the structured filters as real queries and return real rows.
 *
 * This function CANNOT return a record that is not in the database: every
 * element of `records` came out of a SELECT and carries the table and
 * primary key it came from.
 */
export function retrieve(filters: RetrievalFilters, opts: { now?: number; limit?: number } = {}): RetrievalResult {
  const now = opts.now ?? Date.now();
  const types = filters.record_types.length ? filters.record_types : AUDIT_RECORD_TYPES;

  const collected: AuditRecord[] = [];
  const countsByType: Partial<Record<AuditRecordType, number>> = {};
  const truncated: AuditRecordType[] = [];

  for (const type of types) {
    const fetcher = FETCHERS[type];
    if (!fetcher) continue;
    let rows: AuditRecord[];
    try {
      rows = fetcher(filters, now);
    } catch (err) {
      // A missing table (a database predating a migration) is a gap in what
      // can be searched, not a reason to fail the whole search. It is
      // surfaced as a zero count rather than swallowed into a wrong total.
      console.warn(`[audit-search] Could not read ${type}:`, (err as Error).message);
      countsByType[type] = 0;
      continue;
    }
    if (rows.length >= filters.per_type_limit) truncated.push(type);
    // The time window is applied after normalisation because the stored
    // timestamps come in two formats and cannot be compared as strings.
    const windowed = rows.filter((r) => inRange(r.occurred_at, filters.from, filters.to));
    countsByType[type] = windowed.length;
    collected.push(...windowed);
  }

  collected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.occurred_at ? Date.parse(a.occurred_at) : 0;
    const bt = b.occurred_at ? Date.parse(b.occurred_at) : 0;
    if (bt !== at) return bt - at;
    return a.citation.ref.localeCompare(b.citation.ref);
  });

  const timestamps = collected
    .map((r) => (r.occurred_at ? Date.parse(r.occurred_at) : NaN))
    .filter((t) => !Number.isNaN(t));

  const limited = opts.limit != null ? collected.slice(0, opts.limit) : collected;

  return {
    records: limited,
    counts_by_type: countsByType,
    truncated_types: truncated,
    newest_at: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    oldest_at: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
  };
}

/**
 * Resolve one citation token back to the record it names, within the
 * permitted business. Used for drill-down and — importantly — as the
 * independent check that a cited record genuinely exists.
 */
export function resolveCitation(businessId: string, token: string): AuditRecord | null {
  const match = /^([a-z_]+)#(.+)$/.exec(token.trim());
  if (!match) return null;
  const [, rawType, id] = match;
  if (!rawType || !id) return null;
  if (!AUDIT_RECORD_TYPES.includes(rawType as AuditRecordType)) return null;
  const type = rawType as AuditRecordType;

  const found = retrieve({
    business_id: businessId,
    record_types: [type],
    statuses: [],
    from: null, to: null,
    terms: [],
    per_type_limit: 500,
  }).records.find((r) => r.citation.record_id === id);

  return found ?? null;
}
