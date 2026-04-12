/**
 * Reporter agent email delivery (Feature 5).
 *
 * Called after a successful Reporter agent run. Builds email payload from
 * the agent's parsed output + recent metrics + recent outcomes, renders
 * HTML, and delivers via the configured provider (if email_report_to is set).
 */
import db from '../db/db.js';
import { sendEmail, getEmailRecipient } from './email.js';
import { renderWeeklyBriefingEmail } from './email-renderer.js';

function weekOfLabel() {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtChange(from, to) {
  if (from == null || from === 0) return { label: '—', direction: 'flat' };
  const pct = ((to - from) / Math.abs(from)) * 100;
  if (Math.abs(pct) < 1) return { label: 'flat', direction: 'flat' };
  return {
    label: `${pct > 0 ? '+' : ''}${Math.round(pct)}%`,
    direction: pct > 0 ? 'up' : 'down',
  };
}

function buildMetrics(businessId) {
  const names = ['sessions_7d', 'organic_keywords', 'pagespeed_score'];
  const labels = { sessions_7d: 'Sessions', organic_keywords: 'Keywords', pagespeed_score: 'PageSpeed' };
  return names.map((name) => {
    const rows = db.prepare(`
      SELECT metric_value FROM metrics
      WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
      ORDER BY recorded_at DESC LIMIT 2
    `).all(businessId, name);
    const current = rows[0]?.metric_value;
    const prev = rows[1]?.metric_value;
    const change = current != null && prev != null ? fmtChange(prev, current) : { label: '', direction: 'flat' };
    return {
      label: labels[name],
      value: current != null ? Math.round(current).toLocaleString() : '—',
      change_label: change.label,
      direction: change.direction,
    };
  });
}

function buildOutcomes(businessId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT t.id, t.title, t.proposed_by,
           (SELECT verdict FROM task_outcomes WHERE task_id = t.id ORDER BY weeks_after DESC LIMIT 1) as verdict,
           (SELECT change_pct FROM task_outcomes WHERE task_id = t.id ORDER BY weeks_after DESC LIMIT 1) as change_pct,
           t.target_metric
    FROM tasks t
    WHERE t.business_id = ?
      AND t.status IN ('complete', 'verified')
      AND t.completed_at >= ?
    ORDER BY t.completed_at DESC
    LIMIT 10
  `).all(businessId, sevenDaysAgo);

  return rows.map((r) => ({
    title: r.title,
    agent_name: r.proposed_by,
    verdict: r.verdict ?? 'pending',
    change_pct: r.change_pct,
    metric_label: r.target_metric ? r.target_metric.split('.').pop() : '',
    verdict_label: r.verdict ?? 'pending',
  }));
}

function extractPriorities(parsed) {
  const p = [];
  if (Array.isArray(parsed?.priorities)) p.push(...parsed.priorities);
  if (Array.isArray(parsed?.tasks)) {
    for (const t of parsed.tasks) {
      if (p.length >= 3) break;
      if (t.title) p.push(t.title);
    }
  }
  return p.slice(0, 3);
}

function healthDirection(businessId) {
  const scores = db.prepare(`
    SELECT health_score FROM analysis_runs
    WHERE business_id = ? AND health_score IS NOT NULL
    ORDER BY started_at DESC LIMIT 2
  `).all(businessId);
  if (scores.length < 2 || scores[0].health_score === scores[1].health_score) return 'stable';
  return scores[0].health_score > scores[1].health_score ? '↑ improving' : '↓ declining';
}

function currentHealthScore(businessId) {
  const row = db.prepare(`
    SELECT health_score FROM analysis_runs
    WHERE business_id = ? AND health_score IS NOT NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(businessId);
  return row?.health_score ?? 75;
}

export async function sendReporterEmail(parsed, business, businessId, startedAt) {
  const to = getEmailRecipient();
  if (!to) {
    console.log('[reporter-email] Skipping — no recipient configured.');
    return;
  }

  const healthScore = currentHealthScore(businessId);
  const metrics = buildMetrics(businessId);
  const tasksCompleted = buildOutcomes(businessId);
  const priorities = extractPriorities(parsed);

  const data = {
    business,
    period: weekOfLabel(),
    health_score: healthScore,
    health_direction: healthDirection(businessId),
    summary: parsed?.summary || parsed?.reasoning?.slice(0, 400) || 'Reporter agent run completed.',
    metrics,
    tasks_completed: tasksCompleted,
    priorities,
    generated_at: startedAt || new Date().toISOString(),
  };

  const html = renderWeeklyBriefingEmail(data);
  const subject = `Blueprint Weekly — ${business.name} — ${data.period}`;

  const result = await sendEmail({ to, subject, html });
  console.log(`[reporter-email] Sent weekly briefing via ${result.provider} (id: ${result.id}) to ${to}`);
  return result;
}
