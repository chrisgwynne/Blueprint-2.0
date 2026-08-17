/**
 * Grounding verification — the anti-fabrication guarantee (issue #72).
 *
 * These tests are the machine-checkable form of "search must not invent an
 * explanation". They assert the properties the checker exists to enforce,
 * using deliberately realistic fabrications rather than obvious ones — a
 * checker that only catches `[decision#TOTALLY_FAKE]` catches nothing worth
 * catching.
 */
import { describe, test, expect } from 'bun:test';
import {
  extractCitations, verifySummaryGrounding, splitSentences, groundedNumbers,
} from './grounding.ts';
import type { AuditRecord } from './record-index.ts';

function record(partial: Partial<AuditRecord> & { type: string; id: string }): AuditRecord {
  return {
    citation: {
      ref: `${partial.type}#${partial.id}`,
      record_type: partial.type as AuditRecord['citation']['record_type'],
      record_id: partial.id,
      table: 'test_table',
    },
    business_id: 'biz_1',
    title: partial.title ?? 'A record',
    snippet: partial.snippet ?? '',
    snippet_fields: [],
    status: partial.status ?? null,
    occurred_at: partial.occurred_at ?? '2026-08-01T00:00:00.000Z',
    age_hours: partial.age_hours ?? 24,
    freshness: 'fresh',
    actor: partial.actor ?? null,
    fields: partial.fields ?? {},
    href: '/tasks',
    explainable: null,
    matched_terms: [],
    score: 1,
  };
}

const RECORDS: AuditRecord[] = [
  record({
    type: 'decision', id: 'dec_1',
    title: 'Rejected the price increase',
    snippet: 'Margin evidence was too thin to justify the change.',
    status: 'task_rejection',
  }),
  record({
    type: 'receipt', id: 'rcp_1',
    title: 'Opened GitHub issue',
    snippet: 'GitHub acknowledged the issue.',
    status: 'externally_acknowledged',
  }),
];

describe('citation extraction', () => {
  test('pulls every distinct citation token out of a summary', () => {
    const cites = extractCitations('First [decision#dec_1]. Second [receipt#rcp_1]. Again [decision#dec_1].');
    expect(cites.map((c) => c.ref)).toEqual(['decision#dec_1', 'receipt#rcp_1']);
  });

  test('is not confused by repeated calls (the global-regex lastIndex trap)', () => {
    const text = 'One [task#t_1].';
    expect(extractCitations(text)).toHaveLength(1);
    expect(extractCitations(text)).toHaveLength(1);
    expect(extractCitations(text)).toHaveLength(1);
  });

  test('finds nothing in prose that cites nothing', () => {
    expect(extractCitations('The price change was rejected because margins were thin.')).toEqual([]);
  });
});

describe('sentence splitting', () => {
  test('splits on terminators and newlines', () => {
    expect(splitSentences('One. Two! Three?\nFour')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
  });
});

describe('a well-grounded summary is accepted', () => {
  test('every sentence cited, every citation retrieved, no invented numbers', () => {
    const summary =
      'The price increase was rejected [decision#dec_1]. A GitHub issue was opened and acknowledged [receipt#rcp_1].';
    const report = verifySummaryGrounding(summary, RECORDS);
    expect(report.grounded).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.resolved_citations.sort()).toEqual(['decision#dec_1', 'receipt#rcp_1']);
  });
});

describe('fabrication is rejected', () => {
  test('a summary citing a record that was NOT retrieved is rejected', () => {
    // The dangerous case: a plausible id, correctly formatted, for a record
    // the model was never shown. Being real elsewhere would not make it
    // less of a guess.
    const summary = 'The price increase was rejected [decision#dec_1]. It was later reversed [decision#dec_99].';
    const report = verifySummaryGrounding(summary, RECORDS);
    expect(report.grounded).toBe(false);
    expect(report.violations.some((v) => v.kind === 'unknown_citation' && v.detail === 'decision#dec_99')).toBe(true);
  });

  test('an uncited sentence between two cited ones is rejected', () => {
    // The most realistic fabrication shape: a confident causal claim
    // smuggled between two honest sentences.
    const summary =
      'The price increase was rejected [decision#dec_1]. '
      + 'This was because a competitor had just cut their prices. '
      + 'A GitHub issue was opened [receipt#rcp_1].';
    const report = verifySummaryGrounding(summary, RECORDS);
    expect(report.grounded).toBe(false);
    const uncited = report.violations.find((v) => v.kind === 'uncited_sentence');
    expect(uncited).toBeDefined();
    expect(uncited!.detail).toContain('competitor');
  });

  test('a summary with no citations at all is rejected', () => {
    const report = verifySummaryGrounding('Margins were too thin so the change was rejected.', RECORDS);
    expect(report.grounded).toBe(false);
    expect(report.violations.some((v) => v.kind === 'no_citations')).toBe(true);
  });

  test('a number that occurs nowhere in the records is rejected', () => {
    const summary = 'Margins fell 12 percent before the rejection [decision#dec_1].';
    const report = verifySummaryGrounding(summary, RECORDS);
    expect(report.grounded).toBe(false);
    expect(report.violations.some((v) => v.kind === 'ungrounded_number' && v.detail === '12')).toBe(true);
  });

  test('an empty summary is rejected rather than treated as an honest silence', () => {
    const report = verifySummaryGrounding('   ', RECORDS);
    expect(report.grounded).toBe(false);
    expect(report.violations[0]!.kind).toBe('empty');
  });

  test('there is no partial pass — one violation fails the whole summary', () => {
    const summary = 'Rejected [decision#dec_1]. Acknowledged [receipt#rcp_1]. Also reversed [decision#dec_99].';
    const report = verifySummaryGrounding(summary, RECORDS);
    expect(report.grounded).toBe(false);
    // Two sentences were perfectly fine; the summary still fails as a whole.
    expect(report.resolved_citations).toHaveLength(2);
  });
});

describe('numbers that ARE grounded are allowed', () => {
  test('a figure copied out of a record passes', () => {
    const withNumber = [
      record({ type: 'outcome', id: 'out_1', title: 'Outcome check', snippet: 'Revenue changed by 17 percent.' }),
    ];
    const report = verifySummaryGrounding('Revenue changed by 17 percent [outcome#out_1].', withNumber);
    expect(report.grounded).toBe(true);
  });

  test('a figure from a numeric field (not just text) passes', () => {
    const withField = [
      record({ type: 'outcome', id: 'out_2', title: 'Outcome check', fields: { change_pct: 42 } }),
    ];
    const report = verifySummaryGrounding('The measured change was 42 [outcome#out_2].', withField);
    expect(report.grounded).toBe(true);
  });

  test('the result count itself is a grounded number', () => {
    const allowed = groundedNumbers(RECORDS);
    expect(allowed.has('2')).toBe(true);
  });

  test('a count LARGER than the result set is not licensed by the ordinal allowance', () => {
    const one = [record({ type: 'task', id: 't_1', title: 'Task' })];
    const allowed = groundedNumbers(one);
    expect(allowed.has('9')).toBe(false);
  });

  test('digits buried inside a UUID do NOT ground a fabricated statistic', () => {
    // Regression: harvesting digit runs out of identifiers licensed a huge
    // arbitrary set of "grounded" figures, and an invented "37 percent"
    // passed because 37 sat inside a record id.
    const withUuid = [
      record({ type: 'decision', id: '2003a3d4-e53b-4ec5-94cf-6ee2f47451ac', title: 'A decision', snippet: 'No figures here.' }),
    ];
    const allowed = groundedNumbers(withUuid);
    expect(allowed.has('37')).toBe(false);
    expect(allowed.has('2003')).toBe(false);

    const report = verifySummaryGrounding(
      'Margins fell 37 percent [decision#2003a3d4-e53b-4ec5-94cf-6ee2f47451ac].',
      withUuid,
    );
    expect(report.grounded).toBe(false);
    expect(report.violations.some((v) => v.kind === 'ungrounded_number' && v.detail === '37')).toBe(true);
  });

  test('a number standing on its own in the text is still grounded', () => {
    const withUuid = [
      record({ type: 'decision', id: '2003a3d4-e53b-4ec5-94cf-6ee2f47451ac', title: 'A decision', snippet: 'Margin moved 37 points.' }),
    ];
    expect(
      verifySummaryGrounding(
        'Margin moved 37 points [decision#2003a3d4-e53b-4ec5-94cf-6ee2f47451ac].',
        withUuid,
      ).grounded,
    ).toBe(true);
  });
});

describe('the checker is verified against the retrieved set, not the world', () => {
  test('an empty retrieved set makes every citation unknown', () => {
    const report = verifySummaryGrounding('Something happened [decision#dec_1].', []);
    expect(report.grounded).toBe(false);
    expect(report.violations.some((v) => v.kind === 'unknown_citation')).toBe(true);
  });
});
