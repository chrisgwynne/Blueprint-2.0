/**
 * Task execution engine.
 *
 * Routes approved tasks to the right action handler based on `action_type`,
 * transitions the task through executing → complete/failed, and records
 * outcomes + task_events.
 *
 * Currently supported action types:
 *   - github_issue   — create a GitHub issue (uses GitHub connector createIssue)
 *   - github_pr      — create a draft GitHub PR (uses GitHub connector createPR)
 *   - investigation  — no-op execution; just marks complete with a note (human action expected)
 *   - content_draft  — no-op execution; logs that content has been drafted in proposal
 *
 * To add a new action type:
 *   1. Add a case to executeTask()
 *   2. Implement the handler returning { outcome, outcome_data }
 */
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { updateTaskStatus } from './task-queue.js';
import { createTaskEvent } from './task-events.js';

const EXECUTABLE_ACTION_TYPES = new Set([
  'github_issue',
  'github_pr',
  'investigation',
  'content_draft',
]);

export function isExecutable(actionType) {
  return EXECUTABLE_ACTION_TYPES.has(actionType);
}

/**
 * Find the right connector for the given task.
 * Maps action_type → connector type.
 */
function connectorTypeForAction(actionType) {
  if (actionType === 'github_issue' || actionType === 'github_pr') return 'github';
  return null;
}

/**
 * Load + decrypt credentials for a connector. Returns { connector, credentials }
 * or throws if not found / not connected.
 */
function loadConnector(businessId, type) {
  const row = db.prepare(
    `SELECT id, type, name, credentials, config, status FROM connectors
     WHERE business_id = ? AND type = ? AND status = 'connected'
     LIMIT 1`
  ).get(businessId, type);
  if (!row) {
    throw new Error(`No connected ${type} connector found for this business. Add it under Connectors → +.`);
  }
  let credentials = {};
  try {
    if (row.credentials) credentials = JSON.parse(decrypt(row.credentials));
  } catch (err) {
    throw new Error(`Failed to decrypt ${type} credentials: ${err.message}`);
  }
  let config = {};
  try {
    if (row.config) config = JSON.parse(row.config);
  } catch {}
  return { connector: row, credentials, config };
}

// ─── Action handlers ──────────────────────────────────────────────────────────

function buildIssueBody(task) {
  const lines = [
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
  return lines.filter(l => l !== null).join('\n');
}

async function executeGithubIssue(task) {
  const payload = task.action_payload ?? {};
  const { credentials, config } = loadConnector(task.business_id, 'github');

  const owner = payload.owner ?? credentials.owner ?? config.owner;
  if (!owner) throw new Error('GitHub owner is required (in task action_payload or connector config).');

  // Repo: explicit in payload, OR first repo in connector config.repos
  let repo = payload.repo;
  if (!repo) {
    const repos = config.repos ?? credentials.repos;
    if (repos) repo = String(repos).split(',')[0]?.trim();
  }
  if (!repo) throw new Error('GitHub repo is required (in task action_payload.repo or connector config.repos).');

  const { default: github } = await import('../connectors/github/index.js');
  const issue = await github.createIssue(credentials, owner, repo, {
    title: payload.title ?? task.title,
    body: payload.body ?? buildIssueBody(task),
    labels: payload.labels ?? [
      'blueprint/auto-created',
      `blueprint/agent-${task.proposed_by}`,
      `blueprint/${task.priority}`,
    ],
  });

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

async function executeGithubPR(task) {
  const payload = task.action_payload ?? {};
  if (!payload.head) throw new Error('github_pr requires action_payload.head (branch with changes).');

  const { credentials, config } = loadConnector(task.business_id, 'github');
  const owner = payload.owner ?? credentials.owner ?? config.owner;
  const repo  = payload.repo;
  if (!owner || !repo) throw new Error('github_pr requires owner + repo (in action_payload or connector config).');

  const { default: github } = await import('../connectors/github/index.js');
  const pr = await github.createPR(credentials, owner, repo, {
    title: payload.title ?? task.title,
    body:  payload.body ?? buildIssueBody(task),
    head:  payload.head,
    base:  payload.base ?? 'main',
    draft: payload.draft ?? true, // always draft — human reviews
  });

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

function executeInvestigation(task) {
  // Investigation tasks are flagged for human review. Mark complete with a
  // note so they show up in the dashboard as "investigated by agent" but
  // require humans to act on the findings.
  return {
    outcome: `Investigation queued for human review`,
    outcome_data: {
      type: 'investigation',
      description: task.description ?? null,
      proposed_by: task.proposed_by,
    },
  };
}

function executeContentDraft(task) {
  // Content draft tasks: the proposal IS the draft. Marking complete records
  // that the agent has done its work; human downstream action is taken via KB
  // editing or CMS publishing.
  return {
    outcome: `Content draft prepared`,
    outcome_data: {
      type: 'content_draft',
      title: task.title,
      description: task.description ?? null,
      proposed_by: task.proposed_by,
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
 * @param {string} taskId
 * @returns {Promise<{ ok: boolean, outcome?: string, error?: string }>}
 */
export async function executeTask(taskId) {
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!taskRow) {
    return { ok: false, error: `Task '${taskId}' not found` };
  }

  // Re-parse JSON fields once
  const task = {
    ...taskRow,
    action_payload: taskRow.action_payload ? JSON.parse(taskRow.action_payload) : {},
  };

  if (!isExecutable(task.action_type)) {
    return { ok: false, error: `action_type '${task.action_type}' is not executable` };
  }

  // Transition: approved → executing
  try {
    updateTaskStatus(task.id, 'executing', 'system:executor', {});
  } catch (err) {
    return { ok: false, error: `Could not transition to executing: ${err.message}` };
  }

  createTaskEvent(
    task.id,
    'executing',
    'system:executor',
    `Execution started for ${task.action_type}`,
    { action_type: task.action_type }
  );

  // Dispatch
  let result;
  try {
    switch (task.action_type) {
      case 'github_issue':  result = await executeGithubIssue(task); break;
      case 'github_pr':     result = await executeGithubPR(task);    break;
      case 'investigation': result = executeInvestigation(task);      break;
      case 'content_draft': result = executeContentDraft(task);       break;
      default:
        throw new Error(`Unhandled executable action_type: ${task.action_type}`);
    }
  } catch (err) {
    // Mark failed + record outcome
    try {
      updateTaskStatus(task.id, 'failed', 'system:executor', {
        outcome: `Execution failed: ${err.message}`,
        outcome_data: { error: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') ?? null },
      });
      createTaskEvent(
        task.id,
        'failed',
        'system:executor',
        `Execution failed: ${err.message}`,
        { error: err.message }
      );
    } catch {}
    console.error(`[executor] Task ${taskId} failed:`, err);
    return { ok: false, error: err.message };
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
    return { ok: false, error: `Execution succeeded but status update failed: ${err.message}` };
  }

  console.log(`[executor] Task ${taskId} (${task.action_type}) executed: ${result.outcome}`);
  return { ok: true, outcome: result.outcome, outcome_data: result.outcome_data };
}
