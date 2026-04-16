/**
 * Built-in workflow templates, seeded automatically for each business
 * that has no existing workflows.
 */
import crypto from 'crypto';
import db from '../db/db.js';

interface WorkflowStep {
  index: number;
  name: string;
  agent_id: string;
  task_template: string;
  approval_gate: boolean;
  approval_message: string;
  timeout_minutes: number;
}

interface WorkflowTemplate {
  name: string;
  description: string;
  tags: string[];
  steps: WorkflowStep[];
}

export const BUILT_IN_WORKFLOWS: WorkflowTemplate[] = [
  {
    name: 'SEO Audit → Fix',
    description: 'Full SEO audit, content improvements, then GitHub issues.',
    tags: ['seo', 'content'],
    steps: [
      { index: 0, name: 'SEO Analysis', agent_id: 'seo-sentinel',
        task_template: 'Run a full SEO audit. Analyse GSC rankings, PageSpeed scores, and meta tags across all tracked pages. Produce a structured findings brief with: top 5 issues, keyword opportunities, and CWV problems.',
        approval_gate: false, approval_message: '', timeout_minutes: 30 },
      { index: 1, name: 'Content Drafts', agent_id: 'quill',
        task_template: 'Using the SEO findings from the previous step, draft improved meta titles and descriptions for the top 5 pages identified. Format as a clear list with: page URL, current meta, proposed meta, reason.',
        approval_gate: true,
        approval_message: "Review Quill's meta drafts before creating GitHub issues.",
        timeout_minutes: 60 },
      { index: 2, name: 'Create Issues', agent_id: 'dev',
        task_template: 'Create GitHub issues for each approved meta change from the previous step. Title each issue clearly. Label with blueprint/seo.',
        approval_gate: false, approval_message: '', timeout_minutes: 15 },
    ],
  },
  {
    name: 'Keyword Opportunity → Content',
    description: 'Find keyword opportunities and draft targeting content.',
    tags: ['seo', 'content'],
    steps: [
      { index: 0, name: 'Keyword Research', agent_id: 'seo-sentinel',
        task_template: 'Identify the top 5 keyword opportunities from GSC data: high impressions, low CTR, position 4-15. For each keyword include: impressions, current position, recommended content approach.',
        approval_gate: false, approval_message: '', timeout_minutes: 20 },
      { index: 1, name: 'Content Brief', agent_id: 'quill',
        task_template: 'Using the keyword opportunities identified, create detailed content briefs for the top 3. Each brief: target keyword, title, outline, word count recommendation, internal linking opportunities.',
        approval_gate: true,
        approval_message: 'Approve content briefs before drafting begins.',
        timeout_minutes: 30 },
      { index: 2, name: 'Draft Content', agent_id: 'quill',
        task_template: 'Write the first approved content brief from the previous step as a full draft. Follow brand voice guidelines from the KB.',
        approval_gate: true,
        approval_message: 'Review the content draft before publishing.',
        timeout_minutes: 60 },
    ],
  },
  {
    name: 'Performance Fix',
    description: 'Diagnose PageSpeed issues and create fix tasks.',
    tags: ['performance'],
    steps: [
      { index: 0, name: 'CWV Diagnosis', agent_id: 'velocity',
        task_template: 'Analyse current PageSpeed scores and Core Web Vitals. Identify the top 3 highest-impact performance issues with specific fix recommendations for each.',
        approval_gate: false, approval_message: '', timeout_minutes: 20 },
      { index: 1, name: 'Create Fix Issues', agent_id: 'dev',
        task_template: 'Create GitHub issues for each performance fix identified in the previous step. Include: problem description, specific technical fix, expected improvement. Label blueprint/performance.',
        approval_gate: true,
        approval_message: 'Review performance fix issues before creating.',
        timeout_minutes: 15 },
    ],
  },
  {
    name: 'Weekly Business Review',
    description: 'Full business analysis and priority recommendations.',
    tags: ['reporting'],
    steps: [
      { index: 0, name: 'Data Analysis', agent_id: 'trend-spotter',
        task_template: 'Analyse all connector data for the past 7 days vs previous 7 days. Identify: biggest wins, biggest losses, emerging trends, anomalies.',
        approval_gate: false, approval_message: '', timeout_minutes: 30 },
      { index: 1, name: 'Action Plan', agent_id: 'conductor',
        task_template: 'Based on the analysis from the previous step, create a prioritised action plan for the coming week. Top 5 actions with rationale and assigned agent.',
        approval_gate: false, approval_message: '', timeout_minutes: 20 },
      { index: 2, name: 'Briefing Report', agent_id: 'reporter',
        task_template: 'Write a concise executive briefing based on the analysis and action plan. File to KB at reports/weekly-review-{date}.md. 300 words maximum.',
        approval_gate: false, approval_message: '', timeout_minutes: 20 },
    ],
  },
  {
    name: 'Competitor Research',
    description: 'Research competitors and file findings to KB.',
    tags: ['research'],
    steps: [
      { index: 0, name: 'Research', agent_id: 'researcher',
        task_template: 'Research the top 3 competitors in our market. For each: their top keywords, content strategy, pricing signals, and any recent changes. Use web search.',
        approval_gate: false, approval_message: '', timeout_minutes: 45 },
      { index: 1, name: 'File to KB', agent_id: 'researcher',
        task_template: 'File the competitor research findings to the KB at research/competitors-{date}.md. Create entity pages for each competitor at entities/{competitor-name}.md. Update the index.',
        approval_gate: false, approval_message: '', timeout_minutes: 15 },
    ],
  },
];

/**
 * Seed built-in workflows for a business if none exist.
 * Idempotent — only inserts when the business has zero workflows.
 */
export function seedBuiltInWorkflows(businessId: string): number {
  const existing = (db.prepare(
    'SELECT COUNT(*) as c FROM workflows WHERE business_id = ?'
  ).get(businessId) as { c: number } | null)?.c ?? 0;
  if (existing > 0) return 0;

  const insert = db.prepare(`
    INSERT INTO workflows
    (id, business_id, name, description, trigger_type, trigger_config,
     steps, created_by, tags, status)
    VALUES (?, ?, ?, ?, 'manual', '{}', ?, 'system', ?, 'active')
  `);

  let count = 0;
  for (const tpl of BUILT_IN_WORKFLOWS) {
    insert.run(
      crypto.randomUUID(), businessId,
      tpl.name, tpl.description,
      JSON.stringify(tpl.steps),
      JSON.stringify(tpl.tags)
    );
    count++;
  }
  return count;
}

/**
 * Seed for all businesses that don't yet have workflows.
 * Called on server startup and from db/init.js.
 */
export function seedAllBusinesses(): number {
  const businesses = db.prepare('SELECT id, name FROM businesses').all() as Array<{ id: string; name: string }>;
  let total = 0;
  for (const b of businesses) {
    const n = seedBuiltInWorkflows(b.id);
    if (n > 0) {
      console.log(`[workflows] Seeded ${n} built-in workflows for ${b.name}`);
      total += n;
    }
  }
  return total;
}
