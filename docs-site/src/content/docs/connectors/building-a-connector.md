---
title: Building a Connector
description: Step-by-step guide to adding a new data source
---

## The connector interface

Every connector lives at `/server/connectors/{id}/index.js` and exports a default object implementing this interface:

```javascript
export default {
  id: 'my-service',
  name: 'My Service',
  category: 'analytics',  // analytics|commerce|seo|code|email|infrastructure|productivity|advertising
  authType: 'apikey',     // apikey|oauth2|basic|none
  icon: 'bar-chart-2',    // lucide-react icon name

  capabilities: { read: true, write: false, pollingIntervalMinutes: 360 },

  configFields: [
    { id: 'apiKey', label: 'API Key', type: 'password', required: true,
      hint: 'Found at Dashboard → Settings → API' },
  ],

  signalTypes: ['my_metric_drop', 'my_anomaly'],

  async healthCheck(credentials) {
    // Call the API with minimal permissions to verify credentials work
    // Return { ok: true, details: {...} } or { ok: false, error: '...' }
  },

  async fetch(dataType, credentials, params) {
    // Pull data from the API. Return structured JSON.
    // This is called by the scheduler on each polling interval.
  },

  extractMetrics(data, runAt) {
    // Convert fetch() output into individual metric rows.
    // Return array of { name: string, value: number|null, data: object|null }
    return [
      { name: 'myservice.total_users',  value: 1234, data: null },
      { name: 'myservice.active_today', value: 89,   data: null },
      { name: 'myservice.users_data',   value: null,  data: [...usersArray] },
    ];
  },

  // Only needed for OAuth connectors:
  async getAuthUrl(state) { /* return auth URL */ },
  async exchangeCode(code) { /* return { accessToken, refreshToken, expiresAt } */ },
  async refreshToken(credentials) { /* return refreshed credentials */ },
};
```

## Step by step

### 1. Create the connector file

```bash
mkdir server/connectors/my-service
touch server/connectors/my-service/index.js
```

### 2. Implement the interface

Start with `healthCheck` and `fetch`. Use the rate-limiter helper:

```javascript
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

async function apiFetch(endpoint, apiKey) {
  return withRetry(
    () => checkedFetch(`https://api.myservice.com/v1${endpoint}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    { label: 'MyService' }
  );
}
```

### 3. Add signal rules

In `/server/signals/rules.js`, add rules for your connector:

```javascript
{
  id: 'myservice_metric_drop',
  connectorType: 'my-service',
  type: 'anomaly',
  severity: 'warning',
  name: 'Metric Drop',
  evaluate(current, previous) {
    // Return { triggered, confidence, data, title, description }
    // Always handle null/missing data gracefully
    if (!current?.total_users || !previous?.total_users) {
      return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
    }
    // ...your logic
  },
},
```

### 4. Add to the frontend

In `ConnectorDataPage.jsx`, add your connector to `CONNECTOR_META` and `CONNECTOR_TABS`.

In `Sidebar.jsx`, add your icon to `CONNECTOR_ICONS` and `CONNECTOR_LABELS`.

### 5. Test

```bash
cd client && bun run build  # Must pass with zero errors
```

Then add the connector via the UI, click Sync, and verify metrics appear in the database.
