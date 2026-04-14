/**
 * Shared context builders used by both the scheduled agent runner
 * and the chat engine so both see identical, current business data.
 */

/**
 * Build a formatted "Current Business Data" section from the metrics table.
 *
 * Groups metrics by connector type, deduplicates to the latest value per
 * metric name, and returns a ready-to-embed string for system prompts.
 * Returns an empty string if no recent metrics exist.
 *
 * @param {string} businessId
 * @param {import('bun:sqlite').Database} db
 * @param {{ maxAgeHours?: number, maxPerConnector?: number }} [opts]
 * @returns {string}
 */
export function buildMetricsContext(businessId, db, opts = {}) {
  const maxAgeHours    = opts.maxAgeHours    ?? 48;
  const maxPerConnector = opts.maxPerConnector ?? 30;

  const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        c.type      AS connector_type,
        c.name      AS connector_name,
        m.metric_name,
        m.metric_value,
        m.recorded_at
      FROM metrics m
      JOIN connectors c ON c.id = m.connector_id
      WHERE m.business_id = ?
        AND m.recorded_at >= ?
        AND m.metric_value IS NOT NULL
      ORDER BY m.recorded_at DESC
    `).all(businessId, since);
  } catch {
    return '';
  }

  if (!rows.length) return '';

  // Group by connector type, keep only the latest value per metric name
  const byConnector = {};
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.connector_type}::${row.metric_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byConnector[row.connector_type]) {
      byConnector[row.connector_type] = { name: row.connector_name, metrics: [] };
    }
    byConnector[row.connector_type].metrics.push({
      name:  row.metric_name,
      value: row.metric_value,
      at:    row.recorded_at,
    });
  }

  const sections = [];
  for (const [type, { name, metrics }] of Object.entries(byConnector)) {
    const capped  = metrics.slice(0, maxPerConnector);
    const omitted = metrics.length - capped.length;
    const label   = name && name !== type ? `${type} (${name})` : type;
    const lines   = capped.map(m => `  ${m.name}: ${m.value}`);
    if (omitted > 0) lines.push(`  … ${omitted} more metrics available`);
    sections.push(`### ${label.toUpperCase()}\n${lines.join('\n')}`);
  }

  return `## Current Business Data

This is real, live data pulled from your connected sources.
Use these numbers when answering questions or proposing tasks.
Do not ask the user to share data that is already listed here.

${sections.join('\n\n')}`;
}
