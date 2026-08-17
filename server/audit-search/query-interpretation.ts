/**
 * Natural-language query interpretation (issue #72).
 *
 * ── The one job ──────────────────────────────────────────────────────────
 *
 * Turn "why did we reject the Shopify price change last month?" into
 * structured filters. That is ALL the language model is trusted to do in
 * this feature. It never sees a question and answers it; it sees a question
 * and proposes a WHERE clause, which record-index.ts then runs against real
 * rows.
 *
 * Keeping interpretation and retrieval apart is the entire safety argument.
 * A bad interpretation returns the wrong rows — visible, correctable, and
 * the applied filters are shown to the user so they can fix it by hand. A
 * model allowed to answer directly could return a right-sounding wrong
 * answer with nothing to check it against.
 *
 * ── Nothing the model says is trusted ────────────────────────────────────
 *
 * Every field it returns is validated against a vocabulary that comes from
 * the database, and anything unrecognised is REJECTED with a reason that
 * the caller can see — never coerced to the nearest valid value, and never
 * dropped silently. In particular a business id the requester is not
 * permitted to read is rejected as a scope violation: the interpreter can
 * ask for anything it likes and still cannot widen access.
 *
 * ── Three honest failure states ──────────────────────────────────────────
 *
 *   interpreted             — filters were produced confidently.
 *
 *   ambiguous               — the question could mean materially different
 *                             things, or produced no constraint at all.
 *                             Blueprint asks rather than guessing broadly,
 *                             because a guess here silently returns the
 *                             wrong history and looks exactly like a
 *                             correct answer.
 *
 *   interpreter_unavailable — no provider is configured, or the provider
 *                             failed after bounded retries. Search still
 *                             runs, using deterministic literal keyword
 *                             matching, and says clearly that the
 *                             natural-language step did not happen. Silently
 *                             degrading to keyword search while presenting
 *                             it as language understanding would be a lie
 *                             about capability.
 *
 * Retry/backoff and error sanitisation follow kb/kb-analyser.ts: bounded
 * attempts, classifyProviderError() to decide retryability, and
 * safeErrorMessage() so a provider error can never carry a credential or a
 * raw response body into a user-visible payload.
 */
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { classifyProviderError, safeErrorMessage } from '../lib/provider-errors.js';
import { extractFirstJson } from '../lib/json-extract.js';
import {
  AUDIT_RECORD_TYPES, RECORD_TYPE_MEANING, statusVocabulary,
  type AuditRecordType,
} from './record-index.js';

// Matches kb-analyser.ts's bounded-retry posture.
const MAX_LLM_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Below this, the interpreter is not confident enough to be allowed to
 * narrow a search on the user's behalf. Asking a clarifying question costs
 * one round trip; silently searching the wrong slice of history costs an
 * investigation.
 */
export const AMBIGUITY_CONFIDENCE_FLOOR = 0.4;

/** Shorter than this and there is nothing to interpret. */
const MIN_QUERY_CHARS = 3;

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface SearchFilters {
  /** Always a subset of the requester's permitted businesses. */
  business_ids: string[];
  /** Empty means every type. */
  record_types: AuditRecordType[];
  statuses: string[];
  from: string | null;
  to: string | null;
  terms: string[];
}

export function emptyFilters(businessIds: string[]): SearchFilters {
  return { business_ids: [...businessIds], record_types: [], statuses: [], from: null, to: null, terms: [] };
}

export type InterpretationState = 'interpreted' | 'ambiguous' | 'interpreter_unavailable';

export type InterpretationMethod =
  /** A model produced the filters and they passed validation. */
  | 'llm'
  /** Literal keyword/date matching, with no model involved. */
  | 'deterministic_fallback'
  /** No interpretation was attempted — the query was unusable as given. */
  | 'none';

export interface RejectedFilter {
  field: string;
  value: string;
  reason: string;
}

export interface ClarificationRequest {
  /** Why Blueprint will not guess. */
  reason: string;
  /** Specific questions whose answers would resolve it. */
  questions: string[];
  /** The distinct readings that are competing, when the model named them. */
  candidate_readings: string[];
}

export interface QueryInterpretation {
  state: InterpretationState;
  method: InterpretationMethod;
  filters: SearchFilters;
  /** The confidence the model reported. Null when no model was involved — never invented. */
  confidence: number | null;
  /** Plain sentence stating what was applied and on what basis. */
  rationale: string;
  clarification: ClarificationRequest | null;
  /** Everything the interpreter proposed that was refused, and why. */
  rejected: RejectedFilter[];
  /** Sanitised provider diagnostic. Null unless the provider path failed. */
  provider_error: string | null;
  /** How many provider attempts were made. 0 when none was attempted. */
  attempts: number;
}

// ─── Deterministic interpretation ────────────────────────────────────────────

/**
 * Stopwords stripped from keyword terms. Kept to genuine function words —
 * a domain word like "policy" or "failed" is meaningful in this corpus and
 * must survive.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'what', 'why', 'when', 'where', 'which', 'who', 'whom', 'how', 'that', 'this', 'these',
  'those', 'it', 'its', 'we', 'our', 'us', 'i', 'me', 'my', 'you', 'your', 'they', 'them',
  'their', 'there', 'here', 'happened', 'happen', 'show', 'find', 'search', 'me', 'about',
  'any', 'all', 'get', 'got', 'has', 'have', 'had', 'up', 'out', 'so', 'if', 'then',
]);

/** Literal words that name a record type. Nothing fuzzy — see the module docstring. */
const TYPE_KEYWORDS: Array<{ type: AuditRecordType; words: string[] }> = [
  { type: 'decision', words: ['decision', 'decisions', 'decided', 'decide'] },
  { type: 'task', words: ['task', 'tasks', 'action', 'actions', 'work'] },
  { type: 'receipt', words: ['receipt', 'receipts', 'executed', 'execution'] },
  { type: 'outcome', words: ['outcome', 'outcomes', 'result', 'results', 'measured'] },
  { type: 'policy_event', words: ['policy', 'policies', 'rule', 'rules', 'autonomy'] },
  { type: 'connector_event', words: ['connector', 'connectors', 'sync', 'syncs', 'integration'] },
  { type: 'signal', words: ['signal', 'signals', 'alert', 'alerts', 'detected'] },
  { type: 'agent_run', words: ['agent', 'agents', 'run', 'runs'] },
  { type: 'audit_event', words: ['audit', 'log', 'logs', 'trail'] },
];

const DAY_MS = 86_400_000;

/**
 * Explicit time expressions only. "Recently" and "a while ago" are NOT
 * handled here and deliberately produce no window — inventing a boundary
 * for a vague phrase would silently hide records outside it.
 */
export function parseTimeExpression(query: string, now: number): { from: string | null; to: string | null; matched: string | null } {
  const q = query.toLowerCase();

  const relative = /\b(?:last|past|previous)\s+(\d+)\s+(hour|day|week|month|year)s?\b/.exec(q);
  if (relative) {
    const n = parseInt(relative[1]!, 10);
    const unit = relative[2]!;
    const ms = unit === 'hour' ? 3_600_000
      : unit === 'day' ? DAY_MS
      : unit === 'week' ? 7 * DAY_MS
      : unit === 'month' ? 30 * DAY_MS
      : 365 * DAY_MS;
    return { from: new Date(now - n * ms).toISOString(), to: null, matched: relative[0] };
  }

  const singular: Array<[RegExp, number, string]> = [
    [/\btoday\b/, DAY_MS, 'today'],
    [/\byesterday\b/, 2 * DAY_MS, 'yesterday'],
    [/\b(?:last|past|this)\s+week\b/, 7 * DAY_MS, 'last week'],
    [/\b(?:last|past|this)\s+month\b/, 30 * DAY_MS, 'last month'],
    [/\b(?:last|past|this)\s+quarter\b/, 92 * DAY_MS, 'last quarter'],
    [/\b(?:last|past|this)\s+year\b/, 365 * DAY_MS, 'last year'],
  ];
  for (const [pattern, ms, label] of singular) {
    if (pattern.test(q)) return { from: new Date(now - ms).toISOString(), to: null, matched: label };
  }

  const since = /\bsince\s+(\d{4}-\d{2}-\d{2})\b/.exec(q);
  if (since) {
    const t = Date.parse(`${since[1]}T00:00:00Z`);
    if (!Number.isNaN(t)) return { from: new Date(t).toISOString(), to: null, matched: since[0] };
  }

  const between = /\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/.exec(q);
  if (between) {
    const a = Date.parse(`${between[1]}T00:00:00Z`);
    const b = Date.parse(`${between[2]}T23:59:59Z`);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return { from: new Date(a).toISOString(), to: new Date(b).toISOString(), matched: between[0] };
    }
  }

  return { from: null, to: null, matched: null };
}

export function extractTerms(query: string): string[] {
  const terms: string[] = [];
  // Quoted phrases are honoured exactly — the user asked for a literal.
  const quoted = query.match(/"([^"]{2,})"/g) ?? [];
  let remainder = query;
  for (const q of quoted) {
    terms.push(q.slice(1, -1).trim());
    remainder = remainder.replace(q, ' ');
  }
  for (const word of remainder.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []) {
    if (STOPWORDS.has(word)) continue;
    if (terms.includes(word)) continue;
    terms.push(word);
  }
  return terms.slice(0, 8);
}

/**
 * Interpretation with no model at all: literal type words, explicit date
 * expressions and keyword extraction. Used when the provider is
 * unavailable, and always LABELLED as such so nobody mistakes it for
 * language understanding.
 */
export function deterministicInterpretation(
  query: string,
  businessIds: string[],
  vocabulary: Record<AuditRecordType, string[]>,
  now: number,
): SearchFilters {
  const q = query.toLowerCase();
  const matchedTypeWords: string[] = [];
  const types = TYPE_KEYWORDS.filter((k) => {
    const hits = k.words.filter((w) => new RegExp(`\\b${w}\\b`).test(q));
    matchedTypeWords.push(...hits);
    return hits.length > 0;
  }).map((k) => k.type);
  const time = parseTimeExpression(query, now);

  // A status word only counts when it genuinely occurs in this business's
  // history — matching a status that no row has would quietly return
  // nothing and look like "it never happened".
  const known = new Set<string>();
  for (const values of Object.values(vocabulary)) for (const v of values) known.add(v.toLowerCase());
  const statuses = [...known].filter((s) => new RegExp(`\\b${s.replace(/[^a-z0-9_]/g, '.')}\\b`).test(q));

  // A word that has already been consumed as a filter must not ALSO become
  // a keyword. Keyword matching is AND across terms, so leaving "decisions"
  // or "last week" in the term list would require those literal words to
  // appear in the record's own text — which they never do, and the search
  // would return nothing while looking like a correct, well-formed query.
  // This is the single most likely way a fallback silently answers "no
  // records" to a question that has plenty.
  let residual = query;
  for (const w of [...matchedTypeWords, ...statuses]) {
    residual = residual.replace(new RegExp(`\\b${w.replace(/[^A-Za-z0-9_]/g, '.')}\\b`, 'gi'), ' ');
  }
  if (time.matched) residual = residual.replace(new RegExp(time.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');

  const terms = extractTerms(residual).filter((t) => !statuses.includes(t.toLowerCase()));

  return {
    business_ids: [...businessIds],
    record_types: types,
    statuses,
    from: time.from,
    to: time.to,
    terms,
  };
}

// ─── Validation of model output ──────────────────────────────────────────────

interface RawInterpretation {
  record_types?: unknown;
  statuses?: unknown;
  business_ids?: unknown;
  from?: unknown;
  to?: unknown;
  terms?: unknown;
  confidence?: unknown;
  ambiguous?: unknown;
  ambiguity_reason?: unknown;
  clarifying_questions?: unknown;
  candidate_readings?: unknown;
  rationale?: unknown;
}

function asStringArray(value: unknown, cap = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string')
    .map((v) => (v as string).trim())
    .filter(Boolean)
    .slice(0, cap);
}

function validateIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Turn the model's proposal into filters, refusing anything outside the
 * vocabulary or outside the requester's permitted businesses.
 */
export function validateProposedFilters(
  raw: RawInterpretation,
  permittedBusinessIds: string[],
  vocabulary: Record<AuditRecordType, string[]>,
): { filters: SearchFilters; rejected: RejectedFilter[] } {
  const rejected: RejectedFilter[] = [];

  const recordTypes: AuditRecordType[] = [];
  for (const value of asStringArray(raw.record_types)) {
    const normalised = value.toLowerCase();
    if (AUDIT_RECORD_TYPES.includes(normalised as AuditRecordType)) {
      if (!recordTypes.includes(normalised as AuditRecordType)) recordTypes.push(normalised as AuditRecordType);
    } else {
      rejected.push({
        field: 'record_type', value,
        reason: `'${value}' is not a record type Blueprint stores. Searchable types: ${AUDIT_RECORD_TYPES.join(', ')}.`,
      });
    }
  }

  const knownStatuses = new Map<string, string>();
  for (const values of Object.values(vocabulary)) {
    for (const v of values) knownStatuses.set(v.toLowerCase(), v);
  }
  const statuses: string[] = [];
  for (const value of asStringArray(raw.statuses)) {
    const hit = knownStatuses.get(value.toLowerCase());
    if (hit) { if (!statuses.includes(hit)) statuses.push(hit); }
    else {
      rejected.push({
        field: 'status', value,
        reason: `No record in this business has the status '${value}', so filtering on it would return nothing and look like an absence of events.`,
      });
    }
  }

  // The authorization boundary. A proposed business outside the permitted
  // set is refused as a scope violation, not narrowed to something nearby.
  const permitted = new Set(permittedBusinessIds);
  const businessIds: string[] = [];
  for (const value of asStringArray(raw.business_ids)) {
    if (permitted.has(value)) { if (!businessIds.includes(value)) businessIds.push(value); }
    else {
      rejected.push({
        field: 'business_id', value,
        reason: 'You do not have access to that business, so it was excluded from the search.',
      });
    }
  }

  const from = validateIso(raw.from);
  if (raw.from != null && from === null) {
    rejected.push({ field: 'from', value: String(raw.from), reason: 'Not a usable date, so no lower time bound was applied.' });
  }
  const to = validateIso(raw.to);
  if (raw.to != null && to === null) {
    rejected.push({ field: 'to', value: String(raw.to), reason: 'Not a usable date, so no upper time bound was applied.' });
  }

  return {
    filters: {
      business_ids: businessIds.length ? businessIds : [...permittedBusinessIds],
      record_types: recordTypes,
      statuses,
      from,
      to,
      terms: asStringArray(raw.terms, 8),
    },
    rejected,
  };
}

/** True when the filters place no constraint on the search whatsoever. */
export function isUnconstrained(filters: SearchFilters): boolean {
  return !filters.record_types.length
    && !filters.statuses.length
    && !filters.terms.length
    && !filters.from && !filters.to;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You translate a question about a business's own operational history into database filters.

You are NOT answering the question. You never state what happened, why it happened, or what any record says. Another component runs your filters against the real database and returns real rows. Your only output is the filter object below.

Return ONLY a JSON object with these keys:
{
  "record_types": string[],        // subset of the allowed types; [] means search all types
  "statuses": string[],            // subset of the allowed statuses; [] means any status
  "business_ids": string[],        // subset of the allowed businesses; [] means all permitted
  "from": string|null,             // ISO-8601 lower bound, or null for no lower bound
  "to": string|null,               // ISO-8601 upper bound, or null for no upper bound
  "terms": string[],               // literal keywords to match in record text; keep to meaningful nouns
  "confidence": number,            // 0..1, how confident you are this is what was asked
  "ambiguous": boolean,            // true if the question has materially different readings
  "ambiguity_reason": string,      // required when ambiguous
  "clarifying_questions": string[],// required when ambiguous; specific, answerable questions
  "candidate_readings": string[],  // required when ambiguous; the competing readings
  "rationale": string              // one sentence explaining the filters you chose
}

Rules:
- Use ONLY values from the allowed vocabularies given below. Never invent a record type, status, or business id.
- If the question does not mention a time period, set from and to to null. Do not invent a window.
- "terms" must be words that would literally appear in a record. Do not add synonyms the user did not use.
- Set ambiguous=true when the question could mean materially different things, or when it is too vague to constrain at all. Asking is correct; guessing is not.
- Set a low confidence rather than a high one when unsure.`;

function buildUserPrompt(
  query: string,
  businesses: Array<{ id: string; name: string | null }>,
  vocabulary: Record<AuditRecordType, string[]>,
  now: Date,
): string {
  const typeLines = AUDIT_RECORD_TYPES.map((t) => `  - ${t}: ${RECORD_TYPE_MEANING[t]}`).join('\n');
  const statusLines = AUDIT_RECORD_TYPES
    .map((t) => `  - ${t}: ${vocabulary[t].length ? vocabulary[t].join(', ') : '(no records of this type exist for this business)'}`)
    .join('\n');
  const businessLines = businesses.map((b) => `  - ${b.id}${b.name ? ` ("${b.name}")` : ''}`).join('\n');

  return [
    `Current time (UTC): ${now.toISOString()}`,
    '',
    'Allowed record types:',
    typeLines,
    '',
    'Allowed statuses, by record type (these are the values that actually occur in this data):',
    statusLines,
    '',
    'Businesses you may search:',
    businessLines,
    '',
    `Question: ${query}`,
  ].join('\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface InterpretOptions {
  /** Injected in tests, and to force the no-model path. */
  runLLMImpl?: typeof runLLM;
  resolveLLMImpl?: typeof resolveProfileLLM;
  now?: number;
  /** Skip the model entirely and use literal matching. */
  deterministicOnly?: boolean;
  /** Overridable so retries do not make tests slow. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function businessesFor(ids: string[]): Array<{ id: string; name: string | null }> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  try {
    return db.prepare(`SELECT id, name FROM businesses WHERE id IN (${placeholders})`).all(...ids) as
      Array<{ id: string; name: string | null }>;
  } catch {
    return ids.map((id) => ({ id, name: null }));
  }
}

/**
 * Interpret a natural-language query into structured filters.
 *
 * `permittedBusinessIds` is the authorization boundary and is applied to
 * the RESULT as well as offered to the model — a model that ignores the
 * instruction still cannot produce a filter outside this set.
 */
export async function interpretQuery(
  query: string,
  permittedBusinessIds: string[],
  opts: InterpretOptions = {},
): Promise<QueryInterpretation> {
  const now = opts.now ?? Date.now();
  const trimmed = (query ?? '').trim();
  const primaryBusiness = permittedBusinessIds[0] ?? '';
  const vocabulary = statusVocabulary(primaryBusiness);

  // Too short to interpret — established without spending a provider call.
  if (trimmed.length < MIN_QUERY_CHARS) {
    return {
      state: 'ambiguous',
      method: 'none',
      filters: emptyFilters(permittedBusinessIds),
      confidence: null,
      rationale: 'No search was run because the question was too short to interpret.',
      clarification: {
        reason: 'The query was empty or too short to constrain a search.',
        questions: [
          'What happened, or what decision, task or policy are you asking about?',
          'Over what time period?',
        ],
        candidate_readings: [],
      },
      rejected: [],
      provider_error: null,
      attempts: 0,
    };
  }

  const deterministic = deterministicInterpretation(trimmed, permittedBusinessIds, vocabulary, now);

  if (opts.deterministicOnly) {
    return {
      state: 'interpreter_unavailable',
      method: 'deterministic_fallback',
      filters: deterministic,
      confidence: null,
      rationale: 'Natural-language interpretation was not used. Filters come from literal keyword and date matching only.',
      clarification: null,
      rejected: [],
      provider_error: null,
      attempts: 0,
    };
  }

  const resolveImpl = opts.resolveLLMImpl ?? resolveProfileLLM;
  const runImpl = opts.runLLMImpl ?? runLLM;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let providerId: string;
  let model: string;
  try {
    const resolved = resolveImpl({}, { tier: 'triage' });
    providerId = resolved.providerId;
    model = resolved.model;
  } catch (err) {
    // No provider configured at all. Search still works; it just says so.
    return {
      state: 'interpreter_unavailable',
      method: 'deterministic_fallback',
      filters: deterministic,
      confidence: null,
      rationale: 'No language model is configured, so the question was matched literally rather than interpreted.',
      clarification: null,
      rejected: [],
      provider_error: safeErrorMessage(err, 'provider'),
      attempts: 0,
    };
  }

  const businesses = businessesFor(permittedBusinessIds);
  const userPrompt = buildUserPrompt(trimmed, businesses, vocabulary, new Date(now));

  let raw: RawInterpretation | null = null;
  let lastError: unknown = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      const result = await runImpl(providerId, model, {
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0,
        max_tokens: 800,
      });
      const parsed = extractFirstJson<RawInterpretation>(String(result?.content ?? ''));
      if (parsed && typeof parsed === 'object') { raw = parsed; break; }
      // Unparseable output is not retried as if it were a network blip; a
      // model that ignored the format once will usually do so again, and
      // the deterministic path is a perfectly serviceable answer.
      lastError = new Error('The interpreter did not return usable JSON.');
      break;
    } catch (err) {
      lastError = err;
      const classified = classifyProviderError(err, providerId);
      if (!classified.retryable || attempt >= MAX_LLM_ATTEMPTS) break;
      const delayMs = classified.retryAfterMs != null
        ? Math.min(classified.retryAfterMs, MAX_RETRY_DELAY_MS)
        : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      await sleep(delayMs);
    }
  }

  if (!raw) {
    return {
      state: 'interpreter_unavailable',
      method: 'deterministic_fallback',
      filters: deterministic,
      confidence: null,
      rationale: 'The language model could not be reached, so the question was matched literally rather than interpreted. Results may be narrower or broader than intended.',
      clarification: null,
      rejected: [],
      provider_error: safeErrorMessage(lastError, providerId),
      attempts,
    };
  }

  const { filters, rejected } = validateProposedFilters(raw, permittedBusinessIds, vocabulary);
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : null;
  const modelSaysAmbiguous = raw.ambiguous === true;
  const lowConfidence = confidence !== null && confidence < AMBIGUITY_CONFIDENCE_FLOOR;
  const unconstrained = isUnconstrained(filters);

  if (modelSaysAmbiguous || lowConfidence || unconstrained) {
    const reason = modelSaysAmbiguous && typeof raw.ambiguity_reason === 'string' && raw.ambiguity_reason.trim()
      ? raw.ambiguity_reason.trim()
      : lowConfidence
        ? `The question was interpreted with low confidence (${confidence}), below the ${AMBIGUITY_CONFIDENCE_FLOOR} floor at which Blueprint will narrow a search on your behalf.`
        : 'The question produced no filters at all, so running it would return the entire history rather than an answer.';
    const questions = asStringArray(raw.clarifying_questions, 5);
    return {
      state: 'ambiguous',
      method: 'llm',
      filters,
      confidence,
      rationale: 'No search was run. Blueprint asks rather than guessing which records you meant.',
      clarification: {
        reason,
        questions: questions.length ? questions : [
          'Which kind of record are you asking about — a decision, a task, a receipt, a policy change, an outcome, or a connector event?',
          'Over what time period?',
        ],
        candidate_readings: asStringArray(raw.candidate_readings, 5),
      },
      rejected,
      provider_error: null,
      attempts,
    };
  }

  const rationale = typeof raw.rationale === 'string' && raw.rationale.trim()
    ? raw.rationale.trim()
    : 'Filters were derived from the question.';

  return {
    state: 'interpreted',
    method: 'llm',
    filters,
    confidence,
    rationale,
    clarification: null,
    rejected,
    provider_error: null,
    attempts,
  };
}
