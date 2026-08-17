/**
 * Natural-language audit & history search (issue #72).
 *
 * The tests target the guarantees, not the formatting:
 *
 *   RECALL          — a known, seeded set of events is actually found by
 *                     the kind of question a user would ask about it.
 *   NO FABRICATION  — every citation in a returned summary resolves to a
 *                     record that was actually retrieved; a model that
 *                     invents one has its summary discarded whole.
 *   STATES          — no_results, results_stale and ambiguous_query are
 *                     produced in the situations that warrant them, and are
 *                     distinguishable from each other and from an error.
 *   AUTHORIZATION   — a search of business A can never return a row from
 *                     business B, even when the interpreter asks for it.
 *   REDACTION       — a credential sitting in a searched row does not reach
 *                     the result, and is not handed to a model either.
 *
 * The LLM is injected in every test. Interpretation and summarisation are
 * the only model-dependent parts of the feature, and stubbing them is what
 * makes it possible to assert what happens when a model behaves badly —
 * which is the failure this issue exists to prevent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  searchAuditHistory, summariseGrounded, deterministicSummary, searchVocabulary,
  STALE_AFTER_HOURS,
} from './audit-search.ts';
import { retrieve, resolveCitation, statusVocabulary } from './record-index.ts';
import { interpretQuery, deterministicInterpretation, parseTimeExpression, extractTerms } from './query-interpretation.ts';
import { ProviderHttpError } from '../lib/provider-errors.js';

const BIZ_A = 'biz_audit_search_a';
const BIZ_B = 'biz_audit_search_b';

// Fixed instants so nothing depends on wall-clock drift.
const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const RECENT = '2026-08-16T09:00:00.000Z';   // ~27h before NOW
const OLDER = '2026-08-01T09:00:00.000Z';    // ~16 days before NOW
const ANCIENT = '2026-01-05T09:00:00.000Z';  // ~7 months before NOW

const created: Array<{ table: string; id: string }> = [];
function track(table: string, id: string): string {
  created.push({ table, id });
  return id;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function insertDecision(p: {
  business_id: string; title: string; decision: string; reasoning?: string;
  decision_type?: string; created_at?: string; author?: string;
  effective_policy_version?: number | null;
}): string {
  const id = track('decisions', generateId());
  db.prepare(`
    INSERT INTO decisions (id, business_id, decision_type, title, decision, reasoning,
                           confidence, author, created_at, effective_policy_id,
                           effective_policy_version, effective_policy_scope)
    VALUES (?, ?, ?, ?, ?, ?, 0.7, ?, ?, 'pol_fixture', ?, 'business')
  `).run(
    id, p.business_id, p.decision_type ?? 'task_rejection', p.title, p.decision,
    p.reasoning ?? null, p.author ?? 'agent:test', p.created_at ?? RECENT,
    p.effective_policy_version ?? 3,
  );
  return id;
}

function insertTask(p: {
  business_id: string; title: string; description?: string; status?: string;
  action_type?: string | null; created_at?: string; action_payload?: string;
}): string {
  const id = track('tasks', generateId());
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, description, proposed_by, status,
                       trust_tier, approval_mode, action_type, action_payload,
                       created_at, updated_at)
    VALUES (?, ?, ?, ?, 'agent:test', ?, 'yellow', 'requires_approval', ?, ?, ?, ?)
  `).run(
    id, p.business_id, p.title, p.description ?? null, p.status ?? 'proposed',
    p.action_type ?? null, p.action_payload ?? '{}',
    p.created_at ?? RECENT, p.created_at ?? RECENT,
  );
  return id;
}

function insertReceipt(p: {
  business_id: string; task_id: string; title: string; state?: string;
  result_summary?: string; created_at?: string; external_system?: string | null;
}): string {
  const id = track('action_receipts', generateId());
  db.prepare(`
    INSERT INTO action_receipts (id, business_id, task_id, task_version, correlation_key,
                                 action_type, title, state, result_status, result_summary,
                                 external_system, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 'github_issue', ?, ?, 'success', ?, ?, ?, ?)
  `).run(
    id, p.business_id, p.task_id, `blueprint:task=${p.task_id}:v1`,
    p.title, p.state ?? 'externally_acknowledged', p.result_summary ?? null,
    p.external_system ?? 'github', p.created_at ?? RECENT, p.created_at ?? RECENT,
  );
  return id;
}

function insertPolicyEvent(p: {
  business_id: string; event_type: string; reason: string;
  version?: number; created_at?: string;
}): string {
  const id = track('operating_policy_events', generateId());
  db.prepare(`
    INSERT INTO operating_policy_events (id, policy_id, scope, scope_key, business_id,
                                         version, event_type, actor, reason, created_at)
    VALUES (?, 'pol_fixture', 'business', ?, ?, ?, ?, 'dashboard:tester', ?, ?)
  `).run(
    id, p.business_id, p.business_id, p.version ?? 4, p.event_type, p.reason,
    p.created_at ?? RECENT,
  );
  return id;
}

function insertOutcome(p: { task_id: string; verdict: string; detail?: string; check_date?: string }): string {
  const id = track('task_outcomes', generateId());
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value,
                               baseline_value, change_pct, verdict, verdict_detail, created_at)
    VALUES (?, ?, ?, 4, 120, 100, 20, ?, ?, ?)
  `).run(id, p.task_id, p.check_date ?? RECENT, p.verdict, p.detail ?? null, p.check_date ?? RECENT);
  return id;
}

function insertConnector(p: {
  business_id: string; name: string; type?: string; last_sync?: string | null; status?: string;
}): string {
  const id = track('connectors', generateId());
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, p.business_id, p.type ?? 'shopify', p.name, p.status ?? 'connected', p.last_sync ?? RECENT, OLDER);
  return id;
}

function insertSync(p: {
  connector_id: string; status: string; error?: string | null; created_at?: string;
}): string {
  const id = track('connector_syncs', generateId());
  db.prepare(`
    INSERT INTO connector_syncs (id, connector_id, status, records_fetched, error, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(id, p.connector_id, p.status, p.error ?? null, p.created_at ?? RECENT);
  return id;
}

// The known, seeded corpus that the recall tests search for.
let decisionPricing = '';
let taskPricing = '';
let receiptPricing = '';
let policyEventTightened = '';
let outcomePricing = '';
let connectorA = '';
let syncFailure = '';
let ancientDecision = '';
let leakyTask = '';

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Audit Search A', 'audit-search-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Audit Search B', 'audit-search-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);

  decisionPricing = insertDecision({
    business_id: BIZ_A,
    title: 'Rejected the wholesale pricing increase',
    decision: 'Do not raise wholesale prices this quarter.',
    reasoning: 'Margin evidence was too thin and the connector data was stale.',
    decision_type: 'task_rejection',
    created_at: RECENT,
  });

  taskPricing = insertTask({
    business_id: BIZ_A,
    title: 'Raise wholesale pricing by one step',
    description: 'Proposed pricing change across the wholesale catalogue.',
    status: 'rejected',
    action_type: 'shopify_price_update',
    created_at: RECENT,
  });

  receiptPricing = insertReceipt({
    business_id: BIZ_A,
    task_id: taskPricing,
    title: 'Wholesale pricing rollback issue',
    state: 'externally_acknowledged',
    result_summary: 'GitHub accepted the rollback issue for the pricing change.',
    created_at: RECENT,
  });

  policyEventTightened = insertPolicyEvent({
    business_id: BIZ_A,
    event_type: 'activated',
    reason: 'Tightened the autonomy ceiling after the pricing incident.',
    created_at: RECENT,
  });

  outcomePricing = insertOutcome({
    task_id: taskPricing,
    verdict: 'no_change',
    detail: 'No measurable movement in wholesale margin after the pricing decision.',
    check_date: RECENT,
  });

  connectorA = insertConnector({ business_id: BIZ_A, name: 'Shopify Store', last_sync: RECENT });
  syncFailure = insertSync({
    connector_id: connectorA, status: 'failed',
    error: 'Shopify rejected the pricing catalogue request.',
    created_at: RECENT,
  });

  ancientDecision = insertDecision({
    business_id: BIZ_A,
    title: 'Retired the legacy warehouse contract',
    decision: 'Terminate the legacy warehouse agreement.',
    reasoning: 'Superseded by the new fulfilment partner.',
    decision_type: 'contract_decision',
    created_at: ANCIENT,
  });

  // A row whose text and payload contain credential-shaped material. The
  // fixtures are obviously synthetic (mixed-case words, not hex) so no
  // secret scanner mistakes them for a real key.
  leakyTask = insertTask({
    business_id: BIZ_A,
    title: 'Rotate the fulfilment credential',
    description: 'Old header was Authorization: Bearer ThisIsAFakeTokenForTestFixtureOnly and must be replaced.',
    status: 'proposed',
    action_type: 'credential_rotation',
    action_payload: JSON.stringify({ api_key: 'TESTFIXTURE-not-a-real-key', note: 'rotate me' }),
    created_at: RECENT,
  });

  // Business B's own history — never allowed to appear in an A search.
  insertDecision({
    business_id: BIZ_B,
    title: 'Rejected the wholesale pricing increase',
    decision: 'Business B made its own pricing call.',
    reasoning: 'Business B reasoning about wholesale pricing.',
    created_at: RECENT,
  });
  const taskB = insertTask({
    business_id: BIZ_B, title: 'Raise wholesale pricing in business B',
    description: 'Business B pricing work.', created_at: RECENT,
  });
  insertReceipt({ business_id: BIZ_B, task_id: taskB, title: 'Business B pricing receipt' });
});

afterAll(() => {
  for (const { table, id } of [...created].reverse()) {
    try { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); } catch { /* fixture teardown */ }
  }
  try { db.prepare('DELETE FROM businesses WHERE id IN (?, ?)').run(BIZ_A, BIZ_B); } catch { /* ignore */ }
});

// ─── LLM stubs ───────────────────────────────────────────────────────────────

const resolveOk = () => ({ providerId: 'test', model: 'test-model', temperature: 0, max_tokens: 100 });

/** An interpreter that returns a fixed, well-formed filter proposal. */
function interpreterReturning(payload: Record<string, unknown>) {
  return async () => ({
    content: JSON.stringify(payload),
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: 0,
  });
}

/** A summariser that returns whatever text the test wants to test. */
function summariserReturning(text: string) {
  return async () => ({
    content: text,
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: 0,
  });
}

const CONFIDENT = {
  record_types: [], statuses: [], business_ids: [], from: null, to: null,
  terms: ['pricing'], confidence: 0.9, ambiguous: false, rationale: 'Keyword: pricing.',
};

function search(overrides: Parameters<typeof searchAuditHistory>[0]) {
  return searchAuditHistory({ now: NOW, ...overrides });
}

// ─── Grounded retrieval ──────────────────────────────────────────────────────

describe('grounded retrieval returns real rows and only real rows', () => {
  test('every result resolves back to a row that exists in its named table', () => {
    const result = retrieve({
      business_id: BIZ_A, record_types: [], statuses: [],
      from: null, to: null, terms: ['pricing'], per_type_limit: 60,
    }, { now: NOW });

    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      const row = db.prepare(`SELECT 1 AS ok FROM ${record.citation.table} WHERE id = ?`)
        .get(record.citation.record_id) as { ok?: number } | undefined;
      expect(row?.ok).toBe(1);
    }
  });

  test('a snippet is copied verbatim out of the row, not paraphrased', () => {
    const result = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['margin'], per_type_limit: 60,
    }, { now: NOW });
    const found = result.records.find((r) => r.citation.record_id === decisionPricing);
    expect(found).toBeDefined();
    // The exact stored reasoning text appears in the snippet.
    expect(found!.snippet).toContain('Margin evidence was too thin');
  });

  test('a decision carries its #68 policy citation through untouched', () => {
    const result = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['pricing'], per_type_limit: 60,
    }, { now: NOW });
    const found = result.records.find((r) => r.citation.record_id === decisionPricing);
    expect(found!.fields.effective_policy_version).toBe(3);
  });

  test('a decision links to the #60 explanation rather than re-deriving a rationale', () => {
    const result = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['pricing'], per_type_limit: 60,
    }, { now: NOW });
    const found = result.records.find((r) => r.citation.record_id === decisionPricing);
    expect(found!.explainable).toEqual({ kind: 'decision', id: decisionPricing });
  });

  test('a citation token resolves back to its record', () => {
    const resolved = resolveCitation(BIZ_A, `decision#${decisionPricing}`);
    expect(resolved?.citation.record_id).toBe(decisionPricing);
  });

  test('a citation token from another business does not resolve', () => {
    expect(resolveCitation(BIZ_B, `decision#${decisionPricing}`)).toBeNull();
  });
});

// ─── Recall ──────────────────────────────────────────────────────────────────

describe('recall of known seeded events', () => {
  test('a plain-language question finds every record type in the seeded pricing story', async () => {
    const result = await search({
      query: 'what happened with the wholesale pricing change?',
      permittedBusinessIds: [BIZ_A],
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
    });

    expect(result.state).toBe('results');
    const ids = result.results.map((r) => r.citation.record_id);
    // The decision, the task and the receipt are all part of the same story
    // and all mention pricing — a search that found only one of them would
    // send an investigator down a single thread.
    expect(ids).toContain(decisionPricing);
    expect(ids).toContain(taskPricing);
    expect(ids).toContain(receiptPricing);
  });

  test('"which policy applied" reaches the policy event', async () => {
    const result = await search({
      query: 'which policy changed after the pricing incident?',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          ...CONFIDENT, record_types: ['policy_event'], terms: ['pricing'],
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.results.map((r) => r.citation.record_id)).toContain(policyEventTightened);
  });

  test('an outcome question reaches the measured outcome row', async () => {
    const result = await search({
      query: 'was the pricing change measured?',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, record_types: ['outcome'], terms: ['margin'] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.results.map((r) => r.citation.record_id)).toContain(outcomePricing);
  });

  test('a connector failure question reaches the failed sync', async () => {
    const result = await search({
      query: 'did any connector fail?',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, record_types: ['connector_event'], statuses: ['failed'], terms: [] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.results.map((r) => r.citation.record_id)).toContain(syncFailure);
  });

  test('a record-type filter genuinely narrows rather than merely re-ranking', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, record_types: ['decision'] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.citation.record_type === 'decision')).toBe(true);
  });

  test('a time-range filter excludes records outside the window', async () => {
    const result = await search({
      query: 'decisions in the last 30 days',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          ...CONFIDENT, record_types: ['decision'], terms: [],
          from: new Date(NOW - 30 * 86_400_000).toISOString(),
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    const ids = result.results.map((r) => r.citation.record_id);
    expect(ids).toContain(decisionPricing);
    // Seven months old — genuinely outside the window, and excluded.
    expect(ids).not.toContain(ancientDecision);
  });

  test('multiple keywords narrow (AND), they do not widen (OR)', () => {
    const both = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['pricing', 'warehouse'], per_type_limit: 60,
    }, { now: NOW });
    // No single decision mentions both, so an AND search finds nothing —
    // an OR search would have returned two and looked like a better result.
    expect(both.records).toHaveLength(0);
  });

  test('matched terms are reported per result so relevance is checkable', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
    });
    for (const r of result.results) expect(r.matched_terms).toContain('pricing');
  });
});

// ─── Authorization ───────────────────────────────────────────────────────────

describe('authorization scoping', () => {
  test('a search of business A returns nothing belonging to business B', async () => {
    const result = await search({
      query: 'wholesale pricing',
      permittedBusinessIds: [BIZ_A],
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.business_id === BIZ_A)).toBe(true);
  });

  test('an interpreter that asks for another business is refused, and says so', async () => {
    const result = await search({
      query: 'wholesale pricing across all my businesses',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, business_ids: [BIZ_A, BIZ_B] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.applied_filters.business_ids).toEqual([BIZ_A]);
    expect(result.results.every((r) => r.business_id === BIZ_A)).toBe(true);
    expect(result.interpretation.rejected.some((r) => r.field === 'business_id' && r.value === BIZ_B)).toBe(true);
    // The refusal is surfaced, not silently swallowed.
    expect(result.notices.some((n) => n.includes(BIZ_B))).toBe(true);
  });

  test('a hand-set business override cannot widen access either', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      overrides: { business_ids: [BIZ_B] },
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
    });
    expect(result.applied_filters.business_ids).toEqual([BIZ_A]);
    expect(result.results.every((r) => r.business_id === BIZ_A)).toBe(true);
  });

  test('with no permitted business, nothing is searched and that is stated', async () => {
    const result = await search({ query: 'pricing', permittedBusinessIds: [] });
    expect(result.results).toHaveLength(0);
    expect(result.notices.some((n) => /do not have access/i.test(n))).toBe(true);
  });
});

// ─── Redaction ───────────────────────────────────────────────────────────────

describe('redaction of sensitive fields in results', () => {
  test('a credential in a searched row never reaches the result', async () => {
    const result = await search({
      query: 'credential rotation',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, terms: ['credential'] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });

    const found = result.results.find((r) => r.citation.record_id === leakyTask);
    expect(found).toBeDefined();

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('ThisIsAFakeTokenForTestFixtureOnly');
    expect(serialised).not.toContain('TESTFIXTURE-not-a-real-key');
    expect(found!.snippet).toContain('[redacted]');
  });

  test('the records handed to the summariser are the redacted ones', async () => {
    const result = retrieve({
      business_id: BIZ_A, record_types: ['task'], statuses: [],
      from: null, to: null, terms: ['credential'], per_type_limit: 60,
    }, { now: NOW });
    const record = result.records.find((r) => r.citation.record_id === leakyTask)!;

    let promptSeen = '';
    await summariseGrounded('what happened', [record], {
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: (async (_p: string, _m: string, o: { messages: Array<{ content: string }> }) => {
        promptSeen = o.messages.map((m) => m.content).join('\n');
        return { content: 'nothing', usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0 };
      }) as never,
    });

    // The credential was redacted before the prompt was built, so it is
    // never sent to a third-party provider in the first place.
    expect(promptSeen).not.toContain('ThisIsAFakeTokenForTestFixtureOnly');
    expect(promptSeen.length).toBeGreaterThan(0);
  });
});

// ─── Explicit states ─────────────────────────────────────────────────────────

describe('no-result state', () => {
  test('a search that matches nothing says so explicitly, and is not an error', async () => {
    const result = await search({
      query: 'unicorn procurement programme',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, terms: ['unicornprocurement'] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.state).toBe('no_results');
    expect(result.results).toHaveLength(0);
    expect(result.total_matched).toBe(0);
    // The applied filters come back so the user can widen them.
    expect(result.applied_filters.terms).toContain('unicornprocurement');
    expect(result.notices.some((n) => /widen/i.test(n))).toBe(true);
    // And an absence of records is not asserted to be an absence of events.
    expect(result.limitations.some((l) => /not evidence that the event did not occur/i.test(l))).toBe(true);
  });
});

describe('stale-data state', () => {
  test('results whose newest record is old are flagged stale, not presented as current', async () => {
    const result = await search({
      query: 'warehouse contract',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({ ...CONFIDENT, record_types: ['decision'], terms: ['warehouse'] }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });

    expect(result.results.map((r) => r.citation.record_id)).toContain(ancientDecision);
    expect(result.state).toBe('results_stale');
    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.newest_age_hours!).toBeGreaterThan(STALE_AFTER_HOURS);
    expect(result.limitations.some((l) => /history, not as the current state/i.test(l))).toBe(true);
  });

  test('old results are NOT flagged stale when the user asked about a past period', async () => {
    const result = await search({
      query: 'what happened in January?',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          ...CONFIDENT, record_types: ['decision'], terms: ['warehouse'],
          from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z',
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.freshness.historical_query).toBe(true);
    expect(result.freshness.stale).toBe(false);
    expect(result.state).toBe('results');
  });

  test('a connector that has not synced is reported as a limit on the answer', async () => {
    const staleConnector = insertConnector({
      business_id: BIZ_A, name: 'Dormant Feed', last_sync: ANCIENT,
    });
    try {
      const result = await search({
        query: 'pricing',
        permittedBusinessIds: [BIZ_A],
        interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      });
      expect(result.freshness.stale_connectors.some((c) => c.id === staleConnector)).toBe(true);
      expect(result.limitations.some((l) => /never have been recorded/i.test(l))).toBe(true);
    } finally {
      db.prepare('DELETE FROM connectors WHERE id = ?').run(staleConnector);
    }
  });
});

describe('ambiguous-query state', () => {
  test('an interpreter that reports ambiguity stops the search and asks', async () => {
    const result = await search({
      query: 'what about that thing',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          record_types: [], statuses: [], business_ids: [], from: null, to: null, terms: [],
          confidence: 0.8, ambiguous: true,
          ambiguity_reason: 'Could refer to the pricing decision or the warehouse contract.',
          clarifying_questions: ['Do you mean the pricing change or the warehouse contract?'],
          candidate_readings: ['the pricing decision', 'the warehouse contract'],
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });

    expect(result.state).toBe('ambiguous_query');
    expect(result.results).toHaveLength(0);
    expect(result.interpretation.clarification!.questions.length).toBeGreaterThan(0);
    expect(result.interpretation.clarification!.candidate_readings).toContain('the pricing decision');
  });

  test('low interpreter confidence is treated as ambiguity, not as a filter', async () => {
    const result = await search({
      query: 'the thing from before',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          ...CONFIDENT, terms: ['pricing'], confidence: 0.15, ambiguous: false,
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.state).toBe('ambiguous_query');
    expect(result.results).toHaveLength(0);
  });

  test('an interpretation with no constraint at all is ambiguous, not a whole-history dump', async () => {
    const result = await search({
      query: 'everything',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: interpreterReturning({
          record_types: [], statuses: [], business_ids: [], from: null, to: null, terms: [],
          confidence: 0.95, ambiguous: false,
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.state).toBe('ambiguous_query');
  });

  test('a hand-set filter resolves the ambiguity and the search proceeds', async () => {
    const result = await search({
      query: 'what about that thing',
      permittedBusinessIds: [BIZ_A],
      overrides: { record_types: ['decision'], terms: ['pricing'] },
      interpret: {
        runLLMImpl: interpreterReturning({
          record_types: [], statuses: [], business_ids: [], from: null, to: null, terms: [],
          confidence: 0.2, ambiguous: true, ambiguity_reason: 'Too vague.',
          clarifying_questions: ['Which record type?'],
        }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.state).toBe('results');
    expect(result.results.map((r) => r.citation.record_id)).toContain(decisionPricing);
  });

  test('an empty query is ambiguous without spending a provider call', async () => {
    let called = false;
    const result = await search({
      query: '   ',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: (async () => { called = true; return { content: '{}', usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }; }) as never,
        resolveLLMImpl: resolveOk as never,
      },
    });
    expect(result.state).toBe('ambiguous_query');
    expect(called).toBe(false);
  });
});

describe('interpreter unavailability degrades honestly rather than silently', () => {
  test('a provider failure falls back to literal matching and says so', async () => {
    const result = await search({
      query: 'pricing decisions last week',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: (async () => { throw new Error('provider exploded'); }) as never,
        resolveLLMImpl: resolveOk as never,
        sleepImpl: async () => {},
      },
    });

    expect(result.interpretation.state).toBe('interpreter_unavailable');
    expect(result.interpretation.method).toBe('deterministic_fallback');
    expect(result.notices.some((n) => /matched literally/i.test(n))).toBe(true);
    expect(result.limitations.some((l) => /did not use language understanding/i.test(l))).toBe(true);
    // The search still worked — degrading is not the same as failing.
    expect(result.results.map((r) => r.citation.record_id)).toContain(decisionPricing);
  });

  test('no configured provider is a fallback, not an error', async () => {
    const result = await search({
      query: 'pricing decisions',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        resolveLLMImpl: (() => { throw new Error('No LLM provider is configured.'); }) as never,
      },
    });
    expect(result.interpretation.state).toBe('interpreter_unavailable');
    expect(result.results.length).toBeGreaterThan(0);
  });

  test('a provider error message is sanitised before it reaches the payload', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      interpret: {
        runLLMImpl: (async () => {
          throw new Error('401 from provider with Authorization: Bearer ThisIsAFakeTokenForTestFixtureOnly');
        }) as never,
        resolveLLMImpl: resolveOk as never,
        sleepImpl: async () => {},
      },
    });
    expect(JSON.stringify(result)).not.toContain('ThisIsAFakeTokenForTestFixtureOnly');
  });
});

// ─── Summaries: the fabrication guarantee end-to-end ─────────────────────────

describe('generated summaries never assert anything unsupported', () => {
  test('a well-grounded narrative is accepted and labelled as inferred', async () => {
    const records = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['pricing'], per_type_limit: 60,
    }, { now: NOW }).records;

    const token = `decision#${decisionPricing}`;
    const summary = await summariseGrounded('what happened with pricing?', records, {
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: summariserReturning(`The wholesale pricing increase was rejected [${token}].`) as never,
    });

    expect(summary.kind).toBe('grounded_narrative');
    expect(summary.inferred).toBe(true);
    expect(summary.citations).toContain(token);
    expect(summary.disclaimer).toMatch(/INFERRED/);
  });

  test('every cited id in an accepted summary corresponds to a retrieved record', async () => {
    const result = await search({
      query: 'what happened with pricing?',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: summariserReturning(
          `The pricing increase was rejected [decision#${decisionPricing}]. A rollback issue was acknowledged [receipt#${receiptPricing}].`,
        ) as never,
      },
    });

    expect(result.summary.kind).toBe('grounded_narrative');
    const retrievedRefs = new Set(result.results.map((r) => r.citation.ref));
    for (const cited of result.summary.citations) {
      expect(retrievedRefs.has(cited)).toBe(true);
      // And the cited record is genuinely in the database, in its own table.
      const [type, id] = cited.split('#');
      expect(type).toBeTruthy();
      expect(resolveCitation(BIZ_A, cited)?.citation.record_id).toBe(id!);
    }
  });

  test('a summary citing a record that was never retrieved is discarded in full', async () => {
    const result = await search({
      query: 'what happened with pricing?',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: summariserReturning(
          `The pricing increase was rejected [decision#${decisionPricing}]. It was later reversed [decision#dec_does_not_exist].`,
        ) as never,
      },
    });

    expect(result.summary.kind).toBe('withheld');
    expect(result.summary.inferred).toBe(false);
    expect(result.summary.citations).toEqual([]);
    // The invented claim is nowhere in the payload — not even quoted back.
    expect(result.summary.text).not.toContain('later reversed');
    expect(result.notices.some((n) => /discarded/i.test(n))).toBe(true);
    // The records themselves are unaffected by the bad summary.
    expect(result.results.length).toBeGreaterThan(0);
  });

  test('a confident uncited causal claim is discarded in full', async () => {
    const result = await search({
      query: 'why was the pricing change rejected?',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: summariserReturning(
          `The pricing increase was rejected [decision#${decisionPricing}]. `
          + 'The rejection was driven by a competitor undercutting the wholesale market.',
        ) as never,
      },
    });

    expect(result.summary.kind).toBe('withheld');
    expect(result.summary.text).not.toContain('competitor');
    expect(result.summary.grounding!.violations.some((v) => v.kind === 'uncited_sentence')).toBe(true);
  });

  test('an invented figure is discarded in full', async () => {
    const result = await search({
      query: 'how much did pricing move?',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: summariserReturning(
          `Margins fell 37 percent before the rejection [decision#${decisionPricing}].`,
        ) as never,
      },
    });
    expect(result.summary.kind).toBe('withheld');
    expect(result.summary.text).not.toContain('37');
  });

  test('a withheld summary still gives the user the honest deterministic counts', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: summariserReturning('Everything went fine.') as never,
      },
    });
    expect(result.summary.kind).toBe('withheld');
    expect(result.summary.text).toMatch(/record.* matched/);
  });

  test('no summary is generated by default — the records are the answer', async () => {
    let summariserCalled = false;
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: (async () => { summariserCalled = true; return { content: 'x', usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }; }) as never,
      },
    });
    expect(summariserCalled).toBe(false);
    expect(result.summary.kind).toBe('deterministic');
    expect(result.summary.inferred).toBe(false);
  });

  test('a summariser provider failure falls back to counts, never to prose', async () => {
    const result = await search({
      query: 'pricing',
      permittedBusinessIds: [BIZ_A],
      summarise: true,
      interpret: { runLLMImpl: interpreterReturning(CONFIDENT) as never, resolveLLMImpl: resolveOk as never },
      summariseOptions: {
        resolveLLMImpl: resolveOk as never,
        runLLMImpl: (async () => { throw new Error('provider down'); }) as never,
      },
    });
    expect(result.summary.kind).toBe('deterministic');
    expect(result.summary.inferred).toBe(false);
  });

  test('the deterministic summary states only what it counted', () => {
    const records = retrieve({
      business_id: BIZ_A, record_types: ['decision'], statuses: [],
      from: null, to: null, terms: ['pricing'], per_type_limit: 60,
    }, { now: NOW }).records;
    const summary = deterministicSummary(records);
    expect(summary.inferred).toBe(false);
    expect(summary.text).toContain(`${records.length} record`);
  });
});

// ─── Deterministic interpretation ────────────────────────────────────────────

describe('deterministic interpretation (no model involved)', () => {
  test('explicit relative time expressions produce a window', () => {
    const parsed = parseTimeExpression('what happened in the last 7 days', NOW);
    expect(parsed.from).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    expect(parsed.matched).toBe('last 7 days');
  });

  test('a vague time phrase produces NO window rather than an invented one', () => {
    expect(parseTimeExpression('what happened recently', NOW).from).toBeNull();
    expect(parseTimeExpression('a while back', NOW).from).toBeNull();
  });

  test('an explicit date range is honoured', () => {
    const parsed = parseTimeExpression('between 2026-01-01 and 2026-01-31', NOW);
    expect(parsed.from).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.to).toBe('2026-01-31T23:59:59.000Z');
  });

  test('stopwords are dropped and quoted phrases are kept literally', () => {
    const terms = extractTerms('why did we reject the "wholesale pricing increase"?');
    expect(terms).toContain('wholesale pricing increase');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('why');
  });

  test('record-type words map to types, and only real statuses are matched', () => {
    const vocab = statusVocabulary(BIZ_A);
    const filters = deterministicInterpretation('show me rejected decisions', [BIZ_A], vocab, NOW);
    expect(filters.record_types).toContain('decision');
    // 'rejected' is a real task status in this business, so it is applied.
    expect(vocab.task).toContain('rejected');
    expect(filters.statuses).toContain('rejected');
  });

  test('a status word that no row actually has is NOT applied as a filter', () => {
    const vocab = statusVocabulary(BIZ_A);
    const filters = deterministicInterpretation('show me incinerated decisions', [BIZ_A], vocab, NOW);
    expect(filters.statuses).not.toContain('incinerated');
  });
});

// ─── Interpreter validation ──────────────────────────────────────────────────

describe('nothing the interpreter proposes is trusted', () => {
  test('an invented record type is rejected with a reason, not coerced', async () => {
    const interpretation = await interpretQuery('anything', [BIZ_A], {
      now: NOW,
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: interpreterReturning({
        ...CONFIDENT, record_types: ['decision', 'telepathy_log'],
      }) as never,
    });
    expect(interpretation.filters.record_types).toEqual(['decision']);
    expect(interpretation.rejected.some((r) => r.field === 'record_type' && r.value === 'telepathy_log')).toBe(true);
  });

  test('a status no row has is rejected rather than silently matching nothing', async () => {
    const interpretation = await interpretQuery('anything', [BIZ_A], {
      now: NOW,
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: interpreterReturning({ ...CONFIDENT, statuses: ['vaporised'] }) as never,
    });
    expect(interpretation.filters.statuses).toEqual([]);
    expect(interpretation.rejected.some((r) => r.field === 'status' && r.value === 'vaporised')).toBe(true);
  });

  test('an unusable date is rejected rather than becoming a wrong window', async () => {
    const interpretation = await interpretQuery('anything', [BIZ_A], {
      now: NOW,
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: interpreterReturning({ ...CONFIDENT, from: 'sometime in the spring' }) as never,
    });
    expect(interpretation.filters.from).toBeNull();
    expect(interpretation.rejected.some((r) => r.field === 'from')).toBe(true);
  });

  test('unparseable model output is not retried into a guess', async () => {
    let calls = 0;
    const interpretation = await interpretQuery('anything', [BIZ_A], {
      now: NOW,
      resolveLLMImpl: resolveOk as never,
      runLLMImpl: (async () => { calls++; return { content: 'I think you mean the pricing thing.', usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0 }; }) as never,
      sleepImpl: async () => {},
    });
    expect(calls).toBe(1);
    expect(interpretation.state).toBe('interpreter_unavailable');
    expect(interpretation.method).toBe('deterministic_fallback');
  });

  test('a retryable provider failure is retried, within bounds', async () => {
    let calls = 0;
    await interpretQuery('pricing', [BIZ_A], {
      now: NOW,
      resolveLLMImpl: resolveOk as never,
      // ProviderHttpError is the codebase's canonical retryable provider
      // failure — classifyProviderError() reads its `retryable` flag.
      runLLMImpl: (async () => { calls++; throw new ProviderHttpError('test', 429, true); }) as never,
      sleepImpl: async () => {},
    });
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(3);
  });
});

// ─── Vocabulary ──────────────────────────────────────────────────────────────

describe('search vocabulary', () => {
  test('offers only statuses that actually occur in this business', () => {
    const vocab = searchVocabulary(BIZ_A);
    const decisionEntry = vocab.record_types.find((t) => t.type === 'decision')!;
    expect(decisionEntry.statuses).toContain('task_rejection');
    expect(decisionEntry.meaning.length).toBeGreaterThan(0);
  });

  test('a business with no history offers no statuses rather than a plausible default list', () => {
    const vocab = searchVocabulary('biz_that_does_not_exist');
    expect(vocab.record_types.every((t) => t.statuses.length === 0)).toBe(true);
  });
});
