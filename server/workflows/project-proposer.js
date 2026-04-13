import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `Propose a focused project to organise related work.
Return only valid JSON.

Shape:
{
  "name": "Short project name",
  "description": "What this project aims to achieve",
  "color": "#3b82f6",
  "icon": "🔍",
  "assigned_agents": ["agent-id"],
  "tags": ["tag"],
  "target_date": "YYYY-MM-DD"
}`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

export async function proposeProject(businessId, context) {
  const business = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!business) throw new Error('Business not found');
  const signals = db.prepare(
    "SELECT title FROM signals WHERE business_id=? AND status='open' ORDER BY created_at DESC LIMIT 5"
  ).all(businessId);
  const goals = db.prepare(
    "SELECT id, title FROM goals WHERE business_id=? AND status='active'"
  ).all(businessId);

  const userMsg = `Business: ${business.name}
Open signals: ${signals.map(s => s.title).join(', ') || '(none)'}
Active goals: ${goals.map(g => g.title).join(', ') || '(none)'}
Context: ${context}`;

  const { providerId, model } = resolveProfileLLM({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
  try {
    const res = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      temperature: 0.3, max_tokens: 1024,
    });
    return extractJSON(res?.content ?? '');
  } catch (err) {
    console.warn('[project-proposer] failed:', err.message);
    return null;
  }
}
