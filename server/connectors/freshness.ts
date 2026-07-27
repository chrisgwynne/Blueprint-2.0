/**
 * Shared connector freshness/staleness computation — extracted from
 * server/routes/system-health.ts so the new BAP connector-status route
 * (Phase 2) computes the exact same numbers the dashboard shows, rather
 * than a second, drifting copy. This is the "live, per-request recompute"
 * variant (distinct from server/jobs/scheduler.ts's separate hourly
 * cron-persisted `connectors.status = 'stale'` downgrade, which uses its
 * own, narrower threshold table and only runs once an hour — see
 * PHASE2.md for the reconciliation note). This module never touches the
 * DB; it's pure computation over a connector row you already fetched.
 */

export const STALE_THRESHOLDS_HOURS: Record<string, number> = {
  pagespeed: 48,
  gsc: 24,
  ga4: 12,
  shopify: 12,
  uptimerobot: 2,
  stripe: 24,
  github: 24,
  todoist: 2,
  brevo: 24,
  stannp: 72,
  wordpress: 24,
  kirby: 24,
  'google-ads': 24,
  gbp: 24,
};

export const POLLING_DEFAULTS_MIN: Record<string, number> = {
  pagespeed: 1440,
  gsc: 720,
  ga4: 360,
  shopify: 360,
  uptimerobot: 15,
  todoist: 60,
  brevo: 360,
  stannp: 720,
  wordpress: 360,
  kirby: 720,
  'google-ads': 360,
};

export function getPollingInterval(connector: Record<string, unknown>): number {
  try {
    if (connector.config) {
      const cfg = typeof connector.config === 'string' ? JSON.parse(connector.config) as Record<string, unknown> : connector.config as Record<string, unknown>;
      if (cfg.pollingIntervalMinutes) return Number(cfg.pollingIntervalMinutes);
    }
  } catch {}
  return POLLING_DEFAULTS_MIN[connector.type as string] ?? 360;
}

export function computeConnectorStatus(c: Record<string, unknown>, hoursSinceSync: number | null, threshold: number): string {
  if (c.status === 'error') return 'error';
  if (c.status === 'disconnected') return 'disconnected';
  if (hoursSinceSync != null && hoursSinceSync > threshold) return 'stale';
  if (c.status === 'connected' || c.status === 'syncing') return 'live';
  if (c.status === 'stale') return 'stale';
  return (c.status as string) || 'live';
}

export interface FreshnessSummary {
  status: string;
  hours_since_sync: number | null;
  next_sync_in_minutes: number | null;
  stale_threshold_hours: number;
}

/** One-shot convenience: everything a caller needs from a connector row + its type. */
export function computeFreshness(connector: Record<string, unknown>): FreshnessSummary {
  const threshold = STALE_THRESHOLDS_HOURS[connector.type as string] ?? 24;
  const hoursSince = connector.last_sync
    ? (Date.now() - new Date(connector.last_sync as string).getTime()) / 3600000
    : null;
  const status = computeConnectorStatus(connector, hoursSince, threshold);

  const pollingMinutes = getPollingInterval(connector);
  const lastSyncMs = connector.last_sync ? new Date(connector.last_sync as string).getTime() : 0;
  const nextSyncMs = lastSyncMs + pollingMinutes * 60000;
  const nextSyncInMinutes = connector.last_sync ? Math.round((nextSyncMs - Date.now()) / 60000) : null;

  return {
    status,
    hours_since_sync: hoursSince != null ? Math.round(hoursSince * 10) / 10 : null,
    next_sync_in_minutes: nextSyncInMinutes,
    stale_threshold_hours: threshold,
  };
}
