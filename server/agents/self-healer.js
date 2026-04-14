/**
 * Self-Healing Engine
 *
 * When an agent run or connector sync fails, this module:
 *   1. Gathers source code context from the stack trace
 *   2. Searches for known solutions (if a search connector is available)
 *   3. Produces an LLM diagnosis and proposed code fix
 *   4. Creates a GitHub issue for every diagnosable error
 *   5. Creates a DRAFT PR (targeting develop, never main) when confidence ≥ 75%
 *   6. Notifies via dashboard + records to KB
 *
 * SAFETY CONTRACT — enforced in code, not just docs:
 *   ✓ PRs are always draft: true
 *   ✓ PRs always target 'develop', never 'main'
 *   ✓ Blueprint never auto-merges anything
 *   ✓ All healing is fire-and-forget (non-blocking)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'node:crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { decrypt } from '../crypto.js';

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

/**
 * Fire-and-forget: diagnose an agent run failure and propose a fix.
 * Call from agent-runner.js catch block.
 */
export async function healAgentError(error, { agentId, runId, businessId, trigger }) {
  console.log(`[self-heal] Analysing error in '${agentId}' run ${runId}`);
  await _heal(error, { agentId: `agent:${agentId}`, runId, businessId, trigger, label: agentId });
}

/**
 * Fire-and-forget: diagnose an executor task failure.
 * Call from executor.js catch block.
 */
export async function healExecutorError(error, task) {
  const businessId = task?.business_id;
  if (!businessId) return;
  const label = `executor:${task.action_type}`;
  console.log(`[self-heal] Analysing executor error in '${task.action_type}'`);
  await _heal(error, { agentId: label, runId: task.id, businessId, trigger: task.action_type, label });
}

/**
 * Fire-and-forget: diagnose a connector sync failure.
 * Call from scheduler.js sync catch block.
 */
export async function healConnectorError(error, connectorType, businessId) {
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
  });
}

// ─── Core healing pipeline ────────────────────────────────────────────────────

async function _heal(error, ctx) {
  const { agentId, runId, businessId, trigger, label, extraContext } = ctx;

  try {
    const sourceCtx = gatherSourceContext(error);
    const searchResults = await searchForSolution(error, businessId).catch(() => null);
    const healing = await diagnoseAndFix(error, sourceCtx, searchResults, label, extraContext);

    if (!healing) {
      console.log(`[self-heal] Could not diagnose error in '${label}' (no healing output)`);
      return;
    }

    const issue = await createHealingIssue(healing, error, { agentId, runId, businessId, trigger, label });
    if (healing.code_diff && healing.confidence >= 0.75 && healing.safe_to_auto_propose) {
      await createHealingPR(healing, issue, { agentId, runId, businessId, label });
    }

    await recordHealingNotification(healing, issue, error, { agentId, businessId, label });
    await fileHealingToKB(healing, error, { agentId, runId, businessId });
  } catch (healErr) {
    console.warn(`[self-heal] Healing pipeline failed for '${label}':`, healErr.message);
  }
}

// ─── Source context ───────────────────────────────────────────────────────────

function gatherSourceContext(error) {
  const ctx = { error_message: error.message, source_files: [] };

  const stackLines = (error.stack || '').split('\n');
  const frames = stackLines
    .filter(l => l.includes('.js:') && !l.includes('node_modules') && l.includes('Blueprint'))
    .map(l => {
      const m = l.match(/\((.+\.js):(\d+):\d+\)/) || l.match(/at (.+\.js):(\d+):\d+/);
      return m ? { file: m[1], line: parseInt(m[2]) } : null;
    })
    .filter(Boolean)
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

async function searchForSolution(error, businessId) {
  if (!SEARCHABLE_PATTERNS.some(p => error.message.includes(p))) return null;
  try {
    const { agentSearch } = await import('./tools/search.js');
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

async function diagnoseAndFix(error, sourceCtx, searchResults, label, extraContext) {
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
${searchResults.results.slice(0, 2).map(r =>
  `**${r.title}**\n${(r.content || r.description || '').slice(0, 300)}`
).join('\n\n')}
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
    const { providerId, model } = resolveProfileLLM({ model: 'claude-sonnet-4-5' });
    const result = await runLLM(providerId, model, {
      messages: [{ role: 'user', content: prompt }],
      system: 'Return only valid JSON. Be conservative — only propose fixes you are confident about.',
      temperature: 0.1,
      max_tokens: 2000,
    });
    const raw = result?.content ?? '';
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    return JSON.parse((m ? m[1] : raw).trim());
  } catch (e) {
    console.warn('[self-heal] diagnoseAndFix LLM failed:', e.message);
    return null;
  }
}

// ─── GitHub issue ─────────────────────────────────────────────────────────────

async function createHealingIssue(healing, error, { agentId, runId, businessId, label }) {
  const ghRow = db.prepare(
    `SELECT * FROM connectors WHERE business_id = ? AND type = 'github' AND status = 'active' LIMIT 1`
  ).get(businessId);
  if (!ghRow) return null;

  const business = db.prepare('SELECT name FROM businesses WHERE id = ?').get(businessId);

  const issueBody = `## Bug Report: ${healing.root_cause}

**Detected by:** Blueprint Self-Healing System
**Component:** \`${label}\`
**Run ID:** \`${runId}\`
**Business:** ${business?.name ?? businessId}
**Error type:** ${healing.error_type}
**Severity:** ${healing.severity}

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
    const ghCreds = JSON.parse(decrypt(ghRow.credentials));
    const ghConfig = JSON.parse(ghRow.config || '{}');
    const owner = ghCreds.owner || ghConfig.owner;
    const repo = (ghCreds.repos || ghConfig.repos || '').split(',')[0]?.trim();
    if (!owner || !repo) return null;

    const { default: github } = await import('../connectors/github/index.js');
    const issue = await github.createIssue(ghCreds, owner, repo, {
      title: `[Auto] ${healing.root_cause.slice(0, 80)} in ${label}`,
      body: issueBody,
      labels: ['bug', 'self-healing', healing.severity, `blueprint:${label.split(':')[0]}`],
    });
    console.log(`[self-heal] GitHub issue #${issue?.number} created for '${label}'`);
    return issue;
  } catch (ghErr) {
    console.warn('[self-heal] GitHub issue creation failed (non-fatal):', ghErr.message);
    return null;
  }
}

// ─── Draft PR ─────────────────────────────────────────────────────────────────

async function createHealingPR(healing, issue, { agentId, businessId, label }) {
  if (!healing.code_diff) return;

  const ghRow = db.prepare(
    `SELECT * FROM connectors WHERE business_id = ? AND type = 'github' AND status = 'active' LIMIT 1`
  ).get(businessId);
  if (!ghRow) return;

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
⚠️ **This PR was created automatically by Blueprint's self-healing system.**
**Review carefully before merging.**
- Confidence: ${Math.round((healing.confidence ?? 0) * 100)}%
- Fix type: ${healing.fix_type}
- This PR targets \`develop\` — never \`main\``;

  try {
    const ghCreds = JSON.parse(decrypt(ghRow.credentials));
    const ghConfig = JSON.parse(ghRow.config || '{}');
    const owner = ghCreds.owner || ghConfig.owner;
    const repo = (ghCreds.repos || ghConfig.repos || '').split(',')[0]?.trim();
    if (!owner || !repo) return;

    const { default: github } = await import('../connectors/github/index.js');
    // SAFETY: always draft: true, always base: 'develop', never 'main'
    const pr = await github.createPR(ghCreds, owner, repo, {
      title: `fix: ${healing.root_cause.slice(0, 70)} in ${label}`,
      body: prBody,
      head: `self-heal/${label.replace(/[^a-z0-9-]/gi, '-')}-${Date.now()}`,
      base: 'develop',   // NEVER main
      draft: true,       // ALWAYS draft
    });
    console.log(`[self-heal] Draft PR #${pr?.number} created for '${label}'`);
  } catch (prErr) {
    console.warn('[self-heal] Draft PR creation failed (non-fatal):', prErr.message);
  }
}

// ─── Notification + KB ────────────────────────────────────────────────────────

async function recordHealingNotification(healing, issue, error, { agentId, businessId, label }) {
  try {
    const { generateId } = await import('../db/db.js');
    db.prepare(`
      INSERT INTO notifications
        (id, business_id, channel, severity, title, body, entity_type, entity_id, created_at)
      VALUES (?, ?, 'dashboard', ?, ?, ?, 'self_heal', ?, CURRENT_TIMESTAMP)
    `).run(
      generateId(),
      businessId,
      healing.severity === 'critical' ? 'critical' : 'warning',
      `Self-heal: ${label} error detected`,
      [
        `Error: ${error.message.slice(0, 100)}`,
        `Diagnosis: ${(healing.diagnosis ?? '').slice(0, 150)}`,
        issue?.number ? `GitHub issue #${issue.number} created` : '',
        (healing.code_diff && (healing.confidence ?? 0) >= 0.75)
          ? 'Draft PR created — review before merging'
          : 'Manual review needed',
      ].filter(Boolean).join('\n'),
      null
    );
  } catch {}
}

async function fileHealingToKB(healing, error, { agentId, runId, businessId }) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
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
  ? '✅ Draft PR created — awaiting human review'
  : '⚠️ No automatic fix — manual investigation needed'}

## Prevention
${healing.prevention}
`,
      { title: `Self-heal: ${healing.root_cause?.slice(0, 60)}`, tags: ['self-healing', 'bug'],
        written_by: 'self-healer', review_status: 'auto_approved' },
      `self-heal: ${healing.root_cause?.slice(0, 50)}`
    );
  } catch {}
}
