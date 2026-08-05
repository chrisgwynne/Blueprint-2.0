export interface ProviderErrorInfo {
  provider: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  category: string;
  message: string;
  terminalReason: string;
}

const MAX_MESSAGE_LENGTH = 220;

export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly category: string;

  constructor(provider: string, status: number, retryable: boolean, retryAfterMs?: number) {
    const category = retryable ? 'retryable' : 'non_retryable';
    super(`provider ${provider} http_${status} ${category}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.category = category;
  }
}

function inferStatus(message: string): number | undefined {
  const explicit = message.match(/\bhttp[_\s-]?(\d{3})\b/i)?.[1]
    ?? message.match(/\bapi error\s+(\d{3})\b/i)?.[1]
    ?? message.match(/\bstatus\s+(\d{3})\b/i)?.[1];
  const status = explicit ? Number(explicit) : NaN;
  return Number.isFinite(status) ? status : undefined;
}

function inferProvider(err: unknown, fallback = 'provider'): string {
  const direct = (err as { provider?: unknown })?.provider;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  const msg = String((err as Error)?.message ?? '');
  if (/google|gemini/i.test(msg)) return 'google';
  if (/anthropic|claude/i.test(msg)) return 'anthropic';
  if (/openai|gpt/i.test(msg)) return 'openai';
  if (/minimax/i.test(msg)) return 'minimax';
  return fallback;
}

export function isProviderErrorLike(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return (
    err instanceof ProviderHttpError ||
    typeof (err as { provider?: unknown })?.provider === 'string' ||
    typeof (err as { status?: unknown })?.status === 'number' ||
    /\b(Google|Gemini|OpenAI|Anthropic|MiniMax)\b/i.test(msg) ||
    /\bapi error\s+\d{3}\b/i.test(msg) ||
    /\bhttp[_\s-]?\d{3}\b/i.test(msg)
  );
}

function isRetryable(status: number | undefined, err: unknown): boolean {
  const direct = (err as { retryable?: unknown })?.retryable;
  if (typeof direct === 'boolean') return direct;
  return status === 429 || status === 503 || (typeof status === 'number' && status >= 500);
}

export function classifyProviderError(err: unknown, fallbackProvider = 'provider'): ProviderErrorInfo {
  const provider = inferProvider(err, fallbackProvider);
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : inferStatus(String((err as Error)?.message ?? err ?? ''));
  const retryable = isRetryable(status, err);
  const category = retryable ? 'retryable' : 'non_retryable';
  const retryAfterMs = typeof (err as { retryAfterMs?: unknown })?.retryAfterMs === 'number'
    ? Math.max(0, Math.floor((err as { retryAfterMs: number }).retryAfterMs))
    : undefined;
  const statusPart = status ? `http_${status}` : 'error';
  const message = `provider ${provider} ${statusPart} ${category}`.slice(0, MAX_MESSAGE_LENGTH);
  return {
    provider,
    status,
    retryable,
    retryAfterMs,
    category,
    message,
    terminalReason: status ? `provider_${category}_http_${status}` : `provider_${category}_error`,
  };
}

export function safeErrorMessage(err: unknown, fallbackProvider = 'provider'): string {
  if (isProviderErrorLike(err)) {
    return classifyProviderError(err, fallbackProvider).message;
  }
  return String((err as Error)?.message ?? err ?? 'Unknown error.')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/AIza[0-9A-Za-z_-]+/g, 'AIza[redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, 'sk-[redacted]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, MAX_MESSAGE_LENGTH);
}
