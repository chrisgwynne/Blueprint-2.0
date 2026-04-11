import db, { generateId } from '../db/db.js';
import { send as telegramSend } from './telegram.js';

/**
 * Route a notification to the correct adapter and persist it to the DB.
 *
 * @param {Object} notification
 * @param {string} notification.channel - 'telegram' | 'dashboard' | 'email'
 * @param {string} notification.severity - 'info' | 'warning' | 'alert' | 'critical'
 * @param {string} notification.title
 * @param {string} [notification.body]
 * @param {string} [notification.business_id]
 * @param {string} [notification.entity_type]
 * @param {string} [notification.entity_id]
 * @returns {Promise<{ ok: boolean, notificationId: string, error?: string }>}
 */
export async function dispatch(notification) {
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
  } catch (err) {
    console.error('[dispatcher] Failed to insert notification record:', err.message);
  }

  let result = { ok: false, error: 'Channel not configured.' };

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
  } catch (err) {
    console.error(`[dispatcher] Error dispatching to ${notification.channel}:`, err.message);
    result = { ok: false, error: err.message };
  }

  // Mark as sent if successful
  if (result.ok) {
    try {
      db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?').run(now, id);
    } catch (err) {
      console.error('[dispatcher] Failed to update sent_at:', err.message);
    }
  }

  return { ...result, notificationId: id };
}

/**
 * Fan-out a notification to multiple channels simultaneously.
 *
 * @param {string[]} channels - Array of channel names
 * @param {Object} baseNotification - Base notification object (without channel)
 * @returns {Promise<Array<{ channel, ok, error? }>>}
 */
export async function dispatchToAll(channels, baseNotification) {
  const results = await Promise.allSettled(
    channels.map(channel =>
      dispatch({ ...baseNotification, channel, id: generateId() })
    )
  );

  return results.map((result, i) => ({
    channel: channels[i],
    ok: result.status === 'fulfilled' ? result.value.ok : false,
    error: result.status === 'rejected' ? result.reason?.message : result.value?.error,
    notificationId: result.status === 'fulfilled' ? result.value.notificationId : null,
  }));
}
