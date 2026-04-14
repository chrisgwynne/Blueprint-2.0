---
title: "Building a Connector"
section: "Connectors"
order: 20
---

# Building a Connector

Every connector lives at `server/connectors/{id}/index.js` and exports a default object that implements the connector interface. The scheduler discovers connectors by their `type` column in the database, dynamically imports `server/connectors/{type}/index.js`, and calls `fetch()` on every polling cycle.

This guide walks through creating a fully functional connector from scratch, including extracting metrics, writing signal rules, registering in the post-sync pipeline, and setting the polling default.

---

## The connector interface

The full interface is defined in `server/connectors/connector.interface.js`. Every connector must export a default object with this shape:

```js
export default {
  /** Unique machine-readable identifier, e.g. 'gsc', 'ga4', 'pagespeed' */
  id: 'connector-id',

  /** Human-readable display name */
  name: 'Human Name',

  /** Category for grouping in the UI */
  category: 'seo|analytics|ecommerce|email|infrastructure|code|productivity|payments',

  /** How this connector authenticates */
  authType: 'oauth2|apikey|none',

  /** Icon identifier (maps to Lucide icon names in the UI) */
  icon: 'icon-name',

  capabilities: {
    read: true,
    write: false,       // set true only if the connector can mutate data
    webhooks: false,
    /** How often (in minutes) this connector should be polled */
    pollingIntervalMinutes: 360,
  },

  /**
   * Signal rule IDs this connector produces data for.
   * Must match ids defined in server/signals/rules.js
   */
  signalTypes: [],

  /**
   * Verify credentials. Return { ok: true } on success, { ok: false, error } on failure.
   */
  async healthCheck(credentials) {},

  /**
   * Fetch data from the external API.
   * Return a normalised object — this becomes the blob written to the metrics table.
   */
  async fetch(dataType, credentials, params) {},

  /**
   * Extract individual named metric rows from the fetch result.
   * Called by the scheduler after fetch(). Return array of { name, value, data? }.
   * 'name' is the metric key stored in the DB (e.g. 'myservice.metric_name').
   * 'value' is a number. 'data' is an optional JSON blob for rich data.
   */
  extractMetrics(data, runAt) {
    return [];
  },

  // OAuth-only methods — omit (or throw) for apikey connectors:
  async getAuthUrl(state) {},
  async exchangeCode(code) {},
  async refreshToken(credentials) {},
};
```

---

## Step-by-step example

We will build a connector for a fictional API called **Acme Analytics** that tracks page views and errors via an API key.

### Step 1: Create the connector file

Create `server/connectors/acme/index.js`.

```js
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://api.acme.example/v1';

const connector = {
  id: 'acme',
  name: 'Acme Analytics',
  category: 'analytics',
  authType: 'apikey',
  icon: 'bar-chart-2',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360,
  },

  signalTypes: ['acme_error_spike', 'acme_views_drop'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.apiKey) return { ok: false, error: 'API key missing.' };
      const res = await withRetry(
        () => checkedFetch(`${BASE}/account`, {
          headers: { 'X-Api-Key': credentials.apiKey },
        }),
        { label: 'Acme healthCheck' }
      );
      const data = await res.json();
      return { ok: true, details: { account: data.name } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.apiKey) throw new Error('Acme API key is required.');

    const [summaryRes, errorsRes] = await Promise.all([
      withRetry(
        () => checkedFetch(`${BASE}/summary?days=7`, {
          headers: { 'X-Api-Key': credentials.apiKey },
        }),
        { label: 'Acme summary' }
      ),
      withRetry(
        () => checkedFetch(`${BASE}/errors?days=7`, {
          headers: { 'X-Api-Key': credentials.apiKey },
        }),
        { label: 'Acme errors' }
      ),
    ]);

    const summary = await summaryRes.json();
    const errors = await errorsRes.json();

    return {
      views: summary.page_views ?? 0,
      views_prev: summary.page_views_previous ?? 0,
      errors_7d: errors.total ?? 0,
      errors_7d_prev: errors.total_previous ?? 0,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    return [
      { name: 'acme.views',       value: data.views ?? 0,       data: null },
      { name: 'acme.views_prev',  value: data.views_prev ?? 0,  data: null },
      { name: 'acme.errors_7d',   value: data.errors_7d ?? 0,   data: null },
    ];
  },

  // Not an OAuth connector — these are not needed:
  async getAuthUrl() { throw new Error('Acme uses API key auth, not OAuth.'); },
  async exchangeCode() { throw new Error('Acme uses API key auth, not OAuth.'); },
  async refreshToken() { throw new Error('Acme uses API key auth, not OAuth.'); },
};

export default connector;
```

**Rate limiting:** always use `withRetry` and `checkedFetch` from `server/lib/rate-limiter.js`. `checkedFetch` converts non-2xx responses into thrown errors with a `.status` field. `withRetry` retries on 429 and 503 with exponential backoff (1s, 2s, 4s, 8s).

### Step 2: Add signal rules

Open `server/signals/rules.js` and add your rules to the `rules` array. Each rule needs:

- `id` — unique string, matches what you declared in `signalTypes`
- `connectorType` — the `id` of your connector
- `type` — a category string (can match `id`)
- `severity` — `'info'`, `'warning'`, `'alert'`, or `'critical'`
- `name` — human-readable label
- `evaluate(current, previous)` — returns `{ triggered, confidence, data, title, description }`

```js
// In server/signals/rules.js, inside the `rules` array:

{
  id: 'acme_views_drop',
  connectorType: 'acme',
  type: 'acme_views_drop',
  severity: 'warning',
  name: 'Acme Page Views Drop',

  evaluate(current, previous) {
    const curr = current?.views ?? 0;
    const prev = previous?.views ?? 0;
    if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
    const dropPct = ((prev - curr) / prev) * 100;
    const triggered = dropPct >= 20;
    return {
      triggered,
      confidence: triggered ? Math.min(0.95, 0.5 + (dropPct - 20) / 100) : 0,
      data: { curr, prev, dropPct: Math.round(dropPct * 10) / 10 },
      title: triggered ? `Acme views down ${Math.round(dropPct)}% week-over-week` : '',
      description: triggered
        ? `Page views fell from ${prev} to ${curr}.`
        : '',
    };
  },
},

{
  id: 'acme_error_spike',
  connectorType: 'acme',
  type: 'acme_error_spike',
  severity: 'alert',
  name: 'Acme Error Spike',

  evaluate(current, previous) {
    const curr = current?.errors_7d ?? 0;
    const prev = previous?.errors_7d ?? 0;
    if (prev === 0 && curr === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
    // Trigger if errors doubled and exceed 10 absolute
    const triggered = curr >= 10 && curr > prev * 2;
    return {
      triggered,
      confidence: triggered ? 0.9 : 0,
      data: { curr, prev },
      title: triggered ? `Acme errors spiked to ${curr} (was ${prev})` : '',
      description: triggered
        ? `Error count doubled in 7 days. Check the Acme dashboard.`
        : '',
    };
  },
},
```

The signal engine deduplicates automatically — a second identical signal is not created while the first is still open. Cool-down periods after resolution can be configured in `signal-engine.js` (`COOLDOWN_HOURS`).

### Step 3: Register in `CONNECTOR_AGENT_MAP`

Open `server/connectors/post-sync.js` and add an entry to `CONNECTOR_AGENT_MAP`. This controls which agents are queued for a run after your connector syncs.

```js
// In server/connectors/post-sync.js:

export const CONNECTOR_AGENT_MAP = {
  gsc:          ['seo-sentinel', 'trend-spotter', 'quill'],
  ga4:          ['trend-spotter', 'seo-sentinel', 'quill'],
  pagespeed:    ['velocity'],
  shopify:      ['merchant', 'quill'],
  stripe:       ['ledger'],
  uptimerobot:  ['sentinel'],
  github:       ['dev'],
  gbp:          ['outreach'],
  stannp:       ['outreach'],
  brevo:        ['outreach', 'quill'],
  'meta-ads':   ['outreach', 'merchant'],
  acme:         ['trend-spotter'],    // ← add your connector here
};
```

Only list agents that should run after this connector syncs. An agent will only be queued if it is installed and in `active` status, passes its readiness check, and has not run within its minimum hours threshold.

### Step 4: Add the polling default

Open `server/jobs/scheduler.js`. Find the `pollingDefaults` object inside the `*/15 * * * *` cron job and add your connector's default interval in minutes:

```js
const pollingDefaults = {
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
  acme: 360,   // ← add your connector here (360 = 6 hours)
};
```

If omitted, the fallback is 360 minutes. Adding an explicit entry makes the intent clear and allows tuning without touching the fallback.

### Step 5: Register in the frontend

Open `client/src/pages/Connectors.jsx` and add an entry to the `CONNECTOR_TYPES` array. Use `configFields` to define the input form that appears when the user clicks **Add connector**.

```js
// In client/src/pages/Connectors.jsx, inside CONNECTOR_TYPES:

{ id: 'acme', label: 'Acme Analytics', icon: BarChart2, available: true,
  name: 'Acme Analytics',
  configFields: [
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      hint: 'Acme Dashboard → Settings → API → Generate Key.',
    },
  ],
},
```

Supported `type` values for `configFields`: `text`, `password`, `url`, `number`, `select`, `textarea`, `multiselect`.

For OAuth connectors, use the `oauth` property instead of `configFields`:

```js
{ id: 'acme', label: 'Acme', icon: BarChart2, available: true,
  oauth: '/api/oauth/acme',
  name: 'Acme Analytics',
},
```

---

## OAuth connectors

If your connector uses OAuth2, implement `getAuthUrl`, `exchangeCode`, and `refreshToken` in your connector file, and create an OAuth route in `server/routes/`. The Google connectors (`gsc`, `ga4`, `google-ads`, `gbp`) are good reference implementations.

Key requirements:

- The redirect URI **must** be registered in your OAuth app. For Google it is `http://localhost:4000/api/oauth/google/callback`.
- Tokens are stored encrypted. Read credentials with `JSON.parse(decrypt(row.credentials))` — never access them raw.
- Always refresh before the token expires. Check `Date.now() + 60_000 < credentials.expiresAt` before each API call.
- Store `refreshToken` on first exchange. Google only returns it on the first `consent` prompt — if you lose it, the user must re-authorise.

---

## Testing checklist

Before shipping a connector:

- [ ] `healthCheck()` returns `{ ok: true }` with valid credentials and `{ ok: false, error }` with invalid credentials
- [ ] `fetch()` returns a consistent normalised shape across multiple calls
- [ ] `extractMetrics()` returns an array with at least one `{ name, value }` entry; values are numbers
- [ ] Signal rules in `rules.js` have the correct `connectorType` matching your connector `id`
- [ ] `evaluate()` returns `{ triggered: false }` when there is no previous data (first sync)
- [ ] Polling default added to `scheduler.js`
- [ ] `CONNECTOR_AGENT_MAP` entry added in `post-sync.js` (can be an empty array if no agents depend on this connector yet)
- [ ] Frontend entry in `CONNECTOR_TYPES`
- [ ] Manual sync via Sync Now completes without error
- [ ] Signal fires on a test dataset where the threshold is exceeded
- [ ] Signal does not re-fire when an identical open signal already exists (deduplication)
