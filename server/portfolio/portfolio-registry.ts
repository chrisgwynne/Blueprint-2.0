/**
 * Portfolio registry (issue #71) — named, reusable groupings of businesses
 * for comparison, with real membership management and a membership history.
 *
 * ─── Why this exists when #59 and #68 both already say "portfolio" ──────────
 *
 * Two things called "portfolio" already exist in this codebase, and neither
 * is this one:
 *
 *   #68  operating_policy_portfolios — a POLICY grouping. It must partition
 *        businesses: upsertPolicyPortfolio() rejects a business that is
 *        already in another portfolio, because policy inheritance has no
 *        defined answer to "which of my two portfolios' thresholds wins".
 *
 *   #59  command-centre selection — not a stored concept at all. An explicit
 *        list of business ids, with #68's portfolios accepted as a shorthand
 *        and expanded on the way in. Nothing is saved, named or managed.
 *
 * A reporting portfolio needs exactly what #68 forbids: OVERLAP. The same
 * shop belongs in "UK", in "Ecommerce" and in "Q3 turnaround" at the same
 * time, and an operator comparing those three groupings is doing the normal
 * thing, not an edge case. Widening #68's table to allow overlap would break
 * policy inheritance for every business in two portfolios; narrowing this
 * view to a partition would make it answer only one question per business.
 * So this is a separate table with a separate rule, and #68's table stays
 * the only one `resolveOperatingPolicy()` ever consults.
 *
 * Membership can still be SEEDED from a policy portfolio
 * (importPolicyPortfolio) — the two concepts are related, they are just not
 * the same set.
 *
 * ─── Why membership is rows, not a JSON array ───────────────────────────────
 *
 * #68 stores members as a JSON column, which is right for it: a policy
 * portfolio's membership is a current fact and nothing reads its past. Here
 * the past is load-bearing. A comparison over a 90-day window, for a
 * portfolio that gained a business on day 80, is not a like-for-like
 * comparison — that business contributes 10 days against everyone else's
 * 90. The view is required to say so rather than present it as one number,
 * which it can only do if membership changes are recorded.
 * `portfolio_membership_events` is append-only for that reason: a removal
 * writes a row, it never deletes one.
 *
 * ─── Authorization ──────────────────────────────────────────────────────────
 *
 * Every read and write funnels through listAccessibleBusinessIds() from
 * #59's command centre — the single scoping function that module established
 * so a future real ACL has exactly one place to land. Two rules follow:
 *
 *   WRITE  a business the actor cannot access can never be added. There is
 *          no path by which naming an id in a portfolio grants sight of it.
 *   READ   members the actor cannot access are removed from the returned
 *          business_ids AND counted in `hidden_member_count`. Silently
 *          shrinking the list would make a partial portfolio look complete —
 *          the same failure mode the aggregates guard against.
 */
import db, { generateId } from '../db/db.js';
import { listAccessibleBusinessIds } from '../executive/command-centre.js';
import { getPolicyPortfolio } from '../policy/operating-policy.js';

export class PortfolioError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'PortfolioError';
    this.status = status;
    this.code = code;
  }
}

/** A portfolio is a view, not a workspace; more than this is not one screen. */
export const MAX_PORTFOLIO_MEMBERS = 25;

export interface Portfolio {
  id: string;
  name: string;
  description: string | null;
  /** Members the requesting actor may read, in stable name order. */
  business_ids: string[];
  /**
   * Members the actor may NOT read. Reported so a portfolio can never look
   * smaller than it is; the ids themselves are deliberately withheld.
   */
  hidden_member_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type MembershipAction = 'added' | 'removed';

export interface MembershipEvent {
  id: string;
  portfolio_id: string;
  business_id: string;
  /** Null when the business is outside the actor's scope. */
  business_name: string | null;
  action: MembershipAction;
  actor: string;
  reason: string | null;
  occurred_at: string;
}

interface PortfolioRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The authorization seam for everything portfolio-shaped.
 *
 * Defaults to #59's listAccessibleBusinessIds(), which is the single
 * function that module established for "which businesses may this actor
 * read". It is injectable for one reason: this is the seam a real
 * per-user ACL lands on, and making it explicit means the ACL can be
 * introduced — and exercised — without every caller here changing.
 *
 * Nothing in production replaces it today. Tests drive it to simulate an
 * actor who cannot see a business, which is the only way to test the
 * boundary before the ACL exists.
 */
export type BusinessScopeResolver = (actor: string) => string[];

let resolveScope: BusinessScopeResolver = listAccessibleBusinessIds;

/** Install a scope resolver, or pass null to restore the default. */
export function setBusinessScopeResolver(resolver: BusinessScopeResolver | null): void {
  resolveScope = resolver ?? listAccessibleBusinessIds;
}

/**
 * An additional, caller-supplied narrowing of the actor's scope.
 *
 * Added for #80, which exposes these reads over BAP. A BAP agent's
 * `business_access` grant is narrower than the ambient resolver (which today
 * still returns every business), and the route cannot express that by
 * choosing an actor string.
 *
 * It is applied as an INTERSECTION, never a replacement: the result is
 * always a subset of what resolveScope() already allowed, so passing a scope
 * can only ever remove businesses, never add one. A caller naming a business
 * the ambient scope withholds still does not get it. Omitting it leaves
 * every existing caller's behaviour exactly as it was.
 */
export interface ScopeNarrowing {
  scope?: readonly string[];
}

/** The businesses this actor may read. The only scoping call in this subsystem. */
export function accessibleBusinessIds(actor: string, scope?: readonly string[]): string[] {
  const ambient = resolveScope(actor);
  if (!scope) return ambient;
  const narrow = new Set(scope);
  return ambient.filter((id) => narrow.has(id));
}

function accessibleSet(actor: string, scope?: readonly string[]): Set<string> {
  return new Set(accessibleBusinessIds(actor, scope));
}

/** Raw membership, unfiltered. Never returned to a caller as-is. */
function rawMemberIds(portfolioId: string): string[] {
  return (db.prepare(
    'SELECT business_id FROM portfolio_members WHERE portfolio_id = ?'
  ).all(portfolioId) as Array<{ business_id: string }>).map((r) => r.business_id);
}

function businessNames(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT id, name FROM businesses WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ id: string; name: string }>;
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/**
 * Project a portfolio row through the actor's scope.
 *
 * Ordering is by business name so a comparison's column order is stable
 * across reloads — a table whose columns move between refreshes is one an
 * operator cannot read differences off.
 */
function projectPortfolio(row: PortfolioRow, actor: string, scope?: readonly string[]): Portfolio {
  const members = rawMemberIds(row.id);
  const accessible = accessibleSet(actor, scope);
  const visible = members.filter((id) => accessible.has(id));
  const names = businessNames(visible);
  visible.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    business_ids: visible,
    hidden_member_count: members.length - visible.length,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fetchRow(id: string): PortfolioRow | null {
  return (db.prepare('SELECT * FROM portfolios WHERE id = ?').get(id) as PortfolioRow | null) ?? null;
}

/**
 * Validate a set of ids as portfolio members for this actor.
 *
 * "Not a real business" and "not yours" produce the SAME message on purpose.
 * Distinguishing them would confirm an id exists, which is the cross-tenant
 * leak #59 and #61 both close by giving one answer to both questions.
 */
function assertAddable(ids: string[], actor: string): string[] {
  const cleaned = Array.from(new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean)));
  if (cleaned.length === 0) {
    throw new PortfolioError(
      'A portfolio must contain at least one business — an empty portfolio compares nothing.',
      400, 'empty_portfolio',
    );
  }
  const accessible = accessibleSet(actor);
  const rejected = cleaned.filter((id) => !accessible.has(id));
  if (rejected.length > 0) {
    throw new PortfolioError(
      `Not available in the current scope: ${rejected.join(', ')}. `
      + 'A portfolio cannot include a business you cannot read — membership never grants access.',
      403, 'business_not_accessible',
    );
  }
  return cleaned;
}

function recordEvent(
  portfolioId: string, businessId: string, action: MembershipAction,
  actor: string, reason: string | null, at: string,
): void {
  db.prepare(`
    INSERT INTO portfolio_membership_events (id, portfolio_id, business_id, action, actor, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(generateId(), portfolioId, businessId, action, actor, reason, at);
}

function touch(portfolioId: string, at: string): void {
  db.prepare('UPDATE portfolios SET updated_at = ? WHERE id = ?').run(at, portfolioId);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listPortfolios(actor: string, opts: ScopeNarrowing = {}): Portfolio[] {
  return (db.prepare('SELECT * FROM portfolios ORDER BY name').all() as PortfolioRow[])
    .map((r) => projectPortfolio(r, actor, opts.scope));
}

/**
 * One portfolio, scoped to the actor.
 *
 * A portfolio whose members are ALL outside the actor's scope still returns
 * (with an empty business_ids and a non-zero hidden_member_count) rather
 * than 404: the portfolio's existence is not the secret, its contents are,
 * and a 404 here would make "empty" and "not yours" indistinguishable to a
 * legitimate operator debugging their own view.
 */
export function getPortfolio(id: string, actor: string, opts: ScopeNarrowing = {}): Portfolio | null {
  const row = fetchRow(id);
  return row ? projectPortfolio(row, actor, opts.scope) : null;
}

export function requirePortfolio(id: string, actor: string, opts: ScopeNarrowing = {}): Portfolio {
  const p = getPortfolio(id, actor, opts);
  if (!p) throw new PortfolioError(`Portfolio '${id}' not found.`, 404, 'portfolio_not_found');
  return p;
}

/**
 * Membership history, newest first.
 *
 * Events about businesses the actor cannot read are omitted entirely — the
 * history is as scoped as the membership it describes.
 */
export function listMembershipHistory(
  portfolioId: string, actor: string, opts: ScopeNarrowing & { limit?: number } = {},
): MembershipEvent[] {
  if (!fetchRow(portfolioId)) {
    throw new PortfolioError(`Portfolio '${portfolioId}' not found.`, 404, 'portfolio_not_found');
  }
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const accessible = accessibleSet(actor, opts.scope);
  const rows = db.prepare(`
    SELECT * FROM portfolio_membership_events
     WHERE portfolio_id = ?
     ORDER BY datetime(occurred_at) DESC, rowid DESC
     LIMIT ?
  `).all(portfolioId, limit) as Array<Record<string, unknown>>;

  const visible = rows.filter((r) => accessible.has(String(r.business_id)));
  const names = businessNames(visible.map((r) => String(r.business_id)));
  return visible.map((r) => ({
    id: String(r.id),
    portfolio_id: String(r.portfolio_id),
    business_id: String(r.business_id),
    business_name: names.get(String(r.business_id)) ?? null,
    action: String(r.action) as MembershipAction,
    actor: String(r.actor),
    reason: r.reason == null ? null : String(r.reason),
    occurred_at: String(r.occurred_at),
  }));
}

/**
 * Membership changes inside a window, for the comparison's honesty banner.
 *
 * This is the whole reason history is kept. A portfolio that gained or lost
 * a business partway through the comparison window is not comparing equal
 * spans, and the view says so instead of averaging over the discrepancy.
 */
export function membershipChangesInWindow(
  portfolioId: string, windowStart: string, windowEnd: string, actor: string,
  opts: ScopeNarrowing = {},
): MembershipEvent[] {
  const accessible = accessibleSet(actor, opts.scope);
  const rows = db.prepare(`
    SELECT * FROM portfolio_membership_events
     WHERE portfolio_id = ?
       AND datetime(occurred_at) >= datetime(?)
       AND datetime(occurred_at) <= datetime(?)
     ORDER BY datetime(occurred_at) DESC
  `).all(portfolioId, windowStart, windowEnd) as Array<Record<string, unknown>>;

  const visible = rows.filter((r) => accessible.has(String(r.business_id)));
  const names = businessNames(visible.map((r) => String(r.business_id)));
  return visible.map((r) => ({
    id: String(r.id),
    portfolio_id: String(r.portfolio_id),
    business_id: String(r.business_id),
    business_name: names.get(String(r.business_id)) ?? null,
    action: String(r.action) as MembershipAction,
    actor: String(r.actor),
    reason: r.reason == null ? null : String(r.reason),
    occurred_at: String(r.occurred_at),
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export function createPortfolio(input: {
  name: string;
  description?: string | null;
  business_ids: string[];
  actor: string;
}): Portfolio {
  const name = String(input.name ?? '').trim();
  if (!name) throw new PortfolioError('Portfolio name is required.', 400, 'name_required');

  const ids = assertAddable(input.business_ids ?? [], input.actor);
  if (ids.length > MAX_PORTFOLIO_MEMBERS) {
    throw new PortfolioError(
      `A portfolio is capped at ${MAX_PORTFOLIO_MEMBERS} businesses; ${ids.length} were given. `
      + 'A side-by-side comparison wider than that is not one anybody reads.',
      422, 'too_many_members',
    );
  }

  const id = generateId();
  const at = nowIso();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO portfolios (id, name, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, input.description ?? null, input.actor, at, at);
    for (const businessId of ids) {
      db.prepare(`
        INSERT INTO portfolio_members (portfolio_id, business_id, added_by, added_at)
        VALUES (?, ?, ?, ?)
      `).run(id, businessId, input.actor, at);
      recordEvent(id, businessId, 'added', input.actor, 'Portfolio created.', at);
    }
  });
  tx();
  return getPortfolio(id, input.actor)!;
}

/** Rename / re-describe. Membership is changed through the member calls only. */
export function updatePortfolio(
  id: string, patch: { name?: string; description?: string | null }, actor: string,
): Portfolio {
  const row = fetchRow(id);
  if (!row) throw new PortfolioError(`Portfolio '${id}' not found.`, 404, 'portfolio_not_found');

  const name = patch.name === undefined ? row.name : String(patch.name).trim();
  if (!name) throw new PortfolioError('Portfolio name cannot be empty.', 400, 'name_required');
  const description = patch.description === undefined ? row.description : patch.description;

  db.prepare('UPDATE portfolios SET name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(name, description ?? null, nowIso(), id);
  return getPortfolio(id, actor)!;
}

export interface MembershipChangeResult {
  portfolio: Portfolio;
  /** Ids that actually changed state. Already-members / already-absent are no-ops. */
  changed: string[];
  /** Ids that were already in the requested state, reported rather than silently ignored. */
  unchanged: string[];
}

export function addPortfolioMembers(
  id: string, businessIds: string[], actor: string, reason?: string | null,
): MembershipChangeResult {
  if (!fetchRow(id)) throw new PortfolioError(`Portfolio '${id}' not found.`, 404, 'portfolio_not_found');
  const ids = assertAddable(businessIds ?? [], actor);

  const existing = new Set(rawMemberIds(id));
  const toAdd = ids.filter((b) => !existing.has(b));
  const unchanged = ids.filter((b) => existing.has(b));

  if (existing.size + toAdd.length > MAX_PORTFOLIO_MEMBERS) {
    throw new PortfolioError(
      `A portfolio is capped at ${MAX_PORTFOLIO_MEMBERS} businesses; this would make ${existing.size + toAdd.length}.`,
      422, 'too_many_members',
    );
  }

  const at = nowIso();
  const tx = db.transaction(() => {
    for (const businessId of toAdd) {
      db.prepare(`
        INSERT INTO portfolio_members (portfolio_id, business_id, added_by, added_at)
        VALUES (?, ?, ?, ?)
      `).run(id, businessId, actor, at);
      recordEvent(id, businessId, 'added', actor, reason ?? null, at);
    }
    if (toAdd.length > 0) touch(id, at);
  });
  tx();

  return { portfolio: getPortfolio(id, actor)!, changed: toAdd, unchanged };
}

/**
 * Remove members. The membership row goes; the history row stays.
 *
 * An actor may only remove businesses they can read — otherwise removal
 * would be an oracle for whether a hidden id is a member.
 */
export function removePortfolioMembers(
  id: string, businessIds: string[], actor: string, reason?: string | null,
): MembershipChangeResult {
  if (!fetchRow(id)) throw new PortfolioError(`Portfolio '${id}' not found.`, 404, 'portfolio_not_found');

  const cleaned = Array.from(new Set((businessIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)));
  if (cleaned.length === 0) {
    throw new PortfolioError('No businesses given to remove.', 400, 'empty_request');
  }
  const accessible = accessibleSet(actor);
  const rejected = cleaned.filter((b) => !accessible.has(b));
  if (rejected.length > 0) {
    throw new PortfolioError(
      `Not available in the current scope: ${rejected.join(', ')}.`,
      403, 'business_not_accessible',
    );
  }

  const existing = new Set(rawMemberIds(id));
  const toRemove = cleaned.filter((b) => existing.has(b));
  const unchanged = cleaned.filter((b) => !existing.has(b));

  const at = nowIso();
  const tx = db.transaction(() => {
    for (const businessId of toRemove) {
      db.prepare('DELETE FROM portfolio_members WHERE portfolio_id = ? AND business_id = ?')
        .run(id, businessId);
      recordEvent(id, businessId, 'removed', actor, reason ?? null, at);
    }
    if (toRemove.length > 0) touch(id, at);
  });
  tx();

  return { portfolio: getPortfolio(id, actor)!, changed: toRemove, unchanged };
}

/**
 * Delete a portfolio and its membership.
 *
 * The membership EVENTS are kept. A comparison that was run and acted on
 * last quarter should still be explicable afterwards, and deleting the
 * grouping does not un-happen the decisions taken from it.
 */
export function deletePortfolio(id: string, actor: string): void {
  if (!fetchRow(id)) throw new PortfolioError(`Portfolio '${id}' not found.`, 404, 'portfolio_not_found');
  const at = nowIso();
  const members = rawMemberIds(id);
  const tx = db.transaction(() => {
    for (const businessId of members) {
      recordEvent(id, businessId, 'removed', actor, 'Portfolio deleted.', at);
    }
    db.prepare('DELETE FROM portfolio_members WHERE portfolio_id = ?').run(id);
    db.prepare('DELETE FROM portfolios WHERE id = ?').run(id);
  });
  tx();
}

/**
 * Seed a reporting portfolio from one of #68's policy portfolios.
 *
 * A convenience, not a link: the new portfolio is an independent copy from
 * that moment on. Keeping them in sync would re-impose #68's no-overlap rule
 * on a concept that exists precisely to allow overlap.
 *
 * Members outside the actor's scope are dropped rather than refused — the
 * policy portfolio is not the actor's to curate, and refusing would make an
 * unrelated admin's grouping unusable to them.
 */
export function importPolicyPortfolio(policyPortfolioId: string, actor: string, name?: string): Portfolio {
  const source = getPolicyPortfolio(policyPortfolioId);
  if (!source) {
    throw new PortfolioError(
      `Policy portfolio '${policyPortfolioId}' not found.`, 404, 'policy_portfolio_not_found',
    );
  }
  const accessible = accessibleSet(actor);
  const ids = source.business_ids.filter((b) => accessible.has(b));
  if (ids.length === 0) {
    throw new PortfolioError(
      `No business in policy portfolio '${source.name}' is available in the current scope.`,
      403, 'business_not_accessible',
    );
  }
  return createPortfolio({
    name: name?.trim() || source.name,
    description: `Imported from operating-policy portfolio '${source.name}' (${source.id}).`,
    business_ids: ids,
    actor,
  });
}
