/**
 * AI-generated workflow proposals.
 * Asks the Conductor LLM for a new workflow based on current signals.
 */
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '../agents');

const SYSTEM_PROMPT = `You are Blueprint's Conductor. Propose ONE workflow that addresses
the current business situation. Return only valid JSON. No prose outside JSON.

Available agents: conductor, seo-sentinel, quill, velocity, trend-spotter,
merchant, ledger, sentinel, researcher, reporter, dev, outreach

Shape:
{
  "name": "Clear descriptive name",
  "description": "What this workflow does",
  "trigger_type": "manual",
  "trigger_config": {},
  "tags": ["tag1", "tag2"],
  "steps": [
    {
      "index": 0,
      "name": "Step name",
      "agent_id": "agent-id",
      "task_template": "Detailed instruction for the agent",
      "approval_gate": false,
      "approval_message": "",
      "timeout_minutes": 30
    }
  ]
}

Rules:
- approval_gate: true only on steps that produce content a human should review.
- 2-4 steps is ideal. Never more than 6.
- Each step's output flows into the next — write task_templates assuming that.`;

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(str.trim()); } catch { return null; }
}

function loadConductorLLM() {
  const path = join(AGENTS_DIR, 'conductor', 'profile.yaml');
  if (!existsSync(path)) return { model: 'claude-sonnet-4-20250514', temperature: 0.3, max_tokens: 2048 };
  try {
    const profile = yaml.load(readFileSync(path, 'utf8'));
    return profile?.llm ?? { model: 'claude-sonnet-4-20250514' };
  } catch { return { model: 'claude-sonnet-4-20250514' }; }
}

export async function proposeWorkflow(businessId, trigger = 'human request') {
  const business = db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId);
  if (!business) throw new Error('Business not found');

  const signals = db.prepare(`
    SELECT severity, title FROM signals
    WHERE business_id = ? AND status = 'open'
    ORDER BY created_at DESC LIMIT 15
  `).all(businessId);

  const existing = db.prepare(
    "SELECT name, description FROM workflows WHERE business_id = ? AND status != 'archived' LIMIT 30"
  ).all(businessId);

  const userMessage = `Business: ${business.name} (${business.type ?? 'general'})

Current open signals:
${signals.length === 0 ? '(none)' : signals.map(s => `- [${s.severity}] ${s.title}`).join('\n')}

Existing workflows (don't duplicate these):
${existing.length === 0 ? '(none)' : existing.map(w => `- ${w.name}: ${w.description ?? ''}`).join('\n')}

Trigger context: ${trigger}

Propose ONE workflow.`;

  const llmConfig = loadConductorLLM();
  const { providerId, model } = resolveProfileLLM(llmConfig);

  let result;
  try {
    result = await runLLM(providerId, model, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.3,
      max_tokens: 2048,
    });
  } catch (err) {
    console.warn('[workflow-proposer] LLM failed:', err.message);
    return null;
  }

  const proposed = extractJSON(result?.content ?? '');
  if (!proposed?.steps?.length) return null;

  // Normalise step indices
  proposed.steps = proposed.steps.map((s, i) => ({
    index: i,
    name: s.name ?? `Step ${i + 1}`,
    agent_id: s.agent_id ?? 'conductor',
    task_template: s.task_template ?? '',
    approval_gate: !!s.approval_gate,
    approval_message: s.approval_message ?? '',
    timeout_minutes: s.timeout_minutes ?? 30,
  }));

  const workflowId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO workflows
    (id, business_id, name, description, trigger_type, trigger_config,
     steps, created_by, status, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'conductor', 'draft', ?)
  `).run(
    workflowId, businessId,
    proposed.name ?? 'Untitled workflow',
    proposed.description ?? '',
    proposed.trigger_type ?? 'manual',
    JSON.stringify(proposed.trigger_config ?? {}),
    JSON.stringify(proposed.steps),
    JSON.stringify(proposed.tags ?? [])
  );

  return workflowId;
}
