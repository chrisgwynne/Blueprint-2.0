/**
 * Email delivery (Feature 5).
 *
 * Supports SMTP (nodemailer), Resend, Postmark, and Brevo transactional email.
 * Provider + credentials are stored in the settings table under keys:
 *   email_provider       — 'smtp' | 'resend' | 'postmark' | 'brevo'
 *   email_config_{provider} — provider-specific config (JSON)
 *   email_report_to      — recipient address
 */
import db from '../db/db.js';

// ─── Settings helpers ────────────────────────────────────────────────────────

export function getEmailProvider() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'email_provider'").get();
  if (!row) return 'smtp';
  try { return JSON.parse(row.value); } catch { return 'smtp'; }
}

export function getEmailConfig(provider) {
  const key = `email_config_${provider}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

export function saveEmailConfig(provider, config) {
  const key = `email_config_${provider}`;
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(config));
}

export function getEmailRecipient() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'email_report_to'").get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function saveEmailRecipient(email) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('email_report_to', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(email));
}

export function saveEmailProvider(provider) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('email_provider', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(provider));
}

// ─── Send ────────────────────────────────────────────────────────────────────

/**
 * Send an email through the configured provider.
 * @param {{to, subject, html, text, from?}} message
 */
export async function sendEmail({ to, subject, html, text, from }) {
  if (!to) throw new Error('sendEmail: `to` is required');
  if (!subject) throw new Error('sendEmail: `subject` is required');
  if (!html && !text) throw new Error('sendEmail: `html` or `text` required');

  const provider = getEmailProvider();
  const config = getEmailConfig(provider);
  const fromAddr = from || config.from || 'Blueprint <noreply@blueprint.local>';
  const plainText = text ?? (html ? html.replace(/<[^>]+>/g, '').trim().slice(0, 8000) : '');

  switch (provider) {
    case 'resend':   return sendViaResend({ from: fromAddr, to, subject, html, text: plainText, config });
    case 'postmark': return sendViaPostmark({ from: fromAddr, to, subject, html, text: plainText, config });
    case 'brevo':    return sendViaBrevo({ from: fromAddr, to, subject, html, text: plainText, config });
    case 'smtp':
    default:         return sendViaSMTP({ from: fromAddr, to, subject, html, text: plainText, config });
  }
}

async function sendViaSMTP({ from, to, subject, html, text, config }) {
  if (!config.host || !config.port) {
    throw new Error('SMTP config missing: host and port required');
  }
  let nodemailer;
  try {
    nodemailer = await import('nodemailer');
  } catch {
    throw new Error('nodemailer not installed. Run: bun add nodemailer');
  }
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: Number(config.port) === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  const info = await transporter.sendMail({ from, to, subject, html, text });
  return { ok: true, provider: 'smtp', id: info.messageId };
}

async function sendViaResend({ from, to, subject, html, text, config }) {
  if (!config.api_key) throw new Error('Resend api_key missing');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { ok: true, provider: 'resend', id: body.id };
}

async function sendViaPostmark({ from, to, subject, html, text, config }) {
  if (!config.api_key) throw new Error('Postmark api_key missing');
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': config.api_key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ From: from, To: to, Subject: subject, HtmlBody: html, TextBody: text }),
  });
  if (!res.ok) throw new Error(`Postmark error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { ok: true, provider: 'postmark', id: body.MessageID };
}

async function sendViaBrevo({ from, to, subject, html, text, config }) {
  if (!config.api_key) throw new Error('Brevo api_key missing');
  // Parse "Name <email>" or bare email
  const fromMatch = from.match(/^(.+?)\s*<(.+)>$/);
  const sender = fromMatch ? { name: fromMatch[1].trim(), email: fromMatch[2] } : { email: from };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.api_key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject, htmlContent: html, textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { ok: true, provider: 'brevo', id: body.messageId };
}
