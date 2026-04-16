/**
 * Per-agent poll intervals for the safety-net scheduler.
 *
 * The safety-net is a fallback, not the primary trigger — most agent runs
 * should come from events (connector syncs, signals, inbox briefs, chat
 * @mentions). The poll exists so a missed event eventually surfaces.
 *
 * Defaults are tuned per agent:
 *   - fast (sentinel 5m): uptime issues are time-sensitive
 *   - medium (conductor 15m): orchestration needs fresh view
 *   - hourly (merchant, dev): business-metric agents
 *   - slow (seo-sentinel 6h, researcher 8h): deep-work agents
 *   - weekly (reporter): schedule-driven briefings
 *
 * User overrides are stored in the settings table as
 *   key: agent_poll_interval_{agentId}
 *   value: JSON number (minutes)
 *
 * The Settings UI (Tranche 6D) will surface these as sliders per agent.
 */

import db from '../db/db.js';

export const DEFAULT_POLL_INTERVALS_MINUTES: Record<string, number> = {
  sentinel:        5,
  conductor:       15,
  merchant:        60,
  dev:             60,
  velocity:        120,
  quill:           120,
  'trend-spotter': 180,
  ledger:          240,
  outreach:        240,
  'seo-sentinel':  360,
  researcher:      480,
  reporter:        10080,   // weekly — effectively schedule-driven
};

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60 * 24 * 14; // two weeks upper bound

/**
 * Return the configured poll interval for an agent (minutes).
 * Checks settings first, falls back to DEFAULT_POLL_INTERVALS_MINUTES,
 * then to a safe generic default of 60 minutes.
 */
export function getPollInterval(agentId: string): number {
  const key = `agent_poll_interval_${agentId}`;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      const n = Number(parsed);
      if (Number.isFinite(n) && n >= MIN_INTERVAL_MINUTES) return n;
    }
  } catch {}
  return DEFAULT_POLL_INTERVALS_MINUTES[agentId] ?? 60;
}

/**
 * Persist a user override for an agent's poll interval.
 * Throws on invalid input.
 */
export function setPollInterval(agentId: string, minutes: number | string): void {
  const n = Number(minutes);
  if (!Number.isFinite(n)) {
    throw new Error(`Poll interval must be a number (got ${minutes})`);
  }
  if (n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
    throw new Error(
      `Poll interval must be between ${MIN_INTERVAL_MINUTES} and ` +
      `${MAX_INTERVAL_MINUTES} minutes (got ${n})`
    );
  }

  const key = `agent_poll_interval_${agentId}`;
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(n));
}

/**
 * Remove any user override — agent reverts to its default.
 */
export function resetPollInterval(agentId: string): void {
  const key = `agent_poll_interval_${agentId}`;
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export const BOUNDS = {
  min: MIN_INTERVAL_MINUTES,
  max: MAX_INTERVAL_MINUTES,
};
