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
git clone https://github.com/chrisgwynne/Blueprint-2.0
cd Blueprint-2.0
cp .env.example .env
# Configure your LLM in .env — Ollama is easiest for dev (free, no API key)

cd server && bun install && bun run db:init
cd ../client && bun install

# Two terminals:
cd server && bun --watch index.ts    # API on :4000
cd client && bun run dev             # UI on :5173
```

## Building a connector

Connectors live in `/server/connectors/{connector-id}/index.ts`. Every connector implements the same interface:

```typescript
import type { ConnectorInterface } from '../../connector.interface.js';

const connector: ConnectorInterface = {
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
};

export default connector;
```

Add signal rules in `/server/signals/rules.ts`.
Add connector tabs in `/client/src/pages/ConnectorDataPage.tsx`.

## Pull request process

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-connector`
3. Make your changes
4. Test: `cd client && bun run build` (must pass with zero errors)
5. Submit PR using the template

## Code style

- TypeScript throughout — server (NodeNext module resolution) and client (Vite bundler resolution)
- Bun for package management and runtime (runs `.ts` natively, no compilation step)
- Tailwind CSS classes in client code
- Every new route needs auth middleware
- Every connector credential field must use encrypt/decrypt from `crypto.ts`
- Signal rules must handle null data gracefully (return `{ triggered: false }`)
- Run `bun run --cwd server typecheck` and `bun run --cwd client typecheck` before pushing — both must pass with zero errors
