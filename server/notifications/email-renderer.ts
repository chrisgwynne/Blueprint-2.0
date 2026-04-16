/**
 * Email HTML renderer (Feature 5).
 * Generates styled HTML for Blueprint weekly briefings + client variants.
 */

interface MetricItem {
  label?: string;
  value?: string;
  direction?: string;
  change_label?: string;
}

interface TaskItem {
  verdict?: string;
  title?: string;
  agent_name?: string;
  change_pct?: number | null;
  metric_label?: string;
  verdict_label?: string;
}

interface OutcomeItem {
  verdict?: string;
  summary?: string;
}

interface BusinessShape {
  name?: string;
  settings?: {
    logo?: string;
    [key: string]: any;
  };
}

interface WeeklyBriefingData {
  business?: BusinessShape;
  period?: string;
  health_score?: number;
  health_direction?: string;
  summary?: string;
  metrics?: MetricItem[];
  tasks_completed?: TaskItem[];
  priorities?: string[];
  generated_at?: string;
}

interface ClientBriefingData {
  business?: BusinessShape;
  period?: string;
  health_score?: number;
  summary?: string;
  metrics?: MetricItem[];
  outcomes?: OutcomeItem[];
  priorities?: string[];
  generated_at?: string;
  client_url?: string;
}

function safe(v: any, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function healthColor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 60) return '#f59e0b';
  return '#ef4444';
}

function verdictIcon(v: string): string {
  if (v === 'improved') return '&#9989;';     // ✅
  if (v === 'worsened') return '&#10060;';    // ❌
  if (v === 'no_change') return '&#8594;';    // →
  return '&#9675;';                            // ○
}

/**
 * Render the standard weekly briefing email (internal use).
 */
export function renderWeeklyBriefingEmail(briefingData: WeeklyBriefingData): string {
  const {
    business = {},
    period = '',
    health_score = 0,
    health_direction = '',
    summary = '',
    metrics = [],
    tasks_completed = [],
    priorities = [],
    generated_at = new Date().toISOString(),
  } = briefingData || {};

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:4000';
  const businessName = safe(business.name, 'Your business');
  const hColor = healthColor(health_score);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blueprint Weekly — ${businessName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f4f4f5; color: #18181b; padding: 24px 16px; }
  .wrapper { max-width: 600px; margin: 0 auto; }
  .header { background: #0d1117; border-radius: 8px 8px 0 0; padding: 28px 32px; }
  .header-wordmark { font-size: 11px; font-weight: 600; letter-spacing: 0.15em; color: #3b82f6; text-transform: uppercase; margin-bottom: 8px; }
  .header-business { font-size: 22px; font-weight: 700; color: #e2e8f0; margin-bottom: 4px; }
  .header-period { font-size: 13px; color: #94a3b8; }
  .health-score { display: inline-block; font-size: 36px; font-weight: 800; color: ${hColor}; margin-top: 16px; }
  .health-label { font-size: 10px; letter-spacing: 0.12em; color: #94a3b8; text-transform: uppercase; display: block; margin-top: 2px; }
  .section { background: #ffffff; padding: 24px 32px; border-left: 1px solid #e4e4e7; border-right: 1px solid #e4e4e7; }
  .section + .section { border-top: 1px solid #f4f4f5; }
  .section:last-of-type { border-radius: 0 0 8px 8px; border-bottom: 1px solid #e4e4e7; }
  .section-title { font-size: 10px; font-weight: 600; letter-spacing: 0.12em; color: #94a3b8; text-transform: uppercase; margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.65; color: #374151; }
  .metrics-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 4px; }
  .metric-cell { background: #f8fafc; border-radius: 6px; padding: 12px; }
  .metric-name { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .metric-value { font-size: 20px; font-weight: 700; color: #0f172a; }
  .metric-change { font-size: 11px; margin-top: 2px; }
  .up { color: #10b981; }
  .down { color: #ef4444; }
  .flat { color: #94a3b8; }
  .task-item { padding: 12px 0; border-bottom: 1px solid #f1f5f9; display: flex; align-items: flex-start; gap: 10px; }
  .task-item:last-child { border-bottom: none; }
  .task-verdict { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
  .task-title { font-size: 13px; font-weight: 600; color: #1e293b; }
  .task-meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .priorities-list { list-style: none; }
  .priorities-list li { padding: 10px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #374151; display: flex; gap: 10px; align-items: baseline; }
  .priorities-list li:last-child { border-bottom: none; }
  .priority-num { font-size: 11px; font-weight: 700; color: #3b82f6; flex-shrink: 0; width: 16px; }
  .footer { text-align: center; padding: 20px; font-size: 11px; color: #94a3b8; }
  .footer a { color: #3b82f6; text-decoration: none; }
  .cta { display: block; background: #3b82f6; color: #ffffff !important; text-decoration: none; text-align: center; padding: 14px 24px; border-radius: 6px; font-size: 14px; font-weight: 600; margin: 20px 0 4px; }
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="header-wordmark">Blueprint</div>
    <div class="header-business">${businessName}</div>
    <div class="header-period">Week of ${safe(period)}</div>
    <div class="health-score">${health_score}<span style="font-size:18px">/100</span></div>
    <span class="health-label">Health score ${safe(health_direction)}</span>
  </div>

  <div class="section">
    <div class="section-title">This week</div>
    <p class="summary-text">${safe(summary, 'No summary available.')}</p>
  </div>

  ${metrics.length > 0 ? `
  <div class="section">
    <div class="section-title">Key metrics</div>
    <div class="metrics-grid">
      ${metrics.map(m => `
        <div class="metric-cell">
          <div class="metric-name">${safe(m.label)}</div>
          <div class="metric-value">${safe(m.value)}</div>
          <div class="metric-change ${safe(m.direction, 'flat')}">${safe(m.change_label)}</div>
        </div>
      `).join('')}
    </div>
  </div>
  ` : ''}

  ${tasks_completed.length > 0 ? `
  <div class="section">
    <div class="section-title">Actions taken (${tasks_completed.length})</div>
    ${tasks_completed.map(t => `
      <div class="task-item">
        <span class="task-verdict">${verdictIcon(t.verdict ?? '')}</span>
        <div>
          <div class="task-title">${safe(t.title)}</div>
          <div class="task-meta">
            ${safe(t.agent_name)} &middot;
            ${t.verdict === 'improved' && t.change_pct != null
              ? `${safe(t.metric_label)} ${(t.change_pct ?? 0) > 0 ? '+' : ''}${Math.round(t.change_pct ?? 0)}%`
              : t.verdict === 'pending' ? 'Outcome check scheduled'
              : safe(t.verdict_label, t.verdict)}
          </div>
        </div>
      </div>
    `).join('')}
  </div>
  ` : ''}

  ${priorities.length > 0 ? `
  <div class="section">
    <div class="section-title">This week's priorities</div>
    <ol class="priorities-list">
      ${priorities.slice(0, 3).map((p, i) => `
        <li><span class="priority-num">${i + 1}</span><span>${safe(p)}</span></li>
      `).join('')}
    </ol>
    <a href="${clientUrl}" class="cta">Open Blueprint &rarr;</a>
  </div>
  ` : ''}

  <div class="footer">
    Generated by Blueprint on ${new Date(generated_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}<br>
    <a href="${clientUrl}/settings">Manage email settings</a>
  </div>

</div>
</body>
</html>`;
}

/**
 * Render a client-facing briefing — stripped of agent internals.
 */
export function renderClientBriefingEmail(briefingData: ClientBriefingData): string {
  const {
    business = {},
    period = '',
    health_score = 0,
    summary = '',
    metrics = [],
    outcomes = [],
    priorities = [],
    generated_at = new Date().toISOString(),
    client_url,
  } = briefingData || {};

  const businessName = safe(business.name, 'Your website');
  const logo = business.settings?.logo;
  const hColor = healthColor(health_score);
  const openUrl = client_url || process.env.CLIENT_URL || 'http://localhost:4000';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${businessName} — Weekly report</title>
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f4f4f5; color: #18181b; padding: 24px 16px; margin: 0; }
  .wrapper { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
  .header { padding: 32px; text-align: center; border-bottom: 4px solid ${hColor}; }
  .header img { max-height: 40px; margin-bottom: 12px; }
  .header h1 { font-size: 20px; margin: 0 0 4px; color: #0f172a; }
  .header .period { color: #64748b; font-size: 13px; }
  .score-banner { background: ${hColor}15; padding: 20px; text-align: center; }
  .score { font-size: 44px; font-weight: 800; color: ${hColor}; }
  .score-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
  .section { padding: 24px 32px; border-bottom: 1px solid #e4e4e7; }
  .section h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin: 0 0 12px; }
  .summary { line-height: 1.6; color: #374151; font-size: 15px; }
  .metric { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
  .metric:last-child { border: none; }
  .metric-label { color: #64748b; font-size: 13px; }
  .metric-value { font-weight: 700; color: #0f172a; }
  .outcome { padding: 10px 0; border-bottom: 1px solid #f1f5f9; display: flex; gap: 10px; }
  .outcome:last-child { border: none; }
  .outcome-icon { font-size: 18px; }
  .outcome-text { font-size: 13px; color: #374151; }
  .cta { display: block; text-align: center; padding: 14px; background: #3b82f6; color: white !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0; }
  .footer { padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    ${logo ? `<img src="${logo}" alt="${businessName}"/>` : ''}
    <h1>${businessName}</h1>
    <div class="period">Week of ${safe(period)}</div>
  </div>

  <div class="score-banner">
    <div class="score">${health_score}</div>
    <div class="score-label">Website health</div>
  </div>

  <div class="section">
    <h2>This week</h2>
    <p class="summary">${safe(summary, 'No updates this week.')}</p>
  </div>

  ${metrics.length > 0 ? `
  <div class="section">
    <h2>Key metrics</h2>
    ${metrics.map(m => `
      <div class="metric">
        <span class="metric-label">${safe(m.label)}</span>
        <span class="metric-value">${safe(m.value)}${m.change_label ? ` <span style="color:${m.direction === 'up' ? '#10b981' : m.direction === 'down' ? '#ef4444' : '#94a3b8'};font-weight:400">${safe(m.change_label)}</span>` : ''}</span>
      </div>
    `).join('')}
  </div>
  ` : ''}

  ${outcomes.length > 0 ? `
  <div class="section">
    <h2>Improvements made</h2>
    ${outcomes.map(o => `
      <div class="outcome">
        <span class="outcome-icon">${verdictIcon(o.verdict ?? '')}</span>
        <span class="outcome-text">${safe(o.summary)}</span>
      </div>
    `).join('')}
  </div>
  ` : ''}

  <div class="section">
    <a href="${openUrl}" class="cta">View full report &rarr;</a>
  </div>

  <div class="footer">
    Generated ${new Date(generated_at).toLocaleDateString()}
  </div>
</div>
</body>
</html>`;
}
