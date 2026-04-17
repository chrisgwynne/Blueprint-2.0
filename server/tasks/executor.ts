/**
 * Task execution engine.
 *
 * Routes approved tasks to the right action handler based on `action_type`,
 * transitions the task through executing → complete/failed, and records
 * outcomes + task_events.
 *
 * To add a new action type:
 *   1. Add to EXECUTABLE_ACTION_TYPES
 *   2. Add a case to executeTask()
 *   3. Implement the handler returning { outcome, outcome_data }
 */
import crypto from 'node:crypto';
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { updateTaskStatus } from './task-queue.js';
import { createBlueprintIssue } from '../lib/blueprint-github.js';
import { createTaskEvent } from './task-events.js';
import { parseJson } from '../types/shared.js';
import type * as GithubModule from '../connectors/github/index.js';
import type * as WixModule from '../connectors/wix/index.js';
import type * as ShopifyModule from '../connectors/shopify/index.js';
import type * as KbConfig from '../kb/kb-config.js';
import type * as ContextAssembler from './investigation/context-assembler.js';
import type * as PromptBuilder from './investigation/prompt-builder.js';
import type * as TaskSpawner from './investigation/task-spawner.js';
import type * as LlmProviders from '../lib/llm-providers.js';
import type * as AgentActivity from '../agents/activity.js';
import type * as AgentInstaller from '../agents/installer.js';
import type * as AgentRunner from '../agents/agent-runner.js';
import type * as SelfHealer from '../agents/self-healer.js';
import type * as ServerConnection from '../connectors/server-access/connection.js';
import type * as AgentSearch from '../agents/tools/search.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecuteResult {
  outcome: string;
  outcome_data: Record<string, unknown>;
}

interface Task {
  id: string;
  business_id: string;
  action_type: string | null;
  action_payload: Record<string, unknown>;
  title: string;
  description: string | null;
  proposed_by: string;
  status: string;
  trust_tier: string;
  priority?: string;
  confidence?: number | null;
  signal_id?: string | null;
  estimated_impact?: string | null;
  rollback_data?: string | null;
  project_id?: string | null;
  [key: string]: unknown;
}

interface ConnectorRow {
  id: string;
  type: string;
  name?: string;
  credentials: string | null;
  config?: string | null;
  status: string;
  business_id: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  action_type: string | null;
  action_payload: string | null;
  title: string;
  description: string | null;
  proposed_by: string;
  status: string;
  trust_tier: string;
  priority?: string;
  confidence?: number | null;
  signal_id?: string | null;
  estimated_impact?: string | null;
  rollback_data?: string | null;
  project_id?: string | null;
}

// ─── Action type registry ─────────────────────────────────────────────────────

const EXECUTABLE_ACTION_TYPES = new Set<string>([
  'github_issue',
  'github_pr',
  'investigation',
  'content_draft',
  'meta_update',
  'shopify_product_create',
  'shopify_product_update',
  'shopify_description_update',
  'shopify_page_create',
  'shopify_page_update',
  'shopify_blog_post_create',
  'shopify_meta_update',
  'shopify_collection_update',
  'shopify_tag_update',
  'shopify_theme_edit',
  'hire_agent',
  // Wix SEO write-back (page + blog-post SEO fields only, approved)
  'wix_seo_update',
  // Server-access write (requires approved task + backup-before-write)
  'server_file_write',
  'server_file_rollback',
  // Soft write-backs: create KB drafts or issue instructions (no direct API write)
  'gbp_update',
  'klaviyo_flow_update',
  'meta_ads_update',
  // Connector lifecycle — surfaced by agents, reviewed by human
  'connect_connector',
  'research_connector',
]);

export function isExecutable(actionType: string): boolean {
  return EXECUTABLE_ACTION_TYPES.has(actionType);
}

/**
 * Find the right connector for the given task.
 * Maps action_type → connector type.
 */
function connectorTypeForAction(actionType: string | null): string | null {
  if (actionType === 'github_issue' || actionType === 'github_pr') return 'github';
  if (actionType?.startsWith('shopify_')) return 'shopify';
  if (actionType === 'wix_seo_update') return 'wix';
  if (actionType === 'server_file_write' || actionType === 'server_file_rollback') return 'server-access';
  return null;
}

/**
 * Load + decrypt credentials for a connector. Returns { connector, credentials }
 * or throws if not found / not connected.
 */
function loadConnector(businessId: string, type: string): { connector: ConnectorRow; credentials: Record<string, string>; config: Record<string, unknown> } {
  const row = db.prepare(
    `SELECT id, type, name, credentials, config, status FROM connectors
     WHERE business_id = ? AND type = ? AND status = 'connected'
     LIMIT 1`
  ).get(businessId, type) as ConnectorRow | null;
  if (!row) {
    throw new Error(`No connected ${type} connector found for this business. Add it under Connectors → +.`);
  }
  let credentials: Record<string, string> = {};
  try {
    if (row.credentials) credentials = parseJson<Record<string, string>>(decrypt(row.credentials), {});
  } catch (err) {
    throw new Error(`Failed to decrypt ${type} credentials: ${(err as Error).message}`);
  }
  let config: Record<string, unknown> = {};
  try {
    if (row.config) config = parseJson<Record<string, unknown>>(row.config, {});
  } catch {}
  return { connector: row, credentials, config };
}

// ─── Action handlers ──────────────────────────────────────────────────────────

function buildIssueBody(task: Task): string {
  const lines: (string | null)[] = [
    '## Auto-created by Blueprint',
    '',
    `**Proposed by:** ${task.proposed_by}`,
    `**Priority:** ${task.priority}`,
    task.confidence != null ? `**Confidence:** ${Math.round(task.confidence * 100)}%` : null,
    task.signal_id ? `**Linked signal:** ${task.signal_id}` : null,
    '',
    '---',
    '',
    '## Description',
    '',
    task.description ?? '(no description)',
  ];
  if (task.estimated_impact) {
    lines.push('', '---', '', '## Estimated impact', '', task.estimated_impact);
  }
  lines.push('', '---', '', `_Created automatically by Blueprint on ${new Date().toISOString()}_`);
  return lines.filter((l): l is string => l !== null).join('\n');
}

async function executeGithubIssue(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { credentials, config } = loadConnector(task.business_id, 'github');

  const owner = (payload.owner ?? credentials.owner ?? (config.owner as string | undefined)) as string | undefined;
  if (!owner) throw new Error('GitHub owner is required (in task action_payload or connector config).');

  // Repo: explicit in payload, OR first repo in connector config.repos
  let repo = payload.repo as string | undefined;
  if (!repo) {
    const repos = (config.repos ?? credentials.repos) as string | undefined;
    if (repos) repo = String(repos).split(',')[0]?.trim();
  }
  if (!repo) throw new Error('GitHub repo is required (in task action_payload.repo or connector config.repos).');

  const { default: github } = await import('../connectors/github/index.js') as typeof GithubModule;
  const issue = await github.createIssue(credentials, owner, repo, {
    title: (payload.title ?? task.title) as string,
    body: (payload.body as string | undefined) ?? buildIssueBody(task),
    labels: (payload.labels as string[] | undefined) ?? [
      'blueprint/auto-created',
      `blueprint/agent-${task.proposed_by}`,
      `blueprint/${task.priority}`,
    ],
  }) as { number: number; html_url: string; state: string } | null;

  if (!issue?.number) {
    throw new Error(`GitHub did not return a valid issue: ${JSON.stringify(issue).slice(0, 200)}`);
  }

  return {
    outcome: `GitHub issue #${issue.number} created in ${owner}/${repo}`,
    outcome_data: {
      issue_number: issue.number,
      issue_url: issue.html_url,
      repo: `${owner}/${repo}`,
      state: issue.state,
    },
  };
}

async function executeGithubPR(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  if (!payload.head) throw new Error('github_pr requires action_payload.head (branch with changes).');

  const { credentials, config } = loadConnector(task.business_id, 'github');
  const owner = (payload.owner ?? credentials.owner ?? (config.owner as string | undefined)) as string | undefined;
  const repo  = payload.repo as string | undefined;
  if (!owner || !repo) throw new Error('github_pr requires owner + repo (in action_payload or connector config).');

  const { default: github } = await import('../connectors/github/index.js') as typeof GithubModule;
  const pr = await github.createPR(credentials, owner, repo, {
    title: (payload.title ?? task.title) as string,
    body:  (payload.body as string | undefined) ?? buildIssueBody(task),
    head:  payload.head as string,
    base:  (payload.base as string | undefined) ?? 'main',
    draft: (payload.draft as boolean | undefined) ?? true, // always draft — human reviews
  }) as { number: number; html_url: string; state: string; draft: boolean; head?: { ref: string }; base?: { ref: string } } | null;

  if (!pr?.number) {
    throw new Error(`GitHub did not return a valid PR: ${JSON.stringify(pr).slice(0, 200)}`);
  }

  return {
    outcome: `GitHub PR #${pr.number} created (draft) in ${owner}/${repo}`,
    outcome_data: {
      pr_number: pr.number,
      pr_url: pr.html_url,
      repo: `${owner}/${repo}`,
      head: pr.head?.ref,
      base: pr.base?.ref,
      state: pr.state,
      draft: pr.draft,
    },
  };
}

// ─── Investigation LLM system prompt ─────────────────────────────────────────

const INVESTIGATION_SYSTEM_PROMPT = `You are Blueprint's investigation engine.
You analyse business data and produce specific, actionable findings.
Every claim must cite specific data provided in the user message.
Never return null fields — if uncertain, say so explicitly with a low confidence score.
Return only valid JSON. No prose outside the JSON object.`;

function extractInvestigationJSON(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = fenced?.[1] ?? content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  try { return JSON.parse(str.trim()) as Record<string, unknown>; } catch { return null; }
}

async function fileInvestigationToKB(task: Task, findings: Record<string, unknown>): Promise<void> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as typeof KbConfig;
    const result = await getKBForBusiness(task.business_id);
    if (!result?.engine) return;

    const date = new Date().toISOString().slice(0, 10);
    const path = `research/investigation-${task.id.slice(0, 8)}-${date}.md`;

    const actionTaskLines = ((findings.action_tasks as Array<Record<string, unknown>> | undefined) ?? []).map((t, i) =>
      `${i + 1}. **${t.title as string}** (${t.action_type as string}, ${(t.priority as string | undefined) ?? 'p2'})\n   Expected: ${(t.expected_impact as string | undefined) ?? 'unknown'}`
    ).join('\n');

    const content = `# Investigation: ${task.title}

**Date:** ${date}
**Confidence:** ${Math.round(((findings.confidence as number | undefined) ?? 0) * 100)}%
**Recommendation:** ${(findings.recommendation as string | undefined) ?? 'unknown'}

## Summary
${(findings.summary as string | undefined) ?? '(no summary)'}

## Primary Cause
${(findings.primary_cause as string | undefined) ?? '(unknown)'}

## Evidence
${((findings.evidence as string[] | undefined) ?? []).map(e => `- ${e}`).join('\n') || '- (none recorded)'}

## Explanation
${(findings.explanation as string | undefined) ?? '(none)'}

## Action Tasks Spawned
${actionTaskLines || '(none — recommendation was not act_now)'}

## Do Not Do
${((findings.do_not_do as string[] | undefined) ?? []).map(d => `- ${d}`).join('\n') || '- (none specified)'}

## Measurement Plan
- Metric: ${(findings.measurement_plan as Record<string, unknown> | undefined)?.primary_metric as string ?? 'unknown'}
- Check at: ${(findings.measurement_plan as Record<string, unknown> | undefined)?.check_at_days as number ?? 14} days
- Leading indicator: ${((findings.measurement_plan as Record<string, unknown> | undefined)?.leading_indicator as Record<string, unknown> | undefined)?.metric as string ?? 'none'}
`;

    await result.engine.writeFile(
      path, content,
      {
        title: `Investigation: ${task.title}`,
        tags: ['investigation', (findings.recommendation as string | undefined) ?? 'unknown'],
        written_by: 'conductor:investigation',
        review_status: 'auto_approved',
        task_id: task.id,
        confidence: (findings.confidence as number | undefined) ?? null,
      },
      `investigation: ${task.title.slice(0, 60)}`
    );
  } catch (err) {
    console.warn('[executor] fileInvestigationToKB failed (non-fatal):', (err as Error).message);
  }
}

async function executeInvestigation(task: Task): Promise<ExecuteResult> {
  const { assembleInvestigationContext } = await import('./investigation/context-assembler.js') as typeof ContextAssembler;
  const { buildInvestigationPrompt } = await import('./investigation/prompt-builder.js') as typeof PromptBuilder;
  const { spawnFollowOnTasks } = await import('./investigation/task-spawner.js') as typeof TaskSpawner;
  const { runLLM, resolveProfileLLM } = await import('../lib/llm-providers.js') as typeof LlmProviders;
  const { recordAgentActivity } = await import('../agents/activity.js') as typeof AgentActivity;

  // 1. Assemble full context from all relevant connectors
  const context = await assembleInvestigationContext(task, task.business_id);

  // 2. Build detailed prompt
  const prompt = buildInvestigationPrompt(task, context);

  // 3. Run LLM
  const { providerId, model } = resolveProfileLLM({});
  const startedAt = new Date().toISOString();
  let llmResult: Awaited<ReturnType<typeof runLLM>>;
  try {
    llmResult = await runLLM(providerId, model, {
      system: INVESTIGATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
    });
  } catch (err) {
    recordAgentActivity({
      agentId: 'conductor', businessId: task.business_id, trigger: 'investigation',
      status: 'failed', reasoning: `Investigation LLM failed: ${(err as Error).message.slice(0, 160)}`,
      error: (err as Error).message.slice(0, 500), startedAt,
    });
    throw new Error(`Investigation LLM call failed (${providerId}/${model}): ${(err as Error).message}`);
  }

  recordAgentActivity({
    agentId: 'conductor', businessId: task.business_id, trigger: 'investigation',
    status: 'complete', reasoning: `Investigation: ${task.title.slice(0, 80)}`,
    usage: llmResult?.usage, cost_usd: llmResult?.cost_usd, startedAt,
  });

  // 4. Parse findings
  const findings = extractInvestigationJSON(llmResult?.content ?? '');
  if (!findings) {
    const preview = (llmResult?.content ?? '').slice(0, 200);
    throw new Error(`Investigation LLM returned invalid JSON.${preview ? ' Preview: ' + preview : ''}`);
  }

  // 5. File investigation to KB
  await fileInvestigationToKB(task, findings);

  // 6. Handle 'monitor' recommendation — create deferred re-investigation
  if (findings.recommendation === 'monitor') {
    try {
      const checkDays = ((findings.measurement_plan as Record<string, unknown> | undefined)?.check_at_days as number | undefined) ?? 7;
      const checkAt = new Date();
      checkAt.setDate(checkAt.getDate() + checkDays);

      db.prepare(`
        INSERT INTO tasks (
          id, business_id, title, description, status,
          proposed_by, trust_tier, priority, action_type,
          parent_task_id, deferred_until, deferred_reason,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'deferred',
          'conductor:investigation', 'green', 'p2', 'investigation',
          ?, ?, ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        crypto.randomUUID(),
        task.business_id,
        `Follow-up: ${task.title}`,
        `Re-investigate after monitoring period.\n\nOriginal finding: ${(findings.summary as string | undefined) ?? ''}\n\nWhat to check: ${(((findings.measurement_plan as Record<string, unknown> | undefined)?.leading_indicator as Record<string, unknown> | undefined)?.good_sign as string | undefined) ?? 'Check if metrics have improved.'}`,
        task.id,
        checkAt.toISOString(),
        `Monitoring period — check again after ${checkDays} days`
      );
    } catch (err) {
      console.warn('[executor] Failed to create deferred re-investigation:', (err as Error).message);
    }
  }

  // 7. Spawn follow-on tasks if act_now
  let followOns: Array<{ id: string; title: string; action_type: string; priority: string; status: string; deferred_until: string | null }> = [];
  if (findings.recommendation === 'act_now') {
    followOns = await spawnFollowOnTasks(findings, task);
  }

  const summary = (findings.summary as string | undefined) ?? `Investigation complete. Primary cause: ${(findings.primary_cause as string | undefined) ?? 'unknown'}.`;
  const outcomeNote = followOns.length > 0
    ? ` ${followOns.length} follow-on task${followOns.length > 1 ? 's' : ''} queued.`
    : '';

  return {
    outcome: summary.slice(0, 200) + outcomeNote,
    outcome_data: {
      type: 'investigation',
      primary_cause: (findings.primary_cause as string | undefined) ?? null,
      primary_confidence: (findings.confidence as number | undefined) ?? null,
      supporting_evidence: (findings.evidence as unknown[]) ?? [],
      alternative_causes: (findings.alternatives as unknown[]) ?? [],
      recommendation: (findings.recommendation as string | undefined) ?? null,
      recommended_action: (findings.recommendation_reason as string | undefined) ?? null,
      plain_english: (findings.explanation as string | undefined) ?? null,
      confidence_note: null,
      summary: (findings.summary as string | undefined) ?? null,
      do_not_do: (findings.do_not_do as unknown[]) ?? [],
      measurement_plan: (findings.measurement_plan as unknown) ?? null,
      spawned_tasks: followOns.length,
      spawned_task_ids: followOns.map(t => t.id),
    },
  };
}

async function executeContentDraft(task: Task): Promise<ExecuteResult> {
  // File the draft content to KB as wiki/drafts/{slug}.md with pending_review status.
  // Human reviews the KB draft before publishing — we never push directly to CMS.
  const payload = task.action_payload ?? {};

  let kbPath: string | null = null;
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as typeof KbConfig;
    const result = await getKBForBusiness(task.business_id);
    if (result?.engine) {
      const date = new Date().toISOString().slice(0, 10);
      const slug = (task.title ?? 'draft')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      kbPath = `wiki/drafts/${date}-${slug}.md`;

      const draftContent = buildDraftContent(task, payload);

      await result.engine.writeFile(
        kbPath, draftContent,
        {
          title: task.title,
          type: (payload.content_type as string | undefined) ?? 'content_draft',
          status: 'draft',
          target_keyword: (payload.target_keyword as string | undefined) ?? null,
          word_count: (payload.word_count as number | undefined) ?? null,
          created_by: task.proposed_by,
          task_id: task.id,
          review_status: 'pending_review',
        },
        `draft: ${task.title.slice(0, 60)}`
      );
    }
  } catch (err) {
    console.warn('[executor] content_draft KB write failed (non-fatal):', (err as Error).message);
    kbPath = null;
  }

  return {
    outcome: kbPath ? `Content draft filed to KB: ${kbPath}` : 'Content draft prepared (KB unavailable)',
    outcome_data: {
      type: 'content_draft',
      kb_path: kbPath,
      title: task.title,
      content_type: (payload.content_type as string | undefined) ?? null,
      target_keyword: (payload.target_keyword as string | undefined) ?? null,
      word_count: (payload.word_count as number | undefined) ?? null,
      proposed_by: task.proposed_by,
    },
  };
}

function buildDraftContent(task: Task, payload: Record<string, unknown>): string {
  const lines: string[] = [
    `# ${task.title}`,
    '',
    '> **Review status:** Draft — pending human review before publishing.',
    '',
  ];

  if (payload.brief) {
    lines.push('## Brief', '', payload.brief as string, '');
  }
  if (payload.target_keyword) {
    lines.push(`**Target keyword:** ${payload.target_keyword as string}`, '');
  }
  if (payload.word_count) {
    lines.push(`**Target word count:** ${payload.word_count as number}`, '');
  }
  if (task.description) {
    lines.push('## Description', '', task.description, '');
  }
  lines.push('## Draft Content', '', '*(Write your content here)*', '');
  return lines.join('\n');
}

// ─── Meta update (routes to correct CMS connector) ───────────────────────────

async function executeMetaUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};

  // Try Shopify first
  const shopifyConnector = db.prepare(
    `SELECT id FROM connectors WHERE business_id = ? AND type = 'shopify' AND status = 'connected' LIMIT 1`
  ).get(task.business_id) as { id: string } | null;
  if (shopifyConnector && payload.resource_id) {
    const { shopify, credentials, config } = await getShopify(task);
    const updates: Record<string, unknown> = {};
    if (payload.field === 'title' || payload.proposed_title) updates.title = payload.proposed ?? payload.proposed_title;
    if (payload.field === 'description' || payload.proposed_description) updates.body_html = payload.proposed ?? payload.proposed_description;

    if (Object.keys(updates).length > 0) {
      await (shopify as Record<string, unknown> & { updateProduct(creds: Record<string, string>, config: Record<string, unknown>, id: unknown, updates: Record<string, unknown>): Promise<unknown> }).updateProduct(credentials, config, payload.resource_id, updates);
      return {
        outcome: `Meta updated on Shopify product ${payload.resource_id as string}`,
        outcome_data: { resource_id: payload.resource_id, field: payload.field, changes: updates },
      };
    }
  }

  // Try Wix
  const wixConnector = db.prepare(
    `SELECT * FROM connectors WHERE business_id = ? AND type = 'wix' AND status = 'connected' LIMIT 1`
  ).get(task.business_id) as ConnectorRow | null;
  if (wixConnector && payload.page_id) {
    const credentials = parseJson<Record<string, string>>(decrypt(wixConnector.credentials ?? '{}'), {});
    const { default: wix } = await import('../connectors/wix/index.js') as typeof WixModule;
    await wix.updatePageSeo(credentials, {
      pageId: payload.page_id as string,
      title: (payload.proposed_title ?? payload.proposed) as string | undefined,
      description: payload.proposed_description as string | undefined,
    });
    return {
      outcome: `Meta SEO updated on Wix page ${payload.page_id as string}`,
      outcome_data: { page_id: payload.page_id, field: payload.field },
    };
  }

  // No matching connector — file to KB as instructions
  return await fileInstructionDraft(task, payload, 'meta_update',
    `Update the ${(payload.field as string | undefined) ?? 'meta'} on: ${(payload.url ?? payload.resource_id ?? 'the target page') as string}\n\nProposed: ${(payload.proposed ?? payload.proposed_title ?? '(see task description)') as string}`
  );
}

// ─── GBP update (soft — creates KB instruction draft, no direct write API) ───

async function executeGbpUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  return await fileInstructionDraft(task, payload, 'gbp_update',
    `Update Google Business Profile — ${(payload.field as string | undefined) ?? 'field'}:\n\nCurrent: ${(payload.current as string | undefined) ?? '(see GBP)'}\nProposed: ${(payload.proposed as string | undefined) ?? '(see task description)'}\n\nLog in to Google Business Profile to apply this change manually.`
  );
}

// ─── Klaviyo flow update (soft — creates KB instruction draft) ───────────────

async function executeKlaviyoFlowUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  return await fileInstructionDraft(task, payload, 'klaviyo_flow_update',
    `Update Klaviyo flow "${(payload.flow_name ?? payload.flow_id ?? 'unknown') as string}":\n\n${(payload.change_description ?? task.description ?? '(see task description)') as string}\n\nApply this change in the Klaviyo flow editor.`
  );
}

// ─── Meta Ads update (soft — creates KB instruction draft) ───────────────────

async function executeMetaAdsUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  return await fileInstructionDraft(task, payload, 'meta_ads_update',
    `Update Meta Ads campaign "${(payload.campaign_id ?? 'unknown') as string}" — ${(payload.change_type ?? 'change') as string}:\n\n${(payload.change_description ?? task.description ?? '(see task description)') as string}\n\nApply this change in Meta Ads Manager.`
  );
}

// ─── Shared: file instructions to KB when no connector write API exists ──────

async function fileInstructionDraft(task: Task, payload: Record<string, unknown>, actionType: string, instructions: string): Promise<ExecuteResult> {
  let kbPath: string | null = null;
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as typeof KbConfig;
    const result = await getKBForBusiness(task.business_id);
    if (result?.engine) {
      const date = new Date().toISOString().slice(0, 10);
      const slug = (task.title ?? actionType)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      kbPath = `wiki/drafts/${date}-${actionType}-${slug}.md`;

      const content = `# Action Required: ${task.title}

> **Type:** ${actionType}
> **Priority:** ${task.priority ?? 'p2'}
> **Review status:** Pending manual action

## Instructions

${instructions}

## Context

${task.description ?? '(no additional context)'}

---
*Created by Blueprint conductor. Task ID: ${task.id}*
`;
      await result.engine.writeFile(
        kbPath, content,
        { title: task.title, type: actionType, review_status: 'pending_action', task_id: task.id },
        `action-required: ${task.title.slice(0, 60)}`
      );
    }
  } catch (err) {
    console.warn(`[executor] fileInstructionDraft failed for ${actionType}:`, (err as Error).message);
    kbPath = null;
  }

  return {
    outcome: kbPath
      ? `Instructions filed to KB: ${kbPath} — manual action required`
      : `Action required: ${task.title}`,
    outcome_data: {
      type: actionType,
      kb_path: kbPath,
      instructions,
      requires_manual_action: true,
    },
  };
}

// ─── Shopify handlers ─────────────────────────────────────────────────────────

async function getShopify(task: Task): Promise<{ shopify: Record<string, unknown>; credentials: Record<string, string>; config: Record<string, unknown> }> {
  const { credentials, config } = loadConnector(task.business_id, 'shopify');
  const { default: shopify } = await import('../connectors/shopify/index.js') as typeof ShopifyModule;
  return { shopify: shopify as unknown as Record<string, unknown>, credentials, config };
}

async function executeShopifyProductCreate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);

  const result = await (shopify as Record<string, unknown> & { createProduct(creds: Record<string, string>, config: Record<string, unknown>, data: Record<string, unknown>): Promise<{ product?: { id: string; title: string } }> }).createProduct(credentials, config, {
    title: (payload.title ?? task.title) as string,
    body_html: (payload.description ?? payload.body_html ?? task.description ?? '') as string,
    product_type: (payload.product_type as string | undefined) ?? null,
    tags: Array.isArray(payload.tags) ? (payload.tags as string[]).join(', ') : (payload.tags as string | undefined) ?? '',
    variants: (payload.variants as unknown[] | undefined) ?? [{ price: (payload.price as string | undefined) ?? '0.00' }],
  });

  const product = result.product;
  if (!product?.id) throw new Error('Shopify did not return a product.');

  // Rollback data: delete the created product
  db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
    .run(JSON.stringify({ action: 'delete_product', product_id: product.id }), task.id);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify product created (draft): "${product.title}"`,
    outcome_data: {
      product_id: product.id,
      admin_url: `https://${shop}/admin/products/${product.id}`,
      status: 'draft',
    },
  };
}

async function executeShopifyProductUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const productId = payload.product_id as string | undefined;
  if (!productId) throw new Error('product_id is required in action_payload.');

  // Save current state for rollback
  const current = await (shopify as Record<string, unknown> & { fetchProduct(creds: Record<string, string>, config: Record<string, unknown>, id: string): Promise<Record<string, unknown>> }).fetchProduct(credentials, config, productId);
  const rollback: Record<string, unknown> = {
    action: 'restore_product',
    product_id: productId,
    previous_state: {},
  };

  const updates: Record<string, unknown> = {};
  if (payload.new_description !== undefined || payload.body_html !== undefined) {
    updates.body_html = payload.new_description ?? payload.body_html;
    (rollback.previous_state as Record<string, unknown>).body_html = current.body_html;
  }
  if (payload.title !== undefined) {
    updates.title = payload.title;
    (rollback.previous_state as Record<string, unknown>).title = current.title;
  }
  if (payload.tags !== undefined) {
    updates.tags = Array.isArray(payload.tags) ? (payload.tags as string[]).join(', ') : payload.tags;
    (rollback.previous_state as Record<string, unknown>).tags = current.tags;
  }
  if (payload.updates && typeof payload.updates === 'object') {
    Object.assign(updates, payload.updates as Record<string, unknown>);
    for (const k of Object.keys(payload.updates as Record<string, unknown>)) {
      (rollback.previous_state as Record<string, unknown>)[k] = (current[k] as unknown) ?? null;
    }
  }

  await (shopify as Record<string, unknown> & { updateProduct(creds: Record<string, string>, config: Record<string, unknown>, id: string, updates: Record<string, unknown>): Promise<unknown> }).updateProduct(credentials, config, productId, updates);
  db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
    .run(JSON.stringify(rollback), task.id);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify product updated: "${current.title as string}"`,
    outcome_data: {
      product_id: productId,
      admin_url: `https://${shop}/admin/products/${productId}`,
      changes: Object.keys(updates),
    },
  };
}

async function executeShopifyPageCreate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);

  const result = await (shopify as Record<string, unknown> & { createPage(creds: Record<string, string>, config: Record<string, unknown>, data: Record<string, unknown>): Promise<{ page?: { id: string; title: string } }> }).createPage(credentials, config, {
    title: (payload.title ?? task.title) as string,
    body_html: (payload.body_html ?? task.description ?? '') as string,
    handle: (payload.handle as string | undefined) ?? null,
    author: 'Blueprint',
  });

  const page = result.page;
  if (!page?.id) throw new Error('Shopify did not return a page.');

  db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
    .run(JSON.stringify({ action: 'delete_page', page_id: page.id }), task.id);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify page created (draft): "${page.title}"`,
    outcome_data: {
      page_id: page.id,
      admin_url: `https://${shop}/admin/pages/${page.id}`,
      status: 'draft',
    },
  };
}

async function executeShopifyPageUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const pageId = payload.page_id as string | undefined;
  if (!pageId) throw new Error('page_id is required in action_payload.');

  const updates: Record<string, unknown> = {};
  if (payload.body_html !== undefined) updates.body_html = payload.body_html;
  if (payload.title !== undefined) updates.title = payload.title;
  if (payload.updates) Object.assign(updates, payload.updates as Record<string, unknown>);

  await (shopify as Record<string, unknown> & { updatePage(creds: Record<string, string>, config: Record<string, unknown>, id: string, updates: Record<string, unknown>): Promise<unknown> }).updatePage(credentials, config, pageId, updates);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify page updated (ID: ${pageId})`,
    outcome_data: {
      page_id: pageId,
      admin_url: `https://${shop}/admin/pages/${pageId}`,
      changes: Object.keys(updates),
    },
  };
}

async function executeShopifyBlogPostCreate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const blogId = payload.blog_id as string | undefined;
  if (!blogId) throw new Error('blog_id is required in action_payload.');

  const result = await (shopify as Record<string, unknown> & { createBlogPost(creds: Record<string, string>, config: Record<string, unknown>, blogId: string, data: Record<string, unknown>): Promise<{ article?: { id: string; title?: string } }> }).createBlogPost(credentials, config, blogId, {
    title: (payload.title ?? task.title) as string,
    body_html: (payload.body_html ?? task.description ?? '') as string,
    author: (payload.author as string | undefined) ?? 'Blueprint',
    tags: (payload.tags as string | undefined) ?? '',
  });

  const article = result.article;
  return {
    outcome: `Shopify blog post created (draft): "${article?.title ?? task.title}"`,
    outcome_data: {
      article_id: article?.id,
      blog_id: blogId,
      status: 'draft',
    },
  };
}

async function executeShopifyCollectionUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const collectionId = payload.collection_id as string | undefined;
  if (!collectionId) throw new Error('collection_id is required in action_payload.');

  await (shopify as Record<string, unknown> & { updateCollectionDescription(creds: Record<string, string>, config: Record<string, unknown>, id: string, desc: string): Promise<unknown> }).updateCollectionDescription(credentials, config, collectionId, (payload.new_description as string | undefined) ?? '');

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify collection updated (ID: ${collectionId})`,
    outcome_data: {
      collection_id: collectionId,
      admin_url: `https://${shop}/admin/collections/${collectionId}`,
    },
  };
}

async function executeShopifyTagUpdate(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const productId = payload.product_id as string | undefined;
  if (!productId) throw new Error('product_id is required in action_payload.');

  await (shopify as Record<string, unknown> & { updateProductTags(creds: Record<string, string>, config: Record<string, unknown>, id: string, add: string[], remove: string[]): Promise<unknown> }).updateProductTags(
    credentials, config, productId,
    (payload.add_tags as string[] | undefined) ?? [], (payload.remove_tags as string[] | undefined) ?? []
  );

  return {
    outcome: `Product tags updated for product ${productId}`,
    outcome_data: {
      product_id: productId,
      added: (payload.add_tags as string[] | undefined) ?? [],
      removed: (payload.remove_tags as string[] | undefined) ?? [],
    },
  };
}

async function executeShopifyThemeEdit(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const { shopify, credentials } = await getShopify(task);

  const fileKey = payload.file_key as string | undefined;
  if (!fileKey) throw new Error('shopify_theme_edit requires action_payload.file_key (e.g. "assets/custom.css")');
  if (typeof payload.new_content !== 'string') throw new Error('shopify_theme_edit requires action_payload.new_content (string)');

  // Resolve theme ID: prefer explicit payload value, otherwise fetch the active theme
  let themeId = (payload.theme_id as string | undefined) ?? null;
  if (!themeId) {
    themeId = await (shopify as Record<string, unknown> & { getActiveThemeId(creds: Record<string, string>): Promise<string> }).getActiveThemeId(credentials);
  }

  // Backup current content before writing
  const current = await (shopify as Record<string, unknown> & { readThemeFile(creds: Record<string, string>, themeId: string, fileKey: string): Promise<{ value?: string; attachment?: string }> }).readThemeFile(credentials, themeId, fileKey);
  const previousContent = current.value ?? current.attachment ?? '';

  const backupId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO file_backups (id, business_id, connector_id, task_id, remote_path, content, content_hash, backed_up_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    backupId, task.business_id,
    `shopify:${credentials.shopDomain}`, task.id,
    `theme:${themeId}/${fileKey}`,
    previousContent,
    crypto.createHash('sha256').update(previousContent).digest('hex'),
  );

  // Write the new content
  const written = await (shopify as Record<string, unknown> & { writeThemeFile(creds: Record<string, string>, themeId: string, fileKey: string, content: string): Promise<{ updated_at?: string }> }).writeThemeFile(credentials, themeId, fileKey, payload.new_content as string);

  // Store rollback data
  db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
    .run(JSON.stringify({
      action: 'restore_shopify_theme_file',
      theme_id: themeId,
      file_key: fileKey,
      backup_id: backupId,
      shop_domain: credentials.shopDomain,
    }), task.id);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify theme file updated: "${fileKey}" on theme ${themeId} (backup ${backupId.slice(0, 8)})`,
    outcome_data: {
      theme_id: themeId,
      file_key: fileKey,
      backup_id: backupId,
      admin_url: `https://${shop}/admin/themes/${themeId}/editor`,
      updated_at: written?.updated_at ?? null,
    },
  };
}

// ─── Rollback system ──────────────────────────────────────────────────────────

/**
 * Roll back a completed write-back task.
 * Uses the rollback_data stored at execution time.
 */
export async function rollbackTask(taskId: string): Promise<{ outcome: string }> {
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | null;
  if (!taskRow) throw new Error(`Task ${taskId} not found.`);
  if (!taskRow.rollback_data) throw new Error('No rollback data available for this task.');

  const rollback = parseJson<Record<string, unknown>>(taskRow.rollback_data, {});
  if (!rollback.action) throw new Error('Invalid rollback data.');

  // Reconstruct a Task from taskRow for helpers
  const task: Task = {
    ...taskRow,
    action_payload: parseJson<Record<string, unknown>>(taskRow.action_payload, {}),
  };

  if (rollback.action === 'delete_product' && rollback.product_id) {
    const { shopify, credentials, config } = await getShopify(task);
    await (shopify as Record<string, unknown> & { deleteProduct(creds: Record<string, string>, config: Record<string, unknown>, id: unknown): Promise<unknown> }).deleteProduct(credentials, config, rollback.product_id);
    updateTaskStatus(taskId, 'failed', 'system:rollback', { outcome: 'Rolled back: product deleted' });
    createTaskEvent(taskId, 'rolled_back', 'system:rollback', `Product ${rollback.product_id as string} deleted (rollback)`, {});
    return { outcome: `Product ${rollback.product_id as string} deleted` };
  }

  if (rollback.action === 'restore_product' && rollback.product_id) {
    const { shopify, credentials, config } = await getShopify(task);
    await (shopify as Record<string, unknown> & { updateProduct(creds: Record<string, string>, config: Record<string, unknown>, id: unknown, state: unknown): Promise<unknown> }).updateProduct(credentials, config, rollback.product_id, rollback.previous_state);
    updateTaskStatus(taskId, 'failed', 'system:rollback', { outcome: 'Rolled back: product restored' });
    createTaskEvent(taskId, 'rolled_back', 'system:rollback', `Product ${rollback.product_id as string} restored to previous state`, {});
    return { outcome: `Product ${rollback.product_id as string} restored` };
  }

  if (rollback.action === 'restore_shopify_theme_file' && rollback.file_key) {
    const backup = db.prepare('SELECT * FROM file_backups WHERE id = ?').get(rollback.backup_id as string) as { content: string } | null;
    if (!backup) throw new Error(`Backup ${rollback.backup_id as string} not found — cannot rollback theme file.`);

    const { shopify, credentials } = await getShopify(task);
    await (shopify as Record<string, unknown> & { writeThemeFile(creds: Record<string, string>, themeId: unknown, fileKey: unknown, content: string): Promise<unknown> }).writeThemeFile(credentials, rollback.theme_id, rollback.file_key, backup.content);
    updateTaskStatus(taskId, 'failed', 'system:rollback', { outcome: `Rolled back: theme file "${rollback.file_key as string}" restored` });
    createTaskEvent(taskId, 'rolled_back', 'system:rollback', `Theme file "${rollback.file_key as string}" restored from backup ${(rollback.backup_id as string).slice(0, 8)}`, {});
    return { outcome: `Theme file "${rollback.file_key as string}" restored from backup` };
  }

  throw new Error(`Unknown rollback action: ${rollback.action as string}`);
}

// ─── Agent hire action ────────────────────────────────────────────────────────

/**
 * Install a specialist agent from a template. Created by Conductor via
 * analyseAndProposeHires() when connector data justifies it; this executor
 * runs after a human approves the hire proposal.
 *
 * action_payload: { template_id: string }
 */
async function executeHireAgent(task: Task): Promise<ExecuteResult> {
  const payload = task.action_payload ?? {};
  const templateId = payload.template_id as string | undefined;
  if (!templateId) throw new Error('hire_agent requires action_payload.template_id');

  const { installAgent } = await import('../agents/installer.js') as typeof AgentInstaller;
  const result = installAgent(templateId, task.business_id, 'human');

  // Fire-and-forget first run if ready — gives the "wow" moment post-approval.
  if (result.status === 'active') {
    (async () => {
      try {
        const { runAgent } = await import('../agents/agent-runner.js') as typeof AgentRunner;
        await runAgent(templateId, task.business_id, 'post_hire_initial_run', task.id);
      } catch (err) {
        console.warn(`[hire_agent] post-hire run of ${templateId} failed:`, (err as Error).message);
      }
    })();
  }

  return {
    outcome: result.status === 'active'
      ? `Hired ${templateId}. Running initial analysis now.`
      : `Hired ${templateId}. Waiting for: ${(result.readiness.missing_required || []).join(', ') || 'required connectors'} before first run.`,
    outcome_data: {
      agent_id: templateId,
      status: result.status,
      readiness: result.readiness,
    },
  };
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────

/**
 * Execute an approved task. Handles all status transitions internally:
 *   approved → executing → complete (success) or failed (error)
 *
 * Always settles — never throws — so it's safe to fire-and-forget from a route
 * handler. Failures are recorded in task.outcome and task_events.
 *
 * @param taskId
 * @returns {{ ok: boolean, outcome?: string, error?: string }}
 */
export async function executeTask(taskId: string): Promise<{ ok: boolean; outcome?: string; outcome_data?: Record<string, unknown>; error?: string }> {
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | null;
  if (!taskRow) {
    return { ok: false, error: `Task '${taskId}' not found` };
  }

  // Re-parse JSON fields once
  const task: Task = {
    ...taskRow,
    action_payload: parseJson<Record<string, unknown>>(taskRow.action_payload, {}),
  };

  if (!isExecutable(task.action_type ?? '')) {
    return { ok: false, error: `action_type '${task.action_type}' is not executable` };
  }

  // Transition: approved → executing
  try {
    updateTaskStatus(task.id, 'executing', 'system:executor', {});
  } catch (err) {
    return { ok: false, error: `Could not transition to executing: ${(err as Error).message}` };
  }

  createTaskEvent(
    task.id,
    'executing',
    'system:executor',
    `Execution started for ${task.action_type}`,
    { action_type: task.action_type }
  );

  // Dispatch
  let result: ExecuteResult;
  try {
    switch (task.action_type) {
      case 'github_issue':             result = await executeGithubIssue(task); break;
      case 'github_pr':                result = await executeGithubPR(task);    break;
      case 'investigation':            result = await executeInvestigation(task);  break;
      case 'content_draft':            result = await executeContentDraft(task);  break;
      case 'meta_update':              result = await executeMetaUpdate(task);    break;
      case 'shopify_product_create':   result = await executeShopifyProductCreate(task); break;
      case 'shopify_product_update':
      case 'shopify_description_update':
      case 'shopify_meta_update':      result = await executeShopifyProductUpdate(task); break;
      case 'shopify_page_create':      result = await executeShopifyPageCreate(task); break;
      case 'shopify_page_update':      result = await executeShopifyPageUpdate(task); break;
      case 'shopify_blog_post_create': result = await executeShopifyBlogPostCreate(task); break;
      case 'shopify_collection_update': result = await executeShopifyCollectionUpdate(task); break;
      case 'shopify_tag_update':        result = await executeShopifyTagUpdate(task); break;
      case 'shopify_theme_edit':        result = await executeShopifyThemeEdit(task); break;
      case 'hire_agent':                result = await executeHireAgent(task); break;
      case 'wix_seo_update':            result = await executeWixSeoUpdate(task); break;
      case 'server_file_write':         result = await executeServerFileWrite(task); break;
      case 'server_file_rollback':      result = await executeServerFileRollback(task); break;
      case 'gbp_update':                result = await executeGbpUpdate(task); break;
      case 'klaviyo_flow_update':       result = await executeKlaviyoFlowUpdate(task); break;
      case 'meta_ads_update':           result = await executeMetaAdsUpdate(task); break;
      case 'connect_connector':         result = await executeConnectConnector(task); break;
      case 'research_connector':        result = await executeResearchConnector(task); break;
      default:
        throw new Error(`Unhandled executable action_type: ${task.action_type}`);
    }
  } catch (err) {
    // A missing connector means the task is blocked waiting for setup —
    // not broken. Mark it blocked so the user knows what to do, and so it
    // can be retried once the connector is added rather than being treated
    // as a permanent failure.
    const isConnectorMissing = /No connected [\w-]+ connector found/.test((err as Error).message);
    const newStatus = isConnectorMissing ? 'blocked' : 'failed';

    try {
      updateTaskStatus(task.id, newStatus, 'system:executor', {
        outcome: isConnectorMissing
          ? `Blocked: ${(err as Error).message}`
          : `Execution failed: ${(err as Error).message}`,
        outcome_data: { error: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n') ?? null },
      });
      createTaskEvent(
        task.id,
        newStatus,
        'system:executor',
        isConnectorMissing ? `Blocked: ${(err as Error).message}` : `Execution failed: ${(err as Error).message}`,
        { error: (err as Error).message }
      );
    } catch {}
    if (!isConnectorMissing) {
      console.error(`[executor] Task ${taskId} failed:`, err);
      // Self-healing: diagnose executor failures (not missing-connector blocks)
      import('../agents/self-healer.js')
        .then((m) => (m as typeof SelfHealer).healExecutorError(err as Error, task))
        .catch((healErr: Error) => console.warn('[self-heal] Executor healing failed (non-fatal):', healErr.message));
    } else {
      console.warn(`[executor] Task ${taskId} blocked (missing connector):`, (err as Error).message);
    }
    return { ok: false, error: (err as Error).message };
  }

  // Mark complete + record outcome
  try {
    updateTaskStatus(task.id, 'complete', 'system:executor', {
      outcome: result.outcome,
      outcome_data: result.outcome_data,
    });
    createTaskEvent(
      task.id,
      'complete',
      'system:executor',
      result.outcome,
      result.outcome_data ?? {}
    );
  } catch (err) {
    console.error(`[executor] Task ${taskId} succeeded but final transition failed:`, err);
    return { ok: false, error: `Execution succeeded but status update failed: ${(err as Error).message}` };
  }

  console.log(`[executor] Task ${taskId} (${task.action_type}) executed: ${result.outcome}`);
  return { ok: true, outcome: result.outcome, outcome_data: result.outcome_data };
}

// ─── Wix SEO write-back ─────────────────────────────────────────────────────

async function executeWixSeoUpdate(task: Task): Promise<ExecuteResult> {
  const payload = typeof task.action_payload === 'string'
    ? parseJson<Record<string, unknown>>(task.action_payload, {}) : task.action_payload ?? {};
  const { target, target_id, title, description, slug, connector_id } = payload as {
    target?: string;
    target_id?: string;
    title?: string;
    description?: string;
    slug?: string;
    connector_id?: string;
  };
  if (!connector_id) throw new Error('wix_seo_update: connector_id required in action_payload');
  if (!target || !target_id) throw new Error('wix_seo_update: target and target_id required (target: "page"|"post")');

  const connectorRow = db.prepare('SELECT * FROM connectors WHERE id = ? AND type = ?').get(connector_id, 'wix') as ConnectorRow | null;
  if (!connectorRow) throw new Error(`Wix connector ${connector_id} not found`);
  const credentials = parseJson<Record<string, string>>(decrypt(connectorRow.credentials ?? '{}'), {});
  const { default: wix } = await import('../connectors/wix/index.js') as typeof WixModule;

  let res: unknown;
  if (target === 'page') {
    res = await wix.updatePageSeo(credentials, { pageId: target_id, title, description });
  } else if (target === 'post') {
    res = await wix.updatePostSeo(credentials, { postId: target_id, title, description, slug });
  } else {
    throw new Error(`wix_seo_update: unknown target '${target}' (expected 'page' or 'post')`);
  }

  return {
    outcome: `Wix ${target} ${target_id} SEO updated.`,
    outcome_data: { target, target_id, title, description, result: res },
  };
}

// ─── Server-access write + rollback ─────────────────────────────────────────
//
// SAFETY:
//  - Both handlers require an already-approved task; the executor gates
//    that via updateTaskStatus('executing'). We never write without
//    taking a fresh backup of the current file first.
//  - Every write is recorded in audit_log with the backup id so the
//    change is reversible even if the DB and server drift.
//  - Paths are re-validated at write time by the connector's isPathSafe
//    gate — the executor trusts nothing from the payload.

async function loadServerAccessConnector(connectorId: string): Promise<{ row: ConnectorRow; credentials: Record<string, string> }> {
  const row = db.prepare("SELECT * FROM connectors WHERE id = ? AND type = 'server-access'").get(connectorId) as ConnectorRow | null;
  if (!row) throw new Error(`server-access connector ${connectorId} not found`);
  const credentials = parseJson<Record<string, string>>(decrypt(row.credentials ?? '{}'), {});
  return { row, credentials };
}

async function executeServerFileWrite(task: Task): Promise<ExecuteResult> {
  const payload = typeof task.action_payload === 'string'
    ? parseJson<Record<string, unknown>>(task.action_payload, {}) : task.action_payload ?? {};
  const { connector_id, target_file, new_content } = payload as { connector_id?: string; target_file?: string; new_content?: string };
  if (!connector_id) throw new Error('server_file_write: connector_id required');
  if (!target_file) throw new Error('server_file_write: target_file required');
  if (typeof new_content !== 'string') throw new Error('server_file_write: new_content must be a string');

  const { credentials } = await loadServerAccessConnector(connector_id);

  // Lazy-import to keep ssh2/basic-ftp dependencies out of the startup path.
  const { createServerConnection } = await import('../connectors/server-access/connection.js') as typeof ServerConnection;
  type ServerCreds = Parameters<typeof createServerConnection>[0];
  const conn = await createServerConnection(credentials as unknown as ServerCreds, { rootPath: credentials.rootPath });

  try {
    // 1. Fresh read + backup of current content (mandatory — never skip).
    const before = await conn.readFile(target_file);
    if (before.refused) {
      throw new Error(`server_file_write: connector refused to read current file (${before.reason})`);
    }

    const backupId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO file_backups (id, business_id, connector_id, task_id, remote_path, content, content_hash, backed_up_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      backupId, task.business_id, connector_id, task.id,
      target_file, before.content, before.hash,
    );

    // 2. Write.
    const writeResult = await conn.writeFile(target_file, new_content);

    // 3. Refresh the cache hash so subsequent syncs don't flag this as an
    //    external change.
    try {
      db.prepare(`
        INSERT INTO server_file_cache (id, business_id, connector_id, remote_path, content, content_hash, file_size, last_modified, cached_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(connector_id, remote_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          file_size = excluded.file_size,
          last_modified = CURRENT_TIMESTAMP,
          cached_at = CURRENT_TIMESTAMP
      `).run(
        crypto.randomUUID(), task.business_id, connector_id, target_file,
        writeResult.hash, writeResult.bytes_written,
      );
    } catch (err) {
      console.warn('[executor] server_file_cache update failed (non-fatal):', (err as Error).message);
    }

    // 4. Audit.
    try {
      db.prepare(`
        INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
        VALUES (?, ?, 'server_file', ?, 'file_write', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        crypto.randomUUID(), task.business_id,
        target_file, `task:${task.id}`,
        JSON.stringify({ bytes: writeResult.bytes_written, backup_id: backupId, before_hash: before.hash, after_hash: writeResult.hash }),
      );
    } catch (err) {
      console.warn('[executor] file_write audit insert failed:', (err as Error).message);
    }

    return {
      outcome: `Wrote ${writeResult.bytes_written} bytes to ${target_file} (backup ${backupId.slice(0, 8)}).`,
      outcome_data: {
        target_file,
        bytes_written: writeResult.bytes_written,
        backup_id: backupId,
        before_hash: before.hash,
        after_hash: writeResult.hash,
      },
    };
  } finally {
    await conn.disconnect();
  }
}

async function executeServerFileRollback(task: Task): Promise<ExecuteResult> {
  const payload = typeof task.action_payload === 'string'
    ? parseJson<Record<string, unknown>>(task.action_payload, {}) : task.action_payload ?? {};
  const { backup_id } = payload as { backup_id?: string };
  if (!backup_id) throw new Error('server_file_rollback: backup_id required');

  const backup = db.prepare('SELECT * FROM file_backups WHERE id = ?').get(backup_id) as { connector_id: string; remote_path: string; content: string; backed_up_at: string } | null;
  if (!backup) throw new Error(`Backup ${backup_id} not found — cannot rollback.`);

  const { credentials } = await loadServerAccessConnector(backup.connector_id);
  const { createServerConnection } = await import('../connectors/server-access/connection.js') as typeof ServerConnection;
  type ServerCreds2 = Parameters<typeof createServerConnection>[0];
  const conn = await createServerConnection(credentials as unknown as ServerCreds2, { rootPath: credentials.rootPath });

  try {
    const result = await conn.writeFile(backup.remote_path, backup.content);
    try {
      db.prepare(`
        INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
        VALUES (?, ?, 'server_file', ?, 'file_rollback', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        crypto.randomUUID(), task.business_id,
        backup.remote_path, `task:${task.id}`,
        JSON.stringify({ backup_id, restored_from: backup.backed_up_at, bytes: result.bytes_written }),
      );
    } catch {}
    return {
      outcome: `Rolled back ${backup.remote_path} to backup from ${backup.backed_up_at}.`,
      outcome_data: { target_file: backup.remote_path, restored_from: backup.backed_up_at, bytes_written: result.bytes_written },
    };
  } finally {
    await conn.disconnect();
  }
}

// ─── Connector lifecycle handlers ─────────────────────────────────────────────

/**
 * connect_connector — human has approved the recommendation to connect a
 * built-in connector. Returns an instruction to go connect it; no API call.
 */
async function executeConnectConnector(task: Task): Promise<ExecuteResult> {
  const { connector_type, connector_name } = task.action_payload ?? {} as { connector_type?: string; connector_name?: string };
  return {
    outcome: `Connector recommendation acknowledged: connect ${connector_name || connector_type}. Go to Settings → Connectors → Add Connector.`,
    outcome_data: { connector_type, connector_name },
  };
}

/**
 * research_connector — searches for APIs that provide the requested data,
 * evaluates them with an LLM, files a spec to the KB, and creates a GitHub
 * issue for worthwhile connectors.
 */
async function executeResearchConnector(task: Task): Promise<ExecuteResult> {
  const { description, use_case, requested_by } = task.action_payload ?? {} as { description?: string; use_case?: string; requested_by?: string };
  if (!description) throw new Error('research_connector requires action_payload.description');

  const { agentSearch } = await import('../agents/tools/search.js') as typeof AgentSearch;
  const { runLLM, resolveProfileLLM } = await import('../lib/llm-providers.js') as typeof LlmProviders;

  // Search for APIs
  const [apiSearch, pricingSearch] = await Promise.allSettled([
    agentSearch(
      `${description} API developer documentation REST`,
      { search_depth: 'advanced', max_results: 5 },
      task.business_id, db
    ),
    agentSearch(
      `${description} API integration pricing free tier`,
      { search_depth: 'basic', max_results: 4 },
      task.business_id, db
    ),
  ]);

  const apiResults = apiSearch.status === 'fulfilled' && apiSearch.value.available
    ? apiSearch.value.results.slice(0, 4) : [];
  const pricingResults = pricingSearch.status === 'fulfilled' && pricingSearch.value.available
    ? pricingSearch.value.results.slice(0, 3) : [];

  const searchAvailable = apiResults.length > 0;

  const prompt = `You are evaluating APIs to build a Blueprint connector for:

REQUESTED DATA: ${description}
USE CASE: ${use_case ?? 'Not specified'}
REQUESTED BY AGENT: ${requested_by ?? 'unknown'}

${searchAvailable ? `API DOCUMENTATION FOUND:
${apiResults.map(r => `**${r.title}**\nURL: ${r.url}\n${(r.content || r.description || '').slice(0, 400)}`).join('\n\n')}

PRICING / INTEGRATION INFO:
${pricingResults.map(r => `**${r.title}**\n${(r.content || r.description || '').slice(0, 200)}`).join('\n\n')}` : 'No search connector available — use your training knowledge to evaluate known APIs.'}

Produce a connector proposal as JSON:
{
  "connector_name": "Name of the best API option",
  "connector_id": "snake_case_id",
  "provider_url": "https://...",
  "api_docs_url": "https://...",
  "auth_type": "apikey|oauth2|basic",
  "pricing": "free|freemium|paid — brief description",
  "free_tier": "What free tier includes, or null",
  "data_available": ["Specific metric or data point"],
  "signals_possible": ["Signal rule that would be possible"],
  "agents_benefiting": ["agent-id"],
  "build_complexity": "low|medium|high",
  "build_estimate": "e.g. 2-4 hours",
  "recommendation": "build_now|build_later|not_worth_it",
  "recommendation_reason": "Why",
  "sample_endpoints": [{ "name": "what it fetches", "method": "GET", "url": "https://...", "key_fields": ["field1"] }],
  "alternatives": [{ "name": "Alt API", "url": "https://...", "why_not_primary": "reason" }]
}`;

  const { providerId, model } = resolveProfileLLM({});
  const llmResult = await runLLM(providerId, model, {
    messages: [{ role: 'user', content: prompt }],
    system: 'Return only valid JSON. Be specific and honest about API complexity.',
    temperature: 0.2,
    max_tokens: 2000,
  });

  // Parse spec
  let spec: Record<string, unknown>;
  try {
    const raw = llmResult.content ?? '';
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    spec = JSON.parse((m?.[1] ?? raw).trim()) as Record<string, unknown>;
  } catch {
    throw new Error('LLM could not produce a valid connector spec JSON');
  }

  // File spec to KB
  let kbPath: string | null = null;
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as typeof KbConfig;
    const kb = await getKBForBusiness(task.business_id);
    if (kb?.engine) {
      const date = new Date().toISOString().slice(0, 10);
      const slug = (String(spec['connector_id'] ?? '') || String(description ?? '').toLowerCase().replace(/\s+/g, '-')).slice(0, 40);
      kbPath = `research/connector-spec-${slug}-${date}.md`;
      const doc = buildConnectorSpecDoc(spec, task, date);
      await kb.engine.writeFile(
        kbPath, doc,
        { title: `Connector Spec: ${spec.connector_name as string}`, tags: ['connector-spec', 'research', spec.recommendation as string],
          written_by: 'researcher', review_status: 'pending_review' },
        `connector spec: ${spec.connector_name as string}`
      );
    }
  } catch (kbErr) {
    console.warn('[executor] research_connector KB write failed (non-fatal):', (kbErr as Error).message);
  }

  // Create GitHub issue on the Blueprint repo for worthwhile connectors.
  // This goes to chrisgwynne/Blueprint — NOT the business's GitHub connector.
  let issueUrl: string | null = null;
  if (spec.recommendation !== 'not_worth_it') {
    try {
      const issue = await createBlueprintIssue({
        title: `Connector request: ${spec.connector_name as string}`,
        body: buildConnectorIssueBody(spec, task),
        labels: ([
          'connector-request',
          spec['recommendation'] === 'build_now' ? 'priority' : 'backlog',
          String(spec['build_complexity'] ?? ''),
        ] as string[]).filter(Boolean),
      }, db);
      issueUrl = (issue as { url?: string } | null)?.url ?? null;
      if (issue) console.log(`[executor] Connector request issue created: ${(issue as { url: string }).url}`);
    } catch (ghErr) {
      console.warn('[executor] research_connector Blueprint GitHub issue failed (non-fatal):', (ghErr as Error).message);
    }
  }

  return {
    outcome: `Connector spec for "${spec.connector_name as string}" produced. Recommendation: ${spec.recommendation as string}.${issueUrl ? ` GitHub issue created.` : ''}`,
    outcome_data: { connector_name: spec.connector_name, recommendation: spec.recommendation, kb_path: kbPath, issue_url: issueUrl },
  };
}

function buildConnectorSpecDoc(spec: Record<string, unknown>, task: Task, date: string): string {
  return `# Connector Spec: ${spec.connector_name as string}

**Requested by:** ${(task.action_payload?.requested_by as string | undefined) ?? 'unknown'}
**Date:** ${date}
**Recommendation:** ${((spec.recommendation as string | undefined) ?? '').toUpperCase()}

## Provider
- Website: ${(spec.provider_url as string | undefined) ?? 'unknown'}
- API Docs: ${(spec.api_docs_url as string | undefined) ?? 'unknown'}
- Auth: ${(spec.auth_type as string | undefined) ?? 'unknown'}
- Pricing: ${(spec.pricing as string | undefined) ?? 'unknown'}
${spec.free_tier ? `- Free tier: ${spec.free_tier as string}` : ''}

## What this connector provides
${((spec.data_available as string[] | undefined) ?? []).map(d => `- ${d}`).join('\n')}

## Signals it would enable
${((spec.signals_possible as string[] | undefined) ?? []).map(s => `- ${s}`).join('\n')}

## Agents that benefit
${((spec.agents_benefiting as string[] | undefined) ?? []).map(a => `- ${a}`).join('\n')}

## Build assessment
- Complexity: ${(spec.build_complexity as string | undefined) ?? 'unknown'}
- Estimated time: ${(spec.build_estimate as string | undefined) ?? 'unknown'}
- Recommendation: **${(spec.recommendation as string | undefined) ?? 'unknown'}**
- Reason: ${(spec.recommendation_reason as string | undefined) ?? ''}

## Sample endpoints
${((spec.sample_endpoints as Array<{ name: string; method: string; url: string; key_fields?: string[] }> | undefined) ?? []).map(e =>
  `### ${e.name}\n\`${e.method} ${e.url}\`\nKey fields: ${(e.key_fields ?? []).join(', ')}`
).join('\n\n')}

## Alternatives
${((spec.alternatives as Array<{ name: string; why_not_primary: string }> | undefined) ?? []).map(a => `- **${a.name}**: ${a.why_not_primary}`).join('\n') || 'None'}

---
*Spec generated by Blueprint on ${date}*
*Use case: ${(task.action_payload?.use_case as string | undefined) ?? ''}*
`;
}

function buildConnectorIssueBody(spec: Record<string, unknown>, task: Task): string {
  return `## Connector Request: ${spec.connector_name as string}

**Requested by agent:** ${(task.action_payload?.requested_by as string | undefined) ?? 'unknown'}
**Use case:** ${(task.action_payload?.use_case as string | undefined) ?? 'not specified'}

### API details
- **Provider:** ${spec.connector_name as string} (${(spec.provider_url as string | undefined) ?? 'unknown'})
- **API docs:** ${(spec.api_docs_url as string | undefined) ?? 'unknown'}
- **Auth:** ${(spec.auth_type as string | undefined) ?? 'unknown'}
- **Pricing:** ${(spec.pricing as string | undefined) ?? 'unknown'}
${spec.free_tier ? `- **Free tier:** ${spec.free_tier as string}` : ''}

### Data available
${((spec.data_available as string[] | undefined) ?? []).map(d => `- ${d}`).join('\n')}

### Signals it would enable
${((spec.signals_possible as string[] | undefined) ?? []).map(s => `- ${s}`).join('\n')}

### Agents that benefit
${((spec.agents_benefiting as string[] | undefined) ?? []).map(a => `- \`${a}\``).join('\n')}

### Build assessment
- Complexity: **${(spec.build_complexity as string | undefined) ?? 'unknown'}**
- Estimated time: **${(spec.build_estimate as string | undefined) ?? 'unknown'}**

### Sample endpoints
\`\`\`
${((spec.sample_endpoints as Array<{ method: string; url: string; key_fields?: string[] }> | undefined) ?? []).map(e =>
  `${e.method} ${e.url}\nFields: ${(e.key_fields ?? []).join(', ')}`
).join('\n\n')}
\`\`\`

---
*Automatically generated by Blueprint's connector discovery system.*
`;
}
