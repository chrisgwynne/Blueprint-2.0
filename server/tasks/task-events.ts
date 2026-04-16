import db, { generateId } from '../db/db.js';

export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: string;
  actor: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Record an event in the task timeline.
 * @param taskId
 * @param eventType - created|approved|rejected|executing|complete|failed|commented|agent_note|status_changed
 * @param actor - agent id, 'human', or 'system'
 * @param content - human-readable description
 * @param metadata - structured data
 */
export function createTaskEvent(
  taskId: string,
  eventType: string,
  actor: string,
  content: string,
  metadata: Record<string, unknown> = {}
): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO task_events (id, task_id, event_type, actor, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, taskId, eventType, actor, content, JSON.stringify(metadata));
  return id;
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  const rows = db.prepare(`
    SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC
  `).all(taskId) as Array<Omit<TaskEvent, 'metadata'> & { metadata: string | null }>;
  return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
}
