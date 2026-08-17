/**
 * Portfolio registry (#71) — server/portfolio/portfolio-registry.ts.
 *
 * The properties under test are the ones that separate this from #68's
 * policy portfolios and from #59's ad-hoc selection:
 *
 *   - membership OVERLAPS (the thing #68 must forbid and this must allow)
 *   - membership CHANGES are recorded, and survive removal and deletion
 *   - a business outside the actor's scope can never be added, is stripped
 *     from every read, and is COUNTED rather than silently dropped
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../db/db.js';
import {
  addPortfolioMembers, createPortfolio, deletePortfolio, getPortfolio,
  listMembershipHistory, listPortfolios, membershipChangesInWindow,
  PortfolioError, removePortfolioMembers, requirePortfolio, updatePortfolio,
  importPolicyPortfolio, setBusinessScopeResolver, MAX_PORTFOLIO_MEMBERS,
} from './portfolio-registry.js';
import { upsertPolicyPortfolio } from '../policy/operating-policy.js';

const BIZ_A = 'biz_pf_reg_a';
const BIZ_B = 'biz_pf_reg_b';
const BIZ_SECRET = 'biz_pf_reg_secret';
const ALL = [BIZ_A, BIZ_B, BIZ_SECRET];

/**
 * The scope the registry sees. Blueprint's session model is single-tenant
 * today, so the default resolver returns every business; the per-user ACL it
 * stands in for is simulated here through setBusinessScopeResolver(), the
 * seam that ACL will actually land on. Driving the real seam rather than
 * mocking a shared module also keeps this file from leaking into anyone
 * else's suite — bun's module mocks are process-global.
 */
let accessible: string[] = [...ALL];

const ACTOR = 'dashboard:owner';
const created: string[] = [];

function track<T extends { id: string }>(p: T): T {
  created.push(p.id);
  return p;
}

beforeAll(() => {
  setBusinessScopeResolver((_actor: string) => [...accessible]);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'PF Reg A', 'pf-reg-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'PF Reg B', 'pf-reg-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'PF Reg Secret', 'pf-reg-secret') ON CONFLICT(id) DO NOTHING").run(BIZ_SECRET);
});

afterAll(() => {
  setBusinessScopeResolver(null);
  for (const id of created) {
    db.prepare('DELETE FROM portfolio_members WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolio_membership_events WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
  }
  accessible = [...ALL];
});

describe('creation', () => {
  test('creates a named portfolio with members and a creation history', () => {
    const p = track(createPortfolio({
      name: 'Reg Create', description: 'two businesses', business_ids: [BIZ_A, BIZ_B], actor: ACTOR,
    }));
    expect(p.name).toBe('Reg Create');
    expect(p.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());
    expect(p.hidden_member_count).toBe(0);

    const history = listMembershipHistory(p.id, ACTOR);
    expect(history.length).toBe(2);
    expect(history.every((e) => e.action === 'added')).toBe(true);
    expect(history.every((e) => e.actor === ACTOR)).toBe(true);
  });

  test('rejects an empty portfolio — it would compare nothing', () => {
    expect(() => createPortfolio({ name: 'Empty', business_ids: [], actor: ACTOR }))
      .toThrow(/at least one business/i);
  });

  test('rejects a portfolio with no name', () => {
    expect(() => createPortfolio({ name: '  ', business_ids: [BIZ_A], actor: ACTOR }))
      .toThrow(/name is required/i);
  });

  test('de-duplicates repeated ids rather than double-counting a business', () => {
    const p = track(createPortfolio({
      name: 'Reg Dupes', business_ids: [BIZ_A, BIZ_A, BIZ_B], actor: ACTOR,
    }));
    expect(p.business_ids.length).toBe(2);
  });

  test('caps membership at a readable width', () => {
    const many = Array.from({ length: MAX_PORTFOLIO_MEMBERS + 1 }, (_, i) => `biz_overflow_${i}`);
    accessible = many;
    try {
      expect(() => createPortfolio({ name: 'Too wide', business_ids: many, actor: ACTOR }))
        .toThrow(/capped at/i);
    } finally {
      accessible = [...ALL];
    }
  });
});

describe('overlap — the difference from #68 policy portfolios', () => {
  test('the same business may belong to several reporting portfolios at once', () => {
    const uk = track(createPortfolio({ name: 'Reg UK', business_ids: [BIZ_A, BIZ_B], actor: ACTOR }));
    const ecom = track(createPortfolio({ name: 'Reg Ecommerce', business_ids: [BIZ_A], actor: ACTOR }));

    expect(uk.business_ids).toContain(BIZ_A);
    expect(ecom.business_ids).toContain(BIZ_A);

    // Both remain intact on re-read — neither creation displaced the other.
    expect(requirePortfolio(uk.id, ACTOR).business_ids).toContain(BIZ_A);
    expect(requirePortfolio(ecom.id, ACTOR).business_ids).toContain(BIZ_A);
  });

  test('#68 policy portfolios still forbid the overlap this one allows', () => {
    // Guards the reason the two tables are separate: widening #68 to match
    // this behaviour would break policy inheritance.
    const first = upsertPolicyPortfolio({ name: 'PF Reg Policy One', business_ids: [BIZ_A], actor: ACTOR });
    try {
      expect(() => upsertPolicyPortfolio({ name: 'PF Reg Policy Two', business_ids: [BIZ_A], actor: ACTOR }))
        .toThrow(/already belongs to portfolio/i);
    } finally {
      db.prepare('DELETE FROM operating_policy_portfolios WHERE id = ?').run(first.id);
    }
  });

  test('a policy portfolio can seed a reporting portfolio without linking them', () => {
    const policy = upsertPolicyPortfolio({ name: 'PF Reg Seed', business_ids: [BIZ_A, BIZ_B], actor: ACTOR });
    try {
      const imported = track(importPolicyPortfolio(policy.id, ACTOR, 'Imported Copy'));
      expect(imported.name).toBe('Imported Copy');
      expect(imported.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

      // Independent from that moment: changing the copy does not touch the source.
      removePortfolioMembers(imported.id, [BIZ_B], ACTOR);
      expect(requirePortfolio(imported.id, ACTOR).business_ids).toEqual([BIZ_A]);
      // The source policy portfolio still has both — the copy is not a link.
      const source = db.prepare(
        'SELECT business_ids FROM operating_policy_portfolios WHERE id = ?'
      ).get(policy.id) as { business_ids: string } | null;
      expect(JSON.parse(source!.business_ids).sort()).toEqual([BIZ_A, BIZ_B].sort());
    } finally {
      db.prepare('DELETE FROM operating_policy_portfolios WHERE id = ?').run(policy.id);
    }
  });
});

describe('membership changes', () => {
  test('adding a business changes the view and records an event', () => {
    const p = track(createPortfolio({ name: 'Reg Add', business_ids: [BIZ_A], actor: ACTOR }));
    expect(p.business_ids).toEqual([BIZ_A]);

    const result = addPortfolioMembers(p.id, [BIZ_B], ACTOR, 'expanding coverage');
    expect(result.changed).toEqual([BIZ_B]);
    expect(result.portfolio.business_ids.sort()).toEqual([BIZ_A, BIZ_B].sort());

    const history = listMembershipHistory(p.id, ACTOR);
    const added = history.find((e) => e.business_id === BIZ_B && e.action === 'added');
    expect(added?.reason).toBe('expanding coverage');
    expect(added?.business_name).toBe('PF Reg B');
  });

  test('removing a business changes the view but keeps its history', () => {
    const p = track(createPortfolio({ name: 'Reg Remove', business_ids: [BIZ_A, BIZ_B], actor: ACTOR }));

    const result = removePortfolioMembers(p.id, [BIZ_B], ACTOR, 'sold');
    expect(result.changed).toEqual([BIZ_B]);
    expect(result.portfolio.business_ids).toEqual([BIZ_A]);

    const history = listMembershipHistory(p.id, ACTOR);
    // Both the join and the departure survive — the row is never deleted.
    expect(history.filter((e) => e.business_id === BIZ_B).map((e) => e.action).sort())
      .toEqual(['added', 'removed']);
    expect(history.find((e) => e.action === 'removed')?.reason).toBe('sold');
  });

  test('re-adding an existing member is a no-op, reported rather than duplicated', () => {
    const p = track(createPortfolio({ name: 'Reg Noop', business_ids: [BIZ_A], actor: ACTOR }));
    const result = addPortfolioMembers(p.id, [BIZ_A], ACTOR);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([BIZ_A]);
    expect(result.portfolio.business_ids).toEqual([BIZ_A]);
  });

  test('removing a non-member is a no-op, reported rather than an error', () => {
    const p = track(createPortfolio({ name: 'Reg Noop Remove', business_ids: [BIZ_A], actor: ACTOR }));
    const result = removePortfolioMembers(p.id, [BIZ_B], ACTOR);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([BIZ_B]);
  });

  test('history is newest-first and scoped to the window when asked', () => {
    const p = track(createPortfolio({ name: 'Reg Window', business_ids: [BIZ_A], actor: ACTOR }));
    addPortfolioMembers(p.id, [BIZ_B], ACTOR, 'mid-window join');

    const wide = membershipChangesInWindow(
      p.id, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 60_000).toISOString(), ACTOR,
    );
    expect(wide.length).toBe(2);

    // A window that closed before the portfolio existed contains nothing —
    // this is what stops a comparison claiming a membership change it did
    // not observe.
    const past = membershipChangesInWindow(
      p.id, new Date(Date.now() - 90 * 86_400_000).toISOString(),
      new Date(Date.now() - 80 * 86_400_000).toISOString(), ACTOR,
    );
    expect(past.length).toBe(0);
  });

  test('renaming leaves membership and history untouched', () => {
    const p = track(createPortfolio({ name: 'Reg Before', business_ids: [BIZ_A], actor: ACTOR }));
    const renamed = updatePortfolio(p.id, { name: 'Reg After', description: 'now described' }, ACTOR);
    expect(renamed.name).toBe('Reg After');
    expect(renamed.description).toBe('now described');
    expect(renamed.business_ids).toEqual([BIZ_A]);
    expect(listMembershipHistory(p.id, ACTOR).length).toBe(1);
  });

  test('deleting a portfolio retains its membership history', () => {
    const p = createPortfolio({ name: 'Reg Delete', business_ids: [BIZ_A, BIZ_B], actor: ACTOR });
    created.push(p.id);
    deletePortfolio(p.id, ACTOR);

    expect(getPortfolio(p.id, ACTOR)).toBeNull();
    // The decisions taken from last quarter's comparison stay explicable.
    const events = db.prepare(
      'SELECT action FROM portfolio_membership_events WHERE portfolio_id = ?'
    ).all(p.id) as Array<{ action: string }>;
    expect(events.filter((e) => e.action === 'added').length).toBe(2);
    expect(events.filter((e) => e.action === 'removed').length).toBe(2);
  });
});

describe('authorization', () => {
  test('a business outside the actor’s scope cannot be added', () => {
    accessible = [BIZ_A, BIZ_B];
    try {
      expect(() => createPortfolio({ name: 'Reg Forbidden', business_ids: [BIZ_A, BIZ_SECRET], actor: ACTOR }))
        .toThrow(/not available in the current scope/i);
    } finally {
      accessible = [...ALL];
    }
  });

  test('membership never grants sight of a business the actor cannot read', () => {
    // Created while everything is in scope...
    const p = track(createPortfolio({
      name: 'Reg Scoped', business_ids: [BIZ_A, BIZ_SECRET], actor: ACTOR,
    }));
    expect(p.business_ids.length).toBe(2);

    // ...then the actor loses access to one of them.
    accessible = [BIZ_A, BIZ_B];
    try {
      const scoped = requirePortfolio(p.id, ACTOR);
      expect(scoped.business_ids).toEqual([BIZ_A]);
      expect(scoped.business_ids).not.toContain(BIZ_SECRET);
      // Withheld, but never hidden: the count says the view is partial.
      expect(scoped.hidden_member_count).toBe(1);

      // The same scoping applies to history, so the id cannot leak there.
      const history = listMembershipHistory(p.id, ACTOR);
      expect(history.some((e) => e.business_id === BIZ_SECRET)).toBe(false);

      // And to listings.
      const listed = listPortfolios(ACTOR).find((x) => x.id === p.id);
      expect(listed?.business_ids).toEqual([BIZ_A]);
      expect(listed?.hidden_member_count).toBe(1);
    } finally {
      accessible = [...ALL];
    }
  });

  test('an out-of-scope business cannot be removed either — removal is not an oracle', () => {
    const p = track(createPortfolio({
      name: 'Reg Oracle', business_ids: [BIZ_A, BIZ_SECRET], actor: ACTOR,
    }));
    accessible = [BIZ_A, BIZ_B];
    try {
      expect(() => removePortfolioMembers(p.id, [BIZ_SECRET], ACTOR))
        .toThrow(/not available in the current scope/i);
    } finally {
      accessible = [...ALL];
    }
  });

  test('a missing portfolio is a 404-shaped PortfolioError', () => {
    let caught: unknown;
    try { requirePortfolio('portfolio_does_not_exist', ACTOR); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(PortfolioError);
    expect((caught as InstanceType<typeof PortfolioError>).status).toBe(404);
  });
});
