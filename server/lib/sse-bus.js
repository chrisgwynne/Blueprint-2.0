/**
 * Minimal in-process SSE event bus for dashboard real-time updates.
 *
 * Used by workflows (step started/complete, approval needed), agent panel
 * (agent_run_started/complete/failed), chat, and timeline.
 *
 * Scoped per business — clients subscribe to one business at a time.
 * Events are fire-and-forget; if there are no subscribers, they are dropped.
 */
import { EventEmitter } from 'events';

const emitters = new Map();

function getEmitter(businessId) {
  if (!emitters.has(businessId)) {
    const em = new EventEmitter();
    em.setMaxListeners(50);
    emitters.set(businessId, em);
  }
  return emitters.get(businessId);
}

/**
 * Push an event to all subscribers of a business.
 * @param {string} businessId
 * @param {string} type - event name, e.g. 'workflow_started'
 * @param {object} data
 */
export function pushDashboardEvent(businessId, type, data) {
  if (!businessId) return;
  const em = getEmitter(businessId);
  em.emit('event', { type, data, ts: new Date().toISOString() });
}

/**
 * Subscribe a handler to events for a business.
 * Returns an unsubscribe function.
 */
export function subscribe(businessId, handler) {
  const em = getEmitter(businessId);
  em.on('event', handler);
  return () => em.off('event', handler);
}

/**
 * Express SSE handler. Mounts on GET /api/dashboard/stream/:businessId.
 */
export function sseHandler(req, res) {
  const { businessId } = req.params;
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Initial comment so browsers open the stream
  res.write(': connected\n\n');

  const handler = (evt) => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); }
    catch {}
  };
  const unsub = subscribe(businessId, handler);

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
}
