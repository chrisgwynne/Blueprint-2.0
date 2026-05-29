/**
 * Shared connector credential loader.
 *
 * Single source of truth for "find a connected connector for this business and
 * decrypt its credentials". Used by the task executor and the agent tool-loop
 * registry so credential-decrypt logic is never duplicated. Credentials are
 * stored AES-256-GCM encrypted (see server/crypto.ts) and decrypted here only.
 */
import db from '../db/db.js';
import { decrypt } from '../crypto.js';

export interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  credentials?: string | null;
  config?: string | null;
  status?: string;
}

export interface LoadedConnector {
  connector: ConnectorRow;
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Load + decrypt credentials for the (single) connected connector of `type`
 * belonging to `businessId`. Throws a clear, regex-matchable error
 * ("No connected <type> connector found") if none is connected — callers and
 * the executor's blocked-status detection rely on that exact wording.
 */
export function loadConnectorByType(businessId: string, type: string): LoadedConnector {
  const row = db.prepare(
    `SELECT id, type, name, credentials, config, status FROM connectors
     WHERE business_id = ? AND type = ? AND status = 'connected'
     LIMIT 1`
  ).get(businessId, type) as ConnectorRow | null;
  if (!row) {
    throw new Error(`No connected ${type} connector found for this business. Add it under Connectors → +.`);
  }
  let credentials: Record<string, string> = {};
  try {
    if (row.credentials) credentials = safeParse<Record<string, string>>(decrypt(row.credentials), {});
  } catch (err) {
    throw new Error(`Failed to decrypt ${type} credentials: ${(err as Error).message}`);
  }
  const config = safeParse<Record<string, unknown>>(row.config, {});
  return { connector: row, credentials, config };
}
