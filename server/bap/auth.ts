/**
 * Blueprint Agent Protocol — Authentication.
 *
 * API keys use the format `bap_{base64url(24 random bytes)}` (~36 chars).
 * Stored as bcrypt hash in DB; only the first 12 chars (prefix) are stored
 * in plaintext for efficient lookup without a full table scan.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import type { Request, Response, NextFunction } from 'express';
import { getBapContext } from './route-helpers.js';

// ─── Registration authorization ──────────────────────────────────────────────
//
// POST /register used to be fully open — anyone who could reach the HTTP
// port could self-register a BAP key with arbitrary requested permissions.
// It now requires ONE of:
//   (a) an authenticated dashboard session (the operator registering an
//       agent on their own behalf), or
//   (b) a shared `X-Registration-Secret` header matching the operator-
//       configured BAP_REGISTRATION_SECRET env var, for bootstrapping a
//       fully external agent (e.g. Hermes) that has no browser session.
// If BAP_REGISTRATION_SECRET is unset, only path (a) is available — this
// is the safe-by-default state with zero extra configuration.

export function isRegistrationAuthorized(req: Request): boolean {
  const sessionAuthed = Boolean((req.session as { userId?: unknown } | undefined)?.userId);
  if (sessionAuthed) return true;

  const configuredSecret = process.env.BAP_REGISTRATION_SECRET;
  if (!configuredSecret) return false;

  const provided = req.headers['x-registration-secret'];
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(configuredSecret);
  if (a.length !== b.length) return false; // avoid throwing in timingSafeEqual
  return crypto.timingSafeEqual(a, b);
}

export function requireRegistrationAuth(req: Request, res: Response, next: NextFunction): void {
  if (isRegistrationAuthorized(req)) return next();
  res.status(401).json({
    error:
      'Registration requires an authenticated dashboard session, or a valid X-Registration-Secret ' +
      'header matching the operator-configured BAP_REGISTRATION_SECRET. Self-service, unauthenticated ' +
      'registration is no longer permitted.',
  });
}

// ─── Grantable permissions ───────────────────────────────────────────────────
//
// Self-registration can never grant a wildcard permission (`*:*`,
// `resource:*`) or wildcard business access (`*`), regardless of what the
// caller requests or how they authenticated to /register. This is a hard
// floor, not a default — an operator who wants to grant broader access to
// a highly trusted agent already has full database/dashboard access to do
// so directly; the self-registration endpoint itself never grants it.
export const GRANTABLE_BAP_PERMISSIONS: readonly string[] = [
  'signals:read', 'signals:create',
  'tasks:read', 'tasks:propose', 'tasks:approve',
  'kb:read', 'kb:write',
  'metrics:read',
  'agents:read', 'agents:trigger',
  // Phase 2 — BAP completeness. tasks:approve already covers task cancel
  // and execution-job retry/cancel (Phase 1 precedent: those are the same
  // trust tier as approve/reject, not a separate grant); agents:trigger
  // already covers agent-run retry/cancel for the same reason.
  'goals:read', 'goals:propose', 'goals:update',
  'connectors:read', 'connectors:sync',
  'outcomes:read',
  'audit:read',
  // Phase 3 — strategic intelligence. goals:read/goals:update already
  // cover the new /goals/:id/assessment|assessments|strategies|timeline
  // and POST /goals/:id/plan sub-routes (see bap-goals.ts) — not
  // duplicated here.
  'opportunities:read', 'opportunities:trigger',
  'conflicts:read',
  'decisions:read',
  'graph:read', 'graph:trigger',
  'recommendations:read',
  'retrospectives:read', 'retrospectives:trigger',
  // Issue #84 — #73's typed operating-policy-change proposals a
  // retrospective produces. Distinct from retrospectives:read/:trigger
  // above, which only cover the narrative retrospective itself: an agent
  // can hold one grant without the other (e.g. read findings but not the
  // proposals pending review, or vice versa). Read-only, same as
  // operating_policies:read below — reviewing/activating a proposal is a
  // human act through the dashboard's #61 decision-queue flow, and no BAP
  // route accepts a review outcome for one.
  'retrospective_proposals:read',
  'calibration:read',
  // Phase 2-INT — Autonomous Intelligence Foundation. business_profile:read
  // covers GET on the profile; :update covers PATCH. action_registry:read
  // covers listing/getting entries; :write covers upsert (operator/BAP
  // editing of an action_type's metadata). connector_confidence:read and
  // world_model:read are read-only by design — both are derived state,
  // recomputed from connectors/goals/signals, never directly authored.
  // system_issues:read/:update cover listing and acknowledging/resolving.
  'business_profile:read', 'business_profile:update',
  'action_registry:read', 'action_registry:write',
  'connector_confidence:read',
  'world_model:read',
  'system_issues:read', 'system_issues:update',
  // Phase 4 - trust and autonomous-operation accountability. Mutating
  // business facts are split into proposal/update grants so Hermes can read
  // and propose safely without being handed broad factual write access.
  'capabilities:read', 'capabilities:propose', 'capabilities:update',
  'corrections:read', 'corrections:propose',
  'revenue_paths:read', 'revenue_paths:update',
  'scorecards:read',
  'approval_policies:read',
  'measurement_policies:read',
  // #68 — per-business operating policy. Read-only: an agent may see the
  // rules it is governed by, but authoring governance is an operator act,
  // so there is deliberately no operating_policies:write grant.
  'operating_policies:read',
  'provider_preflight:read',
  // Issue #70 — verified action receipts. Read-only: receipts are produced
  // by the approval/execution path itself and no BAP route writes one, so
  // there is deliberately no `receipts:write` counterpart to grant.
  'receipts:read',
  // Issue #77 — the #61 pending-decision queue. Deliberately NOT the
  // `decisions:read` grant above: that one is the decision-memory recall log
  // (bap-decisions.ts), this one is the queue of items still awaiting a
  // human (bap-decision-queue.ts). Same word, different data model, so an
  // agent that wants both must be granted both rather than getting the wrong
  // one silently. Read-only: approve/reject/defer/amend stays a human act on
  // the dashboard, so there is no `decision_queue:review` counterpart.
  'decision_queue:read',
  // Issue #78 — recommendation comparison (#66's engine) over BAP. Distinct
  // from `recommendations:read`, which serves the ranked auto-generated list
  // in bap-review.ts: this grant covers the deliberate side-by-side of
  // candidates the caller names. Read-only — there is no
  // `comparisons:decide`, because recording a comparison outcome writes to
  // `decisions`, and no BAP route writes decision memory (see
  // bap-comparisons.ts's docstring for the full reasoning).
  'comparisons:read',
  // Issue #79 — #59's cross-business executive summary over BAP. One of two
  // BAP grants not resolved against a `:businessId` in the path (see #80
  // below): the route spans businesses, so bap-command-centre.ts checks
  // every id the caller names against `business_access` itself and scopes
  // the engine to that grant. Deliberately separate from the four grants
  // covering the surfaces it summarises (decision_queue:read, receipts:read,
  // outcomes:read, connectors:read) — this is a bounded, ranked overview,
  // not the full records, so an operator can hand out the triage view
  // without handing out every receipt body. Read-only: #59 has no write
  // path, and approving from a summary card would skip the policy re-check
  // the decision queue performs at the moment of decision.
  'command_centre:read',
  // Issue #80 — #71's saved multi-business portfolios and their comparative
  // view. NOT #68's `operating_policy_portfolios`, which are a policy
  // grouping that must partition businesses and are read through
  // `operating_policies:read` as part of the resolved policy; these are
  // general-purpose reporting groupings with deliberately overlapping
  // membership (see bap-portfolios.ts's docstring). Read-only: curating
  // which businesses get compared together is an operator's editorial act,
  // so there is no `portfolios:write` counterpart. The paths carry no
  // :businessId — a portfolio spans businesses — so the route applies the
  // agent's `business_access` itself rather than relying on requirePermission
  // to resolve one from the path.
  'portfolios:read',
  // Issue #81 — the #62 "while you were away" catch-up digest. Read-only:
  // the only state change this grant permits is advancing the AGENT'S OWN
  // digest watermark, which is a genuinely separate storage dimension from
  // the dashboard operator's watermark (keyed on this agent's id, not a
  // session username — see server/digest/bap-digest-watermark.ts). It never
  // touches, and can never be touched by, a human operator's catch-up point.
  'digest:read',
  // Issue #82 — "why did Blueprint do this?" explanation panels (#60).
  // Read-only: an explanation is a rendering of records other modules
  // already authored (signals, decisions, receipts, outcomes), so there is
  // nothing here for a BAP agent to write — no `explanations:write` exists.
  'explanations:read',
  // Issue #83 — natural-language audit/history search (#72's grounded,
  // cited search over decisions, tasks, receipts, outcomes, policy events,
  // connector syncs, signals, agent runs and the audit log), distinct from
  // `audit:read`: `audit:read` lists raw audit_log rows by structured
  // filter; `audit_search:read` accepts a free-text question and returns
  // an answer built from records actually retrieved, with any narrative
  // summary verified against them before it is shown. An agent can be
  // granted one without the other.
  'audit_search:read',
  // Issue #86 — safe simulation/preview mode (#67's shared primitive).
  // Read-only in name AND in effect: POST .../simulate/task-approval runs
  // entirely inside #67's simulation-context.ts guard, which makes any real
  // DB write throw (assertSimulationSafeSql on every db.prepare() call) and
  // makes approveTask() itself refuse to run beneath it
  // (guardSimulationSideEffect at the top of task-queue.ts:approveTask) —
  // this was verified by reading that enforcement, not assumed from the
  // name. The only rows a simulation produces are the stored preview and
  // its own audit-log entry, never a change to the task, a job, a receipt
  // or anything else. Previewing an approval still requires `tasks:approve`
  // as well (see bap-simulation.ts) — this grant alone cannot be used to
  // probe an action the agent could not otherwise propose or approve.
  'simulations:read',
  // Issue #85 — #74's versioned, bounded playbooks. `:read` covers list,
  // detail, run history/detail AND the #67-style zero-side-effect simulate
  // preview (the same "an inert POST stays under :read" precedent
  // `comparisons:read` and `digest:read` already set — simulating creates
  // no task, run or receipt, so it is not a second capability to gate).
  // `:trigger` is its own, narrower grant: unlike simulate, triggering a
  // run creates real tasks that flow through the normal Typed Action
  // Registry + Operating Policy approval gate, same as any directly-
  // proposed task (see bap-playbooks.ts's docstring for the full
  // reasoning) — an operator may want an agent to read and preview
  // playbooks without being able to start one.
  'playbooks:read', 'playbooks:trigger',
];

export function filterGrantablePermissions(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  const allow = new Set(GRANTABLE_BAP_PERMISSIONS);
  return Array.from(new Set(requested.filter((p): p is string => typeof p === 'string' && allow.has(p))));
}

/**
 * Filter caller-supplied business IDs down to businesses that actually
 * exist. Silently drops '*' (wildcard business access is never granted by
 * self-registration) and unknown IDs. Returns [] (no access yet) rather
 * than erroring, so registration always succeeds — an operator can grant
 * access afterwards.
 */
export function filterValidBusinessIds(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  const ids = Array.from(new Set(requested.filter((b): b is string => typeof b === 'string' && b !== '*')));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM businesses WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>;
  const valid = new Set(rows.map((r) => r.id));
  return ids.filter((id) => valid.has(id));
}

// ─── Key generation ─────────────────────────────────────────────────────────

export function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `bap_${random}`;
}

export function keyPrefix(key: string): string {
  return String(key).slice(0, 12);
}

export async function hashApiKey(key: string): Promise<string> {
  return Bun.password.hash(key, { algorithm: 'bcrypt', cost: 12 });
}

export async function verifyApiKey(rawKey: string, hash: string): Promise<boolean> {
  return Bun.password.verify(rawKey, hash);
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Look up and validate an incoming BAP API key.
 * Returns the agent row or null.
 */
export async function validateApiKey(rawKey: string): Promise<Record<string, unknown> | null> {
  if (!rawKey || !rawKey.startsWith('bap_')) return null;

  const prefix = keyPrefix(rawKey);
  const agent = db.prepare(
    'SELECT * FROM bap_agents WHERE api_key_prefix = ? AND status = ?'
  ).get(prefix, 'active') as Record<string, unknown> | null;

  if (!agent) return null;

  const valid = await verifyApiKey(rawKey, agent.api_key_hash as string);
  if (!valid) return null;

  // Update last_seen + call counter (non-blocking)
  try {
    db.prepare(
      'UPDATE bap_agents SET last_seen = CURRENT_TIMESTAMP, total_calls = total_calls + 1 WHERE id = ?'
    ).run(agent.id as string);
  } catch {}

  return agent;
}

// ─── Permissions ────────────────────────────────────────────────────────────

/**
 * Check whether an agent has a specific permission, optionally scoped
 * to a business.
 *
 * @param agent - row from bap_agents
 * @param permission - e.g. "signals:read", "tasks:propose"
 * @param businessId
 */
export function hasPermission(
  agent: Record<string, unknown>,
  permission: string,
  businessId: string | null = null
): boolean {
  const perms = safeJSON<string[]>(agent.permissions, []);
  const access = safeJSON<string[]>(agent.business_access, []);

  // Business access check
  if (businessId) {
    if (!access.includes('*') && !access.includes(businessId)) return false;
  }

  // Permission check — supports wildcards
  const [resource] = permission.split(':');
  return (
    perms.includes(permission) ||
    perms.includes(`${resource}:*`) ||
    perms.includes('*:*')
  );
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express middleware — validates BAP-Key header, attaches req.bapAgent,
 * logs the call to bap_audit on response finish.
 */
export async function bapAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Admin UI routes are mounted alongside BAP on the same router but use
  // session auth (isAuthenticated), not BAP-Key. Skip BAP auth for them so
  // the Settings → External Agents page can load without a BAP key.
  if (req.path.startsWith('/agents-admin')) return next();

  const rawKey =
    (req.headers['bap-key'] as string | undefined) ||
    (req.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '');

  if (!rawKey) {
    res.status(401).json({ error: 'BAP-Key header required.' });
    return;
  }

  const agent = await validateApiKey(rawKey);
  if (!agent) {
    res.status(401).json({ error: 'Invalid or revoked API key.' });
    return;
  }

  (req as Request & { bapAgent: Record<string, unknown> }).bapAgent = agent;

  // Audit log on response finish
  const auditId = crypto.randomUUID();
  const start = Date.now();

  res.on('finish', () => {
    try {
      db.prepare(`
        INSERT INTO bap_audit (id, agent_id, method, endpoint, business_id,
                               status_code, duration_ms, request_id, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        auditId,
        agent.id as string,
        req.method,
        req.path,
        (req.params as Record<string, string>)?.businessId ?? null,
        res.statusCode,
        Date.now() - start,
        getBapContext(req)?.requestId ?? null,
        getBapContext(req)?.correlationId ?? null,
      );
    } catch {}
  });

  next();
}

/**
 * Middleware factory — checks a specific permission.
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bapReq = req as Request & { bapAgent: Record<string, unknown> };
    const businessId =
      (req.params as Record<string, string>)?.businessId ??
      (req.body as Record<string, string>)?.businessId ??
      null;
    if (!hasPermission(bapReq.bapAgent, permission, businessId)) {
      res.status(403).json({
        error: `Permission denied: ${permission}`,
        your_permissions: safeJSON(bapReq.bapAgent.permissions, []),
      });
      return;
    }
    next();
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeJSON<T = unknown[]>(val: unknown, fallback: T): T {
  if (Array.isArray(val)) return val as unknown as T;
  if (!val) return fallback;
  try { return JSON.parse(val as string) as T; } catch { return fallback; }
}
