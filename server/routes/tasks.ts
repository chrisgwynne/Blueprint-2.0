import { Router } from 'express';
import type { Request, Response } from 'express';
import db, { generateId, audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { createTask as _createTask, listTasks, approveTask, rejectTask, updateTaskStatus } from '../tasks/task-queue.js';
import type { TaskStatus } from '../tasks/task-queue.js';
const createTask = _createTask as unknown as (opts: Record<string, unknown>) => Record<string, unknown>;
import { createTaskEvent, getTaskEvents } from '../tasks/task-events.js';
import { rollbackTask } from '../tasks/executor.js';

const router = Router();
router.use(isAuthenticated);

function safeJSON(raw: unknown, fallback: unknown): unknown {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw as string); }
  catch {
    console.warn('[tasks] Failed to parse JSON field, using fallback. Raw:', String(raw).slice(0, 120));
    return fallback;
  }
}

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
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
router.get('/approval-policies', (req: Request, res: Response) => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'approval_policies'").get() as { value: string } | undefined;
    let policies: Record<string, unknown> = {};
    try { policies = row?.value ? JSON.parse(row.value) as Record<string, unknown> : {}; } catch {}
    return res.json({ policies });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PUT /api/tasks/approval-policies
 * Body: { policies: { default?: 'auto'|'manual', <action_type>?: 'auto'|'manual' } }
 */
router.put('/approval-policies', (req: Request, res: Response) => {
  try {
    const policies = (req.body as { policies?: unknown })?.policies ?? {};
    if (typeof policies !== 'object') return res.status(400).json({ error: 'policies must be an object' });
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('approval_policies', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(policies));
    return res.json({ ok: true, policies });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/tasks/:businessId
 * Query: view=kanban|list, status, signal_id, mission_id, page, limit
 */
router.get('/:businessId', (req: Request, res: Response) => {
  try {
    const businessId = String(req.params.businessId);
    const { view = 'list', status, signal_id, mission_id, page = '1', limit = '50' } = req.query;

    const filters = {
      status: status ? String(status) : undefined,
      signal_id: signal_id ? String(signal_id) : undefined,
      mission_id: mission_id ? String(mission_id) : undefined,
    };
    const tasks = (listTasks(businessId, filters) as unknown as Array<Record<string, unknown>>).map(parseRow);

    if (view === 'kanban') {
      const COLUMNS = ['proposed', 'approved', 'executing', 'complete', 'verified', 'failed', 'rejected'];
      const grouped: Record<string, Array<Record<string, unknown> | null>> = {};
      for (const col of COLUMNS) {
        grouped[col] = tasks.filter(t => t?.status === col);
      }
      return res.json({ view: 'kanban', columns: COLUMNS, data: grouped });
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, parseInt(String(limit), 10) || 50);
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
router.post('/', (req: Request, res: Response) => {
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
    } = req.body as Record<string, unknown>;

    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });
    if (!title) return res.status(400).json({ error: 'title is required.' });

    const session = req.session as unknown as Record<string, unknown>;
    const task = createTask({
      business_id,
      signal_id: signal_id ?? null,
      mission_id: mission_id ?? null,
      title,
      description: description ?? null,
      proposed_by: session.userId,
      action_type: action_type ?? null,
      action_payload: action_payload ?? {},
      trust_tier: trust_tier ?? 'yellow',
      priority: priority ?? 'p2',
      estimated_impact: estimated_impact ?? null,
      approval_mode: approval_mode ?? 'requires_approval',
    }) as unknown as Record<string, unknown>;

    createTaskEvent(
      task.id as string,
      'created',
      (session.userId as string) || 'human',
      `Task created manually: "${task.title as string}"`,
      { status: 'proposed', source: 'manual' }
    );

    import('../bap/webhook-dispatcher.js').then((m: any) =>
      m.dispatchWebhookEvent('task.created', {
        task_id: task.id, business_id: task.business_id, title: task.title,
        trust_tier: task.trust_tier, priority: task.priority, approval_mode: task.approval_mode,
      })
    ).catch(() => {});
    return res.status(201).json(parseRow(task));
  } catch (err) {
    console.error('[tasks] Create error:', err);
    return res.status(500).json({ error: 'Failed to create task.' });
  }
});

/**
 * PATCH /api/tasks/:id/approve
 *
 * Approves the task. approveTask() itself atomically enqueues a durable
 * execution job for executable action types (task-queue.ts) and wakes the
 * execution worker immediately for low latency — this route no longer
 * calls executeTask() directly. The HTTP response returns as soon as the
 * approval (and job creation) is committed; the frontend can poll task
 * detail, task events, or GET /api/tasks/:id/execution-job to see progress.
 */
router.patch('/:id/approve', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const session = req.session as unknown as Record<string, unknown>;
    const approver = session.userId as string;
    const task = approveTask(id, approver) as unknown as Record<string, unknown>;
    createTaskEvent(id, 'approved', approver, 'Task approved', {});

    return res.json(parseRow(task));
  } catch (err) {
    if ((err as Error).message.includes('not found')) return res.status(404).json({ error: (err as Error).message });
    if ((err as Error).message.includes('Cannot')) return res.status(422).json({ error: (err as Error).message });
    console.error('[tasks] Approve error:', err);
    return res.status(500).json({ error: 'Failed to approve task.' });
  }
});

/**
 * PATCH /api/tasks/:id/reject
 */
router.patch('/:id/reject', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const session = req.session as unknown as Record<string, unknown>;
    const actor = session.userId as string;
    const { reason } = req.body as { reason?: string };
    const task = rejectTask(id, actor, reason ?? '') as unknown as Record<string, unknown>;
    createTaskEvent(id, 'rejected', actor, reason || 'Task rejected', {});
    return res.json(parseRow(task));
  } catch (err) {
    if ((err as Error).message.includes('not found')) return res.status(404).json({ error: (err as Error).message });
    if ((err as Error).message.includes('Cannot')) return res.status(422).json({ error: (err as Error).message });
    console.error('[tasks] Reject error:', err);
    return res.status(500).json({ error: 'Failed to reject task.' });
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Body: { status, outcome?, outcome_data? }
 */
router.patch('/:id/status', (req: Request, res: Response) => {
  try {
    const { status, outcome, outcome_data } = req.body as { status?: string; outcome?: string; outcome_data?: unknown };
    if (!status) return res.status(400).json({ error: 'status is required.' });

    const session = req.session as unknown as Record<string, unknown>;
    const actor = String(session.userId ?? 'unknown');
    const task = updateTaskStatus(String(req.params.id), status as TaskStatus, actor, { outcome, outcome_data }) as unknown as Record<string, unknown>;
    return res.json(parseRow(task));
  } catch (err) {
    if ((err as Error).message.includes('not found')) return res.status(404).json({ error: (err as Error).message });
    if ((err as Error).message.includes('Cannot')) return res.status(422).json({ error: (err as Error).message });
    console.error('[tasks] Status update error:', err);
    return res.status(500).json({ error: 'Failed to update task status.' });
  }
});

/**
 * GET /api/tasks/:id/detail
 * Returns a full task with linked signal info
 */
router.get('/:id/detail', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const parsed = parseRow(task);

    // Attach linked signal if present
    let signal: Record<string, unknown> | null = null;
    if (task.signal_id) {
      const sigRow = db.prepare('SELECT * FROM signals WHERE id = ?').get(task.signal_id as string) as Record<string, unknown> | undefined;
      if (sigRow) {
        signal = { ...sigRow, data: sigRow.data ? JSON.parse(sigRow.data as string) : {} };
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
router.get('/:id/history', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
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
router.post('/:id/comment', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { content } = req.body as { content?: string };

    if (!content) return res.status(400).json({ error: 'content is required.' });

    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const eventId = createTaskEvent(id, 'commented', 'human', content, {});
    const event = db.prepare('SELECT * FROM task_events WHERE id = ?').get(eventId as string) as Record<string, unknown>;
    const taskRow = db.prepare('SELECT business_id FROM tasks WHERE id = ?').get(id) as { business_id: string } | undefined;
    import('../bap/webhook-dispatcher.js').then((m: any) =>
      m.dispatchWebhookEvent('task.comment', { task_id: id, business_id: taskRow?.business_id, comment: content })
    ).catch(() => {});
    return res.status(201).json({ ...event, metadata: event.metadata ? JSON.parse(event.metadata as string) : {} });
  } catch (err) {
    console.error('[tasks] Comment error:', err);
    return res.status(500).json({ error: 'Failed to add comment.' });
  }
});

/**
 * POST /api/tasks/bulk/approve
 * Body: { task_ids: [...], note? }
 * Bulk-approve proposed tasks (excludes red tier — must be approved individually).
 */
router.post('/bulk/approve', async (req: Request, res: Response) => {
  try {
    const { task_ids, note } = req.body as { task_ids?: string[]; note?: string };
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'task_ids array is required.' });
    }
    const session = req.session as unknown as Record<string, unknown>;
    const approver = session.userId as string;
    let approved = 0, skipped = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of task_ids.slice(0, 50)) {
      try {
        const task = db.prepare('SELECT id, status, trust_tier FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!task) { errors.push({ id, error: 'not found' }); continue; }
        if (task.status !== 'proposed') { skipped++; continue; }
        if (task.trust_tier === 'red') { skipped++; errors.push({ id, error: 'red tier — approve individually' }); continue; }

        approveTask(id, approver);
        createTaskEvent(id, 'approved', approver, note ?? 'Bulk approved', {});
        approved++;
      } catch (err) {
        errors.push({ id, error: (err as Error).message });
      }
    }

    return res.json({ approved, skipped, errors });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/tasks/bulk/reject
 * Body: { task_ids: [...], reason? }
 */
router.post('/bulk/reject', (req: Request, res: Response) => {
  try {
    const { task_ids, reason } = req.body as { task_ids?: string[]; reason?: string };
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'task_ids array is required.' });
    }
    const session = req.session as unknown as Record<string, unknown>;
    const actor = session.userId as string;
    let rejected = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of task_ids.slice(0, 50)) {
      try {
        rejectTask(id, actor, reason ?? 'Bulk rejected');
        createTaskEvent(id, 'rejected', actor, reason ?? 'Bulk rejected', {});
        rejected++;
      } catch (err) {
        errors.push({ id, error: (err as Error).message });
      }
    }

    return res.json({ rejected, errors });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:id/rollback', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const task = db.prepare('SELECT id, status, rollback_data, action_type FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!task.rollback_data) return res.status(422).json({ error: 'No rollback data available for this task.' });

    const result = await rollbackTask(id) as Record<string, unknown>;
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[tasks] Rollback error:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
