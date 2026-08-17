/**
 * Simulation snapshots, expiry and re-authorisation (issue #67).
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * "A separately authorized execution step is required after preview and
 * cannot reuse stale approval silently."
 *
 * The failure mode that criterion is written against is subtle and common:
 * an operator previews an action, agrees with what it showed, and clicks
 * Execute — but between the two, the task was re-tiered, the operating
 * policy changed, a connector went down, or someone else already approved
 * it. The execution then proceeds on a picture that is no longer true, and
 * nothing in the system notices, because the approval was granted against
 * a preview nobody re-checked.
 *
 * So a preview here is not a value the client holds and hands back — the
 * client cannot be the authority on what it was shown. It is a durable row
 * carrying a SNAPSHOT: a fingerprint of every input the preview was
 * computed from. Authorising execution recomputes those fingerprints from
 * the live database and compares. If anything moved, authorisation fails
 * with a per-source drift report naming what changed, and the operator has
 * to preview again. It never silently proceeds.
 *
 * Three independent protections, because they fail in different ways:
 *
 *   - SNAPSHOT DRIFT catches "the world changed". This is the real one.
 *   - EXPIRY (expires_at) catches "the preview is simply too old to trust",
 *     including drift in inputs nobody thought to fingerprint.
 *   - SINGLE USE (consumed_at) stops one authorisation being replayed into
 *     two executions.
 *
 * ── Why snapshot sources are declarative ──────────────────────────────────
 *
 * Re-validation happens LATER, in a different request, on a code path
 * (approveTask) that must not depend on which preview evaluator produced
 * the row. So a snapshot source is a small declarative spec — "the task
 * with this id", "this business's active operating policy" — and this
 * module knows how to resolve every variety. Recomputation therefore needs
 * nothing but the stored row, and there is no evaluator registry to keep
 * populated and no import cycle between the preview code and the execution
 * path it protects.
 *
 * This module writes only to `simulation_previews` plus an audit row, and
 * imports nothing that can create, approve, execute or dispatch anything.
 */
import crypto from 'crypto';
import db, { generateId, audit } from '../db/db.js';

/** Default life of a preview. Long enough to read, short enough to distrust. */
export const DEFAULT_PREVIEW_TTL_SECONDS = 15 * 60;

/**
 * A declarative reference to one input a preview depended on. Every variant
 * is resolvable by resolveSnapshotSource() below from the stored row alone.
 */
export type SnapshotSourceSpec =
  /** One task row — its version, status and payload. */
  | { type: 'task'; id: string }
  /** The active operating policy for a scope (inheritance is version-visible). */
  | { type: 'operating_policy'; scope: 'business' | 'portfolio'; key: string }
  /** Every connector of a business: status and last successful sync. */
  | { type: 'connectors'; business_id: string }
  /** A business profile row. */
  | { type: 'business_profile'; business_id: string }
  /** One registered action type's definition. */
  | { type: 'action_registry'; action_type: string }
  /** A workflow/playbook and its active version. */
  | { type: 'playbook'; workflow_id: string }
  /** The set of tasks currently awaiting a decision for a business. */
  | { type: 'open_tasks'; business_id: string }
  /** Installed agents for a business. */
  | { type: 'agents'; business_id: string }
  /** The instance-wide hiring policy (settings row). */
  | { type: 'hiring_policy' }
  /** Caller-supplied literal inputs, fingerprinted by value. */
  | { type: 'inputs'; label: string; value: unknown };

/** A resolved snapshot source: what it was, when, and how fresh. */
export interface SnapshotSource {
  key: string;
  label: string;
  spec: SnapshotSourceSpec;
  fingerprint: string;
  /** Timestamp the underlying data was last known to change, when knowable. */
  as_of: string | null;
  age_seconds: number | null;
  /** True when the source exists but its data is older than its own freshness expectation. */
  stale: boolean;
  /** Plain-language note: what this is and what its freshness means. */
  note: string;
}

export interface SimulationSnapshot {
  hash: string;
  captured_at: string;
  sources: SnapshotSource[];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 1000));
}

/** Connector data older than this is called out as a freshness risk. */
const CONNECTOR_STALE_AFTER_SECONDS = 24 * 60 * 60;

/**
 * Resolve one source against the CURRENT database. Called both when a
 * preview is created and again when execution is authorised — the identical
 * code path both times, which is what makes the comparison meaningful.
 */
export function resolveSnapshotSource(spec: SnapshotSourceSpec): SnapshotSource {
  switch (spec.type) {
    case 'task': {
      const row = db.prepare(
        'SELECT id, version, status, title, description, trust_tier, approval_mode, action_type, action_payload, applicability_status, approved_by, updated_at FROM tasks WHERE id = ?',
      ).get(spec.id) as Record<string, unknown> | null;
      return {
        key: `task:${spec.id}`,
        label: `Task ${spec.id}`,
        spec,
        fingerprint: sha256(row ? JSON.stringify(row) : 'absent'),
        as_of: (row?.updated_at as string) ?? null,
        age_seconds: ageSeconds((row?.updated_at as string) ?? null),
        stale: false,
        note: row
          ? `The task as it stood at preview time (version ${String(row.version)}, status '${String(row.status)}'). Any edit, re-tiering or approval changes this fingerprint.`
          : 'No such task — it may have been deleted since.',
      };
    }

    case 'operating_policy': {
      const row = db.prepare(
        "SELECT id, version, activated_at, created_at FROM operating_policies WHERE scope = ? AND scope_key = ? AND state = 'active'",
      ).get(spec.scope, spec.key) as Record<string, unknown> | null;
      const policyAt = ((row?.activated_at ?? row?.created_at) as string | undefined) ?? null;
      return {
        key: `operating_policy:${spec.scope}:${spec.key}`,
        label: `Operating policy (${spec.scope} ${spec.key})`,
        spec,
        fingerprint: sha256(row ? JSON.stringify(row) : 'system_default_v0'),
        as_of: policyAt,
        age_seconds: ageSeconds(policyAt),
        stale: false,
        note: row
          ? `Active policy version ${String(row.version)}. Activating a new version invalidates this preview, because the rules it reasoned under would no longer be the rules in force.`
          : 'No policy authored — system defaults were in force.',
      };
    }

    case 'connectors': {
      const rows = db.prepare(
        'SELECT id, type, status, last_sync FROM connectors WHERE business_id = ? ORDER BY id',
      ).all(spec.business_id) as Array<{ id: string; type: string; status: string; last_sync: string | null }>;
      const syncs = rows.map((r) => r.last_sync).filter((s): s is string => !!s).sort();
      const newest = syncs.length ? syncs[syncs.length - 1]! : null;
      const age = ageSeconds(newest);
      const connected = rows.filter((r) => r.status === 'connected').length;
      return {
        key: `connectors:${spec.business_id}`,
        label: `Connectors for ${spec.business_id}`,
        spec,
        fingerprint: sha256(JSON.stringify(rows)),
        as_of: newest,
        age_seconds: age,
        stale: rows.length > 0 && (age === null || age > CONNECTOR_STALE_AFTER_SECONDS),
        note: rows.length === 0
          ? 'This business has no connectors, so nothing in this preview is based on live external data.'
          : newest === null
            ? `${rows.length} connector(s), ${connected} connected, but none has ever completed a sync — anything derived from connector data is unverified.`
            : `${rows.length} connector(s), ${connected} connected. Most recent successful sync ${newest}; the preview reasons about data as of then, not as of now.`,
      };
    }

    case 'business_profile': {
      const row = db.prepare(
        'SELECT business_id, business_type, updated_at FROM business_profiles WHERE business_id = ?',
      ).get(spec.business_id) as Record<string, unknown> | null;
      return {
        key: `business_profile:${spec.business_id}`,
        label: `Business profile for ${spec.business_id}`,
        spec,
        fingerprint: sha256(row ? JSON.stringify(row) : 'absent'),
        as_of: (row?.updated_at as string) ?? null,
        age_seconds: ageSeconds((row?.updated_at as string) ?? null),
        stale: false,
        note: row
          ? `Business type '${String(row.business_type ?? 'unset')}' — action applicability is judged against it.`
          : 'No business profile — applicability checks fall back to defaults.',
      };
    }

    case 'action_registry': {
      const row = db.prepare(
        'SELECT action_type, risk_level, requires_approval, dispatched_by_executor, active, payload_schema, updated_at FROM action_registry WHERE action_type = ?',
      ).get(spec.action_type) as Record<string, unknown> | null;
      return {
        key: `action_registry:${spec.action_type}`,
        label: `Action definition '${spec.action_type}'`,
        spec,
        fingerprint: sha256(row ? JSON.stringify(row) : 'unregistered'),
        as_of: (row?.updated_at as string) ?? null,
        age_seconds: ageSeconds((row?.updated_at as string) ?? null),
        stale: false,
        note: row
          ? `Registry entry for '${spec.action_type}' — its risk level and approval requirement shaped this preview.`
          : `'${spec.action_type}' is not registered, which is itself a blocking finding.`,
      };
    }

    case 'playbook': {
      const wf = db.prepare('SELECT id, status, updated_at FROM workflows WHERE id = ?')
        .get(spec.workflow_id) as Record<string, unknown> | null;
      const version = db.prepare(
        'SELECT id, version, state FROM playbook_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1',
      ).get(spec.workflow_id) as Record<string, unknown> | null;
      return {
        key: `playbook:${spec.workflow_id}`,
        label: `Playbook ${spec.workflow_id}`,
        spec,
        fingerprint: sha256(JSON.stringify({ wf, version })),
        as_of: (wf?.updated_at as string) ?? null,
        age_seconds: ageSeconds((wf?.updated_at as string) ?? null),
        stale: false,
        note: version
          ? `Playbook definition at version ${String(version.version)} (${String(version.state)}). Editing or activating a version invalidates this preview.`
          : 'Previewed from a supplied definition rather than a stored version.',
      };
    }

    case 'open_tasks': {
      const rows = db.prepare(
        "SELECT id, version, trust_tier FROM tasks WHERE business_id = ? AND status IN ('proposed', 'manual_review') ORDER BY id",
      ).all(spec.business_id) as Array<Record<string, unknown>>;
      return {
        key: `open_tasks:${spec.business_id}`,
        label: `Open decisions for ${spec.business_id}`,
        spec,
        fingerprint: sha256(JSON.stringify(rows)),
        as_of: null,
        age_seconds: null,
        stale: false,
        note: `${rows.length} task(s) currently awaiting a decision. A policy preview's impact counts are computed against exactly this set.`,
      };
    }

    case 'agents': {
      // Agents themselves are instance-wide; which ones serve a business is
      // recorded in agent_installations (see hiring/store.ts).
      const rows = db.prepare(
        'SELECT agent_id, status FROM agent_installations WHERE business_id = ? ORDER BY agent_id',
      ).all(spec.business_id) as Array<Record<string, unknown>>;
      return {
        key: `agents:${spec.business_id}`,
        label: `Installed agents for ${spec.business_id}`,
        spec,
        fingerprint: sha256(JSON.stringify(rows)),
        as_of: null,
        age_seconds: null,
        stale: false,
        note: `${rows.filter((r) => r.status === 'installed').length} agent(s) currently installed for this business. Hiring decisions are judged against which roles are already filled.`,
      };
    }

    case 'hiring_policy': {
      const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'hiring_policy'")
        .get() as Record<string, unknown> | null;
      return {
        key: 'hiring_policy',
        label: 'Autonomous hiring policy',
        spec,
        fingerprint: sha256(row ? JSON.stringify(row.value) : 'defaults'),
        as_of: (row?.updated_at as string) ?? null,
        age_seconds: ageSeconds((row?.updated_at as string) ?? null),
        stale: false,
        note: row
          ? 'The stored hiring control-plane settings, including the master switch and dry-run flag.'
          : 'No stored hiring policy — built-in defaults are in force.',
      };
    }

    case 'inputs': {
      return {
        key: `inputs:${spec.label}`,
        label: spec.label,
        spec,
        fingerprint: sha256(JSON.stringify(spec.value ?? null)),
        as_of: null,
        age_seconds: null,
        stale: false,
        note: 'Values supplied with the preview request. Executing with different values is a different question, and will not match this preview.',
      };
    }

    default: {
      // Exhaustiveness: an unhandled spec must fail loudly rather than
      // silently fingerprint to a constant, which would make drift undetectable.
      const unknown = spec as { type?: string };
      throw new Error(`Unknown snapshot source type '${String(unknown.type)}'.`);
    }
  }
}

export function captureSnapshot(specs: SnapshotSourceSpec[]): SimulationSnapshot {
  const sources = specs.map(resolveSnapshotSource);
  return {
    hash: snapshotHash(sources),
    captured_at: new Date().toISOString(),
    sources,
  };
}

/** Order-independent: sources are sorted by key so ordering cannot cause false drift. */
export function snapshotHash(sources: SnapshotSource[]): string {
  const parts = sources
    .map((s) => `${s.key}=${s.fingerprint}`)
    .sort();
  return sha256(parts.join('\n'));
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export interface StoredPreview {
  id: string;
  business_id: string | null;
  kind: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  snapshot_hash: string;
  snapshot_sources: SnapshotSource[];
  result: unknown;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
}

function parsePreviewRow(row: Record<string, unknown> | null): StoredPreview | null {
  if (!row) return null;
  const parse = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== 'string') return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  };
  return {
    id: String(row.id),
    business_id: (row.business_id as string) ?? null,
    kind: String(row.kind),
    actor: String(row.actor),
    target_type: (row.target_type as string) ?? null,
    target_id: (row.target_id as string) ?? null,
    snapshot_hash: String(row.snapshot_hash),
    snapshot_sources: parse<SnapshotSource[]>(row.snapshot_sources, []),
    result: parse<unknown>(row.result, {}),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    consumed_at: (row.consumed_at as string) ?? null,
    consumed_by: (row.consumed_by as string) ?? null,
  };
}

export function savePreview(input: {
  businessId: string | null;
  kind: string;
  actor: string;
  targetType?: string | null;
  targetId?: string | null;
  snapshot: SimulationSnapshot;
  result: unknown;
  ttlSeconds?: number;
}): StoredPreview {
  const id = `simprev_${generateId()}`;
  const ttl = Math.max(30, input.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  db.prepare(`
    INSERT INTO simulation_previews
      (id, business_id, kind, actor, target_type, target_id, snapshot_hash, snapshot_sources, result, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.businessId ?? null,
    input.kind,
    input.actor,
    input.targetType ?? null,
    input.targetId ?? null,
    input.snapshot.hash,
    JSON.stringify(input.snapshot.sources),
    JSON.stringify(input.result ?? {}),
    new Date().toISOString(),
    expiresAt,
  );

  return getPreview(id)!;
}

export function getPreview(id: string): StoredPreview | null {
  return parsePreviewRow(
    db.prepare('SELECT * FROM simulation_previews WHERE id = ?').get(id) as Record<string, unknown> | null,
  );
}

export function listPreviews(businessId: string, limit = 50): StoredPreview[] {
  const rows = db.prepare(
    'SELECT * FROM simulation_previews WHERE business_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(businessId, Math.min(200, Math.max(1, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => parsePreviewRow(r)!);
}

// ─── Re-validation ───────────────────────────────────────────────────────────

export type AuthorizationFailure =
  | 'unknown_preview'
  | 'expired'
  | 'already_consumed'
  | 'snapshot_drift'
  | 'wrong_target';

export interface SnapshotDrift {
  key: string;
  label: string;
  /** What changed, in language an operator can act on. */
  change: string;
  previous_fingerprint: string;
  current_fingerprint: string;
}

export interface AuthorizationResult {
  ok: boolean;
  reason: AuthorizationFailure | null;
  message: string | null;
  drift: SnapshotDrift[];
  preview: StoredPreview | null;
}

/**
 * Compare a stored preview's snapshot against the world as it is now.
 * Read-only — callers decide what to do about the answer.
 */
export function checkPreviewCurrency(preview: StoredPreview): { drift: SnapshotDrift[]; expired: boolean } {
  const expired = new Date(preview.expires_at).getTime() <= Date.now();
  const drift: SnapshotDrift[] = [];

  for (const previous of preview.snapshot_sources) {
    let current: SnapshotSource;
    try {
      current = resolveSnapshotSource(previous.spec);
    } catch {
      // An unresolvable source is treated as drift: the honest answer to
      // "is this still true?" when we cannot tell is "do not assume so".
      drift.push({
        key: previous.key,
        label: previous.label,
        change: 'This input could no longer be read, so the preview cannot be confirmed as current.',
        previous_fingerprint: previous.fingerprint,
        current_fingerprint: 'unresolvable',
      });
      continue;
    }
    if (current.fingerprint !== previous.fingerprint) {
      drift.push({
        key: previous.key,
        label: previous.label,
        change: `${previous.label} has changed since this preview was generated. ${current.note}`,
        previous_fingerprint: previous.fingerprint,
        current_fingerprint: current.fingerprint,
      });
    }
  }

  return { drift, expired };
}

/**
 * The separately-authorised execution step.
 *
 * Succeeds only when the preview exists, has not expired, has not already
 * been used, and every input it depended on is byte-for-byte what it was.
 * On success the preview is marked consumed in the same statement that
 * checks it is unconsumed, so two concurrent executions cannot both
 * believe they hold the authorisation.
 *
 * Failure is always explicit and always names the cause — that is the
 * whole point of the criterion this implements.
 */
export function authorizeFromPreview(input: {
  previewId: string;
  actor: string;
  expectedKind?: string;
  expectedTargetId?: string | null;
}): AuthorizationResult {
  const preview = getPreview(input.previewId);
  if (!preview) {
    return {
      ok: false,
      reason: 'unknown_preview',
      message: `No preview '${input.previewId}' exists. Execution requires a preview generated by this server; run one and review it first.`,
      drift: [],
      preview: null,
    };
  }

  if (input.expectedKind && preview.kind !== input.expectedKind) {
    return {
      ok: false,
      reason: 'wrong_target',
      message: `Preview '${preview.id}' is a '${preview.kind}' preview and cannot authorise a '${input.expectedKind}' execution.`,
      drift: [],
      preview,
    };
  }
  if (input.expectedTargetId && preview.target_id && preview.target_id !== input.expectedTargetId) {
    return {
      ok: false,
      reason: 'wrong_target',
      message: `Preview '${preview.id}' was generated for '${preview.target_id}', not '${input.expectedTargetId}'. An approval cannot be moved between targets.`,
      drift: [],
      preview,
    };
  }

  if (preview.consumed_at) {
    return {
      ok: false,
      reason: 'already_consumed',
      message: `Preview '${preview.id}' was already used to authorise execution at ${preview.consumed_at} by ${preview.consumed_by ?? 'unknown'}. An authorisation is single-use; preview again.`,
      drift: [],
      preview,
    };
  }

  const { drift, expired } = checkPreviewCurrency(preview);

  if (expired) {
    return {
      ok: false,
      reason: 'expired',
      message: `Preview '${preview.id}' expired at ${preview.expires_at}. It is no longer a trustworthy description of what would happen; preview again.`,
      drift,
      preview,
    };
  }

  if (drift.length > 0) {
    audit(
      preview.business_id, 'simulation_preview', preview.id, 'simulation.authorization_refused_stale',
      input.actor, null, null,
      { kind: preview.kind, target_id: preview.target_id, drift: drift.map((d) => d.key) },
    );
    return {
      ok: false,
      reason: 'snapshot_drift',
      message:
        `The data behind preview '${preview.id}' changed after it was generated, so it no longer describes what would happen: ` +
        `${drift.map((d) => d.change).join(' ')} Re-run the preview and review the new result before executing.`,
      drift,
      preview,
    };
  }

  // Single-use claim. The status check is inside the UPDATE's WHERE clause,
  // so a lost race is reported rather than double-authorised.
  const claimed = db.prepare(
    'UPDATE simulation_previews SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL',
  ).run(new Date().toISOString(), input.actor, preview.id);

  if (!claimed.changes) {
    return {
      ok: false,
      reason: 'already_consumed',
      message: `Preview '${preview.id}' was consumed concurrently by another request. Preview again.`,
      drift: [],
      preview: getPreview(preview.id),
    };
  }

  audit(
    preview.business_id, 'simulation_preview', preview.id, 'simulation.authorized',
    input.actor, null, null,
    { kind: preview.kind, target_type: preview.target_type, target_id: preview.target_id, snapshot_hash: preview.snapshot_hash },
  );

  return { ok: true, reason: null, message: null, drift: [], preview: getPreview(preview.id) };
}

/** Housekeeping: drop previews long past their expiry. */
export function purgeExpiredPreviews(olderThanSeconds = 7 * 24 * 60 * 60): number {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
  return db.prepare('DELETE FROM simulation_previews WHERE expires_at < ?').run(cutoff).changes;
}
