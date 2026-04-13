import { Router } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { createTask, listTasks, approveTask, rejectTask, updateTaskStatus } from '../tasks/task-queue.js';
import { createTaskEvent, getTaskEvents } from '../tasks/task-events.js';
import { executeTask, isExecutable, rollbackTask } from '../tasks/executor.js';

const router = Router();
router.use(isAuthenticated);

function safeJSON(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); }
  catch {
    console.warn('[tasks] Failed to parse JSON field, using fallback. Raw:', String(raw).slice(0, 120));
    return fallback;
  }
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    action_payload: safeJSON(row.action_payload, {}),
    outcome_data: safeJSON(row.outcome_data, null),
    rollback_data: safeJSON(row.rollback_data, null),
  };
}

/**
 * GET /api/tasks/approval-policies
 * Returns the user-configured approval policy map. Per-action-type 'auto'
 * skips the human approval step; 'manual' forces it.
 */
router.get('/approval-policies', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'approval_policies'").get();
    let policies = {};
    try { policies = row?.value ? JSON.parse(row.value) : {}; } catch {}
    return res.json({ policies });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/tasks/approval-policies
 * Body: { policies: { default?: 'auto'|'manual', <action_type>?: 'auto'|'manual' } }
 */
router.put('/approval-policies', (req, res) => {
  try {
    const policies = req.body?.policies ?? {};
    if (typeof policies !== 'object') return res.status(400).json({ error: 'policies must be an object' });
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('approval_policies', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(policies));
    return res.json({ ok: true, policies });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks/:businessId
 * Query: view=kanban|list, status, signal_id, mission_id, page, limit
 */
router.get('/:businessId', (req, res) => {
  try {
    const { businessId } = req.params;
    const { view = 'list', status, signal_id, mission_id, page = 1, limit = 50 } = req.query;

    const filters = { status, signal_id, mission_id };
    const tasks = listTasks(businessId, filters).map(parseRow);

    if (view === 'kanban') {
      const COLUMNS = ['proposed', 'approved', 'executing', 'complete', 'verified', 'failed', 'rejected'];
      const grouped = {};
      for (const col of COLUMNS) {
        grouped[col] = tasks.filter(t => t.status === col);
      }
      return res.json({ view: 'kanban', columns: COLUMNS, data: grouped });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, parseInt(limit, 10) || 50);
    const offset = (pageNum - 1) * limitNum;
    const paginated = tasks.slice(offset, offset + limitNum);

    return res.json({
      view: 'list',
      data: paginated,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: tasks.length,
        pages: Math.ceil(tasks.length / limitNum),
      },
    });
  } catch (err) {
    console.error('[tasks] List error:', err);
    return res.status(500).json({ error: 'Failed to list tasks.' });
  }
});

/**
 * POST /api/tasks
 * Create a manual task
 */
router.post('/', (req, res) => {
  try {
    const {
      business_id,
      signal_id,
      mission_id,
      title,
      description,
      action_type,
      action_payload,
      trust_tier,
      priority,
      estimated_impact,
      approval_mode,
    } = req.body;

    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const task = createTask({
      business_id,
      signal_id: signal_id ?? null,
      mission_id: mission_id ?? null,
      title,
      description: description ?? null,
      proposed_by: req.session.userId,
      action_type: action_type ?? null,
      action_payload: action_payload ?? {},
      trust_tier: trust_tier ?? 'yellow',
      priority: priority ?? 'p2',
      estimated_impact: estimated_impact ?? null,
      approval_mode: approval_mode ?? 'requires_approval',
    });

    createTaskEvent(
      task.id,
      'created',
      req.session.userId || 'human',
      `Task created manually: "${task.title}"`,
      { status: 'proposed', source: 'manual' }
    );

    return res.status(201).json(parseRow(task));
  } catch (err) {
    console.error('[tasks] Create error:', err);
    return res.status(500).json({ error: 'Failed to create task.' });
  }
});

/**
 * PATCH /api/tasks/:id/approve
 *
 * Approves the task. If the task's action_type is executable (github_issue,
 * github_pr, investigation, content_draft), the executor is fired in the
 * background — the HTTP response returns immediately with status='approved',
 * and the executor transitions the task through executing → complete/failed.
 * The frontend can poll task detail or task events to see the result.
 */
router.patch('/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const approver = req.session.userId;
    const task = approveTask(id, approver);
    createTaskEvent(id, 'approved', approver, 'Task approved', {});

    // Fire-and-forget execution for executable action types
    if (task && isExecutable(task.action_type)) {
      // Don't await — let the HTTP response return immediately
      executeTask(task.id).catch((err) => {
        console.error(`[tasks] Background execution of ${task.id} crashed:`, err);
      });
    }

    return res.json(parseRow(task));
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Cannot')) return res.status(422).json({ error: err.message });
    console.error('[tasks] Approve error:', err);
    return res.status(500).json({ error: 'Failed to approve task.' });
  }
});

/**
 * PATCH /api/tasks/:id/reject
 */
router.patch('/:id/reject', (req, res) => {
  try {
    const { id } = req.params;
    const actor = req.session.userId;
    const { reason } = req.body;
    const task = rejectTask(id, actor, reason ?? '');
    createTaskEvent(id, 'rejected', actor, reason || 'Task rejected', {});
    return res.json(parseRow(task));
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Cannot')) return res.status(422).json({ error: err.message });
    console.error('[tasks] Reject error:', err);
    return res.status(500).json({ error: 'Failed to reject task.' });
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Body: { status, outcome?, outcome_data? }
 */
router.patch('/:id/status', (req, res) => {
  try {
    const { status, outcome, outcome_data } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required.' });

    const task = updateTaskStatus(req.params.id, status, req.session.userId, { outcome, outcome_data });
    return res.json(parseRow(task));
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Cannot')) return res.status(422).json({ error: err.message });
    console.error('[tasks] Status update error:', err);
    return res.status(500).json({ error: 'Failed to update task status.' });
  }
});

/**
 * GET /api/tasks/:id/detail
 * Returns a full task with linked signal info
 */
router.get('/:id/detail', (req, res) => {
  try {
    const { id } = req.params;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const parsed = parseRow(task);

    // Attach linked signal if present
    let signal = null;
    if (task.signal_id) {
      const sigRow = db.prepare('SELECT * FROM signals WHERE id = ?').get(task.signal_id);
      if (sigRow) {
        signal = { ...sigRow, data: sigRow.data ? JSON.parse(sigRow.data) : {} };
      }
    }

    return res.json({ ...parsed, signal });
  } catch (err) {
    console.error('[tasks] Detail error:', err);
    return res.status(500).json({ error: 'Failed to get task detail.' });
  }
});

/**
 * GET /api/tasks/:id/history
 * Returns the event history for a task
 */
router.get('/:id/history', (req, res) => {
  try {
    const { id } = req.params;
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const events = getTaskEvents(id);
    return res.json(events);
  } catch (err) {
    console.error('[tasks] History error:', err);
    return res.status(500).json({ error: 'Failed to get task history.' });
  }
});

/**
 * POST /api/tasks/:id/comment
 * Body: { content }
 * Creates a task_event of type 'commented' with actor 'human'
 */
router.post('/:id/comment', (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'content is required.' });

    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const eventId = createTaskEvent(id, 'commented', 'human', content, {});
    const event = db.prepare('SELECT * FROM task_events WHERE id = ?').get(eventId);

    return res.status(201).json({ ...event, metadata: event.metadata ? JSON.parse(event.metadata) : {} });
  } catch (err) {
    console.error('[tasks] Comment error:', err);
    return res.status(500).json({ error: 'Failed to add comment.' });
  }
});

/**
 * POST /api/tasks/:id/rollback
 * Roll back a completed write-back task (Shopify product create, etc.)
 */
/**
 * POST /api/tasks/bulk/approve
 * Body: { task_ids: [...], note? }
 * Bulk-approve proposed tasks (excludes red tier — must be approved individually).
 */
router.post('/bulk/approve', async (req, res) => {
  try {
    const { task_ids, note } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'task_ids array is required.' });
    }
    const approver = req.session.userId;
    let approved = 0, skipped = 0;
    const errors = [];

    for (const id of task_ids.slice(0, 50)) {
      try {
        const task = db.prepare('SELECT id, status, trust_tier FROM tasks WHERE id = ?').get(id);
        if (!task) { errors.push({ id, error: 'not found' }); continue; }
        if (task.status !== 'proposed') { skipped++; continue; }
        if (task.trust_tier === 'red') { skipped++; errors.push({ id, error: 'red tier — approve individually' }); continue; }

        approveTask(id, approver);
        createTaskEvent(id, 'approved', approver, note ?? 'Bulk approved', {});
        if (isExecutable(db.prepare('SELECT action_type FROM tasks WHERE id = ?').get(id)?.action_type)) {
          executeTask(id).catch(() => {});
        }
        approved++;
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    return res.json({ approved, skipped, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tasks/bulk/reject
 * Body: { task_ids: [...], reason? }
 */
router.post('/bulk/reject', (req, res) => {
  try {
    const { task_ids, reason } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'task_ids array is required.' });
    }
    const actor = req.session.userId;
    let rejected = 0;
    const errors = [];

    for (const id of task_ids.slice(0, 50)) {
      try {
        rejectTask(id, actor, reason ?? 'Bulk rejected');
        createTaskEvent(id, 'rejected', actor, reason ?? 'Bulk rejected', {});
        rejected++;
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    return res.json({ rejected, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id/rollback', async (req, res) => {
  try {
    const { id } = req.params;
    const task = db.prepare('SELECT id, status, rollback_data, action_type FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!task.rollback_data) return res.status(422).json({ error: 'No rollback data available for this task.' });

    const result = await rollbackTask(id);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[tasks] Rollback error:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
