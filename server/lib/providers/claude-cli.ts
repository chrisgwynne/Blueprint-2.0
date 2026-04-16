/**
 * Claude CLI provider — uses the locally installed `claude` CLI (Claude Code)
 * instead of the Anthropic API directly. No separate API key needed; uses
 * whatever credentials the Claude Code CLI is authenticated with.
 *
 * Requires: Claude Code CLI installed and authenticated (`claude --version` should work).
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CompleteOptions, CompleteResult, ProviderCredentials } from './types.js';

export const KNOWN_MODELS: string[] = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

export function estimateCost(): number {
  // Claude CLI uses the user's subscription — no per-token billing tracked here
  return 0;
}

class CLIError extends Error {
  isCLIError = true;
  constructor(message: string) {
    super(message);
    this.name = 'CLIError';
  }
}

interface CLIResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface CLIOptions {
  model: string;
  prompt: string;
  systemPrompt?: string;
}

function runClaudeCLI({ model, prompt, systemPrompt }: CLIOptions): Promise<CLIResult> {
  // Write both system prompt and user prompt to temp files to avoid Windows'
  // ~32K command-line argument length limit on long analysis payloads.
  const tmpDir = mkdtempSync(join(tmpdir(), 'bp-claude-'));
  const sysFile = join(tmpDir, 'system.txt');
  const promptFile = join(tmpDir, 'prompt.txt');
  let sysTmp = false;

  if (systemPrompt) {
    writeFileSync(sysFile, systemPrompt, 'utf8');
    sysTmp = true;
  }
  writeFileSync(promptFile, prompt, 'utf8');

  const cleanup = () => {
    try { unlinkSync(promptFile); } catch {}
    if (sysTmp) { try { unlinkSync(sysFile); } catch {} }
    try { rmdirSync(tmpDir); } catch {}
  };

  const TIMEOUT_MS = 300_000; // 5 minutes — investigation prompts can be large on CLI

  return new Promise((resolve, reject) => {
    const args: string[] = [
      '--print',
      '--output-format', 'json',
    ];

    // --dangerously-skip-permissions is refused when running as root for security.
    // In non-interactive --print mode there are no permission prompts anyway,
    // so we only pass it when not running as root.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (!isRoot) args.push('--dangerously-skip-permissions');

    if (model) args.push('--model', model);
    if (sysTmp) args.push('--system-prompt-file', sysFile);

    // Pipe prompt via stdin — avoids positional arg length limits
    args.push('--input-format', 'text');

    // Strip ANTHROPIC_API_KEY so the CLI uses its own OAuth/keychain auth.
    const childEnv = { ...process.env } as Record<string, string>;
    delete childEnv['ANTHROPIC_API_KEY'];

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Note: do NOT pass timeout here — spawn() ignores it in Node, and Bun
      // applies it as a hard SIGTERM which produces an unhelpful "code null" error.
      // We implement our own timeout below using setTimeout.
      env: childEnv,
      // Run from tmpDir so Claude Code doesn't pick up any CLAUDE.md context
      // from the project root, which would bleed into the LLM responses.
      cwd: tmpDir,
    });

    // Write prompt via stdin
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Implement real timeout — kills the process and gives a useful error.
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      cleanup();
      reject(new Error(
        `Claude CLI timed out after ${TIMEOUT_MS / 1000}s. ` +
        'The prompt may be too large, or the CLI is unresponsive. ' +
        'Run `claude --version` to verify the CLI is working.'
      ));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      if (err.code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Install Claude Code and ensure `claude` is in your PATH.'));
      } else {
        reject(new Error(`Claude CLI process error: ${err.message}`));
      }
    });

    proc.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      if (code !== 0) {
        if (signal) {
          reject(new Error(
            `Claude CLI was terminated by signal ${signal}. ` +
            'This usually means the process was killed externally or hit a system limit.'
          ));
        } else {
          const detail = stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300);
          reject(new Error(`Claude CLI exited with code ${code}.${detail ? ' ' + detail : ''}`));
        }
        return;
      }

      const raw = stdout.trim();

      if (!raw) {
        // Nothing on stdout — surface stderr so the user knows what happened
        const errDetail = stderr.trim().slice(0, 400);
        reject(new Error(
          `Claude CLI produced no output.${errDetail ? ' Stderr: ' + errDetail : ' Ensure Claude Code is authenticated — run `claude --version` and `claude /login` if needed.'}`
        ));
        return;
      }

      // Claude CLI --output-format json may output a single JSON object OR
      // newline-delimited JSON (NDJSON) with one object per line.
      // Scan lines in reverse to find the first { type:"result" } object.
      const tryExtract = (line: string): CLIResult | null => {
        const obj = JSON.parse(line.trim()) as {
          is_error?: boolean;
          result?: unknown;
          error?: unknown;
          type?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          total_cost_usd?: number;
        };
        if (obj.is_error) throw new CLIError(`Claude CLI error: ${String(obj.result ?? obj.error ?? 'Unknown error')}`);
        if (obj.type === 'result') {
          return {
            text: typeof obj.result === 'string' ? obj.result : '',
            inputTokens: obj.usage?.input_tokens ?? 0,
            outputTokens: obj.usage?.output_tokens ?? 0,
            costUsd: obj.total_cost_usd ?? 0,
          };
        }
        return null;
      };

      // Try single-object parse first (most common case)
      try {
        const found = tryExtract(raw);
        if (found) { resolve(found); return; }
      } catch (e) {
        if (e instanceof CLIError) { reject(e); return; }
        // Not a single JSON object — fall through to NDJSON handling
      }

      // NDJSON: scan lines in reverse for a type:"result" object
      const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const found = tryExtract(lines[i]!);
          if (found) { resolve(found); return; }
        } catch (e) {
          if (e instanceof CLIError) { reject(e); return; }
        }
      }

      // No structured result found — treat the whole output as plain text
      resolve({ text: raw, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    });
  });
}

export async function complete({ model, messages, system, max_tokens: _max_tokens = 4096 }: CompleteOptions): Promise<CompleteResult> {
  // Build the user prompt from messages array
  // For multi-turn, concatenate with role labels; for single-turn (most common), just the content
  let prompt: string;
  const first = messages[0];
  if (messages.length === 1 && first && first.role === 'user') {
    prompt = typeof first.content === 'string'
      ? first.content
      : first.content.map(c => c.text ?? '').join('');
  } else {
    prompt = messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map(c => c.text ?? '').join('');
      return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
    }).join('\n\n');
  }

  const { text, inputTokens, outputTokens, costUsd } = await runClaudeCLI({
    model: model || 'claude-sonnet-4-5',
    prompt,
    systemPrompt: system,
  });

  return {
    content: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    cost_usd: costUsd,
  };
}

export async function listModels(_creds?: ProviderCredentials): Promise<string[]> {
  return KNOWN_MODELS;
}

export async function validateApiKey(_creds?: ProviderCredentials): Promise<boolean> {
  // Validate by checking if `claude --version` works
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code: number | null) => resolve(code === 0));
  });
}
