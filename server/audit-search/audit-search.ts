/**
 * Natural-language audit & history search (issue #72).
 *
 * ── Two layers, kept honestly apart ──────────────────────────────────────
 *
 *   1. INTERPRETATION (query-interpretation.ts) — a language model turns a
 *      sentence into structured filters, and nothing else. It never sees a
 *      question and answers it.
 *
 *   2. GROUNDED RETRIEVAL (record-index.ts) — those filters run as real SQL
 *      against decisions, tasks, receipts, outcomes, policy events,
 *      connector syncs, signals, agent runs and the audit log. Every result
 *      is a row, cited by table and primary key.
 *
 * This module joins the two, applies the freshness and authorization rules,
 * and — optionally — asks a model for a short narrative summary that is
 * then verified against the retrieved rows by grounding.ts and thrown away
 * in full if it fails. The narrative is a convenience. The records are the
 * answer.
 *
 * ── Nothing here recomputes what another module owns ─────────────────────
 *
 * "Why did this happen?" is answered by explain/ (#60), and a result links
 * to it rather than re-deriving a rationale. Policy citations come from the
 * decision row's own effective_policy_* columns (#68). Receipt state comes
 * from #70. This module contributes retrieval and honesty about retrieval,
 * and deliberately contributes no new facts.
 *
 * ── The four states, and why each is explicit ────────────────────────────
 *
 *   results          — rows matched, and they are current enough to act on.
 *
 *   results_stale    — rows matched, but the newest is old. Reported as its
 *                      own state because "the last thing that happened here
 *                      was six weeks ago" is frequently the actual finding,
 *                      and rendering it identically to a fresh result set
 *                      is how someone concludes a pipeline is healthy when
 *                      it stopped running.
 *
 *   no_results       — the search RAN and matched nothing. Distinct from an
 *                      error and distinct from an unasked question: the
 *                      applied filters are returned alongside so the user
 *                      can see exactly what was looked for and widen it.
 *
 *   ambiguous_query  — the question could not be turned into filters
 *                      confidently, so nothing was searched and Blueprint
 *                      asks instead. Guessing broadly here would return a
 *                      wrong slice of history that looks like an answer.
 *
 * Provider unavailability is deliberately NOT one of these states: the
 * search still runs on literal keyword matching. It is reported inside the
 * interpretation block and as a notice, because degrading capability
 * silently is its own kind of dishonesty.
 *
 * ── Redaction ────────────────────────────────────────────────────────────
 *
 * Records are redacted at construction (record-index.ts) and the whole
 * result goes through lib/redaction.ts once more on the way out. Crucially,
 * summarisation is fed the ALREADY-REDACTED records, so a credential
 * sitting in a task payload cannot leave the building inside a prompt.
 */
import db from '../db/db.js';
import { redactSensitive } from '../lib/redaction.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { classifyProviderError, safeErrorMessage } from '../lib/provider-errors.js';
import {
  AUDIT_SEARCH_SCHEMA_VERSION, AUDIT_RECORD_TYPES, RECORD_TYPE_MEANING,
  retrieve, statusVocabulary, DEFAULT_PER_TYPE_LIMIT, AGEING_HOURS, ageHours,
  type AuditRecord, type AuditRecordType,
} from './record-index.js';
import {
  interpretQuery, emptyFilters,
  type QueryInterpretation, type SearchFilters, type InterpretOptions,
} from './query-interpretation.js';
import {
  verifySummaryGrounding, extractCitations,
  type GroundingReport,
} from './grounding.js';

export { AUDIT_SEARCH_SCHEMA_VERSION };

/** Default cap on returned results. */
export const DEFAULT_RESULT_LIMIT = 40;

/**
 * A result set is called stale when its NEWEST record is older than this.
 * Matches record-index's `ageing` boundary so "stale" means one thing
 * across the feature.
 */
export const STALE_AFTER_HOURS = AGEING_HOURS;

export type AuditSearchState = 'results' | 'results_stale' | 'no_results' | 'ambiguous_query';

export const STATE_MEANING: Record<AuditSearchState, string> = {
  results: 'Records matched your search.',
  results_stale: 'Records matched, but the most recent one is old — check whether the underlying activity has stopped.',
  no_results: 'The search ran successfully and matched no records. This is not an error, and it is not proof that nothing happened outside what Blueprint records.',
  ambiguous_query: 'The question could not be turned into a search confidently, so nothing was searched. Blueprint is asking rather than guessing.',
};

// ─── Summary ─────────────────────────────────────────────────────────────────

export type SummaryKind =
  /** Model-written, and it passed every grounding check. */
  | 'grounded_narrative'
  /** Counts computed from the retrieved rows. Cannot be wrong; says nothing new. */
  | 'deterministic'
  /** A model wrote one and it failed verification, so it was discarded. */
  | 'withheld';

export interface SearchSummary {
  kind: SummaryKind;
  text: string;
  /**
   * TRUE only for a model-written narrative. The UI must label an inferred
   * summary differently from the records themselves — this flag is what it
   * keys on, and it is never true for a deterministic summary.
   */
  inferred: boolean;
  /** Citation tokens the summary uses, each of which resolved to a retrieved record. */
  citations: string[];
  /** The verification result, included even on success so it can be audited. */
  grounding: GroundingReport | null;
  /** Present when a narrative was written and rejected. */
  withheld_reason: string | null;
  /** Always present, always shown. */
  disclaimer: string;
}

const DETERMINISTIC_DISCLAIMER =
  'This is a count of the records found, not an interpretation of them. Blueprint has not inferred anything beyond what the rows say.';
const NARRATIVE_DISCLAIMER =
  'This summary is INFERRED. Every sentence cites the record it came from, and every citation was checked against the results below — but the wording is generated, and the cited records are the evidence, not this paragraph.';
const WITHHELD_DISCLAIMER =
  'A written summary was produced and then discarded because it made a claim that could not be traced to a retrieved record. The records below are unaffected.';

// ─── Freshness ───────────────────────────────────────────────────────────────

export interface FreshnessReport {
  newest_at: string | null;
  oldest_at: string | null;
  newest_age_hours: number | null;
  /** True when the newest matching record is older than STALE_AFTER_HOURS. */
  stale: boolean;
  /**
   * True when the user explicitly asked about an old period, so old records
   * are the correct answer rather than a warning sign.
   */
  historical_query: boolean;
  /** One sentence. Always populated. */
  summary: string;
  /**
   * Connectors whose last sync is itself old. A search can only find what
   * was ingested, so a stale connector is a real limit on the answer and is
   * reported next to it rather than left for the user to discover.
   */
  stale_connectors: Array<{ id: string; name: string | null; last_sync: string | null; age_hours: number | null }>;
}

function assessFreshness(
  newestAt: string | null,
  oldestAt: string | null,
  filters: SearchFilters,
  businessIds: string[],
  now: number,
): FreshnessReport {
  const newestAge = ageHours(newestAt, now);
  // If the user asked for a window that ENDS in the past, or STARTS long
  // ago, old results are exactly what was requested.
  const toAge = ageHours(filters.to, now);
  const fromAge = ageHours(filters.from, now);
  const historical = (toAge != null && toAge > STALE_AFTER_HOURS)
    || (fromAge != null && fromAge > STALE_AFTER_HOURS);

  const stale = newestAge != null && newestAge > STALE_AFTER_HOURS && !historical;

  const staleConnectors: FreshnessReport['stale_connectors'] = [];
  try {
    const placeholders = businessIds.map(() => '?').join(', ');
    if (businessIds.length) {
      const rows = db.prepare(
        `SELECT id, name, last_sync FROM connectors WHERE business_id IN (${placeholders}) AND status != 'disconnected'`,
      ).all(...businessIds) as Array<{ id: string; name: string | null; last_sync: string | null }>;
      for (const row of rows) {
        const age = ageHours(row.last_sync ? new Date(Date.parse(row.last_sync.replace(' ', 'T') + (/[Zz]$/.test(row.last_sync) ? '' : 'Z'))).toISOString() : null, now);
        if (row.last_sync == null || (age != null && age > STALE_AFTER_HOURS)) {
          staleConnectors.push({ id: row.id, name: row.name, last_sync: row.last_sync, age_hours: age });
        }
      }
    }
  } catch {
    // Absence of a connectors table is a gap in what can be reported, not a
    // reason to fail the search. Reported as "no stale connectors known".
  }

  const parts: string[] = [];
  if (newestAt == null) {
    parts.push('No matching record carries a usable timestamp, so freshness cannot be assessed.');
  } else if (stale) {
    parts.push(`The most recent matching record is about ${Math.round(newestAge!)} hours old. Nothing matching has happened since.`);
  } else if (historical) {
    parts.push('These results are old because you asked about a past period — that is expected, not a staleness warning.');
  } else {
    parts.push(`The most recent matching record is about ${Math.round(newestAge ?? 0)} hours old.`);
  }
  if (staleConnectors.length) {
    parts.push(`${staleConnectors.length} connector(s) have not synced recently, so events after their last sync may simply never have been recorded.`);
  }

  return {
    newest_at: newestAt,
    oldest_at: oldestAt,
    newest_age_hours: newestAge,
    stale,
    historical_query: historical,
    summary: parts.join(' '),
    stale_connectors: staleConnectors,
  };
}

// ─── Result ──────────────────────────────────────────────────────────────────

export interface AppliedFilters extends SearchFilters {
  /** Human-readable rendering, so the UI can show filters without re-deriving labels. */
  description: string;
}

export interface AuditSearchResult {
  schema_version: string;
  query: string;
  state: AuditSearchState;
  state_meaning: string;
  /** How the question became filters, including its own failure state. */
  interpretation: QueryInterpretation;
  /** Exactly what was searched for. Editable by the UI and re-runnable. */
  applied_filters: AppliedFilters;
  results: AuditRecord[];
  total_matched: number;
  counts_by_type: Partial<Record<AuditRecordType, number>>;
  /** Types whose per-type read limit was hit — the answer may be incomplete. */
  truncated_types: AuditRecordType[];
  freshness: FreshnessReport;
  summary: SearchSummary;
  /** Things the user must know that are not errors. Never silently dropped. */
  notices: string[];
  /** What this search cannot tell you. Never empty. */
  limitations: string[];
  generated_at: string;
}

function describeFilters(filters: SearchFilters, businessNames: Map<string, string | null>): string {
  const parts: string[] = [];
  const names = filters.business_ids.map((id) => businessNames.get(id) ?? id);
  parts.push(names.length === 1 ? `business ${names[0]}` : `${names.length} businesses`);
  parts.push(filters.record_types.length ? `types: ${filters.record_types.join(', ')}` : 'all record types');
  if (filters.statuses.length) parts.push(`status: ${filters.statuses.join(', ')}`);
  if (filters.from || filters.to) {
    parts.push(`between ${filters.from ?? 'the earliest record'} and ${filters.to ?? 'now'}`);
  } else {
    parts.push('all time');
  }
  if (filters.terms.length) parts.push(`keywords: ${filters.terms.join(', ')}`);
  return parts.join(' · ');
}

// ─── Deterministic summary ───────────────────────────────────────────────────

/**
 * A summary that cannot be wrong: it counts the rows in front of it and
 * says nothing else. This is the fallback whenever a narrative is
 * unavailable or fails verification, and it is always an acceptable answer.
 */
export function deterministicSummary(records: AuditRecord[]): SearchSummary {
  if (!records.length) {
    return {
      kind: 'deterministic',
      text: 'No records matched.',
      inferred: false,
      citations: [],
      grounding: null,
      withheld_reason: null,
      disclaimer: DETERMINISTIC_DISCLAIMER,
    };
  }

  const byType = new Map<AuditRecordType, number>();
  for (const r of records) byType.set(r.citation.record_type, (byType.get(r.citation.record_type) ?? 0) + 1);
  const breakdown = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}${count === 1 ? '' : 's'}`)
    .join(', ');

  const stamped = records.map((r) => r.occurred_at).filter((v): v is string => !!v).sort();
  const range = stamped.length
    ? ` Earliest ${stamped[0]}, latest ${stamped[stamped.length - 1]}.`
    : '';

  return {
    kind: 'deterministic',
    text: `${records.length} record${records.length === 1 ? '' : 's'} matched: ${breakdown}.${range}`,
    inferred: false,
    citations: [],
    grounding: null,
    withheld_reason: null,
    disclaimer: DETERMINISTIC_DISCLAIMER,
  };
}

// ─── Narrative summary ───────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You write a very short factual summary of database records that have already been retrieved for a user's question.

Absolute rules — a summary breaking any of them is discarded in full by an automatic checker:
1. EVERY sentence must cite at least one record, using the exact marker [type#id] as given in the records below. A sentence without a citation is deleted along with the whole summary.
2. You may only cite records that appear below. Never cite an id that is not in the list.
3. You may only state facts that are visible in the records below. Do not explain causes, motives, or consequences that a record does not state.
4. Every number you write must appear in the records below. Do not compute percentages, totals, averages or trends.
5. If the records do not answer the question, say so — citing the records that were found.
6. Maximum 4 sentences. Plain past tense. No preamble, no headings, no bullet points.`;

function recordsForPrompt(records: AuditRecord[], cap: number): string {
  return records.slice(0, cap).map((r) => {
    const bits = [
      `[${r.citation.ref}]`,
      `type=${r.citation.record_type}`,
      r.status ? `status=${r.status}` : null,
      r.occurred_at ? `at=${r.occurred_at}` : null,
      r.actor ? `actor=${r.actor}` : null,
      `title=${JSON.stringify(r.title)}`,
      r.snippet ? `text=${JSON.stringify(r.snippet)}` : null,
    ].filter(Boolean);
    return bits.join(' ');
  }).join('\n');
}

/** How many records the narrative is allowed to see. Bounded prompt, bounded cost. */
const SUMMARY_RECORD_CAP = 20;
const SUMMARY_MAX_ATTEMPTS = 2;

export interface SummariseOptions {
  runLLMImpl?: typeof runLLM;
  resolveLLMImpl?: typeof resolveProfileLLM;
}

/**
 * Ask a model for a narrative, then verify it. Returns a withheld summary
 * rather than an unverified one — there is no code path that returns
 * model prose which has not passed verifySummaryGrounding().
 */
export async function summariseGrounded(
  query: string,
  records: AuditRecord[],
  opts: SummariseOptions = {},
): Promise<SearchSummary> {
  if (!records.length) return deterministicSummary(records);

  const resolveImpl = opts.resolveLLMImpl ?? resolveProfileLLM;
  const runImpl = opts.runLLMImpl ?? runLLM;

  let providerId: string;
  let model: string;
  try {
    const resolved = resolveImpl({}, { tier: 'triage' });
    providerId = resolved.providerId;
    model = resolved.model;
  } catch {
    // No provider: the deterministic summary is the honest answer, not a
    // degraded one. It says exactly as much as it knows.
    return deterministicSummary(records);
  }

  // The records passed here are already redacted by record-index.ts, so
  // nothing sensitive is placed in the prompt.
  const visible = records.slice(0, SUMMARY_RECORD_CAP);
  const prompt = [
    `User's question: ${query}`,
    '',
    'Retrieved records:',
    recordsForPrompt(visible, SUMMARY_RECORD_CAP),
  ].join('\n');

  let lastReport: GroundingReport | null = null;
  let lastText = '';

  for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
    let content: string;
    try {
      const result = await runImpl(providerId, model, {
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 500,
      });
      content = String(result?.content ?? '').trim();
    } catch (err) {
      const classified = classifyProviderError(err, providerId);
      void safeErrorMessage(err, providerId);
      if (classified.retryable && attempt < SUMMARY_MAX_ATTEMPTS) continue;
      return deterministicSummary(records);
    }

    lastText = content;
    // Verified against `visible` — exactly what the model was shown. A
    // citation to a retrieved-but-unshown record would be a guess.
    lastReport = verifySummaryGrounding(content, visible);
    if (lastReport.grounded) {
      return {
        kind: 'grounded_narrative',
        text: content,
        inferred: true,
        citations: extractCitations(content).map((c) => c.ref),
        grounding: lastReport,
        withheld_reason: null,
        disclaimer: NARRATIVE_DISCLAIMER,
      };
    }
  }

  const kinds = [...new Set((lastReport?.violations ?? []).map((v) => v.kind))];
  const fallback = deterministicSummary(records);
  return {
    kind: 'withheld',
    text: fallback.text,
    inferred: false,
    citations: [],
    grounding: lastReport,
    withheld_reason:
      `A written summary was discarded because it failed grounding checks (${kinds.join(', ') || 'unknown'}). ` +
      'Blueprint does not show a summary it cannot trace to retrieved records.',
    disclaimer: WITHHELD_DISCLAIMER,
    // The withheld case still shows the deterministic counts, so the user
    // is not left with nothing — just with nothing invented.
  };
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface AuditSearchRequest {
  query: string;
  /** The authorization boundary. Results can never come from outside it. */
  permittedBusinessIds: string[];
  /**
   * Filters the user set by hand in the UI. These OVERRIDE the interpreted
   * ones field by field: a filter a human typed is not a guess, and must
   * not be second-guessed by the interpreter.
   */
  overrides?: Partial<SearchFilters>;
  limit?: number;
  /** Ask for a narrative summary. Off by default: the records are the answer. */
  summarise?: boolean;
  now?: number;
  interpret?: InterpretOptions;
  summariseOptions?: SummariseOptions;
}

function businessNameMap(ids: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (!ids.length) return map;
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id, name FROM businesses WHERE id IN (${placeholders})`).all(...ids) as
      Array<{ id: string; name: string | null }>;
    for (const r of rows) map.set(r.id, r.name);
  } catch { /* names are cosmetic; ids remain correct */ }
  return map;
}

function applyOverrides(filters: SearchFilters, overrides: Partial<SearchFilters> | undefined, permitted: string[]): SearchFilters {
  if (!overrides) return filters;
  const out: SearchFilters = { ...filters };
  if (overrides.record_types) out.record_types = overrides.record_types.filter((t) => AUDIT_RECORD_TYPES.includes(t));
  if (overrides.statuses) out.statuses = [...overrides.statuses];
  if (overrides.terms) out.terms = [...overrides.terms];
  if (overrides.from !== undefined) out.from = overrides.from;
  if (overrides.to !== undefined) out.to = overrides.to;
  // Even a hand-set business filter is intersected with what the requester
  // may read. A UI cannot grant itself access by sending a different id.
  if (overrides.business_ids) {
    const allowed = overrides.business_ids.filter((b) => permitted.includes(b));
    out.business_ids = allowed.length ? allowed : [...permitted];
  }
  return out;
}

const BASE_LIMITATIONS = [
  'This searches the records Blueprint wrote. Anything a module did not record cannot be found here, and its absence is not evidence that it did not happen.',
  'Matching is literal keyword matching over each record\'s own text — it is not semantic, so a record that describes the same thing in different words will not be found.',
];

/**
 * Run one natural-language audit search.
 *
 * The order is fixed and load-bearing: interpret → (stop if ambiguous) →
 * retrieve real rows → assess freshness → optionally summarise the rows
 * that were actually retrieved → redact → return.
 */
export async function searchAuditHistory(request: AuditSearchRequest): Promise<AuditSearchResult> {
  const now = request.now ?? Date.now();
  const permitted = [...new Set(request.permittedBusinessIds)].filter(Boolean);
  const query = (request.query ?? '').trim();
  const limit = request.limit ?? DEFAULT_RESULT_LIMIT;
  const names = businessNameMap(permitted);
  const notices: string[] = [];
  const limitations = [...BASE_LIMITATIONS];

  if (!permitted.length) {
    // Not a search failure — an authorization outcome, stated as one.
    const filters = emptyFilters([]);
    return finalise({
      query,
      state: 'no_results',
      interpretation: {
        state: 'ambiguous', method: 'none', filters, confidence: null,
        rationale: 'No search was run because no business is accessible to you.',
        clarification: null, rejected: [], provider_error: null, attempts: 0,
      },
      filters,
      names,
      records: [], countsByType: {}, truncatedTypes: [],
      freshness: assessFreshness(null, null, filters, [], now),
      summary: deterministicSummary([]),
      notices: ['You do not have access to any business, so there was nothing to search.'],
      limitations,
      totalMatched: 0,
    });
  }

  const interpretation = await interpretQuery(query, permitted, { ...request.interpret, now });

  if (interpretation.state === 'interpreter_unavailable') {
    notices.push(
      'The natural-language interpreter was unavailable, so your question was matched literally, word by word. ' +
      'Check the applied filters below — they may be narrower or broader than you meant.',
    );
    limitations.push('This search did not use language understanding. Filters came from literal keyword and date matching.');
  }

  for (const r of interpretation.rejected) {
    notices.push(`Filter not applied — ${r.field} '${r.value}': ${r.reason}`);
  }

  // Ambiguous: nothing is searched, and Blueprint says why. An override
  // supplied by the user is a decision on their part, so it resolves the
  // ambiguity and the search proceeds.
  const hasUserOverrides = !!request.overrides && Object.keys(request.overrides).length > 0;
  if (interpretation.state === 'ambiguous' && !hasUserOverrides) {
    const filters = applyOverrides(interpretation.filters, request.overrides, permitted);
    return finalise({
      query,
      state: 'ambiguous_query',
      interpretation,
      filters,
      names,
      records: [], countsByType: {}, truncatedTypes: [],
      freshness: assessFreshness(null, null, filters, permitted, now),
      summary: {
        kind: 'deterministic',
        text: 'No search was run, so there is nothing to summarise.',
        inferred: false, citations: [], grounding: null, withheld_reason: null,
        disclaimer: DETERMINISTIC_DISCLAIMER,
      },
      notices,
      limitations,
      totalMatched: 0,
    });
  }

  const filters = applyOverrides(interpretation.filters, request.overrides, permitted);

  // Retrieval, per permitted business, in SQL scoped to that business.
  const allRecords: AuditRecord[] = [];
  const countsByType: Partial<Record<AuditRecordType, number>> = {};
  const truncated = new Set<AuditRecordType>();
  let newest: number | null = null;
  let oldest: number | null = null;

  for (const businessId of filters.business_ids) {
    const result = retrieve({
      business_id: businessId,
      record_types: filters.record_types,
      statuses: filters.statuses,
      from: filters.from,
      to: filters.to,
      terms: filters.terms,
      per_type_limit: DEFAULT_PER_TYPE_LIMIT,
    }, { now });

    allRecords.push(...result.records);
    for (const [type, count] of Object.entries(result.counts_by_type)) {
      countsByType[type as AuditRecordType] = (countsByType[type as AuditRecordType] ?? 0) + (count ?? 0);
    }
    for (const t of result.truncated_types) truncated.add(t);
    if (result.newest_at) {
      const t = Date.parse(result.newest_at);
      newest = newest == null ? t : Math.max(newest, t);
    }
    if (result.oldest_at) {
      const t = Date.parse(result.oldest_at);
      oldest = oldest == null ? t : Math.min(oldest, t);
    }
  }

  allRecords.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.occurred_at ? Date.parse(a.occurred_at) : 0;
    const bt = b.occurred_at ? Date.parse(b.occurred_at) : 0;
    if (bt !== at) return bt - at;
    return a.citation.ref.localeCompare(b.citation.ref);
  });

  const totalMatched = allRecords.length;
  const records = allRecords.slice(0, limit);

  if (totalMatched > records.length) {
    notices.push(`${totalMatched} records matched; the top ${records.length} by relevance are shown. Narrow the filters to see the rest.`);
  }
  if (truncated.size) {
    notices.push(
      `More than ${DEFAULT_PER_TYPE_LIMIT} records of type(s) ${[...truncated].join(', ')} matched before filtering. ` +
      'This result set may be incomplete for those types — add a time range to be sure.',
    );
    limitations.push(`Reads are capped at ${DEFAULT_PER_TYPE_LIMIT} rows per record type, and that cap was reached.`);
  }

  const freshness = assessFreshness(
    newest == null ? null : new Date(newest).toISOString(),
    oldest == null ? null : new Date(oldest).toISOString(),
    filters, filters.business_ids, now,
  );
  if (freshness.stale_connectors.length) {
    limitations.push(
      'Some connectors have not synced recently, so activity after their last sync may never have been recorded and therefore cannot be found by any search.',
    );
  }

  let summary: SearchSummary;
  if (!records.length) {
    summary = deterministicSummary(records);
  } else if (request.summarise) {
    summary = await summariseGrounded(query, records, request.summariseOptions);
    if (summary.kind === 'withheld') {
      notices.push(summary.withheld_reason ?? 'A written summary was discarded because it could not be verified against the records.');
    }
  } else {
    summary = deterministicSummary(records);
  }

  const state: AuditSearchState = !records.length
    ? 'no_results'
    : freshness.stale ? 'results_stale' : 'results';

  if (state === 'no_results') {
    notices.push(
      'Nothing matched. The filters that were applied are shown above — widen the time range, remove a keyword, or clear the record-type filter to broaden the search.',
    );
  }

  return finalise({
    query, state, interpretation, filters, names,
    records, countsByType, truncatedTypes: [...truncated],
    freshness, summary, notices, limitations, totalMatched,
  });
}

interface FinaliseInput {
  query: string;
  state: AuditSearchState;
  interpretation: QueryInterpretation;
  filters: SearchFilters;
  names: Map<string, string | null>;
  records: AuditRecord[];
  countsByType: Partial<Record<AuditRecordType, number>>;
  truncatedTypes: AuditRecordType[];
  freshness: FreshnessReport;
  summary: SearchSummary;
  notices: string[];
  limitations: string[];
  totalMatched: number;
}

/**
 * The single exit point. Stamps the schema version, adds the limitations
 * that follow mechanically from the state, and runs the WHOLE payload
 * through lib/redaction.ts — the same choke-point discipline
 * finaliseExplanation() (#60) uses, and for the same reason: no individual
 * builder is trusted to have sanitised its own inputs.
 */
function finalise(input: FinaliseInput): AuditSearchResult {
  const limitations = [...input.limitations];

  if (input.state === 'no_results') {
    limitations.push('No records matched. That means Blueprint holds no matching record — it is not evidence that the event did not occur.');
  }
  if (input.state === 'results_stale') {
    limitations.push('The newest matching record is old. Treat these results as history, not as the current state.');
  }
  if (input.summary.kind === 'grounded_narrative') {
    limitations.push('The written summary is inferred. It passed automatic grounding checks, but the cited records are the evidence — not the summary.');
  }
  if (input.summary.kind === 'withheld') {
    limitations.push('No written summary is shown because the one produced could not be traced to retrieved records.');
  }
  if (input.interpretation.method === 'deterministic_fallback') {
    limitations.push('The question was not interpreted by a language model, so phrasing that does not literally appear in the records will not have matched.');
  }

  const result: AuditSearchResult = {
    schema_version: AUDIT_SEARCH_SCHEMA_VERSION,
    query: input.query,
    state: input.state,
    state_meaning: STATE_MEANING[input.state],
    interpretation: input.interpretation,
    applied_filters: {
      ...input.filters,
      description: describeFilters(input.filters, input.names),
    },
    results: input.records,
    total_matched: input.totalMatched,
    counts_by_type: input.countsByType,
    truncated_types: input.truncatedTypes,
    freshness: input.freshness,
    summary: input.summary,
    notices: [...new Set(input.notices)],
    limitations: [...new Set(limitations)],
    generated_at: new Date().toISOString(),
  };

  // Depth 10 rather than the default 6: a result legitimately nests
  // result → results[] → fields → the field's own structure, and
  // collapsing a real field value to '[truncated]' would itself misrepresent
  // the record.
  return redactSensitive<AuditSearchResult>(result, { maxDepth: 10, maxArrayLength: 80 });
}

// ─── Vocabulary readback ─────────────────────────────────────────────────────

/**
 * What can be searched and filtered for this business — record types with
 * their meanings, and the statuses that ACTUALLY occur in its rows. The UI
 * builds its filter chips from this so it can never offer a filter that
 * matches nothing.
 */
export function searchVocabulary(businessId: string): {
  schema_version: string;
  record_types: Array<{ type: AuditRecordType; meaning: string; statuses: string[] }>;
  states: Record<AuditSearchState, string>;
} {
  const vocab = statusVocabulary(businessId);
  return {
    schema_version: AUDIT_SEARCH_SCHEMA_VERSION,
    record_types: AUDIT_RECORD_TYPES.map((type) => ({
      type,
      meaning: RECORD_TYPE_MEANING[type],
      statuses: vocab[type],
    })),
    states: STATE_MEANING,
  };
}
