/**
 * UptimeRobot connector — apikey auth.
 *
 * Docs: https://uptimerobot.com/api/
 * Endpoint base: https://api.uptimerobot.com/v2/
 *
 * Auth: HTTP POST with form-encoded body containing api_key + format=json.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://api.uptimerobot.com/v2';

// Monitor status codes from UptimeRobot
const STATUS = {
  PAUSED: 0,
  NOT_CHECKED: 1,
  UP: 2,
  SEEMS_DOWN: 8,
  DOWN: 9,
};

async function apiFetch(endpoint, apiKey, body = {}) {
  const res = await checkedFetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey, format: 'json', ...body }),
  });
  return res.json();
}

const connector = {
  id: 'uptimerobot',
  name: 'UptimeRobot',
  category: 'infrastructure',
  authType: 'apikey',
  icon: 'activity',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 15,
  },

  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Found in UptimeRobot Dashboard → My Settings → API Settings (use a Read-Only key).',
    },
  ],

  signalTypes: [
    'monitor_down',
    'monitor_seems_down',
    'uptime_below_threshold',
    'response_time_spike',
  ],

  async healthCheck(credentials) {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const data = await withRetry(
        () => apiFetch('getAccountDetails', credentials.apiKey),
        { label: 'UptimeRobot healthCheck' }
      );
      if (data.stat !== 'ok') {
        return { ok: false, error: data.error?.message ?? 'Unknown UptimeRobot API error.' };
      }
      return {
        ok: true,
        details: {
          email: data.account?.email,
          monitor_count: data.account?.monitor_count,
          up: data.account?.up_monitors,
          down: data.account?.down_monitors,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.apiKey) throw new Error('UptimeRobot API key is required.');

    const [account, monitors] = await Promise.all([
      withRetry(
        () => apiFetch('getAccountDetails', credentials.apiKey),
        { label: 'UptimeRobot account' }
      ),
      withRetry(
        () => apiFetch('getMonitors', credentials.apiKey, {
          response_times: '1',
          response_times_limit: '24',
          logs: '1',
          logs_limit: '10',
          custom_uptime_ratios: '1-7-30',
        }),
        { label: 'UptimeRobot monitors' }
      ),
    ]);

    const monitorsList = Array.isArray(monitors.monitors) ? monitors.monitors : [];

    return {
      account: account.account ?? null,
      monitors: monitorsList,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const monitors = Array.isArray(data?.monitors) ? data.monitors : [];

    const up = monitors.filter(m => m.status === STATUS.UP).length;
    const down = monitors.filter(m => m.status === STATUS.DOWN).length;
    const seemsDown = monitors.filter(m => m.status === STATUS.SEEMS_DOWN).length;
    const paused = monitors.filter(m => m.status === STATUS.PAUSED).length;
    const total = monitors.length;

    // Average uptime ratio across all monitors (using 30-day if available)
    const ratios = monitors
      .map(m => {
        const r = m.custom_uptime_ratio ?? '';
        const parts = String(r).split('-');
        // Order: 1-7-30 → take the last (30-day) value
        const v = parseFloat(parts[parts.length - 1]);
        return isNaN(v) ? null : v;
      })
      .filter(v => v !== null);
    const overallUptime = ratios.length > 0
      ? Math.round((ratios.reduce((s, v) => s + v, 0) / ratios.length) * 100) / 100
      : 0;

    metrics.push(
      { name: 'uptimerobot.monitors_total', value: total,      data: null },
      { name: 'uptimerobot.monitors_up',    value: up,         data: null },
      { name: 'uptimerobot.monitors_down',  value: down,       data: null },
      { name: 'uptimerobot.monitors_seems_down', value: seemsDown, data: null },
      { name: 'uptimerobot.monitors_paused', value: paused,    data: null },
      { name: 'uptimerobot.overall_uptime', value: overallUptime, data: null },
    );

    // Rich data
    const monitorsCondensed = monitors.map(m => ({
      id: m.id,
      friendly_name: m.friendly_name,
      url: m.url,
      type: m.type,
      status: m.status,
      uptime_ratio_30d: parseFloat(String(m.custom_uptime_ratio ?? '').split('-').pop()) || null,
      response_time_ms: m.response_times?.[0]?.value ?? null,
      response_times: m.response_times ?? [],
      logs: m.logs ?? [],
    }));

    metrics.push({ name: 'uptimerobot.monitors_data', value: total, data: monitorsCondensed });

    // Down monitors detail (for signals)
    const downMonitors = monitorsCondensed.filter(m => m.status === STATUS.DOWN || m.status === STATUS.SEEMS_DOWN);
    if (downMonitors.length > 0) {
      metrics.push({ name: 'uptimerobot.down_monitors_data', value: downMonitors.length, data: downMonitors });
    }

    return metrics;
  },

  async getAuthUrl() { throw new Error('UptimeRobot uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('UptimeRobot uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('UptimeRobot uses API key authentication, not OAuth.'); },
};

export default connector;
