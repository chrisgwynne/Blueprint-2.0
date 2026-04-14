---
title: "LLM Providers"
description: "Configure which AI models power Blueprint's agents"
section: "Agents"
order: 7
---

# LLM Providers

Blueprint's agents are powered by large language models. You choose which provider and model each agent uses. You can set a global default and override it per agent. Blueprint supports six providers out of the box.

---

## Providers at a Glance

| Provider | Cost | Privacy | Best For |
|----------|------|---------|----------|
| Ollama | Free | Fully local — data never leaves your server | Privacy-first setups, no API budget |
| Claude CLI | Free if you have Claude Code subscription | API | Best value if you already subscribe to Claude |
| Anthropic | Pay per token | API | Best analysis quality |
| OpenAI | Pay per token | API | Broad model choice |
| Google Gemini | Pay per token | API | Large context windows |
| LM Studio | Free (self-hosted) | Fully local | Local models with a GUI |

---

## Provider Details

### Ollama (Recommended for Getting Started)

Ollama runs open-source models locally on your server. No account, no API key, no cost. Your business data never leaves the machine Blueprint is running on.

Set up Ollama separately (see [ollama.ai](https://ollama.ai)), pull a model, and Blueprint will connect automatically using `http://localhost:11434`.

**Recommended models:**
- `gemma3:12b` — good balance of quality and speed, runs on 16GB RAM
- `llama3.3:70b` — higher quality, requires 48GB+ RAM or GPU
- `mistral:7b` — fast, low memory, good for routine scanning tasks

**When to use:** privacy-sensitive deployments, no API budget, self-contained self-hosting.

**When not to use:** if your server has limited RAM (< 16GB), Ollama models will be slow or unavailable for the larger models that give better analysis quality.

---

### Claude CLI (Best Value If You Already Subscribe)

Claude CLI uses your existing Claude Code subscription — no API key needed, no additional cost. Blueprint calls `claude` on the command line using the authenticated session from your subscription.

This is the cheapest option if you already pay for Claude Code, because you are not charged per token on top of your subscription.

The pre-installed agents (Conductor, SEO Sentinel, Quill, Trend Spotter) default to Claude CLI using `claude-sonnet-4-20250514`.

**When to use:** if you have an active Claude Code subscription and want to avoid API costs.

**Setup:** no configuration needed beyond Blueprint being installed on a machine where the `claude` CLI is authenticated.

---

### Anthropic Claude

Direct Anthropic API access. Pay per token. Requires an API key from [console.anthropic.com](https://console.anthropic.com).

Set `ANTHROPIC_API_KEY` in your `.env` file or enter it at **Settings → LLM Providers → Anthropic**.

**Recommended models:**
- `claude-sonnet-4-20250514` — best analysis and reasoning quality; use for Conductor and analysis agents
- `claude-haiku-4-5-20251001` — faster and cheaper; use for routine monitoring agents (Sentinel, routine checks)

---

### OpenAI

Requires an API key from [platform.openai.com](https://platform.openai.com). Set `OPENAI_API_KEY`.

**Recommended models:**
- `gpt-4o` — high quality, good for analysis
- `gpt-4o-mini` — fast and cheap; good for high-frequency routine checks

---

### Google Gemini

Requires an API key from [aistudio.google.com](https://aistudio.google.com). Set `GOOGLE_GEMINI_API_KEY`.

**Recommended models:**
- `gemini-2.0-flash` — fast, large context window, good for agents processing large data sets
- `gemini-2.0-flash-lite` — cheapest option for high-frequency runs

---

### LM Studio

LM Studio provides a local OpenAI-compatible API server. Run models locally with a GUI, then point Blueprint at the LM Studio endpoint.

Configure the base URL in **Settings → LLM Providers → LM Studio**. Default: `http://localhost:1234`.

---

## Setting Up Providers

Navigate to **Settings → LLM Providers → Add Provider**. Select the provider, enter the API key (if required), and save. Blueprint tests the connection before saving.

The provider set here becomes the global default for all agents that do not have an explicit override in their `profile.yaml`.

---

## Per-Agent Override

Each agent's `profile.yaml` contains an `llm` block. To override the global default for a specific agent:

```yaml
llm:
  provider: anthropic          # anthropic | openai | gemini | ollama | lm-studio | claude-cli
  model: claude-sonnet-4-20250514
  temperature: 0.4
  max_tokens: 4096
  cost_cap_daily_usd: 2.00
```

Save the file. The change takes effect on the next run — no restart required.

You can also set a fallback provider that Blueprint uses if the primary is unavailable:

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  fallback_provider: ollama
  fallback_model: gemma3:12b
  cost_cap_daily_usd: 1.50
```

---

## Cost Caps

Every agent has a `cost_cap_daily_usd` field in its `profile.yaml`. If an agent's estimated token cost for the day reaches this cap, Conductor pauses it and logs a warning. The cap resets at midnight UTC.

| Agent | Default Daily Cap |
|-------|-------------------|
| Conductor | $2.00 |
| SEO Sentinel | $1.50 |
| Quill | $1.50 |
| Trend Spotter | $1.00 |

Conductor monitors total system spend. If the combined agent spend approaches a configurable system-wide cap, Conductor pauses lower-priority agents (P3-only runs) before cutting higher-priority ones.

---

## Which Model to Choose

| Use Case | Recommendation |
|----------|----------------|
| Analysis agents (Conductor, SEO Sentinel, Ledger) | Claude Sonnet 4 or GPT-4o |
| Content agents (Quill, Reporter) | Claude Sonnet 4 — best at following detailed brief formats |
| Routine monitoring (Sentinel, Velocity) | Claude Haiku or GPT-4o-mini — fast and cheap for frequent runs |
| Privacy-sensitive data | Ollama or LM Studio — data stays on your server |
| Lowest possible cost | Claude CLI (if subscribed) or Ollama |

For most setups: use **Claude CLI** for pre-installed agents (if you have the subscription) and **Ollama** as the fallback for anything where cost matters more than quality.
