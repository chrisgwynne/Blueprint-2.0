# Security & Data Handling

Blueprint runs on your own infrastructure and reasons over real business data — revenue, customer records, ad accounts, source code. This document states what that means in practice, and every claim below is checked against the actual code, not aspirational.

## Where your data lives

Blueprint is **self-hosted only** — there is no hosted/cloud tier and no Blueprint-operated server anywhere in the request path. Your SQLite database (`data/blueprint.db`) and your git-backed knowledge base (`kb/`) live on disk, on hardware you control. Nothing is synced to a third party by Blueprint itself.

## What actually leaves your machine

Blueprint restricts its own outbound network access to an explicit allowlist (`server/lib/outbound-allowlist.ts`), enforced in code as one of the layers defending against prompt injection — not just documented as policy. The only hosts Blueprint will ever contact are:

- Your configured LLM provider (Anthropic, OpenAI, Google, OpenRouter, or your own Ollama/LM Studio endpoint)
- The specific connector APIs you've connected (Shopify, GA4, GitHub, Stripe, and so on — see [the connector list](README.md#-connectors))
- OAuth token endpoints for the connectors that use OAuth

There is no telemetry, analytics, or crash-reporting call anywhere in the codebase — we checked, not just promised: no `posthog`/`segment`/`mixpanel`/`amplitude`/`sentry.init` or equivalent exists in this repository. Blueprint cannot phone home even if a future version wanted to, without that change being visible in a diff against this file's claim.

## Your LLM provider, and what it sees

Whatever an agent needs to reason about — a signal, a KB excerpt, a task draft — goes to whichever LLM provider you configured, and only that provider.

- **Ollama or LM Studio (local models)**: nothing leaves your machine at all. This is the zero-data-exposure option and needs no API key.
- **A cloud provider (Anthropic, OpenAI, Google, OpenRouter, or a custom OpenAI-compatible endpoint)**: the prompt Blueprint constructs is sent to that provider under *their* API data-use terms, not Blueprint's — Blueprint does not add any of its own logging, retention, or training pipeline on top of what you send. Check your chosen provider's own API terms (most major providers, unlike their consumer chat products, do not train on API traffic by default — but that's their policy, not a Blueprint guarantee, so verify it for the provider you actually pick).

Blueprint never routes your inference through a Blueprint-operated proxy or gateway — API keys and requests go directly from your instance to the provider you configured.

## Credentials at rest

Every connector credential (API keys, OAuth tokens, app passwords) is encrypted at rest with AES-256-GCM (`server/crypto.ts`) before it's written to the database — never stored in plaintext.

## Write-back safety

Any action that changes something outside Blueprint (a GitHub issue, a Shopify listing, a server file) requires human approval by default, governed by a typed, versioned Operating Policy — see [server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md) for the full mechanics. Every write captures rollback data before it touches anything real.

## Reporting a vulnerability

Open an issue, or if the report is sensitive, contact the maintainer directly rather than filing publicly. There is no bug bounty program at this time.
