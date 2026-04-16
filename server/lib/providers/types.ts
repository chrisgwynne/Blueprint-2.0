/**
 * Shared types for LLM provider adapters.
 */

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface MessagePart {
  text?: string;
  [key: string]: unknown;
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | MessagePart[];
}

export interface CompleteOptions extends ProviderCredentials {
  messages: ProviderMessage[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface CompleteResult {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  cost_usd?: number;
}

export interface ProviderAdapter {
  KNOWN_MODELS?: string[];
  estimateCost?(model: string, inputTokens: number, outputTokens: number): number;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  listModels(creds?: ProviderCredentials): Promise<string[]>;
  validateApiKey(creds?: ProviderCredentials): Promise<boolean>;
}
