/**
 * Goals engine (Prompt 2).
 *
 * Checks goal progress by reading the latest metric value, computes
 * percent-to-target, updates status (achieved/missed/at_risk), logs a
 * goal_checks entry, generates an agent note, and optionally creates
 * signals or tasks for at-risk or stalled goals.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import { pushDashboardEvent } from '../lib/sse-bus.js';

export async function checkAllGoals(businessId) {
  const goals = db.prepare(`
    SELECT * FROM goals WHERE business_id = ? AND status = 'active'
  `).all(businessId);
  let checked = 0;
  for (const g of goals) {
    try { await checkGoal(g); checked++; }
    catch (err) { console.warn(`[goals] check failed for ${g.id}:`, err.message); }
  }
  return checked;
}

export async function checkGoalById(goalId) {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(goalId);
  if (!goal) throw new Error('Goal not found');
  return checkGoal(goal);
}

async function checkGoal(goal) {
  if (!goal.metric_name) return null;

  const latest = db.prepare(`
    SELECT metric_value FROM metrics
    WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
    ORDER BY recorded_at DESC LIMIT 1
  `).get(goal.business_id, goal.metric_name);

  if (latest?.metric_value == null) return null;

  const current = Number(latest.metric_value);
  const baseline = Number(goal.metric_baseline ?? 0);
  const target = Number(goal.metric_target ?? 0);
  const totalChange = target - baseline;
  const currentChange = current - baseline;
  const progressPct = totalChange !== 0
    ? Math.min(100, Math.max(0, (currentChange / totalChange) * 100))
    : 0;

  const now = new Date();
  const deadline = goal.deadline ? new Date(goal.deadline) : null;
  const daysLeft = deadline ? Math.ceil((deadline - now) / 86400000) : null;
  const isAchieved = progressPct >= 100;
  const isMissed = deadline && daysLeft < 0 && !isAchieved;
  const isAtRisk = deadline && daysLeft != null && daysLeft < 14 && progressPct < 70 && !isAchieved;

  const newStatus = isAchieved ? 'achieved' : isMissed ? 'missed' : 'active';
  const statusChange = isAchieved ? 'achieved' : isAtRisk ? 'at_risk' : isMissed ? 'missed' : 'on_track';

  db.prepare(`
    UPDATE goals
    SET metric_current=?, progress_pct=?, last_checked=CURRENT_TIMESTAMP,
        status=?, achieved_at=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    current, progressPct, newStatus,
    isAchieved ? new Date().toISOString() : null,
    goal.id
  );

  // Agent note via LLM (best-effort)
  const note = await generateNote(goal, current, progressPct, daysLeft).catch(() => '');

  db.prepare(`
    INSERT INTO goal_checks
    (id, goal_id, business_id, metric_value, progress_pct, status_change, agent_note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), goal.id, goal.business_id, current, progressPct, statusChange, note);

  pushDashboardEvent(goal.business_id, 'goal_check', {
    goalId: goal.id, progressPct, status: newStatus, statusChange,
  });

  // Achieved — file to KB and celebrate
  if (isAchieved) {
    await fileGoalToKB(goal, 'achieved', note).catch(() => {});
  }

  // At-risk — create a signal
  if (isAtRisk) {
    try {
      const exists = db.prepare(
        "SELECT id FROM signals WHERE business_id=? AND rule_id='goal_at_risk' AND data LIKE ? AND status='open'"
      ).get(goal.business_id, `%${goal.id}%`);
      if (!exists) {
        db.prepare(`
          INSERT INTO signals (id, business_id, rule_id, type, severity, title, description, data, status, confidence, created_at)
          VALUES (?, ?, 'goal_at_risk', 'risk', 'warning', ?, ?, ?, 'open', 0.9, CURRENT_TIMESTAMP)
        `).run(
          crypto.randomUUID(), goal.business_id,
          `Goal at risk: ${goal.title}`,
          `${progressPct.toFixed(0)}% progress with ${daysLeft} days remaining. ${note}`,
          JSON.stringify({ goal_id: goal.id, progress_pct: progressPct, days_left: daysLeft })
        );
      }
    } catch {}
  }

  return { goalId: goal.id, progressPct, status: newStatus, note };
}

async function generateNote(goal, current, progressPct, daysLeft) {
  try {
    const prompt = `Goal: ${goal.title}
Metric: ${goal.metric_name}
Baseline: ${goal.metric_baseline} → Current: ${current} → Target: ${goal.metric_target}
Progress: ${progressPct.toFixed(1)}%
Days remaining: ${daysLeft ?? 'no deadline'}

Write ONE specific sentence about status and most important next action.`;

    const { providerId, model } = resolveProfileLLM({
      model: 'claude-haiku-4-5-20251001',
    });
    const result = await runLLM(providerId, model, {
      system: 'Write one specific sentence. No JSON, no markdown, no filler.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 120,
    });
    return (result?.content || '').trim().slice(0, 400);
  } catch {
    const direction = progressPct >= 50 ? 'on track' : 'falling behind';
    return `Progress at ${progressPct.toFixed(0)}% — ${direction}.`;
  }
}

async function fileGoalToKB(goal, outcome, note) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const result = await getKBForBusiness(goal.business_id);
    if (!result?.engine) return;
    const today = new Date().toISOString().split('T')[0];
    const body = `# Goal ${outcome === 'achieved' ? '✅ Achieved' : '❌ Missed'}: ${goal.title}

**Metric:** ${goal.metric_name}
**Baseline:** ${goal.metric_baseline}
**Target:** ${goal.metric_target}
**Final:** ${goal.metric_current}
**Created:** ${goal.created_at}
**${outcome === 'achieved' ? 'Achieved' : 'Deadline'}:** ${goal.achieved_at || goal.deadline}

## Note

${note || '_(no note)_'}

## Strategy

${goal.strategy || 'None recorded'}
`;
    await result.engine.writeFile(
      `decisions/goal-${outcome}-${goal.id.slice(0, 8)}.md`,
      body,
      {
        title: goal.title,
        tags: ['goal', outcome],
        created: today, updated: today,
        written_by: 'system', review_status: 'auto_approved',
      },
      `goal: ${outcome} — ${goal.title}`
    );
  } catch {}
}
