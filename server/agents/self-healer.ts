/**
 * Self-Healing Engine
 *
 * When an agent run or connector sync fails, this module:
 *   1. Gathers source code context from the stack trace
 *   2. Searches for known solutions (if a search connector is available)
 *   3. Produces an LLM diagnosis and proposed code fix
 *   4. Creates a GitHub issue for every diagnosable error
 *   5. Creates a DRAFT PR (targeting develop, never main) when confidence >= 75%
 *   6. Notifies via dashboard + records to KB
 *
 * SAFETY CONTRACT — enforced in code, not just docs:
 *   PR are always draft: true
 *   PRs always target 'develop', never 'main'
 *   Blueprint never auto-merges anything
 *   All healing is fire-and-forget (non-blocking)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'node:crypto';
import os from 'node:os';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import {
  createBlueprintIssue as _createBlueprintIssueRaw,
  createBlueprintPR,
  isBlueprintGitHubConfigured,
  isBlueprintGitHubEnabled,
} from '../lib/blueprint-github.js';
// Re-type createBlueprintIssue because JS default parameter infers labels: never[]
const createBlueprintIssue = _createBlueprintIssueRaw as unknown as (
  params: { title: string; body: string; labels?: string[] },
  db: unknown
) => Promise<GitHubIssue | null>;
import { wrapInContentBoundary } from '../lib/content-sanitiser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// Errors classes worth searching for solutions
const SEARCHABLE_PATTERNS = [
  'Cannot read propert',
  'is not a function',
  'SQLITE_ERROR',
  'fetch failed',
  'JSON parse error',
  'API error',
  'rate limit',
  'timed out',
  'ECONNREFUSED',
  'Unexpected token',
];

interface HealContext {
  agentId: string;
  runId: string | null;
  businessId: string;
  trigger?: string;
  label: string;
  extraContext?: string;
  requestContext?: RequestContext;
}

interface RequestContext {
  userAgent?: string;
  ip?: string;
  referer?: string;
  device?: string;
  os?: string;
}

interface EnvContext {
  node_version: string;
  platform: string;
  arch: string;
  os_type: string;
  os_release: string;
  hostname: string;
  uptime_seconds: number;
  timestamp: string;
  user_agent?: string;
  ip?: string;
  referer?: string;
  device?: string;
  os?: string;
}

interface HealingDiagnosis {
  diagnosis: string;
  root_cause: string;
  error_type: string;
  confidence: number;
  fix_description: string;
  fix_type: string;
  code_diff: string | null;
  test_to_verify: string;
  prevention: string;
  severity: string;
  affects_other_files: string[];
  safe_to_auto_propose: boolean;
}

interface SourceFile {
  path: string;
  error_line: number;
  content: string;
}

interface SourceContext {
  error_message: string;
  source_files: SourceFile[];
}

interface GitHubIssue {
  number: number;
  url?: string;
}

interface GitHubPR {
  number: number;
  url?: string;
}

interface PriorOccurrence {
  fingerprint: string;
  component: string;
  error_type: string | null;
  error_message: string;
  diagnosis: string | null;
  severity: string | null;
  confidence: number | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  env_context: string | null;
  last_business_id: string | null;
  last_run_id: string | null;
}

interface SearchResult {
  title: string;
  url?: string;
  content?: string;
  description?: string;
}

interface SearchResults {
  available: boolean;
  answer?: string;
  results?: SearchResult[];
}

interface BusinessRow {
  name: string;
}

/**
 * Fire-and-forget: diagnose an agent run failure and propose a fix.
 * Call from agent-runner.js catch block.
 */
export async function healAgentError(error: Error, { agentId, runId, businessId, trigger, requestContext }: {
  agentId: string;
  runId: string | null;
  businessId: string;
  trigger?: string;
  requestContext?: RequestContext;
}): Promise<void> {
  console.log(`[self-heal] Analysing error in '${agentId}' run ${runId}`);
  await _heal(error, {
    agentId: `agent:${agentId}`, runId, businessId, trigger,
    label: agentId, requestContext,
  });
}

/**
 * Fire-and-forget: diagnose an executor task failure.
 * Call from executor.js catch block.
 */
export async function healExecutorError(error: Error, task: Record<string, unknown>, requestContext?: RequestContext): Promise<void> {
  const businessId = task?.business_id as string | undefined;
  if (!businessId) return;
  const label = `executor:${task.action_type}`;
  console.log(`[self-heal] Analysing executor error in '${task.action_type}'`);
  await _heal(error, {
    agentId: label, runId: task.id as string | null, businessId, trigger: task.action_type as string,
    label, requestContext,
  });
}

/**
 * Fire-and-forget: diagnose a connector sync failure.
 * Call from scheduler.js sync catch block.
 */
export async function healConnectorError(error: Error, connectorType: string, businessId: string, requestContext?: RequestContext): Promise<void> {
  if (!businessId) return;
  const label = `connector:${connectorType}`;
  console.log(`[self-heal] Analysing connector error in '${connectorType}'`);
  await _heal(error, {
    agentId: label,
    runId: crypto.randomUUID(),
    businessId,
    trigger: 'connector_sync',
    label,
    extraContext: `connector source: server/connectors/${connectorType}/index.js`,
    requestContext,
  });
}

// ─── Core healing pipeline ────────────────────────────────────────────────────

async function _heal(error: Error, ctx: HealContext): Promise<void> {
  const { agentId, runId, businessId, trigger, label, extraContext, requestContext } = ctx;

  try {
    // Fingerprint the error so we can dedup and track recurrence.
    const fingerprint = createErrorFingerprint(error, label);

    // Check if we've seen this exact error before.
    const prior = loadPriorOccurrence(fingerprint);

    // Capture the environment (node, os, process + any request context
    // the caller was able to pass in — UA, IP, etc.)
    const envContext = captureEnvContext(requestContext);

    // If we've seen this fingerprint before, just bump the counter and decide
    // whether to re-notify. No new LLM diagnosis, no new GitHub issue.
    if (prior) {
      const { shouldNotify, reason } = shouldRenotify(prior);
      bumpOccurrence(fingerprint, { businessId, runId, envContext });
      console.log(
        `[self-heal] Recurrence #${prior.occurrence_count + 1} for '${label}' ` +
        `(fingerprint ${fingerprint.slice(0, 8)}): ${shouldNotify ? `notify — ${reason}` : 'throttled'}`
      );
      if (shouldNotify) {
        markNotified(fingerprint);
        await sendRecurrenceNotification(prior, error, {
          agentId, businessId, label, occurrenceCount: prior.occurrence_count + 1,
        });
      }
      return;
    }

    // First time seeing this fingerprint — run full diagnosis pipeline.
    const sourceCtx = gatherSourceContext(error);
    const searchResults = await searchForSolution(error, businessId).catch(() => null);
    const healing = await diagnoseAndFix(error, sourceCtx, searchResults, label, extraContext);

    if (!healing) {
      console.log(`[self-heal] Could not diagnose error in '${label}' (no healing output)`);
      // Still record the fingerprint so future identical errors can dedup.
      recordFirstOccurrence(fingerprint, {
        component: label, errorMessage: error.message,
        businessId, runId, envContext,
      });
      return;
    }

    // Opt-out check: only reach GitHub if the user hasn't disabled the
    // integration in Settings. When disabled, we still log, notify, and
    // file to KB — we just don't touch GitHub.
    const ghEnabled = isBlueprintGitHubEnabled(db);

    let issue: GitHubIssue | null = null;
    let pr: GitHubPR | null = null;
    if (ghEnabled) {
      issue = await createHealingIssue(healing, error, {
        agentId, runId, businessId, trigger, label, envContext,
      });
      if (healing.code_diff && healing.confidence >= 0.75 && healing.safe_to_auto_propose) {
        pr = await createHealingPR(healing, issue, { agentId, runId, businessId, label });
      }
    } else {
      console.log(
        `[self-heal] Blueprint GitHub disabled in Settings — skipping issue/PR for '${label}'`
      );
    }

    // Persist the first occurrence with issue/PR links so future duplicates
    // know where the existing report lives.
    recordFirstOccurrence(fingerprint, {
      component: label,
      errorType: healing.error_type,
      errorMessage: error.message,
      diagnosis: healing.diagnosis,
      severity: healing.severity,
      confidence: healing.confidence,
      issue, pr,
      businessId, runId, envContext,
    });

    await recordHealingNotification(healing, issue, pr, error, { agentId, businessId, label });
    markNotified(fingerprint);
    await fileHealingToKB(healing, error, { agentId, runId, businessId });
  } catch (healErr) {
    console.warn(`[self-heal] Healing pipeline failed for '${label}':`, (healErr as Error).message);
  }
}

// ─── Fingerprinting + recurrence tracking ────────────────────────────────────

function createErrorFingerprint(error: Error, label: string): string {
  const rawMsg = error?.message ?? '';
  const normalisedMsg = rawMsg
    .replace(/\b[0-9a-f]{8,}\b/gi, '{id}')       // hex ids / uuids
    .replace(/\b\d{10,}\b/g, '{ts}')              // unix timestamps
    .replace(/\b\d+\b/g, '{n}')                   // loose numbers
    .replace(/\s+/g, ' ')
    .slice(0, 240);

  const stackLine = (error?.stack ?? '')
    .split('\n')
    .find(l => l.includes('.js:') && !l.includes('node_modules')) || '';
  const framePart = (stackLine.match(/\((.+\.js):(\d+):/) || stackLine.match(/at (.+\.js):(\d+):/) || [])
    .slice(1, 3).join(':');

  return crypto
    .createHash('sha256')
    .update(`${label}|${normalisedMsg}|${framePart}`)
    .digest('hex');
}

function loadPriorOccurrence(fingerprint: string): PriorOccurrence | null {
  try {
    return (db.prepare(
      'SELECT * FROM self_heal_log WHERE fingerprint = ?'
    ).get(fingerprint) as PriorOccurrence | null) || null;
  } catch {
    return null;
  }
}

function recordFirstOccurrence(fingerprint: string, data: {
  component: string;
  errorType?: string;
  errorMessage: string;
  diagnosis?: string;
  severity?: string;
  confidence?: number;
  issue?: GitHubIssue | null;
  pr?: GitHubPR | null;
  businessId: string;
  runId: string | null;
  envContext: EnvContext;
}): void {
  try {
    db.prepare(`
      INSERT INTO self_heal_log (
        fingerprint, component, error_type, error_message, diagnosis,
        severity, confidence, occurrence_count,
        first_seen_at, last_seen_at,
        github_issue_number, github_issue_url,
        github_pr_number, github_pr_url,
        env_context, last_business_id, last_run_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, 1,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(fingerprint) DO UPDATE SET
        last_seen_at     = CURRENT_TIMESTAMP,
        occurrence_count = occurrence_count + 1,
        last_business_id = excluded.last_business_id,
        last_run_id      = excluded.last_run_id
    `).run(
      fingerprint,
      data.component,
      data.errorType ?? null,
      (data.errorMessage ?? '').slice(0, 2000),
      (data.diagnosis ?? '').slice(0, 2000),
      data.severity ?? null,
      data.confidence ?? null,
      data.issue?.number ?? null,
      data.issue?.url ?? null,
      data.pr?.number ?? null,
      data.pr?.url ?? null,
      JSON.stringify(data.envContext ?? {}),
      data.businessId ?? null,
      data.runId ?? null,
    );
  } catch (err) {
    console.warn('[self-heal] Could not record first occurrence:', (err as Error).message);
  }
}

function bumpOccurrence(fingerprint: string, { businessId, runId, envContext }: {
  businessId: string;
  runId: string | null;
  envContext: EnvContext;
}): void {
  try {
    db.prepare(`
      UPDATE self_heal_log
         SET occurrence_count = occurrence_count + 1,
             last_seen_at     = CURRENT_TIMESTAMP,
             last_business_id = COALESCE(?, last_business_id),
             last_run_id      = COALESCE(?, last_run_id),
             env_context      = COALESCE(?, env_context)
       WHERE fingerprint = ?
    `).run(
      businessId ?? null,
      runId ?? null,
      envContext ? JSON.stringify(envContext) : null,
      fingerprint,
    );
  } catch (err) {
    console.warn('[self-heal] Could not bump occurrence:', (err as Error).message);
  }
}

function markNotified(fingerprint: string): void {
  try {
    db.prepare(
      'UPDATE self_heal_log SET last_notified_at = CURRENT_TIMESTAMP WHERE fingerprint = ?'
    ).run(fingerprint);
  } catch {}
}

// ─── Notification throttling ────────────────────────────────────────────────
//
// To avoid spamming Telegram with "same error again" pings, we only re-notify:
//   - on the 1st, 10th, 50th, 100th, 500th, 1000th occurrence
//   - OR if >24h have passed since the last notification
// Everything in between is silent — the count is still incremented in the
// self_heal_log row so the UI shows accurate numbers.

const NOTIFY_AT_COUNTS = new Set([1, 10, 50, 100, 500, 1000, 5000, 10000]);
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function shouldRenotify(prior: PriorOccurrence): { shouldNotify: boolean; reason: string } {
  const nextCount = (prior.occurrence_count ?? 0) + 1;
  if (NOTIFY_AT_COUNTS.has(nextCount)) {
    return { shouldNotify: true, reason: `milestone count=${nextCount}` };
  }
  if (!prior.last_notified_at) {
    return { shouldNotify: true, reason: 'no prior notification' };
  }
  const lastMs = new Date(prior.last_notified_at + 'Z').getTime();
  if (Number.isFinite(lastMs) && Date.now() - lastMs > NOTIFY_COOLDOWN_MS) {
    return { shouldNotify: true, reason: 'cooldown elapsed' };
  }
  return { shouldNotify: false, reason: 'throttled' };
}

async function sendRecurrenceNotification(prior: PriorOccurrence, error: Error, { agentId, businessId, label, occurrenceCount }: {
  agentId: string;
  businessId: string;
  label: string;
  occurrenceCount: number;
}): Promise<void> {
  try {
    const { dispatch } = await import('../notifications/dispatcher.js') as unknown as {
      dispatch: (opts: Record<string, unknown>) => Promise<void>;
    };
    const body = [
      `Error has now occurred ${occurrenceCount}× (first seen ${prior.first_seen_at}).`,
      `Message: ${(error.message ?? '').slice(0, 120)}`,
      prior.github_issue_url
        ? `Existing issue: ${prior.github_issue_url}`
        : 'No GitHub issue (disabled or not configured).',
      prior.github_pr_url
        ? `Existing draft PR: ${prior.github_pr_url}`
        : '',
    ].filter(Boolean).join('\n');

    await dispatch({
      business_id: businessId,
      channel: 'dashboard',
      severity: 'warning',
      title: `Self-heal recurrence: ${label} (×${occurrenceCount})`,
      body,
      entity_type: 'self_heal',
      entity_id: null,
    }).catch(() => {});

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      await dispatch({
        business_id: businessId,
        channel: 'telegram',
        severity: 'warning',
        title: `Self-heal recurrence: ${label} (×${occurrenceCount})`,
        body,
        entity_type: 'self_heal',
        entity_id: null,
      }).catch(() => {});
    }
  } catch {}
}

// ─── Environment context capture ─────────────────────────────────────────────

function captureEnvContext(requestContext?: RequestContext): EnvContext {
  const ctx: EnvContext = {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os_type: os.type(),
    os_release: os.release(),
    hostname: os.hostname(),
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
  if (requestContext && typeof requestContext === 'object') {
    if (requestContext.userAgent) ctx.user_agent = String(requestContext.userAgent).slice(0, 500);
    if (requestContext.ip)        ctx.ip         = String(requestContext.ip).slice(0, 64);
    if (requestContext.referer)   ctx.referer    = String(requestContext.referer).slice(0, 500);
    if (requestContext.device)    ctx.device     = String(requestContext.device).slice(0, 120);
    if (requestContext.os)        ctx.os         = String(requestContext.os).slice(0, 120);
  }
  return ctx;
}

// ─── Source context ───────────────────────────────────────────────────────────

function gatherSourceContext(error: Error): SourceContext {
  const ctx: SourceContext = { error_message: error.message, source_files: [] };

  const stackLines = (error.stack || '').split('\n');
  const frames = stackLines
    .filter(l => l.includes('.js:') && !l.includes('node_modules') && l.includes('Blueprint'))
    .map(l => {
      const m = l.match(/\((.+\.js):(\d+):\d+\)/) || l.match(/at (.+\.js):(\d+):\d+/);
      return m ? { file: m[1] ?? '', line: parseInt(m[2] ?? '0') } : null;
    })
    .filter((f): f is { file: string; line: number } => f !== null)
    .slice(0, 3);

  for (const frame of frames) {
    const absPath = frame.file.startsWith('/') ? frame.file : resolve(ROOT, frame.file);
    if (existsSync(absPath)) {
      try {
        const lines = readFileSync(absPath, 'utf8').split('\n');
        const start = Math.max(0, frame.line - 12);
        const end = Math.min(lines.length, frame.line + 12);
        ctx.source_files.push({
          path: frame.file.replace(ROOT + '/', ''),
          error_line: frame.line,
          content: lines.slice(start, end).map((l, i) => `${start + i + 1}${i + start + 1 === frame.line ? ' >' : '  '} ${l}`).join('\n'),
        });
      } catch {}
    }
  }
  return ctx;
}

// ─── Solution search ──────────────────────────────────────────────────────────

async function searchForSolution(error: Error, businessId: string): Promise<SearchResults | null> {
  if (!SEARCHABLE_PATTERNS.some(p => error.message.includes(p))) return null;
  try {
    const { agentSearch } = await import('./tools/search.js') as unknown as {
      agentSearch: (query: string, opts: Record<string, unknown>, businessId: string, db: unknown) => Promise<SearchResults>;
    };
    const cleanMsg = error.message
      .replace(/\/[^\s]+\.js:\d+/g, '')
      .replace(/\bat\s+\S+/g, '')
      .slice(0, 100);
    const result = await agentSearch(
      `Node.js Blueprint "${cleanMsg}" fix`,
      { search_depth: 'basic', max_results: 3 },
      businessId, db
    );
    return result.available ? result : null;
  } catch {
    return null;
  }
}

// ─── LLM diagnosis ───────────────────────────────────────────────────────────

async function diagnoseAndFix(error: Error, sourceCtx: SourceContext, searchResults: SearchResults | null, label: string, extraContext?: string): Promise<HealingDiagnosis | null> {
  const prompt = `You are Blueprint's self-healing system.
An error occurred. Diagnose it and propose a minimal, safe code fix.

## ERROR
${error.message}

## STACK TRACE (first 10 lines)
${error.stack?.split('\n').slice(0, 10).join('\n') ?? '(no stack)'}

## CONTEXT
Label: ${label}
${extraContext ? extraContext + '\n' : ''}
${sourceCtx.source_files.map(f => `
File: ${f.path} (error near line ${f.error_line})
\`\`\`
${f.content}
\`\`\`
`).join('\n')}

${searchResults?.results?.length ? `
## SEARCH RESULTS
${wrapInContentBoundary(
  searchResults.results.slice(0, 2).map(r =>
    `**${r.title}**\n${(r.content || r.description || '').slice(0, 300)}`
  ).join('\n\n'),
  'self-healer:search'
)}
` : ''}

Produce diagnosis as JSON:
{
  "diagnosis": "Plain English: what went wrong and why",
  "root_cause": "Specific technical root cause (one sentence)",
  "error_type": "null_reference|type_error|api_error|parse_error|timeout|db_error|logic_error|other",
  "confidence": 0.0,
  "fix_description": "What the fix does (plain English)",
  "fix_type": "null_check|error_handling|api_update|logic_fix|config_fix|other",
  "code_diff": "Unified diff of the fix, or null if you cannot determine a safe fix",
  "test_to_verify": "How to verify the fix worked",
  "prevention": "How to prevent this class of error in future",
  "severity": "critical|high|medium|low",
  "affects_other_files": [],
  "safe_to_auto_propose": false
}

Set safe_to_auto_propose: true ONLY for purely defensive fixes:
null checks, try/catch wrappers, default value guards.
Set it false for any change that affects logic or behaviour.
Set code_diff to null if you are not confident in the fix.`;

  try {
    // Use whatever LLM the user has configured — never hardcode.
    const { providerId, model } = resolveProfileLLM({});
    const result = await runLLM(providerId, model, {
      messages: [{ role: 'user', content: prompt }],
      system: 'Return only valid JSON. Be conservative — only propose fixes you are confident about.',
      temperature: 0.1,
      max_tokens: 2000,
    });
    const raw = result?.content ?? '';
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    return JSON.parse((m?.[1] ?? raw).trim()) as HealingDiagnosis;
  } catch (e) {
    console.warn('[self-heal] diagnoseAndFix LLM failed:', (e as Error).message);
    return null;
  }
}

// ─── GitHub issue (Blueprint repo only) ──────────────────────────────────────

async function createHealingIssue(healing: HealingDiagnosis, error: Error, { agentId, runId, businessId, label, envContext }: {
  agentId: string;
  runId: string | null;
  businessId: string;
  trigger?: string;
  label: string;
  envContext: EnvContext;
}): Promise<GitHubIssue | null> {
  // Verify Blueprint GitHub is configured before attempting
  const githubStatus = await isBlueprintGitHubConfigured(db).catch(() => ({ configured: false, error: 'check failed' })) as { configured: boolean; error?: string };
  if (!githubStatus.configured) {
    console.warn('[self-heal] Blueprint GitHub not configured:', githubStatus.error);
    return null;
  }

  const business = db.prepare('SELECT name FROM businesses WHERE id = ?').get(businessId) as BusinessRow | null;
  const envLines = envContext
    ? Object.entries(envContext).map(([k, v]) => `- **${k}**: ${v}`).join('\n')
    : '(not captured)';

  const issueBody = `## Bug Report: ${healing.root_cause}

**Detected by:** Blueprint Self-Healing System
**Component:** \`${label}\`
**Run ID:** \`${runId}\`
**Business context:** ${business?.name ?? businessId}
**Error type:** ${healing.error_type}
**Severity:** ${healing.severity}

## Environment
${envLines}

## Error
\`\`\`
${error.message}
\`\`\`

## Diagnosis
${healing.diagnosis}

**Root cause:** ${healing.root_cause}

## Proposed Fix
${healing.fix_description}

\`\`\`diff
${healing.code_diff ?? '(No automatic fix determined — manual investigation needed)'}
\`\`\`

## How to verify
${healing.test_to_verify}

## Prevention
${healing.prevention}

${healing.affects_other_files?.length ? `\n## Other files that may need the same fix\n${healing.affects_other_files.map(f => `- \`${f}\``).join('\n')}` : ''}

---
*Automatically created by Blueprint's self-healing system.*
*Fix confidence: ${Math.round((healing.confidence ?? 0) * 100)}%*
${healing.safe_to_auto_propose && healing.code_diff ? '*A draft PR has been opened with the proposed fix.*' : ''}`;

  try {
    const issue = await createBlueprintIssue({
      title: `[Auto] ${healing.root_cause.slice(0, 80)} in ${label}`,
      body: issueBody,
      labels: ['bug', 'self-healing', healing.severity, `blueprint:${label.split(':')[0]}`],
    }, db) as GitHubIssue;
    console.log(`[self-heal] Blueprint GitHub issue #${issue?.number} created for '${label}'`);
    return issue;
  } catch (ghErr) {
    console.warn('[self-heal] GitHub issue creation failed (non-fatal):', (ghErr as Error).message);
    return null;
  }
}

// ─── Draft PR (Blueprint repo only) ──────────────────────────────────────────

async function createHealingPR(healing: HealingDiagnosis, issue: GitHubIssue | null, { agentId, runId, businessId, label }: {
  agentId: string;
  runId: string | null;
  businessId: string;
  label: string;
}): Promise<GitHubPR | null> {
  if (!healing.code_diff) return null;

  const prBody = `## Fix: ${healing.root_cause}

${issue?.number ? `Closes #${issue.number}\n` : ''}
### What this fixes
${healing.fix_description}

### Change
\`\`\`diff
${healing.code_diff}
\`\`\`

### How to verify
${healing.test_to_verify}

---
This PR was created automatically by Blueprint's self-healing system.
**Review carefully before merging.**
- Confidence: ${Math.round((healing.confidence ?? 0) * 100)}%
- Fix type: ${healing.fix_type}
- This PR targets \`develop\` — never \`main\``;

  try {
    // SAFETY: createBlueprintPR always sets draft:true and base:'develop'
    const pr = await createBlueprintPR({
      title: `fix: ${healing.root_cause.slice(0, 70)} in ${label}`,
      body: prBody,
      branch: `${label.replace(/[^a-z0-9-]/gi, '-')}-${(runId ?? '').slice(0, 8)}`,
      diff: healing.code_diff,
    }, db) as GitHubPR;
    console.log(`[self-heal] Draft PR #${pr?.number} created for '${label}'`);
    return pr;
  } catch (prErr) {
    console.warn('[self-heal] Draft PR creation failed (non-fatal):', (prErr as Error).message);
    return null;
  }
}

// ─── Notification + KB ────────────────────────────────────────────────────────

async function recordHealingNotification(healing: HealingDiagnosis, issue: GitHubIssue | null, pr: GitHubPR | null, error: Error, { agentId, businessId, label }: {
  agentId: string;
  businessId: string;
  label: string;
}): Promise<void> {
  const severity = healing.severity === 'critical' ? 'critical' : 'warning';
  const title = `Self-heal: ${label} error detected`;

  const bodyLines = [
    `Error: ${error.message.slice(0, 100)}`,
    `Diagnosis: ${(healing.diagnosis ?? '').slice(0, 150)}`,
    issue?.url
      ? `GitHub issue #${issue.number}: ${issue.url}`
      : issue?.number
        ? `GitHub issue #${issue.number} created`
        : 'Blueprint GitHub not configured — no issue created',
    pr?.url
      ? `Draft PR #${pr.number}: ${pr.url}`
      : (healing.code_diff && (healing.confidence ?? 0) >= 0.75)
        ? 'Draft PR not created — configure BLUEPRINT_GITHUB_TOKEN'
        : 'Manual fix needed',
  ].filter(Boolean);

  try {
    const { dispatch } = await import('../notifications/dispatcher.js') as unknown as {
      dispatch: (opts: Record<string, unknown>) => Promise<void>;
    };

    // Dashboard notification
    await dispatch({
      business_id: businessId,
      channel: 'dashboard',
      severity,
      title,
      body: bodyLines.join('\n'),
      entity_type: 'self_heal',
      entity_id: null,
    }).catch(() => {});

    // Telegram notification if configured
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      await dispatch({
        business_id: businessId,
        channel: 'telegram',
        severity,
        title: `Blueprint Self-Heal: ${label}`,
        body: [
          `Error: ${error.message.slice(0, 80)}`,
          `Diagnosis: ${(healing.diagnosis ?? '').slice(0, 100)}`,
          '',
          issue?.url
            ? `Issue: github.com/chrisgwynne/Blueprint/issues/${issue.number}`
            : 'No GitHub issue (token not configured)',
          pr?.url
            ? `Draft PR: github.com/chrisgwynne/Blueprint/pull/${pr.number}`
            : (healing.confidence ?? 0) >= 0.75
              ? 'PR not created (configure BLUEPRINT_GITHUB_TOKEN)'
              : 'Manual fix needed',
        ].join('\n'),
        entity_type: 'self_heal',
        entity_id: null,
      }).catch(() => {});
    }
  } catch {}
}

async function fileHealingToKB(healing: HealingDiagnosis, error: Error, { agentId, runId, businessId }: {
  agentId: string;
  runId: string | null;
  businessId: string;
}): Promise<void> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
      getKBForBusiness: (id: string) => Promise<{ engine?: { writeFile: (...args: unknown[]) => Promise<void> } } | null>;
    };
    const kb = await getKBForBusiness(businessId);
    if (!kb?.engine) return;
    const date = new Date().toISOString().split('T')[0];
    const slug = runId?.slice(0, 6) ?? 'unknown';
    await kb.engine.writeFile(
      `decisions/self-heal-${date}-${slug}.md`,
      `# Self-Healing Event

**Date:** ${date}
**Component:** ${agentId}
**Severity:** ${healing.severity}

## Error
\`${error.message}\`

## Diagnosis
${healing.diagnosis}

## Fix proposed
${healing.fix_description}

## Status
${(healing.code_diff && (healing.confidence ?? 0) >= 0.75)
  ? 'Draft PR created — awaiting human review'
  : 'No automatic fix — manual investigation needed'}

## Prevention
${healing.prevention}
`,
      { title: `Self-heal: ${healing.root_cause?.slice(0, 60)}`, tags: ['self-healing', 'bug'],
        written_by: 'self-healer', review_status: 'auto_approved' },
      `self-heal: ${healing.root_cause?.slice(0, 50)}`
    );
  } catch {}
}
