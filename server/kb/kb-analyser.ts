/**
 * KB Analyser — makes the KB an active participant in the mesh.
 *
 * Reads recently-modified KB files and asks the LLM to identify:
 *   - signals: anomalies, risks, opportunities the content implies
 *   - tasks: specific actions implied by the content
 *   - connector_gaps: data sources mentioned/implied but not connected
 *   - contradictions: KB entries that disagree with each other
 *   - compounding_insights: connections between entries that create more
 *     significant insights when combined
 *
 * Every output flows into the rest of the mesh via the Tranche 1 helpers:
 *   signals → createSignalIfNotDuplicate()
 *   tasks → createTask()
 *   gaps → surfaceConnectorGap()
 *   insights → filed back to KB as research/ entries
 *   everything → logIntelligenceEvent() for the Timeline
 *
 * Triggered two ways:
 *   1. Debounced 5 minutes after any KB write (KBEngine.writeFile)
 *   2. Weekly full-KB scan from the scheduler
 */

import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { createSignalIfNotDuplicate } from '../signals/signal-helpers.js';
import { surfaceConnectorGap } from '../lib/connector-gap-handler.js';
import { logIntelligenceEvent } from '../lib/intelligence-events.js';
import { createTask } from '../tasks/task-queue.js';
import crypto from 'node:crypto';
import type { KBEngine } from './kb-engine.js';

// Files that are boilerplate or noise — never worth sending to the LLM.
const SKIP_PATHS = new Set(['WIKI.md', 'index.md', 'log.md', 'hot.md']);

// How many recent files to include in one analysis pass.
const MAX_FILES_PER_PASS = 20;

// Minimum number of eligible recent files before we'll spend an LLM call.
// A single isolated write rarely compounds with anything.
const MIN_FILES_FOR_ANALYSIS = 2;

// Per-file content cap so a few giant pages don't blow the prompt.
const FILE_CHAR_CAP = 500;

// Minimum LLM confidence for auto-creating signals/tasks.
const MIN_CONFIDENCE = 0.65;

// Guard against runaway analysis — don't re-analyse the same business more
// than once every N minutes regardless of writes.
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const lastRunAt = new Map<string, number>();

interface AnalysisResult {
  signals: number;
  tasks: number;
  gaps: number;
  insights: number;
  contradictions: number;
  errors: string[];
  skipped?: string;
}

interface AnalysisSignal {
  title?: string;
  type?: string;
  severity?: string;
  description?: string;
  confidence?: number;
  source_files?: string[];
  reason?: string;
}

interface AnalysisTask {
  title?: string;
  description?: string;
  action_type?: string;
  priority?: string;
  confidence?: number;
  source_files?: string[];
  reason?: string;
}

interface AnalysisGap {
  connector_name?: string;
  reason?: string;
  use_case?: string;
}

interface AnalysisContradiction {
  file_a?: string;
  file_b?: string;
  description?: string;
  severity?: string;
}

interface AnalysisInsight {
  title?: string;
  description?: string;
  files?: string[];
  action?: string;
}

interface LLMAnalysis {
  signals?: AnalysisSignal[];
  tasks?: AnalysisTask[];
  connector_gaps?: AnalysisGap[];
  contradictions?: AnalysisContradiction[];
  compounding_insights?: AnalysisInsight[];
}

/**
 * Analyse recent KB activity for a business. Fire-and-forget from callers.
 *
 * @param businessId
 * @param opts
 * @param opts.hours — window of "recent" files
 * @param opts.force — bypass the rate-limit guard
 */
export async function analyseKBForSignals(
  businessId: string,
  opts: { hours?: number; force?: boolean } = {}
): Promise<AnalysisResult | null> {
  if (!businessId) return null;
  const { hours = 48, force = false } = opts;

  // Rate limit: don't analyse the same business too frequently even if
  // writes keep triggering it.
  const last = lastRunAt.get(businessId);
  if (!force && last && Date.now() - last < MIN_INTERVAL_MS) {
    return null;
  }
  lastRunAt.set(businessId, Date.now());

  const { getKBForBusiness } = await import('./kb-config.js');
  const kbResult = await getKBForBusiness(businessId).catch(() => null);
  if (!kbResult?.engine) return null;
  const { engine: kb, business } = kbResult;

  // Find eligible files: recently modified, not special, not written by
  // the analyser itself (prevents self-triggering loops).
  const recent = (await kb.getRecentlyModified(hours)).filter(
    (f: { path: string }) =>
      !SKIP_PATHS.has(f.path) &&
      !f.path.startsWith('_archived/') &&
      !f.path.startsWith('raw/')
  );

  if (recent.length < MIN_FILES_FOR_ANALYSIS) {
    return { signals: 0, tasks: 0, gaps: 0, insights: 0, contradictions: 0, errors: [], skipped: 'not_enough_files' };
  }

  // Read content, filter out analyser-written files
  const contents: { path: string; content: string; tags: string[] }[] = [];
  for (const f of recent.slice(0, MAX_FILES_PER_PASS)) {
    try {
      const parsed = await kb.readFile(f.path);
      if (parsed.frontmatter?.written_by === 'kb-analyser') continue;
      contents.push({
        path: f.path,
        content: (parsed.content ?? '').slice(0, FILE_CHAR_CAP),
        tags: (parsed.frontmatter?.tags as string[]) ?? [],
      });
    } catch {}
  }
  if (contents.length < MIN_FILES_FOR_ANALYSIS) {
    return { signals: 0, tasks: 0, gaps: 0, insights: 0, contradictions: 0, errors: [], skipped: 'all_analyser_written' };
  }

  // Context: active goals + recent signals + recent tasks so the LLM
  // doesn't propose duplicates of things already in flight.
  const goalsSummary = summariseActiveGoals(businessId);
  const signalsSummary = summariseRecentSignals(businessId);
  const tasksSummary = summariseRecentTasks(businessId);

  const prompt = buildPrompt({
    businessName: business.name,
    contents, goalsSummary, signalsSummary, tasksSummary,
  });

  // Use whatever LLM the user has configured — never hardcode a model.
  let analysis: LLMAnalysis | null = null;
  try {
    const { providerId, model } = resolveProfileLLM({});
    const response = await runLLM(providerId, model, {
      system: 'Return only valid JSON. Only surface genuinely actionable items — no routine filler.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 3000,
    });
    analysis = extractJSON(response?.content);
  } catch (err) {
    console.warn(`[kb-analyser] LLM call failed for ${business.slug}:`, (err as Error).message);
    return { signals: 0, tasks: 0, gaps: 0, insights: 0, contradictions: 0, errors: [(err as Error).message] };
  }
  if (!analysis) {
    return { signals: 0, tasks: 0, gaps: 0, insights: 0, contradictions: 0, errors: ['could_not_parse_llm_output'] };
  }

  const result = await processAnalysis(analysis, { businessId, kb, businessSlug: business.slug });

  // Log one summary event so the Timeline sees the KB analyser ran
  logIntelligenceEvent({
    business_id: businessId,
    source_type: 'kb',
    source_id: 'analyser',
    event_type: 'analysed_kb',
    description: `Analysed ${contents.length} recent files: ${result.signals} signals, ${result.tasks} tasks, ${result.gaps} gaps, ${result.insights} insights`,
    metadata: { files_analysed: contents.length, ...result },
  });

  try {
    await kb.appendLog('analyse', `${result.signals} signals, ${result.tasks} tasks, ${result.gaps} gaps, ${result.insights} insights filed`);
  } catch {}

  return result;
}

// ─── Prompt + LLM output handling ─────────────────────────────────────────────

function buildPrompt({
  businessName,
  contents,
  goalsSummary,
  signalsSummary,
  tasksSummary,
}: {
  businessName: string;
  contents: { path: string; content: string; tags: string[] }[];
  goalsSummary: string;
  signalsSummary: string;
  tasksSummary: string;
}): string {
  return `You are Blueprint's KB analyst for ${businessName}. Review these recently-modified knowledge base entries and identify genuinely actionable items.

## Recent KB entries (${contents.length})

${contents.map(f => `=== ${f.path} ===
${f.content}
`).join('\n')}

## Context the KB already has in flight

Active goals: ${goalsSummary || '(none)'}

Recent signals (DO NOT propose duplicates of these):
${signalsSummary || '(none)'}

Recent tasks in flight (DO NOT propose duplicates of these):
${tasksSummary || '(none)'}

## Return valid JSON in this exact shape

{
  "signals": [{
    "title": "short title",
    "type": "anomaly | opportunity | risk | correlation",
    "severity": "info | warning | alert | critical",
    "description": "what's going on and why it matters",
    "confidence": 0.0,
    "source_files": ["path/to/file.md"],
    "reason": "why this warrants a signal"
  }],
  "tasks": [{
    "title": "short imperative title",
    "description": "specific action to take",
    "action_type": "investigation | content | outreach | config_change | other",
    "priority": "p1 | p2 | p3",
    "confidence": 0.0,
    "source_files": ["path/to/file.md"],
    "reason": "what in the KB implies this task"
  }],
  "connector_gaps": [{
    "connector_name": "semrush | klaviyo | free-form-tool-name",
    "reason": "why this data would help",
    "use_case": "specific use this would enable"
  }],
  "contradictions": [{
    "file_a": "path/to/file-a.md",
    "file_b": "path/to/file-b.md",
    "description": "what contradicts",
    "severity": "minor | major | critical"
  }],
  "compounding_insights": [{
    "title": "the insight",
    "description": "why these entries together mean more than any one alone",
    "files": ["path/a.md", "path/b.md"],
    "action": "signal | task | note"
  }]
}

Rules:
- Only include items with genuine actionable value. If nothing is worth reporting, return empty arrays.
- Never propose anything already present in the signals or tasks context above.
- confidence must be 0.0–1.0. Below 0.65 will be dropped; calibrate honestly.
- source_files must reference actual paths from the KB entries above.
- contradictions: only raise "major" or "critical" — don't flag minor phrasing differences.
- compounding_insights: only when combining 2+ files genuinely adds information not in any one alone.
`;
}

function extractJSON(text: unknown): LLMAnalysis | null {
  if (!text) return null;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  return null;
}

// ─── Context summarisers (short & cheap — no LLM calls) ──────────────────────

function summariseActiveGoals(businessId: string): string {
  try {
    const rows = db.prepare(`
      SELECT title, metric_name, progress_pct
        FROM goals
       WHERE business_id = ? AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 10
    `).all(businessId) as { title: string; metric_name: string | null; progress_pct: number | null }[];
    if (rows.length === 0) return '';
    return rows.map(g => `- ${g.title}${g.metric_name ? ` (tracking ${g.metric_name})` : ''}${g.progress_pct != null ? ` — ${Math.round(g.progress_pct)}% progress` : ''}`).join('\n');
  } catch {
    return '';
  }
}

function summariseRecentSignals(businessId: string): string {
  try {
    const rows = db.prepare(`
      SELECT title, severity, status, rule_id
        FROM signals
       WHERE business_id = ? AND created_at > datetime('now', '-14 days')
       ORDER BY created_at DESC
       LIMIT 10
    `).all(businessId) as { title: string; severity: string; status: string; rule_id: string }[];
    if (rows.length === 0) return '';
    return rows.map(s => `- [${s.severity}] ${s.title} (${s.status})`).join('\n');
  } catch {
    return '';
  }
}

function summariseRecentTasks(businessId: string): string {
  try {
    const rows = db.prepare(`
      SELECT title, status, proposed_by, action_type
        FROM tasks
       WHERE business_id = ?
         AND status IN ('proposed', 'approved', 'executing')
         AND created_at > datetime('now', '-14 days')
       ORDER BY created_at DESC
       LIMIT 10
    `).all(businessId) as { title: string; status: string; proposed_by: string; action_type: string | null }[];
    if (rows.length === 0) return '';
    return rows.map(t => `- [${t.status}] ${t.title} (by ${t.proposed_by}${t.action_type ? `, ${t.action_type}` : ''})`).join('\n');
  } catch {
    return '';
  }
}

// ─── Processing the LLM output ────────────────────────────────────────────────

/**
 * Apply a parsed LLM analysis to the mesh. Exported so tests and alternative
 * callers can route a prepared analysis through the Tranche 1 helpers without
 * needing to go through the full LLM pipeline.
 */
export async function processAnalysis(
  analysis: LLMAnalysis,
  { businessId, kb, businessSlug }: { businessId: string; kb: KBEngine; businessSlug: string }
): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    signals: 0, tasks: 0, gaps: 0, insights: 0, contradictions: 0, errors: [],
  };

  // Signals
  for (const s of analysis.signals ?? []) {
    if (!s?.title || (s.confidence ?? 0) < MIN_CONFIDENCE) continue;
    try {
      const ruleId = `kb_analyser:${slugish(s.title)}_${hashShort(s.title + (s.source_files ?? []).join(','))}`;
      const res = createSignalIfNotDuplicate({
        business_id: businessId,
        rule_id: ruleId,
        type: s.type || 'anomaly',
        severity: s.severity || 'info',
        title: s.title,
        description: describeSignal(s),
        confidence: Number(s.confidence) || 0.7,
        data: { source_files: s.source_files ?? [], reason: s.reason ?? null },
        source_label: 'kb-analyser',
      });
      if (res?.created) result.signals += 1;
    } catch (err) {
      result.errors.push(`signal '${s.title}': ${(err as Error).message}`);
    }
  }

  // Tasks
  for (const t of analysis.tasks ?? []) {
    if (!t?.title || (t.confidence ?? 0) < MIN_CONFIDENCE) continue;
    try {
      // Skip if we already have an open task with a very similar title
      const existing = db.prepare(`
        SELECT id FROM tasks
         WHERE business_id = ?
           AND status IN ('proposed', 'approved', 'executing')
           AND title = ?
      `).get(businessId, t.title);
      if (existing) continue;

      const created = createTask({
        business_id: businessId,
        title: t.title.slice(0, 180),
        description: describeTask(t),
        proposed_by: 'kb-analyser',
        action_type: t.action_type || 'investigation',
        priority: validPriority(t.priority),
        trust_tier: 'yellow',
        confidence: Number(t.confidence) || 0.7,
        action_payload: { source_files: t.source_files ?? [], reason: t.reason ?? null },
      });
      if (created?.id) {
        result.tasks += 1;
        logIntelligenceEvent({
          business_id: businessId,
          source_type: 'kb',
          source_id: 'analyser',
          target_type: 'task',
          target_id: created.id,
          event_type: 'created_task',
          description: `${t.priority || 'p2'}: ${t.title.slice(0, 140)}`,
        });
      }
    } catch (err) {
      result.errors.push(`task '${t.title}': ${(err as Error).message}`);
    }
  }

  // Connector gaps
  for (const g of analysis.connector_gaps ?? []) {
    if (!g?.connector_name) continue;
    try {
      const res = await surfaceConnectorGap({
        business_id: businessId,
        connector_name: g.connector_name,
        source: 'kb-analyser',
        reason: g.reason ?? null,
        use_case: g.use_case ?? null,
        implied_by: 'KB analysis',
        priority: 'p3',
      });
      if (res?.first_time) result.gaps += 1;
    } catch (err) {
      result.errors.push(`gap '${g.connector_name}': ${(err as Error).message}`);
    }
  }

  // Contradictions — only act on major/critical
  for (const c of analysis.contradictions ?? []) {
    if (!c?.file_a || !c?.file_b) continue;
    if (c.severity === 'minor') continue;
    try {
      const title = `Resolve KB contradiction: ${(c.description ?? '').slice(0, 80)}`;
      const existing = db.prepare(`
        SELECT id FROM tasks
         WHERE business_id = ?
           AND status IN ('proposed', 'approved', 'executing')
           AND title = ?
      `).get(businessId, title);
      if (existing) continue;

      const created = createTask({
        business_id: businessId,
        title,
        description: `Two KB entries contradict each other:\n\n` +
          `- **File A:** \`${c.file_a}\`\n` +
          `- **File B:** \`${c.file_b}\`\n\n` +
          `**Conflict:** ${c.description ?? '(not specified)'}\n\n` +
          `*Surfaced by KB analysis.*`,
        proposed_by: 'kb-analyser',
        action_type: 'investigation',
        priority: c.severity === 'critical' ? 'p1' : 'p2',
        trust_tier: 'yellow',
        confidence: 0.9,
        action_payload: { file_a: c.file_a, file_b: c.file_b, severity: c.severity },
      });
      if (created?.id) {
        result.contradictions += 1;
        logIntelligenceEvent({
          business_id: businessId,
          source_type: 'kb',
          source_id: 'analyser',
          target_type: 'task',
          target_id: created.id,
          event_type: 'escalated_contradiction',
          description: `${c.severity}: ${(c.description ?? '').slice(0, 140)}`,
        });
      }
    } catch (err) {
      result.errors.push(`contradiction: ${(err as Error).message}`);
    }
  }

  // Compounding insights — file back to KB
  for (const i of analysis.compounding_insights ?? []) {
    if (!i?.title || !i?.description || !i.files || i.files.length < 2) continue;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const slug = slugish(i.title).slice(0, 60);
      const path = `research/compounding-${date}-${slug}.md`;
      const body = `# ${i.title}\n\n${i.description}\n\n` +
        `## Contributing entries\n\n${i.files.map(f => `- [[${f}]]`).join('\n')}\n`;
      await kb.writeFile(
        path, body,
        {
          title: i.title,
          tags: ['compounding', 'insight'],
          written_by: 'kb-analyser',
          review_status: 'pending_review',
        },
        `insight: ${i.title.slice(0, 60)}`
      );
      result.insights += 1;

      logIntelligenceEvent({
        business_id: businessId,
        source_type: 'kb',
        source_id: 'analyser',
        target_type: 'kb_entry',
        target_id: path,
        event_type: 'filed_kb',
        description: `Compounding insight: ${i.title.slice(0, 140)}`,
        metadata: { files: i.files },
      });

      // If the insight itself should become a signal, raise one too
      if (i.action === 'signal') {
        createSignalIfNotDuplicate({
          business_id: businessId,
          rule_id: `kb_analyser:insight_${hashShort(i.title)}`,
          type: 'correlation',
          severity: 'info',
          title: i.title,
          description: i.description,
          confidence: 0.75,
          data: { files: i.files },
          source_label: 'kb-analyser',
        });
      }
    } catch (err) {
      result.errors.push(`insight '${i.title}': ${(err as Error).message}`);
    }
  }

  return result;
}

function describeSignal(s: AnalysisSignal): string {
  const parts = [];
  if (s.description) parts.push(s.description);
  if (s.reason) parts.push(`\n\n**Why it matters:** ${s.reason}`);
  if (s.source_files?.length) {
    parts.push(`\n\n**Source files:** ${s.source_files.map(f => `\`${f}\``).join(', ')}`);
  }
  parts.push(`\n\n*Surfaced by KB analyser.*`);
  return parts.join('');
}

function describeTask(t: AnalysisTask): string {
  const parts = [];
  if (t.description) parts.push(t.description);
  if (t.reason) parts.push(`\n\n**Reason:** ${t.reason}`);
  if (t.source_files?.length) {
    parts.push(`\n\n**Source files:** ${t.source_files.map(f => `\`${f}\``).join(', ')}`);
  }
  parts.push(`\n\n*Surfaced by KB analyser.*`);
  return parts.join('');
}

function validPriority(p: string | undefined): string {
  return ['p1', 'p2', 'p3'].includes(p ?? '') ? p! : 'p3';
}

function slugish(s: string | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function hashShort(s: string): string {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
}

// ─── Debounced per-business scheduler ────────────────────────────────────────
//
// KBEngine.writeFile calls scheduleKBAnalysis(businessId) after every commit.
// Repeated writes within the debounce window reset the timer so we analyse
// once per burst of activity, not once per file.

const DEBOUNCE_MS = 5 * 60 * 1000;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleKBAnalysis(businessId: string): void {
  if (!businessId) return;

  // Reset any pending timer for this business
  const existing = pendingTimers.get(businessId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(businessId);
    analyseKBForSignals(businessId).catch(err => {
      console.warn(`[kb-analyser] Scheduled analysis failed for ${businessId}:`, (err as Error).message);
    });
  }, DEBOUNCE_MS);

  // Don't let this timer hold the process open during shutdown
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  pendingTimers.set(businessId, timer);
}

/**
 * Cancel any pending debounced analysis. Used by tests and graceful shutdown.
 */
export function cancelScheduledAnalysis(businessId: string | null = null): void {
  if (businessId) {
    const t = pendingTimers.get(businessId);
    if (t) { clearTimeout(t); pendingTimers.delete(businessId); }
    return;
  }
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
}
