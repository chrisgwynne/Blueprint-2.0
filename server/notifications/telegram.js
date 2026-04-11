import db, { generateId } from '../db/db.js';
import { approveTask, rejectTask } from '../tasks/task-queue.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

const SEVERITY_ICONS = {
  info: '🔵',
  warning: '🟡',
  alert: '🟠',
  critical: '🔴',
};

const PRIORITY_LABELS = {
  p1: '🔴 P1 — Critical',
  p2: '🟡 P2 — Important',
  p3: '⚪ P3 — Nice to have',
};

/**
 * Get Telegram config for a business.
 * Reads from business settings first, falls back to env vars.
 *
 * @param {string} businessId
 * @returns {{ botToken: string|null, chatId: string|null }}
 */
export function getTelegramConfig(businessId = null) {
  if (businessId) {
    try {
      const biz = db.prepare('SELECT settings FROM businesses WHERE id = ?').get(businessId);
      if (biz?.settings) {
        const settings = JSON.parse(biz.settings);
        if (settings?.telegram?.botToken && settings?.telegram?.chatId) {
          return { botToken: settings.telegram.botToken, chatId: String(settings.telegram.chatId) };
        }
      }
    } catch {}
  }

  // Fall back to env vars
  const botToken = process.env.TELEGRAM_BOT_TOKEN || null;
  const chatId = process.env.TELEGRAM_CHAT_ID || null;
  return { botToken, chatId };
}

/**
 * Get all businesses that have Telegram configured.
 * Returns array of { businessId, businessName, botToken, chatId }
 */
function getAllTelegramConfigs() {
  try {
    const businesses = db.prepare('SELECT id, name, settings FROM businesses').all();
    const configs = [];

    for (const biz of businesses) {
      if (!biz.settings) continue;
      try {
        const settings = JSON.parse(biz.settings);
        if (settings?.telegram?.botToken && settings?.telegram?.chatId) {
          configs.push({
            businessId: biz.id,
            businessName: biz.name,
            botToken: settings.telegram.botToken,
            chatId: String(settings.telegram.chatId),
          });
        }
      } catch {}
    }

    // Also include env-var-configured bot (global) if set and not already covered
    const envToken = process.env.TELEGRAM_BOT_TOKEN;
    const envChatId = process.env.TELEGRAM_CHAT_ID;
    if (envToken && envChatId) {
      const alreadyCovered = configs.some(c => c.botToken === envToken);
      if (!alreadyCovered) {
        configs.push({ businessId: null, businessName: 'Global', botToken: envToken, chatId: envChatId });
      }
    }

    return configs;
  } catch {
    return [];
  }
}

// ─── Polling state ───────────────────────────────────────────────────────────
// Map from botToken -> last processed update_id
const updateOffsets = new Map();
let pollingInterval = null;

/**
 * Start long-polling for all configured Telegram bots.
 * Safe to call multiple times — only starts once.
 */
export function startTelegramPolling() {
  if (pollingInterval) return;

  console.log('[telegram] Starting polling loop...');

  pollingInterval = setInterval(async () => {
    const configs = getAllTelegramConfigs();
    if (configs.length === 0) return;

    for (const cfg of configs) {
      try {
        await pollBot(cfg);
      } catch (err) {
        // Silent — bot may be misconfigured
      }
    }
  }, 4000); // Poll every 4 seconds

  // Don't hold the event loop open
  if (pollingInterval?.unref) pollingInterval.unref();
}

async function pollBot({ botToken, chatId, businessId, businessName }) {
  const offset = (updateOffsets.get(botToken) ?? 0);

  const res = await fetch(`${TELEGRAM_API}${botToken}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: offset + 1, timeout: 0, limit: 10 }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return;
  const data = await res.json();
  if (!data.ok || !data.result?.length) return;

  for (const update of data.result) {
    updateOffsets.set(botToken, update.update_id);

    if (update.callback_query) {
      await handleCallbackInternal(update.callback_query, botToken);
    } else if (update.message?.text) {
      await handleCommandInternal(update.message, botToken, chatId, businessId);
    }
  }
}

async function handleCallbackInternal(callbackQuery, botToken) {
  const { id: callbackId, data, from, message } = callbackQuery;

  // Ack immediately
  await fetch(`${TELEGRAM_API}${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId }),
  }).catch(() => {});

  if (!data) return;

  const [action, taskId] = data.split(':');
  const actor = `telegram:${from?.username ?? from?.id ?? 'unknown'}`;

  try {
    if (action === 'approve') {
      const task = approveTask(taskId, actor);
      await editTelegramMessage(botToken, message.chat.id, message.message_id,
        `✅ <b>Approved</b> by ${escapeHtml(from?.username ?? 'user')}\n\n${escapeHtml(task.title)}\n<i>Task ID: ${taskId}</i>`
      );
      console.log(`[telegram] Task ${taskId} approved by ${actor}`);
    } else if (action === 'reject') {
      const task = rejectTask(taskId, actor, `Rejected via Telegram by ${from?.username ?? from?.id}`);
      await editTelegramMessage(botToken, message.chat.id, message.message_id,
        `❌ <b>Rejected</b> by ${escapeHtml(from?.username ?? 'user')}\n\n${escapeHtml(task.title)}\n<i>Task ID: ${taskId}</i>`
      );
      console.log(`[telegram] Task ${taskId} rejected by ${actor}`);
    }
  } catch (err) {
    console.error('[telegram] Callback handler error:', err.message);
    await sendRawMessage(botToken, message.chat.id, `⚠️ Could not process action: ${escapeHtml(err.message)}`).catch(() => {});
  }
}

async function handleCommandInternal(message, botToken, chatId, businessId) {
  const text = (message.text || '').trim();
  const [cmd, arg] = text.split(/\s+/);

  if (cmd === '/status') {
    const businesses = businessId
      ? db.prepare('SELECT id, name FROM businesses WHERE id = ?').all(businessId)
      : db.prepare('SELECT id, name FROM businesses').all();

    const lines = ['📊 <b>Blueprint Status</b>', ''];
    for (const biz of businesses) {
      const openSignals = db.prepare(`SELECT COUNT(*) as cnt FROM signals WHERE business_id = ? AND status = 'open'`).get(biz.id)?.cnt ?? 0;
      const pendingTasks = db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE business_id = ? AND status IN ('proposed', 'approved')`).get(biz.id)?.cnt ?? 0;
      lines.push(`<b>${escapeHtml(biz.name)}</b>`);
      lines.push(`  🚨 Open signals: ${openSignals}`);
      lines.push(`  📋 Pending tasks: ${pendingTasks}`);
    }
    await sendRawMessage(botToken, message.chat.id, lines.join('\n'));
  } else if (cmd === '/tasks') {
    const bid = businessId || (db.prepare('SELECT id FROM businesses LIMIT 1').get()?.id);
    if (!bid) return;
    const tasks = db.prepare(`SELECT id, title, priority, status FROM tasks WHERE business_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 5`).all(bid);
    if (!tasks.length) {
      await sendRawMessage(botToken, message.chat.id, '📋 No pending tasks.');
      return;
    }
    const lines = ['📋 <b>Pending Tasks</b>', ''];
    for (const t of tasks) {
      lines.push(`• <b>${escapeHtml(t.title)}</b> <i>(${t.id.slice(0, 8)})</i>`);
    }
    lines.push('', 'Reply /approve &lt;id&gt; or /reject &lt;id&gt; to act on a task.');
    await sendRawMessage(botToken, message.chat.id, lines.join('\n'));
  } else if (cmd === '/approve' && arg) {
    const actor = `telegram:${message.from?.username ?? message.from?.id ?? 'unknown'}`;
    try {
      const task = approveTask(arg, actor);
      await sendRawMessage(botToken, message.chat.id, `✅ Task <b>${escapeHtml(task.title)}</b> approved.`);
    } catch (err) {
      await sendRawMessage(botToken, message.chat.id, `⚠️ ${escapeHtml(err.message)}`);
    }
  } else if (cmd === '/reject' && arg) {
    const actor = `telegram:${message.from?.username ?? message.from?.id ?? 'unknown'}`;
    try {
      const task = rejectTask(arg, actor, 'Rejected via Telegram');
      await sendRawMessage(botToken, message.chat.id, `❌ Task <b>${escapeHtml(task.title)}</b> rejected.`);
    } catch (err) {
      await sendRawMessage(botToken, message.chat.id, `⚠️ ${escapeHtml(err.message)}`);
    }
  }
}

// ─── Message senders ─────────────────────────────────────────────────────────

async function sendRawMessage(botToken, chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    });
    const data = await res.json();
    return data.ok ? { ok: true, messageId: data.result?.message_id } : { ok: false, error: data.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a message to a Telegram chat.
 * Resolves bot token + chat ID from businessId or env vars.
 *
 * @param {string} chatId - Override chat ID (or pass null to use configured)
 * @param {string} text - HTML-formatted message text
 * @param {Array|null} inlineKeyboard - Optional inline keyboard buttons
 * @param {string} businessId - Business ID to look up config
 */
export async function sendMessage(chatId, text, inlineKeyboard = null, businessId = null) {
  const { botToken, chatId: defaultChatId } = getTelegramConfig(businessId);
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');

  const targetChatId = chatId || defaultChatId;
  if (!targetChatId) throw new Error('TELEGRAM_CHAT_ID is not configured.');

  const body = {
    chat_id: targetChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  return sendRawMessage(botToken, targetChatId, text, inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {});
}

/**
 * Send a notification message.
 */
export async function send(notification, chatId = null, businessId = null) {
  const { botToken, chatId: defaultChatId } = getTelegramConfig(businessId ?? notification.business_id);
  if (!botToken || !defaultChatId) return { ok: false, error: 'Telegram not configured' };

  const targetChatId = chatId || defaultChatId;
  const icon = SEVERITY_ICONS[notification.severity] ?? '⚪';

  const text = [
    `${icon} <b>${escapeHtml(notification.title)}</b>`,
    '',
    notification.body ? escapeHtml(notification.body) : '',
    '',
    notification.entity_type
      ? `<i>Type: ${notification.entity_type} | ID: ${notification.entity_id ?? 'N/A'}</i>`
      : '',
    `<i>${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</i>`,
  ].filter(Boolean).join('\n').trim();

  return sendRawMessage(botToken, targetChatId, text);
}

/**
 * Send a task approval request with inline Approve/Reject buttons.
 */
export async function sendApprovalRequest(task, business, chatId = null) {
  const businessId = business?.id ?? task?.business_id ?? null;
  const { botToken, chatId: defaultChatId } = getTelegramConfig(businessId);
  if (!botToken || !defaultChatId) return { ok: false, error: 'Telegram not configured' };

  const targetChatId = chatId || defaultChatId;

  const trustLabel = {
    green: '🟢 Green (auto-execute if approved)',
    yellow: '🟡 Yellow (manual approval required)',
    red: '🔴 Red (high-risk, requires approval)',
  }[task.trust_tier] ?? '⚪ Unknown';

  const text = [
    `⚡ <b>Task Approval Required</b>`,
    business ? `<b>${escapeHtml(business.name)}</b>` : '',
    '',
    `📋 <b>${escapeHtml(task.title)}</b>`,
    '',
    task.description ? escapeHtml(task.description) : '',
    '',
    `🔒 Trust tier: ${trustLabel}`,
    `${PRIORITY_LABELS[task.priority] ?? task.priority}`,
    task.confidence !== null ? `📊 Confidence: ${Math.round((task.confidence ?? 0) * 100)}%` : '',
    task.estimated_impact ? `💡 Expected impact: ${escapeHtml(task.estimated_impact)}` : '',
    task.action_type ? `⚙️ Action type: ${task.action_type}` : '',
    '',
    `<i>Task ID: ${task.id}</i>`,
    `<i>Proposed by: ${task.proposed_by}</i>`,
  ].filter(Boolean).join('\n');

  const inlineKeyboard = [[
    { text: '✅ Approve', callback_data: `approve:${task.id}` },
    { text: '❌ Reject', callback_data: `reject:${task.id}` },
  ]];

  return sendRawMessage(botToken, targetChatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function editTelegramMessage(botToken, chatId, messageId, text) {
  try {
    await fetch(`${TELEGRAM_API}${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  } catch {}
}

/**
 * Webhook route handler (for production/hosted environments).
 * Mount this on POST /api/telegram/webhook
 */
export async function webhookHandler(req, res) {
  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update) return;

  // For webhook mode, we don't know which business this is for
  // unless the bot token identifies it. Use global config as fallback.
  const { botToken, chatId } = getTelegramConfig(null);

  if (update.callback_query) {
    await handleCallbackInternal(update.callback_query, botToken).catch(err => {
      console.error('[telegram] webhook callback error:', err.message);
    });
  } else if (update.message) {
    await handleCommandInternal(update.message, botToken, chatId, null).catch(err => {
      console.error('[telegram] webhook command error:', err.message);
    });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
