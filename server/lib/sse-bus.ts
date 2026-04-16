/**
 * Minimal in-process SSE event bus for dashboard real-time updates.
 */

import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

interface SSEEvent {
  type: string;
  data: unknown;
  ts: string;
}

type SSEHandler = (evt: SSEEvent) => void;

const emitters = new Map<string, EventEmitter>();

function getEmitter(businessId: string): EventEmitter {
  if (!emitters.has(businessId)) {
    const em = new EventEmitter();
    em.setMaxListeners(50);
    emitters.set(businessId, em);
  }
  return emitters.get(businessId)!;
}

export function pushDashboardEvent(businessId: string, type: string, data: unknown): void {
  if (!businessId) return;
  const em = getEmitter(businessId);
  em.emit('event', { type, data, ts: new Date().toISOString() } satisfies SSEEvent);
}

export function subscribe(businessId: string, handler: SSEHandler): () => void {
  const em = getEmitter(businessId);
  em.on('event', handler);
  return () => em.off('event', handler);
}

export function sseHandler(req: Request, res: Response): void {
  const { businessId } = req.params as { businessId?: string };
  if (!businessId) {
    res.status(400).json({ error: 'businessId required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  res.write(': connected\n\n');

  const handler: SSEHandler = (evt) => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); }
    catch {}
  };
  const unsub = subscribe(businessId, handler);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
}
