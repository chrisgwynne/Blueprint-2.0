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
import crypto from 'node:crypto';
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { updateTaskStatus } from './task-queue.js';
import { createTaskEvent } from './task-events.js';

const EXECUTABLE_ACTION_TYPES = new Set([
  'github_issue',
  'github_pr',
  'investigation',
  'content_draft',
  'shopify_product_create',
  'shopify_product_update',
  'shopify_description_update',
  'shopify_page_create',
  'shopify_page_update',
  'shopify_blog_post_create',
  'shopify_meta_update',
  'shopify_collection_update',
  'shopify_tag_update',
  'hire_agent',
  // Wix SEO write-back (page + blog-post SEO fields only, approved)
  'wix_seo_update',
  // Server-access write (requires approved task + backup-before-write)
  'server_file_write',
  'server_file_rollback',
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
  if (actionType?.startsWith('shopify_')) return 'shopify';
  if (actionType === 'wix_seo_update') return 'wix';
  if (actionType === 'server_file_write' || actionType === 'server_file_rollback') return 'server-access';
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

async function executeInvestigation(task) {
  // Approving an investigation task should actually RUN the investigation,
  // not mark it complete with a placeholder. Previously this returned a
  // one-liner "queued for human review" and the task instantly landed in
  // Complete with nothing to show.
  const { runInvestigation } = await import('../brain/investigation-engine.js');

  // The investigation engine wants a specific metric OR a signal id OR a
  // free-form question. For a task created from a signal, use the signal.
  // Otherwise ship the task title + description as the question so the
  // LLM has something to reason about.
  const question = task.description
    ? `${task.title}. ${task.description}`
    : task.title;

  const investigation = await runInvestigation({
    businessId: task.business_id,
    signalId: task.signal_id ?? null,
    metricName: task.action_payload?.metric_name ?? null,
    question,
    triggeredBy: `task:${task.id}`,
  });

  if (!investigation) {
    // Shouldn't happen now that runInvestigation throws on failure, but guard
    // in case the engine returned a shape we didn't expect.
    throw new Error('Investigation engine returned no result.');
  }

  return {
    outcome: investigation.explanation
      ? `Investigation complete. ${String(investigation.explanation).slice(0, 140)}${investigation.explanation.length > 140 ? '…' : ''}`
      : 'Investigation complete.',
    outcome_data: {
      type: 'investigation',
      investigation_id: investigation.id,
      confidence: investigation.confidence ?? null,
      primary_cause: investigation.primary_cause ?? null,
      recommendation: investigation.recommendation ?? null,
      explanation: investigation.explanation ?? null,
      alternatives: investigation.alternatives ?? null,
      evidence: investigation.evidence ?? null,
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

// ─── Shopify handlers ─────────────────────────────────────────────────────────

async function getShopify(task) {
  const { credentials, config } = loadConnector(task.business_id, 'shopify');
  const { default: shopify } = await import('../connectors/shopify/index.js');
  return { shopify, credentials, config };
}

async function executeShopifyProductCreate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);

  const result = await shopify.createProduct(credentials, config, {
    title: payload.title ?? task.title,
    body_html: payload.description ?? payload.body_html ?? task.description ?? '',
    product_type: payload.product_type ?? null,
    tags: Array.isArray(payload.tags) ? payload.tags.join(', ') : payload.tags ?? '',
    variants: payload.variants ?? [{ price: payload.price ?? '0.00' }],
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

async function executeShopifyProductUpdate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const productId = payload.product_id;
  if (!productId) throw new Error('product_id is required in action_payload.');

  // Save current state for rollback
  const current = await shopify.fetchProduct(credentials, config, productId);
  const rollback = {
    action: 'restore_product',
    product_id: productId,
    previous_state: {},
  };

  const updates = {};
  if (payload.new_description !== undefined || payload.body_html !== undefined) {
    updates.body_html = payload.new_description ?? payload.body_html;
    rollback.previous_state.body_html = current.body_html;
  }
  if (payload.title !== undefined) {
    updates.title = payload.title;
    rollback.previous_state.title = current.title;
  }
  if (payload.tags !== undefined) {
    updates.tags = Array.isArray(payload.tags) ? payload.tags.join(', ') : payload.tags;
    rollback.previous_state.tags = current.tags;
  }
  if (payload.updates && typeof payload.updates === 'object') {
    Object.assign(updates, payload.updates);
    for (const k of Object.keys(payload.updates)) {
      rollback.previous_state[k] = current[k] ?? null;
    }
  }

  await shopify.updateProduct(credentials, config, productId, updates);
  db.prepare('UPDATE tasks SET rollback_data = ? WHERE id = ?')
    .run(JSON.stringify(rollback), task.id);

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify product updated: "${current.title}"`,
    outcome_data: {
      product_id: productId,
      admin_url: `https://${shop}/admin/products/${productId}`,
      changes: Object.keys(updates),
    },
  };
}

async function executeShopifyPageCreate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);

  const result = await shopify.createPage(credentials, config, {
    title: payload.title ?? task.title,
    body_html: payload.body_html ?? task.description ?? '',
    handle: payload.handle ?? null,
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

async function executeShopifyPageUpdate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const pageId = payload.page_id;
  if (!pageId) throw new Error('page_id is required in action_payload.');

  const updates = {};
  if (payload.body_html !== undefined) updates.body_html = payload.body_html;
  if (payload.title !== undefined) updates.title = payload.title;
  if (payload.updates) Object.assign(updates, payload.updates);

  await shopify.updatePage(credentials, config, pageId, updates);

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

async function executeShopifyBlogPostCreate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const blogId = payload.blog_id;
  if (!blogId) throw new Error('blog_id is required in action_payload.');

  const result = await shopify.createBlogPost(credentials, config, blogId, {
    title: payload.title ?? task.title,
    body_html: payload.body_html ?? task.description ?? '',
    author: payload.author ?? 'Blueprint',
    tags: payload.tags ?? '',
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

async function executeShopifyCollectionUpdate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const collectionId = payload.collection_id;
  if (!collectionId) throw new Error('collection_id is required in action_payload.');

  await shopify.updateCollectionDescription(credentials, config, collectionId, payload.new_description ?? '');

  const shop = credentials.shopDomain;
  return {
    outcome: `Shopify collection updated (ID: ${collectionId})`,
    outcome_data: {
      collection_id: collectionId,
      admin_url: `https://${shop}/admin/collections/${collectionId}`,
    },
  };
}

async function executeShopifyTagUpdate(task) {
  const payload = task.action_payload ?? {};
  const { shopify, credentials, config } = await getShopify(task);
  const productId = payload.product_id;
  if (!productId) throw new Error('product_id is required in action_payload.');

  await shopify.updateProductTags(
    credentials, config, productId,
    payload.add_tags ?? [], payload.remove_tags ?? []
  );

  return {
    outcome: `Product tags updated for product ${productId}`,
    outcome_data: {
      product_id: productId,
      added: payload.add_tags ?? [],
      removed: payload.remove_tags ?? [],
    },
  };
}

// ─── Rollback system ──────────────────────────────────────────────────────────

/**
 * Roll back a completed write-back task.
 * Uses the rollback_data stored at execution time.
 */
export async function rollbackTask(taskId) {
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!taskRow) throw new Error(`Task ${taskId} not found.`);
  if (!taskRow.rollback_data) throw new Error('No rollback data available for this task.');

  const rollback = JSON.parse(taskRow.rollback_data);
  if (!rollback.action) throw new Error('Invalid rollback data.');

  if (rollback.action === 'delete_product' && rollback.product_id) {
    const { shopify, credentials, config } = await getShopify(taskRow);
    await shopify.deleteProduct(credentials, config, rollback.product_id);
    updateTaskStatus(taskId, 'failed', 'system:rollback', { outcome: 'Rolled back: product deleted' });
    createTaskEvent(taskId, 'rolled_back', 'system:rollback', `Product ${rollback.product_id} deleted (rollback)`, {});
    return { outcome: `Product ${rollback.product_id} deleted` };
  }

  if (rollback.action === 'restore_product' && rollback.product_id) {
    const { shopify, credentials, config } = await getShopify(taskRow);
    await shopify.updateProduct(credentials, config, rollback.product_id, rollback.previous_state);
    updateTaskStatus(taskId, 'failed', 'system:rollback', { outcome: 'Rolled back: product restored' });
    createTaskEvent(taskId, 'rolled_back', 'system:rollback', `Product ${rollback.product_id} restored to previous state`, {});
    return { outcome: `Product ${rollback.product_id} restored` };
  }

  throw new Error(`Unknown rollback action: ${rollback.action}`);
}

// ─── Agent hire action ────────────────────────────────────────────────────────

/**
 * Install a specialist agent from a template. Created by Conductor via
 * analyseAndProposeHires() when connector data justifies it; this executor
 * runs after a human approves the hire proposal.
 *
 * action_payload: { template_id: string }
 */
async function executeHireAgent(task) {
  const payload = task.action_payload ?? {};
  const templateId = payload.template_id;
  if (!templateId) throw new Error('hire_agent requires action_payload.template_id');

  const { installAgent } = await import('../agents/installer.js');
  const result = installAgent(templateId, task.business_id, 'human');

  // Fire-and-forget first run if ready — gives the "wow" moment post-approval.
  if (result.status === 'active') {
    (async () => {
      try {
        const { runAgent } = await import('../agents/agent-runner.js');
        await runAgent(templateId, task.business_id, 'post_hire_initial_run', task.id);
      } catch (err) {
        console.warn(`[hire_agent] post-hire run of ${templateId} failed:`, err.message);
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
      case 'github_issue':             result = await executeGithubIssue(task); break;
      case 'github_pr':                result = await executeGithubPR(task);    break;
      case 'investigation':            result = await executeInvestigation(task);  break;
      case 'content_draft':            result = executeContentDraft(task);       break;
      case 'shopify_product_create':   result = await executeShopifyProductCreate(task); break;
      case 'shopify_product_update':
      case 'shopify_description_update':
      case 'shopify_meta_update':      result = await executeShopifyProductUpdate(task); break;
      case 'shopify_page_create':      result = await executeShopifyPageCreate(task); break;
      case 'shopify_page_update':      result = await executeShopifyPageUpdate(task); break;
      case 'shopify_blog_post_create': result = await executeShopifyBlogPostCreate(task); break;
      case 'shopify_collection_update': result = await executeShopifyCollectionUpdate(task); break;
      case 'shopify_tag_update':        result = await executeShopifyTagUpdate(task); break;
      case 'hire_agent':                result = await executeHireAgent(task); break;
      case 'wix_seo_update':            result = await executeWixSeoUpdate(task); break;
      case 'server_file_write':         result = await executeServerFileWrite(task); break;
      case 'server_file_rollback':      result = await executeServerFileRollback(task); break;
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

// ─── Wix SEO write-back ─────────────────────────────────────────────────────

async function executeWixSeoUpdate(task) {
  const payload = typeof task.action_payload === 'string'
    ? JSON.parse(task.action_payload) : task.action_payload ?? {};
  const { target, target_id, title, description, slug, connector_id } = payload;
  if (!connector_id) throw new Error('wix_seo_update: connector_id required in action_payload');
  if (!target || !target_id) throw new Error('wix_seo_update: target and target_id required (target: "page"|"post")');

  const connectorRow = db.prepare('SELECT * FROM connectors WHERE id = ? AND type = ?').get(connector_id, 'wix');
  if (!connectorRow) throw new Error(`Wix connector ${connector_id} not found`);
  const credentials = JSON.parse(decrypt(connectorRow.credentials));
  const { default: wix } = await import('../connectors/wix/index.js');

  let res;
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

async function loadServerAccessConnector(connectorId) {
  const row = db.prepare("SELECT * FROM connectors WHERE id = ? AND type = 'server-access'").get(connectorId);
  if (!row) throw new Error(`server-access connector ${connectorId} not found`);
  const credentials = JSON.parse(decrypt(row.credentials));
  return { row, credentials };
}

async function executeServerFileWrite(task) {
  const payload = typeof task.action_payload === 'string'
    ? JSON.parse(task.action_payload) : task.action_payload ?? {};
  const { connector_id, target_file, new_content } = payload;
  if (!connector_id) throw new Error('server_file_write: connector_id required');
  if (!target_file) throw new Error('server_file_write: target_file required');
  if (typeof new_content !== 'string') throw new Error('server_file_write: new_content must be a string');

  const { row: connectorRow, credentials } = await loadServerAccessConnector(connector_id);

  // Lazy-import to keep ssh2/basic-ftp dependencies out of the startup path.
  const { createServerConnection } = await import('../connectors/server-access/connection.js');
  const conn = await createServerConnection(credentials, { rootPath: credentials.rootPath });

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
      console.warn('[executor] server_file_cache update failed (non-fatal):', err.message);
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
      console.warn('[executor] file_write audit insert failed:', err.message);
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

async function executeServerFileRollback(task) {
  const payload = typeof task.action_payload === 'string'
    ? JSON.parse(task.action_payload) : task.action_payload ?? {};
  const { backup_id } = payload;
  if (!backup_id) throw new Error('server_file_rollback: backup_id required');

  const backup = db.prepare('SELECT * FROM file_backups WHERE id = ?').get(backup_id);
  if (!backup) throw new Error(`Backup ${backup_id} not found — cannot rollback.`);

  const { credentials } = await loadServerAccessConnector(backup.connector_id);
  const { createServerConnection } = await import('../connectors/server-access/connection.js');
  const conn = await createServerConnection(credentials, { rootPath: credentials.rootPath });

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
