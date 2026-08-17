/**
 * Grounding verification for generated search summaries (issue #72).
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * Natural-language search over an audit trail has exactly one way to fail
 * catastrophically: producing a fluent sentence about something that never
 * happened. An audit system that occasionally invents an event is worse
 * than no search at all, because the invention is indistinguishable from
 * the truth and arrives with the same authority.
 *
 * Blueprint's answer is not "prompt the model to be careful". It is a
 * deterministic checker that runs AFTER the model and BEFORE the user sees
 * anything, and that has the power to throw the whole summary away.
 *
 * ── The contract a summary must satisfy ──────────────────────────────────
 *
 * A generated summary is admissible only if ALL of these hold:
 *
 *   1. It cites at least one record. A summary with no citations is
 *      unfalsifiable prose and is rejected outright.
 *
 *   2. Every citation resolves to a record that was ACTUALLY RETRIEVED for
 *      this search. Not "exists somewhere in the database" — retrieved.
 *      A model that cites a real record it was never shown is guessing,
 *      and a guess that happens to be right is still a guess.
 *
 *   3. Every sentence carries at least one citation. This is the rule that
 *      does the real work. Fabrication almost never arrives as a bogus id;
 *      it arrives as a confident uncited sentence ("this was caused by the
 *      pricing change") sitting between two properly-cited ones. Requiring
 *      a citation per sentence removes the place where such a claim can
 *      live. Counting statements are not exempted — they are produced by
 *      the deterministic layer instead, which cannot get them wrong.
 *
 *   4. Every number in the summary occurs in the retrieved corpus, or is a
 *      count the retrieval itself computed. "Revenue fell 12%" is rejected
 *      when no retrieved record contains 12 — the most common shape of a
 *      plausible-sounding invention.
 *
 * ── What happens when a summary fails ────────────────────────────────────
 *
 * It is discarded in full, not patched. The search then reports the
 * deterministic summary — pure counts over the retrieved rows, which cannot
 * be wrong — plus the specific violations, so the failure is visible rather
 * than silent. Degrading to "here are the records, with no narrative" is
 * always an acceptable answer for an audit tool. Guessing never is.
 */
import type { AuditRecord, AuditRecordType } from './record-index.js';

/**
 * Citation markers a summary must use: `[decision#dec_17]`.
 *
 * Deliberately the same `type#id` token AuditRecord.citation.ref carries,
 * so a citation is checked by string identity against the retrieved set and
 * there is no mapping layer that could drift.
 */
export const CITATION_PATTERN = /\[([a-z_]+)#([^\]\s]+)\]/g;

export interface ExtractedCitation {
  /**
   * Named `ref` rather than `token` deliberately: lib/redaction.ts replaces
   * the value of any key matching /^token$/ with `[redacted]`, which would
   * silently blank every citation on the way out of the API and break the
   * one field the whole feature's checkability rests on.
   */
  ref: string;
  record_type: string;
  record_id: string;
}

export function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();
  // A fresh regex per call: the global flag makes lastIndex stateful, and a
  // shared instance would silently skip matches on alternate calls.
  const pattern = new RegExp(CITATION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [full, type, id] = match;
    if (!type || !id) continue;
    const ref = `${type}#${id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, record_type: type, record_id: id });
    void full;
  }
  return out;
}

export type GroundingViolationKind =
  /** The summary was empty or whitespace. */
  | 'empty'
  /** The summary cites nothing at all — unfalsifiable prose. */
  | 'no_citations'
  /** A citation names a record that was not among the retrieved results. */
  | 'unknown_citation'
  /** A sentence asserts something without citing any record. */
  | 'uncited_sentence'
  /** A number appears that occurs nowhere in the retrieved records. */
  | 'ungrounded_number';

export const VIOLATION_MEANING: Record<GroundingViolationKind, string> = {
  empty: 'No summary text was produced.',
  no_citations: 'The summary cited no records at all, so nothing in it can be checked.',
  unknown_citation: 'The summary cited a record that was not among the search results — it was not something Blueprint retrieved.',
  uncited_sentence: 'A sentence made a claim without citing any record to support it.',
  ungrounded_number: 'A figure appeared in the summary that does not occur in any retrieved record.',
};

export interface GroundingViolation {
  kind: GroundingViolationKind;
  /** The specific offending text or token. */
  detail: string;
  /** The sentence it occurred in, when applicable. */
  excerpt: string | null;
}

export interface GroundingReport {
  /** True only when there are zero violations. There is no partial pass. */
  grounded: boolean;
  citations: ExtractedCitation[];
  /** Citations that resolved to a retrieved record. */
  resolved_citations: string[];
  violations: GroundingViolation[];
  /** Every sentence checked, so the check itself is inspectable. */
  sentences_checked: number;
}

/**
 * Split into sentences for the per-sentence citation rule.
 *
 * Kept simple on purpose: an over-clever splitter that merges two sentences
 * would let an uncited claim ride along inside a cited one, which is the
 * exact failure this guard exists to prevent. Splitting slightly too
 * eagerly is the safe direction — it can only make the check stricter.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Does this sentence assert anything? A bare list bullet, a heading or a
 * fragment of punctuation is not a claim, and demanding a citation for it
 * would reject honest formatting.
 *
 * Anything with two or more word characters IS treated as a claim. The bar
 * is set that low deliberately: the cost of demanding a citation for a
 * harmless fragment is a rejected summary, and the cost of exempting a
 * fragment that turns out to be a claim is a fabrication reaching the user.
 */
function isClaim(sentence: string): boolean {
  const stripped = sentence.replace(new RegExp(CITATION_PATTERN.source, 'g'), ' ').trim();
  const words = stripped.match(/[A-Za-z]{2,}/g) ?? [];
  return words.length >= 2;
}

/**
 * Numbers that may legitimately appear in a summary:
 *   - every numeric token occurring as a NUMBER in the retrieved corpus
 *   - the retrieval's own counts: total results, and the count per type
 *
 * Built from the corpus rather than a whitelist so it needs no maintenance
 * as new record types are added.
 *
 * ── Why identifiers are excluded ─────────────────────────────────────────
 *
 * A UUID like `2003a3d4-e53b-4ec5-94cf-6ee2f47451ac` contains the digit
 * runs 2003, 53, 4, 94, 6, 47451 and so on. Harvesting digits out of
 * identifiers therefore licenses an enormous, effectively arbitrary set of
 * "grounded" figures, and a fabricated statistic only has to collide with
 * one of them to pass. That is not a hypothetical: it was caught by this
 * module's own test suite, where an invented "37 percent" was waved through
 * because 37 happened to sit inside a fixture's record id.
 *
 * So numbers are harvested only from tokens that are ENTIRELY numeric —
 * `37`, `12.5`, and the `2026`/`08`/`17` of a timestamp all qualify, while
 * a digit run welded to letters inside an identifier does not. Record ids
 * are skipped outright: an id is a name, not a quantity, and no honest
 * summary needs to quote one as a figure.
 */
export function groundedNumbers(records: AuditRecord[]): Set<string> {
  const allowed = new Set<string>();

  const harvest = (value: unknown, depth = 0): void => {
    if (value == null || depth > 6) return;
    if (typeof value === 'number') { allowed.add(normaliseNumber(String(value))); return; }
    if (typeof value === 'string') {
      // Split on anything that is not alphanumeric or a decimal point, then
      // keep only wholly-numeric tokens. This is what stops a digit run
      // embedded in an identifier from grounding a fabricated statistic.
      for (const token of value.split(/[^0-9A-Za-z.]+/)) {
        if (/^\d+(?:\.\d+)?$/.test(token)) allowed.add(normaliseNumber(token));
      }
      return;
    }
    if (Array.isArray(value)) { for (const v of value) harvest(v, depth + 1); return; }
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) harvest(v, depth + 1);
    }
  };

  for (const r of records) {
    harvest(r.title); harvest(r.snippet); harvest(r.status); harvest(r.actor);
    harvest(r.occurred_at); harvest(r.fields);
    if (r.age_hours != null) allowed.add(normaliseNumber(String(Math.round(r.age_hours))));
  }

  // Counts the retrieval genuinely computed — these are facts about the
  // result set, not claims about the business.
  allowed.add(normaliseNumber(String(records.length)));
  const byType = new Map<AuditRecordType, number>();
  for (const r of records) {
    byType.set(r.citation.record_type, (byType.get(r.citation.record_type) ?? 0) + 1);
  }
  for (const count of byType.values()) allowed.add(normaliseNumber(String(count)));

  // Small integers used as ordinals ("the first two records") are not
  // claims about the data. Capped at the result count so it can never
  // license a figure larger than the evidence.
  for (let i = 0; i <= Math.min(records.length, 10); i++) allowed.add(String(i));

  return allowed;
}

/** `12.0` and `12` are the same number; compare on a canonical form. */
function normaliseNumber(raw: string): string {
  const n = Number(raw);
  if (Number.isNaN(n)) return raw;
  return String(n);
}

/**
 * Verify a generated summary against the records it was generated from.
 *
 * `records` MUST be exactly the set the model was shown. Passing a wider
 * set (e.g. everything in the database) would defeat rule 2 and turn a
 * lucky guess into a pass.
 */
export function verifySummaryGrounding(summary: string, records: AuditRecord[]): GroundingReport {
  const violations: GroundingViolation[] = [];
  const text = (summary ?? '').trim();

  if (!text) {
    return {
      grounded: false, citations: [], resolved_citations: [],
      violations: [{ kind: 'empty', detail: 'The summary was empty.', excerpt: null }],
      sentences_checked: 0,
    };
  }

  const retrievedRefs = new Set(records.map((r) => r.citation.ref));
  const citations = extractCitations(text);
  const resolved: string[] = [];

  for (const c of citations) {
    if (retrievedRefs.has(c.ref)) resolved.push(c.ref);
    else {
      violations.push({
        kind: 'unknown_citation',
        detail: c.ref,
        excerpt: splitSentences(text).find((s) => s.includes(c.ref)) ?? null,
      });
    }
  }

  if (!citations.length) {
    violations.push({ kind: 'no_citations', detail: 'The summary cited no records.', excerpt: null });
  }

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (!isClaim(sentence)) continue;
    if (!extractCitations(sentence).length) {
      violations.push({ kind: 'uncited_sentence', detail: sentence, excerpt: sentence });
    }
  }

  const allowedNumbers = groundedNumbers(records);
  // Numbers inside citation tokens are part of a record id, not a claim.
  const withoutCitations = text.replace(new RegExp(CITATION_PATTERN.source, 'g'), ' ');
  for (const raw of withoutCitations.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowedNumbers.has(normaliseNumber(raw))) {
      violations.push({
        kind: 'ungrounded_number',
        detail: raw,
        excerpt: sentences.find((s) => s.includes(raw)) ?? null,
      });
    }
  }

  return {
    grounded: violations.length === 0,
    citations,
    resolved_citations: resolved,
    violations,
    sentences_checked: sentences.length,
  };
}
