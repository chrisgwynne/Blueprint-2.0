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

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

/**
 * Assemble all data for a retrospective period.
 */
function assembleData(businessId, periodStart, periodEnd) {
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const completedTasks = db.prepare(`
    SELECT t.id, t.title, t.action_type, t.proposed_by, t.confidence,
           t.status, t.approved_at, t.completed_at,
           (julianday(t.approved_at) - julianday(t.created_at)) * 24 AS hours_to_approve
    FROM tasks t
    WHERE t.business_id = ? AND t.completed_at BETWEEN ? AND ?
  `).all(businessId, startIso, endIso);

  const outcomes = db.prepare(`
    SELECT o.task_id, o.verdict, o.change_pct, o.metric_value, o.baseline_value,
           t.title, t.action_type, t.proposed_by, t.confidence, t.target_metric
    FROM task_outcomes o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.business_id = ? AND o.check_date BETWEEN ? AND ?
  `).all(businessId, startIso, endIso);

  const agentRuns = db.prepare(`
    SELECT agent_id, COUNT(*) as runs,
           SUM(tasks_proposed) as tasks_proposed,
           SUM(signals_detected) as signals_detected,
           AVG(CASE WHEN error IS NULL THEN 1 ELSE 0 END) as success_rate
    FROM agent_runs
    WHERE business_id = ? AND started_at BETWEEN ? AND ?
    GROUP BY agent_id
  `).all(businessId, startIso, endIso);

  const goalChecks = db.prepare(`
    SELECT gc.*, g.title, g.metric_target, g.status AS goal_status
    FROM goal_checks gc
    JOIN goals g ON g.id = gc.goal_id
    WHERE gc.business_id = ? AND gc.checked_at BETWEEN ? AND ?
    ORDER BY gc.checked_at DESC
  `).all(businessId, startIso, endIso);

  const signals = db.prepare(`
    SELECT type, severity, status, rule_id, COUNT(*) AS count
    FROM signals
    WHERE business_id = ? AND created_at BETWEEN ? AND ?
    GROUP BY type, severity, status, rule_id
  `).all(businessId, startIso, endIso);

  const deferredTasks = db.prepare(`
    SELECT COUNT(*) AS count FROM tasks
    WHERE business_id = ? AND status = 'deferred'
      AND updated_at BETWEEN ? AND ?
  `).get(businessId, startIso, endIso);

  const openWindows = db.prepare(`
    SELECT action_type, COUNT(*) AS count
    FROM action_memory
    WHERE business_id = ? AND outcome_measured = 0
      AND measurement_window_end > CURRENT_TIMESTAMP
    GROUP BY action_type
  `).all(businessId);

  // Per-agent calibration from outcomes
  const agentCalibration = {};
  for (const o of outcomes) {
    if (!o.proposed_by) continue;
    const agent = o.proposed_by.replace(/^agent:/, '');
    if (!agentCalibration[agent]) {
      agentCalibration[agent] = { stated: [], outcomes: [] };
    }
    if (o.confidence != null) agentCalibration[agent].stated.push(o.confidence);
    agentCalibration[agent].outcomes.push(o.verdict === 'improved' ? 1 : 0);
  }

  return {
    completedTasks, outcomes, agentRuns, goalChecks, signals,
    deferredTasks: deferredTasks?.count ?? 0,
    openWindows, agentCalibration,
  };
}

function buildPrompt(business, data, periodStart, periodEnd) {
  const lines = [];
  lines.push(`Business: ${business?.name ?? 'unknown'}`);
  lines.push(`Period: ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`TASKS COMPLETED (${data.completedTasks.length}):`);
  for (const t of data.completedTasks.slice(0, 30)) {
    lines.push(`- "${t.title}" (${t.action_type ?? '?'}, by ${t.proposed_by}, confidence ${t.confidence ?? 'n/a'})`);
  }
  lines.push('');
  lines.push(`OUTCOMES MEASURED (${data.outcomes.length}):`);
  for (const o of data.outcomes.slice(0, 30)) {
    const pct = o.change_pct != null ? `${o.change_pct > 0 ? '+' : ''}${o.change_pct.toFixed(1)}%` : 'n/a';
    lines.push(`- "${o.title}": ${o.verdict} (${pct}) on ${o.target_metric ?? '?'}; stated confidence ${o.confidence ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('AGENT ACTIVITY:');
  for (const a of data.agentRuns) {
    lines.push(`- ${a.agent_id}: ${a.runs} runs, ${a.tasks_proposed ?? 0} tasks proposed, ${a.signals_detected ?? 0} signals, ${((a.success_rate ?? 0) * 100).toFixed(0)}% run success`);
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
    lines.push(`- ${g.title} (${g.goal_status}): ${(g.progress_pct ?? 0).toFixed(0)}% — ${g.status_change ?? 'no change'}${g.agent_note ? ` — ${g.agent_note}` : ''}`);
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
 * @param {string} businessId
 * @param {object} [opts] — { triggered_by }
 */
export async function runRetrospective(businessId, opts = {}) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) throw new Error('Business not found');

  const periodEnd = new Date();
  const periodStart = new Date(Date.now() - 30 * 86400000);

  const data = assembleData(businessId, periodStart, periodEnd);
  const prompt = buildPrompt(business, data, periodStart, periodEnd);

  const { providerId, model } = resolveProfileLLM({
    model: 'claude-sonnet-4-20250514',
  });

  let parsed = null;
  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, max_tokens: 4096,
    });
    parsed = extractJSON(result?.content ?? '');
  } catch (err) {
    console.warn('[retrospective] LLM failed:', err.message);
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
    parsed.executive_summary ?? null,
    JSON.stringify(parsed.what_worked ?? []),
    JSON.stringify(parsed.what_didnt ?? []),
    JSON.stringify(parsed.learnings ?? []),
    JSON.stringify(parsed.agent_assessments ?? []),
    JSON.stringify(parsed.open_windows ?? []),
    JSON.stringify(parsed.recommendations ?? []),
    JSON.stringify(parsed.operating_changes ?? []),
    JSON.stringify(parsed.calibration_notes ?? []),
    JSON.stringify(parsed),
    opts.triggered_by ?? 'scheduler'
  );

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

  return { id, ...parsed, kb_path: kbPath };
}

async function applyCalibration(businessId, parsed, periodStart, periodEnd) {
  const assessments = Array.isArray(parsed.agent_assessments) ? parsed.agent_assessments : [];
  const notes = Array.isArray(parsed.calibration_notes) ? parsed.calibration_notes : [];
  const noteByAgent = Object.fromEntries(notes.map((n) => [n.agent_id, n]));

  for (const a of assessments) {
    if (!a.agent_id) continue;
    const calNote = noteByAgent[a.agent_id];
    db.prepare(`
      INSERT INTO agent_calibration
      (id, agent_id, business_id, period_start, period_end,
       tasks_with_outcomes, avg_stated_confidence, avg_actual_outcome_rate,
       calibration_error, calibration_score, calibration_offset, trend, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), a.agent_id, businessId,
      periodStart.toISOString(), periodEnd.toISOString(),
      a.tasks_proposed ?? 0,
      a.avg_stated_confidence ?? null,
      a.avg_actual_outcome_rate ?? null,
      a.calibration_error ?? null,
      a.calibration_error != null ? Math.max(0, 1 - Math.abs(a.calibration_error)) : null,
      calNote?.calibration_offset ?? 0,
      null, // trend is calculated over multiple periods elsewhere
      a.note ?? calNote?.note ?? null
    );
  }
}

async function injectAgentFindings(businessId, parsed) {
  const assessments = Array.isArray(parsed.agent_assessments) ? parsed.agent_assessments : [];
  for (const a of assessments) {
    if (!a.agent_id || !a.note) continue;
    const key = `agent_retro_note_${businessId}_${a.agent_id}`;
    const payload = {
      retro_at: new Date().toISOString(),
      note: a.note,
      grade: a.grade ?? null,
      calibration_error: a.calibration_error ?? null,
    };
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(payload));
  }
}

async function fileToKB(businessId, parsed, periodStart, periodEnd) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return null;

    const monthName = periodStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const slug = periodStart.toISOString().slice(0, 7);
    const path = `reports/retrospective-${slug}.md`;

    const L = [];
    L.push(`# Retrospective — ${monthName}`);
    L.push('');
    L.push(`**Period:** ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`);
    L.push('');
    if (parsed.executive_summary) {
      L.push('## Executive summary');
      L.push('');
      L.push(parsed.executive_summary);
      L.push('');
    }
    if (Array.isArray(parsed.what_worked) && parsed.what_worked.length) {
      L.push('## What worked');
      L.push('');
      for (const w of parsed.what_worked) {
        L.push(`- **${w.title}** — ${w.evidence ?? ''}${w.insight ? `\n  _${w.insight}_` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.what_didnt) && parsed.what_didnt.length) {
      L.push("## What didn't");
      L.push('');
      for (const w of parsed.what_didnt) {
        L.push(`- **${w.title}** — ${w.evidence ?? ''}${w.insight ? `\n  _${w.insight}_` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.learnings) && parsed.learnings.length) {
      L.push('## Learnings');
      L.push('');
      for (const l of parsed.learnings) {
        L.push(`- ${l.learning}${l.applies_to ? ` (applies to: ${l.applies_to})` : ''}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.agent_assessments) && parsed.agent_assessments.length) {
      L.push('## Agent assessments');
      L.push('');
      L.push('| Agent | Grade | Proposed | Accept | Outcome | Stated conf | Actual | Error |');
      L.push('|---|---|---|---|---|---|---|---|');
      for (const a of parsed.agent_assessments) {
        L.push(`| ${a.agent_id} | ${a.grade ?? '-'} | ${a.tasks_proposed ?? 0} | ${((a.acceptance_rate ?? 0) * 100).toFixed(0)}% | ${((a.outcome_rate ?? 0) * 100).toFixed(0)}% | ${((a.avg_stated_confidence ?? 0) * 100).toFixed(0)}% | ${((a.avg_actual_outcome_rate ?? 0) * 100).toFixed(0)}% | ${a.calibration_error != null ? (a.calibration_error * 100).toFixed(1) + '%' : '-'} |`);
      }
      L.push('');
      for (const a of parsed.agent_assessments) {
        if (a.note) L.push(`- **${a.agent_id}:** ${a.note}`);
      }
      L.push('');
    }
    if (Array.isArray(parsed.recommendations) && parsed.recommendations.length) {
      L.push('## Recommendations for next month');
      L.push('');
      parsed.recommendations.forEach((r, i) => L.push(`${i + 1}. ${r}`));
      L.push('');
    }
    if (Array.isArray(parsed.operating_changes) && parsed.operating_changes.length) {
      L.push('## How Blueprint should operate differently');
      L.push('');
      for (const c of parsed.operating_changes) L.push(`- ${c}`);
      L.push('');
    }

    await result.engine.writeFile(
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
    console.warn('[retrospective] KB write failed:', err.message);
    return null;
  }
}

/**
 * File transferable learnings to the shared KB (Feature 7).
 */
async function fileTransferableToShared(businessId, parsed) {
  try {
    const { getSharedKB } = await import('../kb/shared-kb.js');
    const engine = await getSharedKB();
    if (!engine) return;

    const transferable = [
      ...(parsed.learnings ?? []).filter((l) => l.applies_to && l.applies_to !== 'this business only'),
      ...(parsed.what_worked ?? []).map((w) => ({ learning: `${w.title}: ${w.evidence}`, applies_to: 'all' })),
    ];
    if (transferable.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
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
    console.warn('[retrospective] shared KB write failed:', err.message);
  }
}

export function listRetrospectives(businessId, limit = 24) {
  const rows = db.prepare(`
    SELECT id, business_id, period_start, period_end, executive_summary,
           kb_path, triggered_by, created_at
    FROM retrospectives WHERE business_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(businessId, limit);
  return rows;
}

export function getRetrospective(id, businessId) {
  const row = db.prepare('SELECT * FROM retrospectives WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!row) return null;
  const parsed = {};
  for (const k of ['what_worked', 'what_didnt', 'learnings', 'agent_assessments', 'open_windows', 'recommendations', 'operating_changes', 'calibration_notes']) {
    try { parsed[k] = JSON.parse(row[k] || '[]'); } catch { parsed[k] = []; }
  }
  let full = null;
  try { full = row.full_report_json ? JSON.parse(row.full_report_json) : null; } catch {}
  return { ...row, ...parsed, full };
}
