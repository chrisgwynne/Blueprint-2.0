import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set. Must be a 64-character hex string (32 bytes).');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars). Got ${key.length} bytes.`);
  }
  return key;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param text - Plaintext to encrypt
 * @returns JSON string containing { iv, tag, data } all as hex strings
 */
export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  });
}

/**
 * Decrypt a value produced by encrypt().
 * @param encrypted - JSON string with { iv, tag, data }
 * @returns Decrypted plaintext
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  let parsed: { iv: string; tag: string; data: string };
  try {
    parsed = JSON.parse(encrypted);
  } catch {
    throw new Error('Invalid encrypted payload — could not parse JSON.');
  }

  const { iv, tag, data } = parsed;
  if (!iv || !tag || !data) {
    throw new Error('Invalid encrypted payload — missing iv, tag, or data fields.');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
    { authTagLength: TAG_LENGTH }
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
