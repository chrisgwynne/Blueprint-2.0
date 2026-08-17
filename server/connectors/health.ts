/**
 * Connector Health & Freshness Explainer (issue #65).
 *
 * A raw `connected`/`disconnected` flag — or even the finer freshness.ts
 * `live`/`stale`/`error`/`disconnected` status — is not enough for a human
 * to trust (or distrust) a downstream recommendation: a connector can be
 * "connected" and still be serving a partial catalogue scan, or "degraded"
 * for a reason that's a five-second permission fix rather than a broken
 * integration.
 *
 * This module is the single place that turns the three existing, already-
 * computed diagnostic layers —
 *   - server/connectors/freshness.ts  (live / stale / error / disconnected)
 *   - server/connectors/confidence.ts (9-dimension confidence scoring,
 *     including isConnectorApplicable() for "not relevant to this business")
 *   - the `${type}.coverage_complete` metric a connector's extractMetrics()
 *     may report when a sync only captured part of the data (see
 *     server/connectors/google-merchant/index.ts, issue #42)
 * — into one normalized health state plus human-readable explanation text,
 * so both the dashboard (system-health.ts, SystemHealth.tsx, Connectors.tsx)
 * and BAP agents (bap-connectors.ts) describe a connector's trustworthiness
 * identically. It never makes a live API call; it reads state already
 * computed/persisted by those modules.
 */
import db from '../db/db.js';
import type { Connector } from '../types/db.js';
import { computeFreshness } from './freshness.js';
import { computeConnectorConfidence, isConnectorApplicable, type ConfidenceStatus } from './confidence.js';

export type ConnectorHealthState =
  | 'healthy'
  | 'stale'
  | 'partial'
  | 'failing'
  | 'permission_required'
  | 'not_applicable';

export interface ConnectorHealthExplanation {
  state: ConnectorHealthState;
  /** Timestamp of the connector's last successful sync (connectors.last_sync
   *  is only ever advanced on a successful fetch — see routes/connectors.ts
   *  runConnectorSync — so this is genuinely "last known success", never a
   *  failed-attempt timestamp masquerading as one). */
  last_success: string | null;
  /** true/false when the connector type reports a `${type}.coverage_complete`
   *  metric on its most recent sync; null when the connector type doesn't
   *  report coverage at all (nothing to be dishonest about). */
  coverage_complete: boolean | null;
  /** One-line description of the state, safe to show without further context. */
  summary: string;
  /** Which features/signals depend on this connector and how they're
   *  affected — null only for the healthy state. */
  impact: string | null;
  /** A concrete, safe next action — null only for the healthy state. */
  next_step: string | null;
}

/**
 * authFromError() in confidence.ts assigns authorisation_status='degraded'
 * for exactly one signature: a stored last_error matching
 * forbidden|permission|scope|403 (as opposed to 401/unauthorized, which is
 * classified as a broken *authentication* status, not authorisation). That
 * makes authorisation_status==='degraded' an unambiguous, already-persisted
 * signal for "this needs a permission/scope fix", distinct from a generic
 * transient failure — nothing else sets it to 'degraded'.
 */
export function isPermissionIssue(authorisationStatus: ConfidenceStatus): boolean {
  return authorisationStatus === 'degraded';
}

/**
 * Reads the most recent `${type}.coverage_complete` metric a connector's
 * extractMetrics() wrote (see google-merchant/index.ts for the reference
 * implementation from issue #42). Returns null — not true — when the
 * connector type has never reported one, so "no coverage metric" is never
 * conflated with "coverage confirmed complete."
 */
export function getLatestCoverageComplete(connectorId: string, type: string): boolean | null {
  try {
    // Same-second writes tie on recorded_at (CURRENT_TIMESTAMP is
    // second-resolution) — rowid DESC breaks the tie by actual insertion
    // order so the truly most-recent sync's value always wins.
    const row = db.prepare(
      `SELECT metric_value FROM metrics WHERE connector_id = ? AND metric_name = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`
    ).get(connectorId, `${type}.coverage_complete`) as { metric_value: number | null } | undefined;
    if (!row || row.metric_value == null) return null;
    return row.metric_value !== 0;
  } catch {
    return null;
  }
}

export interface HealthStateInputs {
  applicable: boolean;
  freshnessStatus: string; // live | stale | error | disconnected | syncing | ...
  authorisationStatus: ConfidenceStatus;
  authenticationStatus: ConfidenceStatus;
  connectivityStatus: ConfidenceStatus;
  coverageComplete: boolean | null;
}

/**
 * Precedence, most-actionable/most-honest first: a connector that's not
 * applicable to this business shouldn't also be flagged as failing; a
 * permission problem is worth calling out distinctly from a generic
 * failure because the fix is different (grant scope vs. re-auth/investigate);
 * a connector that IS syncing but only partially must never be reported as
 * simply "healthy" or "stale" — that would imply completeness it doesn't have.
 */
export function deriveConnectorHealthState(inputs: HealthStateInputs): ConnectorHealthState {
  if (!inputs.applicable) return 'not_applicable';
  if (isPermissionIssue(inputs.authorisationStatus)) return 'permission_required';
  if (
    inputs.freshnessStatus === 'error' ||
    inputs.freshnessStatus === 'disconnected' ||
    inputs.authenticationStatus === 'broken' ||
    inputs.connectivityStatus === 'broken'
  ) {
    return 'failing';
  }
  if (inputs.coverageComplete === false) return 'partial';
  if (inputs.freshnessStatus === 'stale') return 'stale';
  return 'healthy';
}

// What breaks, in plain language, when a given connector type stops
// delivering trustworthy data — used to make the "impact" text specific
// rather than a generic "something might be wrong" (issue #65 acceptance
// criteria: "be specific about which features/signals are affected").
const CONNECTOR_IMPACT_AREAS: Record<string, string> = {
  ga4: 'Traffic trends, conversion tracking, and revenue-attribution signals',
  gsc: 'Search visibility, keyword ranking, and SEO signals',
  pagespeed: 'Site performance / Core Web Vitals signals',
  shopify: 'Revenue, order, and product-performance signals',
  'google-merchant': 'Shopping feed visibility and product-coverage signals',
  gbp: 'Local visibility, review, and Business Profile signals',
  'google-ads': 'Ad spend and paid-search performance signals',
  stripe: 'Revenue and payment signals',
  github: 'Code-health signals and self-healing draft-PR remediation',
  uptimerobot: 'Uptime/downtime monitoring signals',
  todoist: 'Task sync between Blueprint and Todoist',
  brevo: 'Email marketing campaign signals',
  klaviyo: 'Email marketing campaign signals',
  stannp: 'Direct-mail campaign signals',
  wordpress: 'Content and CMS health signals',
  kirby: 'Content and CMS health signals',
  wix: 'Content and CMS health signals',
  semrush: 'Competitive SEO intelligence signals',
  social: 'Social (Facebook/Instagram) engagement signals',
  buffer: 'Scheduled social-post publishing',
  'server-access': 'Automated file-remediation actions (self-healing)',
};

function impactAreaFor(type: string, label: string): string {
  return CONNECTOR_IMPACT_AREAS[type] ?? `Signals, goals, and recommendations derived from ${label} data`;
}

function fmtTs(iso: string | null): string {
  return iso ? new Date(iso).toISOString() : 'never';
}

export interface ExplainConnectorHealthOptions {
  /** Display label — defaults to connector.name, falling back to type. */
  label?: string;
}

/**
 * The one function both server/routes/system-health.ts and
 * server/routes/bap-connectors.ts should call — computing this in two
 * places would let the dashboard and a BAP agent disagree about the same
 * connector's health, exactly the drift freshness.ts's docstring already
 * warns against.
 */
export function explainConnectorHealth(
  connector: Pick<Connector, 'id' | 'business_id' | 'type' | 'name' | 'status' | 'last_sync' | 'last_error' | 'config'>,
  options: ExplainConnectorHealthOptions = {},
): ConnectorHealthExplanation {
  const freshness = computeFreshness(connector as unknown as Record<string, unknown>);
  const confidence = computeConnectorConfidence(connector as Connector);
  const applicable = isConnectorApplicable(
    { type: connector.type, last_sync: connector.last_sync },
    connector.business_id,
  );
  const coverageComplete = getLatestCoverageComplete(connector.id, connector.type);

  const state = deriveConnectorHealthState({
    applicable,
    freshnessStatus: freshness.status,
    authorisationStatus: confidence.authorisation_status,
    authenticationStatus: confidence.authentication_status,
    connectivityStatus: confidence.connectivity_status,
    coverageComplete,
  });

  const label = options.label || connector.name || connector.type;
  const impactArea = impactAreaFor(connector.type, label);
  const lastSuccess = connector.last_sync ?? null;

  let summary: string;
  let impact: string | null = null;
  let next_step: string | null = null;

  switch (state) {
    case 'not_applicable':
      summary = `${label} is not applicable to this business and has never synced.`;
      break;

    case 'permission_required':
      summary = `${label} is connected but missing a required permission or scope.`;
      impact = `${impactArea} cannot refresh until access is restored. ${
        lastSuccess
          ? `Data still reflects the last successful sync (${fmtTs(lastSuccess)}) — it is not being kept current.`
          : 'No sync has ever completed successfully, so there is no data for this connector yet.'
      }`;
      next_step = `Reconnect under Connectors → ${label} → Reconnect, granting the permission/scope the provider is now rejecting.`;
      break;

    case 'failing':
      summary = `${label} is failing to sync${connector.last_error ? ` — ${connector.last_error}` : '.'}`;
      impact = `${impactArea} ${
        lastSuccess
          ? `is frozen at its last successful sync (${fmtTs(lastSuccess)}) and will not reflect anything that has happened since.`
          : 'has never successfully synced, so there is no data for this connector to inform yet.'
      }`;
      next_step = lastSuccess
        ? `Reconnect under Connectors → ${label} → Sync Now. If it keeps failing, run Health Check to see the provider's exact error, or check the provider's API quota/status.`
        : `Finish setup under Connectors → ${label} → Configure, then Sync Now.`;
      break;

    case 'partial':
      summary = `${label}'s most recent sync only captured part of the data (coverage incomplete).`;
      impact = `${impactArea} reflect an incomplete snapshot as of ${fmtTs(lastSuccess)} — treat any totals or trends derived from it as a lower bound, not the full picture.`;
      next_step = `Check the provider's API quota/pagination limits, then re-run Sync Now under Connectors → ${label}. If the catalogue/dataset is simply large, this may resolve itself on the next scheduled sync.`;
      break;

    case 'stale':
      summary = `${label} has not synced within its expected cadence (last success ${fmtTs(lastSuccess)}).`;
      impact = `${impactArea} ${
        freshness.hours_since_sync != null ? `are ${freshness.hours_since_sync}h old` : 'are of unknown age'
      } and won't reflect anything that has happened since ${fmtTs(lastSuccess)}.`;
      next_step = `Sync now under Connectors → ${label} → Sync Now. If it keeps falling behind its expected cadence, run Health Check to confirm credentials are still valid.`;
      break;

    case 'healthy':
    default:
      summary = `${label} is healthy and up to date (last success ${fmtTs(lastSuccess)}).`;
      break;
  }

  return {
    state,
    last_success: lastSuccess,
    coverage_complete: coverageComplete,
    summary,
    impact,
    next_step,
  };
}
