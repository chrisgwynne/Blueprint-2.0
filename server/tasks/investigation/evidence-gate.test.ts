/**
 * Unit coverage for the evidence-vs-confidence gate (issue #43).
 *
 * The investigation executor used to trust an LLM's self-reported
 * `primary_confidence`/`recommendation` unconditionally, so a task could be
 * marked `complete` with confidence 0.85 even though none of the external
 * evidence its own description demanded (exact landing-page URL, HTTP
 * status/redirect chain, canonical consistency, product availability,
 * Merchant Center/Shopify mapping) was ever collected — and even though the
 * model's own recommendation was `investigate_further`. These are pure-logic
 * tests of the gate itself; server/tasks/executor.investigation-evidence-gate.test.ts
 * covers it wired into the real executor.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseRequiredEvidence,
  assessEvidenceCoverage,
  capConfidenceToEvidence,
  decideCompletionGate,
  sanitiseEvidenceValue,
  type EvidenceGateContext,
} from './evidence-gate.js';

describe('parseRequiredEvidence', () => {
  test('extracts every evidence category mentioned in the task text', () => {
    const required = parseRequiredEvidence({
      title: 'Confirm why the /widgets landing page dropped out of Shopping results',
      description:
        'Confirm the exact landing-page URL that is live, check the HTTP status and redirect chain, ' +
        'verify canonical consistency, confirm product availability, and confirm the Merchant Center / ' +
        'Shopify product mapping before drawing any conclusion.',
    });
    const keys = required.map((r) => r.key).sort();
    expect(keys).toEqual([
      'canonical_consistency',
      'http_status',
      'landing_page_url',
      'merchant_mapping',
      'product_availability',
    ].sort());
  });

  test('returns an empty list for a task with no explicit evidence requirements', () => {
    const required = parseRequiredEvidence({ title: 'Why did revenue drop?', description: 'General investigation.' });
    expect(required).toEqual([]);
  });
});

describe('assessEvidenceCoverage', () => {
  test('every required category is unmet when no real evidence was gathered', () => {
    const required = parseRequiredEvidence({
      title: 'Investigate product delisting',
      description: 'Confirm product availability and the Merchant Center / Shopify product mapping.',
    });
    const coverage = assessEvidenceCoverage(required, { current_metrics: {}, theme_files: null, relevant_connectors: [] });
    expect(coverage.requiredCount).toBe(2);
    expect(coverage.verifiedCount).toBe(0);
    expect(coverage.coverageRatio).toBe(0);
    expect(coverage.missing).toHaveLength(2);
    expect(coverage.missing.every((m) => !m.verified)).toBe(true);
  });

  test('a category is verified when real connector-sourced data backs it, not just LLM prose', () => {
    const required = parseRequiredEvidence({
      title: 'Investigate product delisting',
      description: 'Confirm product availability.',
    });
    const ctx: EvidenceGateContext = {
      current_metrics: { shopify: { inventory_level: { value: 12, recorded_at: '2026-08-01' } } },
    };
    const coverage = assessEvidenceCoverage(required, ctx);
    expect(coverage.requiredCount).toBe(1);
    expect(coverage.verifiedCount).toBe(1);
    expect(coverage.coverageRatio).toBe(1);
    expect(coverage.missing).toHaveLength(0);
    expect(coverage.checks[0]!.source).toBe('shopify');
    expect(coverage.checks[0]!.observed_at).not.toBeNull();
  });

  test('an empty requirement list has full coverage by definition', () => {
    const coverage = assessEvidenceCoverage([], { current_metrics: {} });
    expect(coverage.requiredCount).toBe(0);
    expect(coverage.coverageRatio).toBe(1);
    expect(coverage.missing).toHaveLength(0);
  });
});

describe('capConfidenceToEvidence — reject unsupported confidence', () => {
  test('zero evidence coverage caps 0.85 well below the reported bug value', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: {} }
    );
    const result = capConfidenceToEvidence(0.85, coverage);
    expect(result.capped).toBe(true);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.confidence).toBeLessThan(0.85);
  });

  test('full evidence coverage does not cap a high confidence value', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: { shopify: { inventory_level: { value: 1 } } } }
    );
    const result = capConfidenceToEvidence(0.85, coverage);
    expect(result.capped).toBe(false);
    expect(result.confidence).toBe(0.85);
  });

  test('no required evidence at all leaves confidence untouched', () => {
    const coverage = assessEvidenceCoverage([], { current_metrics: {} });
    const result = capConfidenceToEvidence(0.9, coverage);
    expect(result.capped).toBe(false);
    expect(result.confidence).toBe(0.9);
  });

  test('a null/missing confidence stays null rather than being invented', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: {} }
    );
    const result = capConfidenceToEvidence(undefined, coverage);
    expect(result.confidence).toBeNull();
    expect(result.capped).toBe(false);
  });
});

describe('decideCompletionGate', () => {
  test('investigate_further + missing evidence is self-contradictory — never complete', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: {} }
    );
    const gate = decideCompletionGate({ recommendation: 'investigate_further', coverage });
    expect(gate.canComplete).toBe(false);
    expect(gate.finalStatus).toBe('manual_review');
    expect(gate.reason).toMatch(/investigate_further/);
  });

  test('missing evidence under any other recommendation blocks rather than completing silently', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: {} }
    );
    const gate = decideCompletionGate({ recommendation: 'act_now', coverage });
    expect(gate.canComplete).toBe(false);
    expect(gate.finalStatus).toBe('blocked');
  });

  test('full coverage allows completion regardless of recommendation', () => {
    const coverage = assessEvidenceCoverage(
      [{ key: 'product_availability', label: 'Product availability', matched_text: 'availability' }],
      { current_metrics: { shopify: { inventory_level: { value: 1 } } } }
    );
    const gate = decideCompletionGate({ recommendation: 'investigate_further', coverage });
    expect(gate.canComplete).toBe(true);
    expect(gate.finalStatus).toBe('complete');
  });
});

describe('sanitiseEvidenceValue — strip sensitive URL query strings before persistence', () => {
  test('strips query strings from URLs nested anywhere in the structure', () => {
    const sanitised = sanitiseEvidenceValue({
      primary_cause: 'Landing page https://shop.example.com/products/widget?variant=99&discount=SECRET42 redirects',
      supporting_evidence: [
        'GSC shows https://shop.example.com/collections/sale?utm_source=email&token=abc123 dropped out of the index',
        'no url here, just a question?',
      ],
      nested: { url: '/products/widget?ref=affiliate123' },
    });
    expect(sanitised.primary_cause).toBe('Landing page https://shop.example.com/products/widget redirects');
    expect(sanitised.supporting_evidence[0]).toBe('GSC shows https://shop.example.com/collections/sale dropped out of the index');
    expect(sanitised.supporting_evidence[0]).not.toMatch(/token=/);
    expect(sanitised.supporting_evidence[1]).toBe('no url here, just a question?');
    expect(sanitised.nested.url).toBe('/products/widget');
  });

  test('leaves non-URL text and non-string types untouched', () => {
    const sanitised = sanitiseEvidenceValue({ confidence: 0.42, ok: true, note: null, list: [1, 2, 3] });
    expect(sanitised).toEqual({ confidence: 0.42, ok: true, note: null, list: [1, 2, 3] });
  });
});
