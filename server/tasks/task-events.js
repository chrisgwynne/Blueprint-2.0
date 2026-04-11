import db, { generateId } from '../db/db.js';

/**
 * Record an event in the task timeline.
 * @param {string} taskId
 * @param {string} eventType - created|approved|rejected|executing|complete|failed|commented|agent_note|status_changed
 * @param {string} actor - agent id, 'human', or 'system'
 * @param {string} content - human-readable description
 * @param {object} metadata - structured data
 */
export function createTaskEvent(taskId, eventType, actor, content, metadata = {}) {
  const id = generateId();
  db.prepare(`
    INSERT INTO task_events (id, task_id, event_type, actor, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, taskId, eventType, actor, content, JSON.stringify(metadata));
  return id;
}

export function getTaskEvents(taskId) {
  const rows = db.prepare(`
    SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC
  `).all(taskId);
  return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : {} }));
}
