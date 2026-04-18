import db, { generateId } from '../db/db.js';
import { send as telegramSend } from './telegram.js';

interface Notification {
  id?: string;
  channel: string;
  severity: string;
  title: string;
  body?: string;
  business_id?: string;
  entity_type?: string;
  entity_id?: string;
}

interface DispatchResult {
  ok: boolean;
  notificationId: string;
  error?: string;
}

/**
 * Route a notification to the correct adapter and persist it to the DB.
 */
export async function dispatch(notification: Notification): Promise<DispatchResult> {
  const id = notification.id ?? generateId();
  const now = new Date().toISOString();

  // Insert notification record
  try {
    db.prepare(`
      INSERT OR IGNORE INTO notifications
        (id, business_id, channel, severity, title, body, entity_type, entity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      notification.business_id ?? null,
      notification.channel,
      notification.severity,
      notification.title,
      notification.body ?? null,
      notification.entity_type ?? null,
      notification.entity_id ?? null,
      now
    );
  } catch (err: any) {
    console.error('[dispatcher] Failed to insert notification record:', err.message);
  }

  let result: { ok: boolean; error?: string } = { ok: false, error: 'Channel not configured.' };

  try {
    switch (notification.channel) {
      case 'telegram': {
        const isTelegramEnabled = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
        if (!isTelegramEnabled) {
          result = { ok: false, error: 'Telegram not configured.' };
          break;
        }
        result = await telegramSend(notification);
        break;
      }

      case 'dashboard': {
        // Dashboard notifications are stored in DB only (polled by frontend)
        result = { ok: true };
        break;
      }

      case 'email': {
        // Email adapter — not yet implemented
        console.warn('[dispatcher] Email channel not yet implemented.');
        result = { ok: false, error: 'Email channel not implemented.' };
        break;
      }

      default: {
        console.warn(`[dispatcher] Unknown notification channel: ${notification.channel}`);
        result = { ok: false, error: `Unknown channel: ${notification.channel}` };
      }
    }
  } catch (err: any) {
    console.error(`[dispatcher] Error dispatching to ${notification.channel}:`, err.message);
    result = { ok: false, error: err.message };
  }

  // Mark as sent if successful
  if (result.ok) {
    try {
      db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?').run(now, id);
    } catch (err: any) {
      console.error('[dispatcher] Failed to update sent_at:', err.message);
    }
  }

  return { ...result, notificationId: id };
}

/**
 * Fan-out a notification to multiple channels simultaneously.
 */
export async function dispatchToAll(
  channels: string[],
  baseNotification: Omit<Notification, 'channel' | 'id'>
): Promise<Array<{ channel: string; ok: boolean; error?: string; notificationId: string | null }>> {
  const results = await Promise.allSettled(
    channels.map(channel =>
      dispatch({ ...baseNotification, channel, id: generateId() })
    )
  );

  return results.map((result, i) => ({
    channel: channels[i]!,
    ok: result.status === 'fulfilled' ? result.value.ok : false,
    error: result.status === 'rejected' ? result.reason?.message : result.value?.error,
    notificationId: result.status === 'fulfilled' ? result.value.notificationId : null,
  }));
}
