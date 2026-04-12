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

export const KNOWN_MODELS = [
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];

export function estimateCost() {
  // Claude CLI uses the user's subscription — no per-token billing tracked here
  return 0;
}

function runClaudeCLI({ model, prompt, systemPrompt }) {
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

  return new Promise((resolve, reject) => {
    const args = [
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
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
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

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      cleanup();
      if (err.code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Install Claude Code and ensure `claude` is in your PATH.'));
      } else {
        reject(new Error(`Claude CLI process error: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300);
        reject(new Error(`Claude CLI exited with code ${code}. ${detail}`));
        return;
      }

      // Parse JSON output (--output-format json)
      // Claude CLI format: { type: "result", result: "<text>", total_cost_usd: <num>, usage: { input_tokens, output_tokens } }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.is_error) {
          reject(new Error(`Claude CLI error: ${parsed.result ?? 'Unknown error'}`));
          return;
        }
        const text = parsed.result ?? '';
        const inputTokens = parsed.usage?.input_tokens ?? 0;
        const outputTokens = parsed.usage?.output_tokens ?? 0;
        const costUsd = parsed.total_cost_usd ?? 0;
        resolve({ text, inputTokens, outputTokens, costUsd });
      } catch {
        // Fall back to raw text output
        resolve({ text: stdout.trim(), inputTokens: 0, outputTokens: 0, costUsd: 0 });
      }
    });
  });
}

export async function complete({ model, messages, system, max_tokens = 4096 }) {
  // Build the user prompt from messages array
  // For multi-turn, concatenate with role labels; for single-turn (most common), just the content
  let prompt;
  if (messages.length === 1 && messages[0].role === 'user') {
    prompt = typeof messages[0].content === 'string'
      ? messages[0].content
      : messages[0].content?.map(c => c.text ?? '').join('') ?? '';
  } else {
    prompt = messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content?.map(c => c.text ?? '').join('') ?? '';
      return `${m.role === 'user' ? 'Human' : 'Assistant'}: ${content}`;
    }).join('\n\n');
  }

  const { text, inputTokens, outputTokens, costUsd } = await runClaudeCLI({
    model: model || 'claude-sonnet-4-20250514',
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

export async function listModels() {
  return KNOWN_MODELS;
}

export async function validateApiKey() {
  // Validate by checking if `claude --version` works
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
