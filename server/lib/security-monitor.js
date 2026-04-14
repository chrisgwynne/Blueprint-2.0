/**
 * Security Monitor — Layer 4: anomalous output detection.
 *
 * Even with sanitisation (layer 1), outbound allowlisting (layer 2), and KB
 * scoping (layer 3), a sufficiently clever injection may still steer an
 * agent toward producing suspicious output. Before any agent-generated
 * content is persisted (task created, KB written, signal fired), we scan
 * it for anomalies and block high-severity ones outright.
 *
 * The monitor is deliberately noisy for high-severity patterns (unexpected
 * outbound URLs, API keys, base64 blobs, explicit exfiltration verbiage)
 * and quieter for medium-severity heuristics.
 */

import { isOutboundAllowed } from './outbound-allowlist.js';

// Terms that sign-post KB-style sensitive data in agent output. An agent
// proposing a task about "update api_key" legitimately could say those
// things, but the combination of them plus an outbound URL or base64 blob
// tips into high severity.
const SENSITIVE_TERMS = [
  'api_key', 'api-key', 'apikey',
  'secret_key', 'secret-key',
  'encryption_key', 'encryption-key',
  'private_key', 'private-key',
  'password',
  'bearer token', 'access_token', 'access-token',
  'credential', 'credentials',
  'session cookie', 'session_cookie',
];

// Explicit exfiltration verbiage. If the agent writes these verbatim in
// output, something has gone wrong.
const EXFIL_TERMS = [
  'exfiltrate',
  'leak the kb',
  'dump the kb',
  'dump the database',
  'send all kb',
  'send kb contents',
  'print the system prompt',
  'print my instructions',
  'reveal the system prompt',
  'reveal your instructions',
];

const BASE64_BLOCK_RE = /[A-Za-z0-9+/]{80,}={0,2}/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

/**
 * Scan an agent's parsed output for anomalies.
 *
 * @param {unknown} agentOutput - parsed JSON or object
 * @param {string} agentId
 * @returns {Array<{ type: string, severity: 'high' | 'medium' | 'low', value?: string, count?: number }>}
 */
export function detectAnomalousOutput(agentOutput, agentId = 'unknown') {
  const anomalies = [];
  if (agentOutput == null) return anomalies;

  let outputStr;
  try {
    outputStr = typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput);
  } catch {
    // Output is unserialisable — treat as anomaly.
    anomalies.push({ type: 'unserialisable_output', severity: 'high' });
    return anomalies;
  }
  if (!outputStr) return anomalies;

  const lower = outputStr.toLowerCase();

  // 1. URLs that are not on the outbound allowlist → high severity.
  try {
    const urls = outputStr.match(URL_RE) ?? [];
    for (const url of urls) {
      const { allowed, hostname } = isOutboundAllowed(url);
      if (!allowed) {
        anomalies.push({
          type: 'unexpected_url',
          severity: 'high',
          value: hostname ?? url.slice(0, 120),
        });
      }
    }
  } catch {}

  // 2. Long base64-looking blobs → possible exfiltration via encoded payload.
  try {
    const b64 = outputStr.match(BASE64_BLOCK_RE) ?? [];
    // Filter false positives: very common suffixes/hashes that happen to look
    // base64 but are noise (e.g. tokens already inside URLs). Only count
    // blobs that stand alone in the output.
    const suspicious = b64.filter(b => b.length >= 120);
    if (suspicious.length > 0) {
      anomalies.push({
        type: 'possible_base64_exfiltration',
        severity: 'medium',
        count: suspicious.length,
      });
    }
  } catch {}

  // 3. Sensitive terminology present in output. Medium alone; high if paired
  //    with an unexpected URL or base64 blob.
  const sensitiveHits = [];
  for (const term of SENSITIVE_TERMS) {
    if (lower.includes(term)) sensitiveHits.push(term);
  }
  if (sensitiveHits.length > 0) {
    const paired = anomalies.some(a =>
      a.type === 'unexpected_url' || a.type === 'possible_base64_exfiltration'
    );
    anomalies.push({
      type: 'sensitive_term_in_output',
      severity: paired ? 'high' : 'medium',
      value: sensitiveHits.slice(0, 5).join(', '),
    });
  }

  // 4. Explicit exfiltration phrasing → always high.
  for (const term of EXFIL_TERMS) {
    if (lower.includes(term)) {
      anomalies.push({
        type: 'explicit_exfiltration_verbiage',
        severity: 'high',
        value: term,
      });
      break;
    }
  }

  // 5. Raw sensitive data formats (API keys, JWTs, private keys) appearing
  //    directly in agent output are always high severity.
  //    Mirrors scanForSensitiveData but kept local to avoid a cycle.
  const KEY_PATTERNS = [
    /sk-ant-[a-zA-Z0-9_-]{20,}/,
    /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/,
    /gh[pousr]_[a-zA-Z0-9_-]{30,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY-----/,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  for (const re of KEY_PATTERNS) {
    if (re.test(outputStr)) {
      anomalies.push({
        type: 'credential_in_output',
        severity: 'high',
      });
      break;
    }
  }

  if (anomalies.length > 0) {
    try {
      console.warn(
        `[security:monitor] ${anomalies.length} anomaly(s) in '${agentId}' output — ` +
        anomalies.map(a => `${a.type}(${a.severity})`).join(', ')
      );
    } catch {}
  }

  return anomalies;
}

/**
 * Convenience helper — returns only the high-severity anomalies. Agent
 * runners block output when this array is non-empty.
 */
export function highSeverityAnomalies(agentOutput, agentId) {
  return detectAnomalousOutput(agentOutput, agentId).filter(a => a.severity === 'high');
}
