// ─── LLM provider types ───────────────────────────────────────────────────────

export type LLMProviderName =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'ollama'
  | 'lmstudio'
  | 'minimax'
  | 'custom'
  | 'claude-cli';

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  model?: string;
  messages: LLMMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: LLMTool[];
  provider?: LLMProviderName;
  /** Track costs — business + agent context */
  business_id?: string;
  agent_id?: string;
  run_id?: string;
}

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: LLMUsage;
  stop_reason: string;
  provider: LLMProviderName;
  cost_usd?: number;
}

export interface LLMProvider {
  name: LLMProviderName;
  call(request: LLMRequest): Promise<LLMResponse>;
}

/** Config for a specific LLM provider, stored in settings */
export interface LLMProviderConfig {
  provider: LLMProviderName;
  model: string;
  api_key?: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
}
