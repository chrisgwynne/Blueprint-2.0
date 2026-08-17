/**
 * Brain — Monthly Retrospective Engine.
 *
 * Analyses the previous 30 days of actions, outcomes, agent performance,
 * goal progress, and signal quality. Produces a structured retrospective
 * that is filed to the KB and whose findings flow back into agent prompts.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import {
  listProposalsForRetrospective, type ProposalGenerationResult,
} from './retrospective-proposals.js';

const SYSTEM_PROMPT = `You are Blueprint's retrospective analyst.

Given a month's worth of actions, outcomes, agent performance, and goal
progress, produce an honest, specific retrospective.

Rules:
- Be honest. If nothing worked, say so.
- Be specific. Reference task titles, metrics, and numbers.
- If an agent is overconfident, call it out.
- Recommendations must be concrete — not "improve SEO" but
  "SEO Sentinel should stop proposing meta changes on pages with
   <100 monthly impressions; they don't measurably move".

Return only valid JSON. No prose outside JSON.

Schema:
{
  "executive_summary": "3-4 honest sentences",
  "what_worked": [
    { "title": "short label", "evidence": "specific data point", "insight": "why it worked" }
  ],
  "what_didnt": [
    { "title": "short label", "evidence": "specific data point", "insight": "why it failed" }
  ],
  "learnings": [
    { "learning": "specific, actionable insight", "applies_to": "which agents or situations" }
  ],
  "agent_assessments": [
    {
      "agent_id": "conductor|seo-sentinel|etc",
      "tasks_proposed": <n>,
      "acceptance_rate": 0.0-1.0,
      "outcome_rate": 0.0-1.0,
      "avg_stated_confidence": 0.0-1.0,
      "avg_actual_outcome_rate": 0.0-1.0,
      "calibration_error": "positive = overconfident, negative = underconfident",
      "grade": "A|B|C|D|F",
      "note": "specific observation about this agent"
    }
  ],
  "open_windows": [
    { "action_type": "name", "count": <n>, "note": "don't draw conclusions yet" }
  ],
  "recommendations": [
    "concrete action for next month"
  ],
  "operating_changes": [
    "what Blueprint itself should do differently"
  ],
  "calibration_notes": [
    { "agent_id": "name", "calibration_offset": -0.15,
      "note": "display confidence with this offset applied" }
  ]
}`;

function extractJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str!.trim()); } catch { return null; }
}

interface RetroData {
  completedTasks: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  goalChecks: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  deferredTasks: number;
  openWindows: Record<string, unknown>[];
  agentCalibration: Record<string, { stated: number[]; outcomes: number[] }>;
}

/**
 * Assemble all data for a retrospective period.
 */
function assembleData(businessId: string, periodStart: Date, periodEnd: Date): RetroData {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const completedTasks = db.prepare(`
    SELECT t.id, t.title, t.action_type, t.proposed_by, t.confidence,
           t.status, t.approved_at, t.completed_at,
           (julianday(t.approved_at) - julianday(t.created_at)) * 24 AS hours_to_approve
    FROM tasks t
    WHERE t.business_id = ? AND t.completed_at BETWEEN ? AND ?
  `).all(businessId, startIso, endIso) as Record<string, unknown>[];

  const outcomes = db.prepare(`
    SELECT o.task_id, o.verdict, o.change_pct, o.metric_value, o.baseline_value,
           t.title, t.action_type, t.proposed_by, t.confidence, t.target_metric
    FROM task_outcomes o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND o.check_date BETWEEN ? AND ?
  `).all(businessId, startIso, endIso) as Record<string, unknown>[];

  const agentRuns = db.prepare(`
    SELECT agent_id, COUNT(*) as runs,
           SUM(tasks_proposed) as tasks_proposed,
           SUM(signals_detected) as signals_detected,
           AVG(CASE WHEN error IS NULL THEN 1 ELSE 0 END) as success_rate
    FROM agent_runs
    WHERE business_id = ? AND started_at BETWEEN ? AND ?
    GROUP BY agent_id
  `).all(businessId, startIso, endIso) as Record<string, unknown>[];

  const goalChecks = db.prepare(`
    SELECT gc.*, g.title, g.metric_target, g.status AS goal_status
    FROM goal_checks gc
    JOIN goals g ON g.id = gc.goal_id
    WHERE gc.business_id = ? AND gc.checked_at BETWEEN ? AND ?
    ORDER BY gc.checked_at DESC
  `).all(businessId, startIso, endIso) as Record<string, unknown>[];

  const signals = db.prepare(`
    SELECT type, severity, status, rule_id, COUNT(*) AS count
    FROM signals
    WHERE business_id = ? AND created_at BETWEEN ? AND ?
    GROUP BY type, severity, status, rule_id
  `).all(businessId, startIso, endIso) as Record<string, unknown>[];

  const deferredTasksRow = db.prepare(`
    SELECT COUNT(*) AS count FROM tasks
    WHERE business_id = ? AND status = 'deferred'
      AND updated_at BETWEEN ? AND ?
  `).get(businessId, startIso, endIso) as { count: number } | null;

  const openWindows = db.prepare(`
    SELECT action_type, COUNT(*) AS count
    FROM action_memory
    WHERE business_id = ? AND outcome_measured = 0
      AND measurement_window_end > CURRENT_TIMESTAMP
    GROUP BY action_type
  `).all(businessId) as Record<string, unknown>[];

  // Per-agent calibration from outcomes
  const agentCalibration: Record<string, { stated: number[]; outcomes: number[] }> = {};
  for (const o of outcomes) {
    if (!o.proposed_by) continue;
    const agent = (o.proposed_by as string).replace(/^agent:/, '');
    if (!agentCalibration[agent]) {
      agentCalibration[agent] = { stated: [], outcomes: [] };
    }
    if (o.confidence != null) agentCalibration[agent]!.stated.push(o.confidence as number);
    agentCalibration[agent]!.outcomes.push(o.verdict === 'improved' ? 1 : 0);
  }

  return {
    completedTasks, outcomes, agentRuns, goalChecks, signals,
    deferredTasks: deferredTasksRow?.count ?? 0,
    openWindows, agentCalibration,
  };
}

function buildPrompt(business: Record<string, unknown> | null, data: RetroData, periodStart: Date, periodEnd: Date): string {
  const lines: string[] = [];
  lines.push(`Business: ${(business?.name as string) ?? 'unknown'}`);
  lines.push(`Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`TASKS COMPLETED (${data.completedTasks.length}):`);
  for (const t of data.completedTasks.slice(0, 30)) {
    lines.push(`- "${t.title}" (${(t.action_type as string | null) ?? '?'}, by ${t.proposed_by}, confidence ${(t.confidence as number | null) ?? 'n/a'})`);
  }
  lines.push('');
  lines.push(`OUTCOMES MEASURED (${data.outcomes.length}):`);
  for (const o of data.outcomes.slice(0, 30)) {
    const pct = o.change_pct != null ? `${(o.change_pct as number) > 0 ? '+' : ''}${(o.change_pct as number).toFixed(1)}%` : 'n/a';
    lines.push(`- "${o.title}": ${o.verdict} (${pct}) on ${(o.target_metric as string | null) ?? '?'}; stated confidence ${(o.confidence as number | null) ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('AGENT ACTIVITY:');
  for (const a of data.agentRuns) {
    lines.push(`- ${a.agent_id}: ${a.runs} runs, ${(a.tasks_proposed as number | null) ?? 0} tasks proposed, ${(a.signals_detected as number | null) ?? 0} signals, ${(((a.success_rate as number | null) ?? 0) * 100).toFixed(0)}% run success`);
  }
  lines.push('');
  lines.push('PER-AGENT CALIBRATION (from outcomes):');
  for (const [agent, d] of Object.entries(data.agentCalibration)) {
    if (d.stated.length === 0) continue;
    const avgStated = d.stated.reduce((s, v) => s + v, 0) / d.stated.length;
    const avgOutcome = d.outcomes.reduce((s, v) => s + v, 0) / d.outcomes.length;
    lines.push(`- ${agent}: stated avg ${(avgStated * 100).toFixed(0)}%, actual outcome rate ${(avgOutcome * 100).toFixed(0)}%, error ${((avgStated - avgOutcome) * 100).toFixed(1)}% (${d.stated.length} outcomes)`);
  }
  lines.push('');
  lines.push('GOAL PROGRESS CHECKS:');
  for (const g of data.goalChecks.slice(0, 20)) {
    lines.push(`- ${g.title} (${g.goal_status}): ${((g.progress_pct as number | null) ?? 0).toFixed(0)}% — ${(g.status_change as string | null) ?? 'no change'}${g.agent_note ? ` — ${g.agent_note}` : ''}`);
  }
  lines.push('');
  lines.push('SIGNALS:');
  for (const s of data.signals) {
    lines.push(`- ${s.type}/${s.severity}/${s.status}: ${s.count} (${s.rule_id})`);
  }
  lines.push(`Deferred tasks: ${data.deferredTasks}`);
  lines.push('');
  lines.push('OPEN MEASUREMENT WINDOWS (do not draw conclusions yet):');
  for (const w of data.openWindows) {
    lines.push(`- ${w.action_type}: ${w.count} action(s) still in window`);
  }
  lines.push('');
  lines.push('Produce the full retrospective JSON per the schema.');
  return lines.join('\n');
}

/**
 * Run a retrospective for a business over the last 30 days.
 */
export async function runRetrospective(
  businessId: string,
  opts: { triggered_by?: string } = {}
): Promise<Record<string, unknown> | null> {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Record<string, unknown> | null;
  if (!business) throw new Error('Business not found');

  const periodEnd = new Date();
  const periodStart = new Date(Date.now() - 30 * 86400000);

  const data = assembleData(businessId, periodStart, periodEnd);
  const prompt = buildPrompt(business, data, periodStart, periodEnd);

  const { providerId, model } = resolveProfileLLM({});

  let parsed: Record<string, unknown> | null = null;
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 4096,
    });
    parsed = extractJSON((result as { content: string } | null)?.content ?? '');
  } catch (err) {
    console.warn('[retrospective] LLM failed:', (err as Error).message);
    return null;
  }

  if (!parsed) return null;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO retrospectives
    (id, business_id, period_start, period_end,
     executive_summary, what_worked, what_didnt, learnings,
     agent_assessments, open_windows, recommendations,
     operating_changes, calibration_notes, full_report_json, triggered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, businessId, periodStart.toISOString(), periodEnd.toISOString(),
    (parsed.executive_summary as string | null) ?? null,
    JSON.stringify((parsed.what_worked as unknown[] | null) ?? []),
    JSON.stringify((parsed.what_didnt as unknown[] | null) ?? []),
    JSON.stringify((parsed.learnings as unknown[] | null) ?? []),
    JSON.stringify((parsed.agent_assessments as unknown[] | null) ?? []),
    JSON.stringify((parsed.open_windows as unknown[] | null) ?? []),
    JSON.stringify((parsed.recommendations as unknown[] | null) ?? []),
    JSON.stringify((parsed.operating_changes as unknown[] | null) ?? []),
    JSON.stringify((parsed.calibration_notes as unknown[] | null) ?? []),
    JSON.stringify(parsed),
    opts.triggered_by ?? 'scheduler'
  );

  import('../bap/webhook-dispatcher.js').then((m: any) =>
    m.dispatchWebhookEvent('retrospective.created', {
      retrospective_id: id, business_id: businessId,
      period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(),
      executive_summary: (parsed.executive_summary as string | null) ?? null,
    })
  ).catch(() => {});

  // ── Structured operating-change proposals (#73) ──
  // The narrative above stays as it was. This turns the parts of it that
  // measured records actually support into bounded, reviewable proposals —
  // and records, as first-class output, every place the records did NOT
  // support one. Nothing here activates anything: at most it writes draft
  // versions in the owning subsystems plus review items in the decision
  // queue, both inert until a human approves them.
  let proposalResult: ProposalGenerationResult | null = null;
  try {
    const { generateRetrospectiveProposals } = await import('./retrospective-proposals.js');
    proposalResult = generateRetrospectiveProposals({
      businessId,
      retrospectiveId: id,
      periodStart,
      periodEnd,
      parsedReport: parsed,
    });
    db.prepare(
      'UPDATE retrospectives SET evidence_gaps = ?, unstructured_suggestions = ? WHERE id = ?',
    ).run(
      JSON.stringify(proposalResult.gaps),
      JSON.stringify(proposalResult.unstructured_suggestions),
      id,
    );
  } catch (err) {
    console.warn('[retrospective] proposal generation failed:', (err as Error).message);
  }

  // Apply calibration to agent_calibration table
  await applyCalibration(businessId, parsed, periodStart, periodEnd).catch(() => {});

  // Persist per-agent findings so they appear in agent system prompts
  await injectAgentFindings(businessId, parsed).catch(() => {});

  // File to KB + shared KB
  const kbPath = await fileToKB(businessId, parsed, periodStart, periodEnd).catch(() => null);
  if (kbPath) {
    db.prepare('UPDATE retrospectives SET kb_path = ? WHERE id = ?').run(kbPath, id);
  }
  await fileTransferableToShared(businessId, parsed).catch(() => {});

  // Lapse anything an earlier retrospective proposed that nobody reviewed.
  // Done here rather than on a timer so a stale proposal cannot outlive the
  // period it was reasoning about without somebody looking at it.
  try {
    const { expireStaleProposals } = await import('./retrospective-proposals.js');
    expireStaleProposals(businessId);
  } catch (err) {
    console.warn('[retrospective] proposal expiry sweep failed:', (err as Error).message);
  }

  // Phase 3 — cross-business learning: recompute the abstract,
  // non-identifying outcome patterns every business's opportunity engine
  // and historical-learning queries can consult. Global (not scoped to
  // this business), so a retrospective anywhere on the instance keeps it
  // fresh for everyone.
  try {
    const { updateCrossBusinessPatterns } = await import('./cross-business-patterns.js') as unknown as { updateCrossBusinessPatterns: () => unknown };
    updateCrossBusinessPatterns();
  } catch (err) {
    console.warn('[retrospective] cross-business pattern update failed:', (err as Error).message);
  }

  return {
    id, ...parsed, kb_path: kbPath,
    // The structured half. Deliberately alongside the prose rather than
    // replacing it: a reader should be able to see both what the analyst
    // said and which of it the records could actually justify acting on.
    proposals: proposalResult?.proposals ?? [],
    evidence_gaps: proposalResult?.gaps ?? [],
    proposal_conflicts: proposalResult?.conflicts ?? [],
    unstructured_suggestions: proposalResult?.unstructured_suggestions ?? [],
    evidence_summary: proposalResult?.evidence_summary ?? null,
  };
}

/**
 * Phase 3: the numeric calibration fields (error/score/offset/bins/etc)
 * are now always computed deterministically by
 * server/brain/calibration.ts's recalculateCalibrationForBusiness() — this
 * function used to insert its OWN agent_calibration row per agent using
 * the LLM's self-reported calibration_error, a second, less reliable
 * source of truth for the exact same numbers the deterministic engine
 * already computes from task_outcomes directly. It now only attaches the
 * LLM's qualitative note/grade onto the row the deterministic engine just
 * wrote, rather than inserting a competing row.
 */
async function applyCalibration(
  businessId: string,
  parsed: Record<string, unknown>,
  _periodStart: Date,
  _periodEnd: Date
): Promise<void> {
  const { recalculateCalibrationForBusiness } = await import('./calibration.js') as unknown as {
    recalculateCalibrationForBusiness: (businessId: string) => unknown;
  };
  recalculateCalibrationForBusiness(businessId);

  const assessments = Array.isArray(parsed.agent_assessments) ? parsed.agent_assessments as Record<string, unknown>[] : [];
  for (const a of assessments) {
    if (!a.agent_id || !a.note) continue;
    const latest = db.prepare(
      'SELECT id FROM agent_calibration WHERE agent_id = ? AND business_id = ? ORDER BY calculated_at DESC LIMIT 1'
    ).get(a.agent_id as string, businessId) as { id: string } | undefined;
    if (latest) {
      db.prepare('UPDATE agent_calibration SET notes = ? WHERE id = ?').run(a.note as string, latest.id);
    }
  }
}

async function injectAgentFindings(businessId: string, parsed: Record<string, unknown>): Promise<void> {
  const assessments = Array.isArray(parsed.agent_assessments) ? parsed.agent_assessments as Record<string, unknown>[] : [];
  for (const a of assessments) {
    if (!a.agent_id || !a.note) continue;
    const key = `agent_retro_note_${businessId}_${a.agent_id}`;
    const payload = {
      retro_at: new Date().toISOString(),
      note: a.note,
      grade: (a.grade as string | null) ?? null,
      calibration_error: (a.calibration_error as number | null) ?? null,
    };
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(payload));
  }
}

async function fileToKB(
  businessId: string,
  parsed: Record<string, unknown>,
  periodStart: Date,
  periodEnd: Date
): Promise<string | null> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as {
      getKBForBusiness: (id: string) => Promise<{ engine: Record<string, unknown> } | null>;
    };
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;

    const monthName = periodStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const slug = periodStart.toISOString().slice(0, 7);
    const path = `reports/retrospective-${slug}.md`;

    const L: string[] = [];
    L.push(`# Retrospective — ${monthName}`);
    L.push('');
    L.push(`**Period:** ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
    L.push('');
    if (parsed.executive_summary) {
      L.push('## Executive summary');
      L.push('');
      L.push(parsed.executive_summary as string);
      L.push('');
    }
    if (Array.isArray(parsed.what_worked) && parsed.what_worked.length) {
      L.push('## What worked');
      L.push('');
      for (const w of parsed.what_worked as Record<string, unknown>[]) {
        L.push(`- **${w.title}** — ${(w.evidence as string | null) ?? ''}${w.insight ? `\n  _${w.insight}_` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.what_didnt) && parsed.what_didnt.length) {
      L.push("## What didn't");
      L.push('');
      for (const w of parsed.what_didnt as Record<string, unknown>[]) {
        L.push(`- **${w.title}** — ${(w.evidence as string | null) ?? ''}${w.insight ? `\n  _${w.insight}_` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.learnings) && parsed.learnings.length) {
      L.push('## Learnings');
      L.push('');
      for (const l of parsed.learnings as Record<string, unknown>[]) {
        L.push(`- ${l.learning}${l.applies_to ? ` (applies to: ${l.applies_to})` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.agent_assessments) && parsed.agent_assessments.length) {
      L.push('## Agent assessments');
      L.push('');
      L.push('| Agent | Grade | Proposed | Accept | Outcome | Stated conf | Actual | Error |');
      L.push('|---|---|---|---|---|---|---|---|');
      for (const a of parsed.agent_assessments as Record<string, unknown>[]) {
        L.push(`| ${a.agent_id} | ${(a.grade as string | null) ?? '-'} | ${(a.tasks_proposed as number | null) ?? 0} | ${(((a.acceptance_rate as number | null) ?? 0) * 100).toFixed(0)}% | ${(((a.outcome_rate as number | null) ?? 0) * 100).toFixed(0)}% | ${(((a.avg_stated_confidence as number | null) ?? 0) * 100).toFixed(0)}% | ${(((a.avg_actual_outcome_rate as number | null) ?? 0) * 100).toFixed(0)}% | ${a.calibration_error != null ? ((a.calibration_error as number) * 100).toFixed(1) + '%' : '-'} |`);
      }
      L.push('');
      for (const a of parsed.agent_assessments as Record<string, unknown>[]) {
        if (a.note) L.push(`- **${a.agent_id}:** ${a.note}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.recommendations) && parsed.recommendations.length) {
      L.push('## Recommendations for next month');
      L.push('');
      (parsed.recommendations as string[]).forEach((r, i) => L.push(`${i + 1}. ${r}`));
      L.push('');
    }
    if (Array.isArray(parsed.operating_changes) && parsed.operating_changes.length) {
      L.push('## How Blueprint should operate differently');
      L.push('');
      for (const c of parsed.operating_changes as string[]) L.push(`- ${c}`);
      L.push('');
    }

    const engine = result.engine as { writeFile: (...args: unknown[]) => Promise<void> };
    await engine.writeFile(
      path, L.join('\n'),
      {
        title: `Retrospective — ${monthName}`,
        tags: ['retrospective', 'report'],
        created: new Date().toISOString().slice(0, 10),
        updated: new Date().toISOString().slice(0, 10),
        written_by: 'retrospective-engine',
        review_status: 'auto_approved',
      },
      `retrospective: ${monthName}`
    );
    return path;
  } catch (err) {
    console.warn('[retrospective] KB write failed:', (err as Error).message);
    return null;
  }
}

/**
 * File transferable learnings to the shared KB (Feature 7).
 */
async function fileTransferableToShared(businessId: string, parsed: Record<string, unknown>): Promise<void> {
  try {
    const { getSharedKB } = await import('../kb/shared-kb.js') as unknown as {
      getSharedKB: () => Promise<{ writeFile: (...args: unknown[]) => Promise<void> } | null>;
    };
    const engine = await getSharedKB();
    if (!engine) return;

    const transferable = [
      ...((parsed.learnings as Record<string, unknown>[] | null) ?? []).filter((l) => l.applies_to && l.applies_to !== 'this business only'),
      ...((parsed.what_worked as Record<string, unknown>[] | null) ?? []).map((w) => ({ learning: `${w.title}: ${w.evidence}`, applies_to: 'all' })),
    ];
    if (transferable.length === 0) return;

    const today = new Date().toISOString().split('T')[0]!;
    const path = `tactics/retrospective-learnings-${today}-${businessId.slice(0, 8)}.md`;
    const lines = [`# Transferable learnings (${today})`, ''];
    for (const t of transferable) {
      lines.push(`- ${t.learning}${t.applies_to ? ` — applies to: ${t.applies_to}` : ''}`);
    }
    await engine.writeFile(
      path, lines.join('\n'),
      {
        title: `Transferable learnings ${today}`,
        tags: ['learning', 'shared', 'retrospective'],
        created: today, updated: today,
        written_by: 'retrospective-engine',
        review_status: 'auto_approved',
      },
      `shared learnings ${today}`
    );
  } catch (err) {
    console.warn('[retrospective] shared KB write failed:', (err as Error).message);
  }
}

export function listRetrospectives(businessId: string, limit = 24): Record<string, unknown>[] {
  const rows = db.prepare(`
    SELECT id, business_id, period_start, period_end, executive_summary,
           kb_path, triggered_by, created_at
    FROM retrospectives WHERE business_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit) as Record<string, unknown>[];
  return rows;
}

export function getRetrospective(id: string, businessId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM retrospectives WHERE id = ? AND business_id = ?').get(id, businessId) as Record<string, unknown> | null;
  if (!row) return null;
  const parsed: Record<string, unknown> = {};
  for (const k of [
    'what_worked', 'what_didnt', 'learnings', 'agent_assessments', 'open_windows',
    'recommendations', 'operating_changes', 'calibration_notes',
    // #73: where the records could not support a proposal, and which prose
    // suggestions deliberately stayed prose.
    'evidence_gaps', 'unstructured_suggestions',
  ]) {
    try { parsed[k] = JSON.parse((row[k] as string) || '[]'); } catch { parsed[k] = []; }
  }
  let full: Record<string, unknown> | null = null;
  try { full = row.full_report_json ? JSON.parse(row.full_report_json as string) as Record<string, unknown> : null; } catch {}

  // The proposals are read live rather than snapshotted into the report:
  // their status changes as humans approve, reject or let them lapse, and a
  // frozen copy would show a stale "awaiting review" long after the decision.
  let proposals: unknown[] = [];
  try { proposals = listProposalsForRetrospective(id, businessId); } catch { proposals = []; }

  return { ...row, ...parsed, proposals, full };
}
