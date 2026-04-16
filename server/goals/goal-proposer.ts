/**
 * AI-generated goal proposals.
 */
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You propose specific, measurable business goals for Blueprint.
Return only valid JSON. No prose outside JSON.

Shape:
{
  "title": "Concrete, measurable title with target and deadline",
  "description": "Why this matters and what success looks like",
  "metric_name": "namespaced.metric.name",
  "metric_target": <number>,
  "deadline": "YYYY-MM-DD",
  "assigned_agents": ["agent-id"],
  "strategy": "How agents should approach this goal",
  "tags": ["tag"],
  "milestones": [
    { "title": "50% progress", "target_pct": 50, "notes": "" }
  ]
}

Only use real metric_name values from the provided list of current metrics.
Only include agents from: conductor, seo-sentinel, quill, velocity, trend-spotter,
merchant, ledger, sentinel, researcher, reporter, dev, outreach.`;

function extractJSON(content: string | null | undefined): any | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

export async function proposeGoal(businessId: string, context: string): Promise<any | null> {
  const business = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId) as any;
  if (!business) throw new Error('Business not found');

  const metrics = db.prepare(`
    SELECT metric_name, metric_value FROM metrics
    WHERE business_id = ? AND metric_value IS NOT NULL
    GROUP BY metric_name
    ORDER BY recorded_at DESC LIMIT 40
  `).all(businessId) as Array<{ metric_name: string; metric_value: number }>;

  const existing = db.prepare(
    "SELECT title FROM goals WHERE business_id=? AND status='active'"
  ).all(businessId) as Array<{ title: string }>;

  const userMessage = `Business: ${business.name} (${business.type ?? 'general'})

Current metrics (sample):
${metrics.slice(0, 20).map(m => `- ${m.metric_name}: ${m.metric_value}`).join('\n') || '(none)'}

Existing goals (don't duplicate):
${existing.map(g => `- ${g.title}`).join('\n') || '(none)'}

Context: ${context}

Propose ONE specific goal.`;

  const { providerId, model } = resolveProfileLLM({});

  try {
    const result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.3,
      max_tokens: 1024,
    }) as { content: string; usage: { input_tokens: number; output_tokens: number }; cost_usd?: number };
    return extractJSON(result?.content ?? '');
  } catch (err: any) {
    console.warn('[goal-proposer] LLM failed:', err.message);
    return null;
  }
}
