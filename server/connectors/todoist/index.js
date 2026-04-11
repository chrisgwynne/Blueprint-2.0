/**
 * Todoist connector — OAuth2 auth.
 *
 * Docs: https://developer.todoist.com/rest/v2/
 *       https://developer.todoist.com/sync/v9/
 *
 * Auth URL:    https://todoist.com/oauth/authorize
 * Token URL:   https://todoist.com/oauth/access_token
 * Tokens DO NOT expire — no refresh flow needed.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const REST_BASE = 'https://api.todoist.com/rest/v2';
const SYNC_BASE = 'https://api.todoist.com/sync/v9';
const AUTH_BASE = 'https://todoist.com/oauth/authorize';
const TOKEN_URL = 'https://todoist.com/oauth/access_token';
const SCOPES = 'data:read';

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

const connector = {
  id: 'todoist',
  name: 'Todoist',
  category: 'productivity',
  authType: 'oauth2',
  icon: 'check-square',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 60,
  },

  configFields: [
    {
      id: 'projectFilter',
      label: 'Projects to track',
      type: 'multiselect',
      required: false,
      hint: 'Leave empty to track all projects.',
    },
  ],

  signalTypes: ['high_priority_overdue', 'overdue_tasks_spike', 'tasks_completed_drop'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.accessToken) return { ok: false, error: 'Access token missing.' };
      const res = await withRetry(
        () => checkedFetch(`${REST_BASE}/projects`, { headers: authHeaders(credentials.accessToken) }),
        { label: 'Todoist healthCheck' }
      );
      const projects = await res.json();
      return { ok: true, details: { projects: Array.isArray(projects) ? projects.length : 0 } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.accessToken) throw new Error('Todoist access token is required.');
    const headers = authHeaders(credentials.accessToken);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [projectsRes, tasksRes, completedRes] = await Promise.all([
      withRetry(() => checkedFetch(`${REST_BASE}/projects`, { headers }), { label: 'Todoist projects' }),
      withRetry(() => checkedFetch(`${REST_BASE}/tasks`, { headers }), { label: 'Todoist tasks' }),
      withRetry(
        () => checkedFetch(`${SYNC_BASE}/completed/get_all?limit=200&since=${encodeURIComponent(sevenDaysAgo)}`, {
          headers,
        }),
        { label: 'Todoist completed' }
      ).catch(() => null),
    ]);

    const projects = await projectsRes.json();
    const tasks = await tasksRes.json();
    const completedData = completedRes ? await completedRes.json() : null;

    return {
      projects: Array.isArray(projects) ? projects : [],
      tasks: Array.isArray(tasks) ? tasks : [],
      completed_7d: completedData?.items ?? [],
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const completed = Array.isArray(data?.completed_7d) ? data.completed_7d : [];

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const isOverdue = t => {
      const due = t.due?.date ?? t.due?.datetime;
      if (!due) return false;
      return new Date(due) < todayStart;
    };
    const isDueToday = t => {
      const due = t.due?.date ?? t.due?.datetime;
      if (!due) return false;
      const d = new Date(due);
      return d >= todayStart && d < todayEnd;
    };

    const overdue = tasks.filter(isOverdue);
    const dueToday = tasks.filter(isDueToday);
    // Todoist API returns priority 1 (lowest) → 4 (highest)
    const p1 = tasks.filter(t => t.priority === 4);

    metrics.push(
      { name: 'todoist.tasks_active',       value: tasks.length,      data: null },
      { name: 'todoist.tasks_overdue',      value: overdue.length,    data: null },
      { name: 'todoist.tasks_due_today',    value: dueToday.length,   data: null },
      { name: 'todoist.tasks_p1',           value: p1.length,         data: null },
      { name: 'todoist.tasks_completed_7d', value: completed.length,  data: null },
      { name: 'todoist.projects_count',     value: projects.length,   data: null },
    );

    metrics.push(
      { name: 'todoist.projects_data',     value: projects.length, data: projects },
      { name: 'todoist.overdue_tasks',     value: overdue.length,  data: overdue.slice(0, 50) },
      { name: 'todoist.due_today_tasks',   value: dueToday.length, data: dueToday.slice(0, 50) },
      { name: 'todoist.completed_data',    value: completed.length, data: completed.slice(0, 100) },
    );

    return metrics;
  },

  async getAuthUrl(state) {
    const clientId = process.env.TODOIST_CLIENT_ID;
    if (!clientId) throw new Error('TODOIST_CLIENT_ID env var not set.');
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      state: state ?? '',
    });
    return `${AUTH_BASE}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const clientId = process.env.TODOIST_CLIENT_ID;
    const clientSecret = process.env.TODOIST_CLIENT_SECRET;
    const redirectUri = process.env.TODOIST_REDIRECT_URI || 'http://localhost:4000/api/oauth/todoist/callback';
    if (!clientId || !clientSecret) {
      throw new Error('TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET must be set.');
    }
    const res = await checkedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokens = await res.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: null, // Todoist tokens don't expire
      expiresAt: null,
      scope: tokens.token_type ? SCOPES : null,
    };
  },

  async refreshToken(credentials) {
    // Todoist tokens never expire — return as-is.
    return credentials;
  },
};

export default connector;
