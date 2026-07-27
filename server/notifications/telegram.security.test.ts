/**
 * Regression tests for F-05: Telegram command/callback handlers must only
 * act on messages from the operator-configured chat. Mocks global fetch
 * (no real Telegram API calls); exercises the real handler functions
 * against a real task row in the test DB.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  isAuthorizedChat,
  handleCommandInternal,
  handleCallbackInternal,
  type TelegramMessage,
  type TelegramCallbackQuery,
} from './telegram.ts';

const BIZ = 'biz_telegram_sec';
const AUTHORIZED_CHAT_ID = '111111';
const ATTACKER_CHAT_ID = '999999';

let taskId: string;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Telegram Sec', 'telegram-sec') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

beforeEach(() => {
  taskId = generateId();
  db.prepare(`
    INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, created_at)
    VALUES (?, ?, 'Sensitive task', 'test', 'proposed', 'yellow', 'requires_approval', CURRENT_TIMESTAMP)
  `).run(taskId, BIZ);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function taskStatus(): string {
  return (db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
}

describe('isAuthorizedChat', () => {
  test('rejects when no chat is configured at all (fail closed)', () => {
    expect(isAuthorizedChat('123', null)).toBe(false);
  });

  test('rejects a mismatched chat id', () => {
    expect(isAuthorizedChat(ATTACKER_CHAT_ID, AUTHORIZED_CHAT_ID)).toBe(false);
  });

  test('accepts a matching chat id, including string/number coercion', () => {
    expect(isAuthorizedChat(AUTHORIZED_CHAT_ID, AUTHORIZED_CHAT_ID)).toBe(true);
    expect(isAuthorizedChat(111111, AUTHORIZED_CHAT_ID)).toBe(true);
  });
});

describe('handleCommandInternal — /approve from an unauthorized chat is ignored', () => {
  test('an /approve command from a different chat does not approve the task', async () => {
    const message: TelegramMessage = {
      text: `/approve ${taskId}`,
      chat: { id: ATTACKER_CHAT_ID },
      from: { id: 42, username: 'attacker' },
    };
    await handleCommandInternal(message, 'fake-bot-token', AUTHORIZED_CHAT_ID, null);
    expect(taskStatus()).toBe('proposed');
  });

  test('the same command from the authorized chat does approve the task', async () => {
    const message: TelegramMessage = {
      text: `/approve ${taskId}`,
      chat: { id: AUTHORIZED_CHAT_ID },
      from: { id: 1, username: 'owner' },
    };
    await handleCommandInternal(message, 'fake-bot-token', AUTHORIZED_CHAT_ID, null);
    expect(taskStatus()).not.toBe('proposed');
  });

  test('when no chat is configured, even a "matching" undefined/null chat is rejected', async () => {
    const message: TelegramMessage = {
      text: `/approve ${taskId}`,
      chat: { id: ATTACKER_CHAT_ID },
    };
    await handleCommandInternal(message, 'fake-bot-token', null, null);
    expect(taskStatus()).toBe('proposed');
  });
});

describe('handleCallbackInternal — approve callback from an unauthorized chat is ignored', () => {
  test('a callback_query from a different chat does not approve the task', async () => {
    const callback: TelegramCallbackQuery = {
      id: 'cbq_1',
      data: `approve:${taskId}`,
      from: { id: 42, username: 'attacker' },
      message: { chat: { id: ATTACKER_CHAT_ID }, message_id: 1 },
    };
    await handleCallbackInternal(callback, 'fake-bot-token', AUTHORIZED_CHAT_ID);
    expect(taskStatus()).toBe('proposed');
  });

  test('a callback_query from the authorized chat does approve the task', async () => {
    const callback: TelegramCallbackQuery = {
      id: 'cbq_2',
      data: `approve:${taskId}`,
      from: { id: 1, username: 'owner' },
      message: { chat: { id: AUTHORIZED_CHAT_ID }, message_id: 1 },
    };
    await handleCallbackInternal(callback, 'fake-bot-token', AUTHORIZED_CHAT_ID);
    expect(taskStatus()).not.toBe('proposed');
  });

  test('the callback is still ack\'d (answerCallbackQuery called) even when unauthorized, so the Telegram client does not hang', async () => {
    let ackCalled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('answerCallbackQuery')) ackCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const callback: TelegramCallbackQuery = {
      id: 'cbq_3',
      data: `approve:${taskId}`,
      from: { id: 42, username: 'attacker' },
      message: { chat: { id: ATTACKER_CHAT_ID }, message_id: 1 },
    };
    await handleCallbackInternal(callback, 'fake-bot-token', AUTHORIZED_CHAT_ID);
    expect(ackCalled).toBe(true);
    expect(taskStatus()).toBe('proposed');
  });
});
