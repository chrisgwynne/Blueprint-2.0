# Contributing to Blueprint

Thank you for your interest in contributing.

## Ways to contribute

- **Report bugs** — use the bug report issue template
- **Request connectors** — use the connector request template
- **Submit connectors** — the connector interface makes this straightforward
- **Improve documentation** — docs live in the docs site repo
- **Fix bugs** — check issues labelled `good first issue`

## Development setup

```bash
git clone https://github.com/chrisgwynne/blueprint
cd blueprint
cp .env.example .env
# Configure your LLM in .env — Ollama is easiest for dev (free, no API key)

cd server && bun install && bun run db/init.js
cd ../client && bun install

# Two terminals:
cd server && bun --watch index.js    # API on :4000
cd client && bun run dev             # UI on :5173
```

## Building a connector

Connectors live in `/server/connectors/{connector-id}/index.js`. Every connector implements the same interface:

```javascript
export default {
  id: 'my-connector',
  name: 'My Connector',
  category: 'analytics',     // analytics|commerce|seo|code|email|infrastructure|productivity|advertising
  authType: 'apikey',        // apikey|oauth2|basic|none
  icon: 'bar-chart-2',       // lucide-react icon name

  configFields: [
    { id: 'apiKey', label: 'API Key', type: 'password', required: true,
      hint: 'Found in Dashboard → Settings → API' }
  ],

  capabilities: { read: true, write: false, pollingIntervalMinutes: 360 },
  signalTypes: ['my_signal_rule_id'],

  async healthCheck(credentials) { /* return { ok, error?, details? } */ },
  async fetch(dataType, credentials, params) { /* return data */ },
  extractMetrics(data, runAt) { /* return [{ name, value, data }] */ },
}
```

Add signal rules in `/server/signals/rules.js`.
Add connector tabs in `/client/src/pages/ConnectorDataPage.jsx`.

## Pull request process

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-connector`
3. Make your changes
4. Test: `cd client && bun run build` (must pass with zero errors)
5. Submit PR using the template

## Code style

- No TypeScript — plain JavaScript throughout
- Bun for package management
- Tailwind CSS classes in client code
- Every new route needs auth middleware
- Every connector credential field must use encrypt/decrypt from `crypto.js`
- Signal rules must handle null data gracefully (return `{ triggered: false }`)
