import { Router } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { createTask, listTasks, approveTask, rejectTask, updateTaskStatus } from '../tasks/task-queue.js';
import { createTaskEvent, getTaskEvents } from '../tasks/task-events.js';

const router = Router();
router.use(isAuthenticated);

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    action_payload: row.action_payload ? JSON.parse(row.action_payload) : {},
    outcome_data: row.outcome_data ? JSON.parse(row.outcome_data) : null,
    rollback_data: row.rollback_data ? JSON.parse(row.rollback_data) : null,
  };
}

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
 */
router.patch('/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const approver = req.session.userId;
    const task = approveTask(id, approver);
    createTaskEvent(id, 'approved', approver, 'Task approved', {});
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

export default router;
