/**
 * Security Monitor — Layer 4: anomalous output detection.
 */

import { isOutboundAllowed } from './outbound-allowlist.js';

const SENSITIVE_TERMS = [
  'api_key', 'api-key', 'apikey',
  'secret_key', 'secret-key',
  'encryption_key', 'encryption-key',
  'private_key', 'private-key',
  'password',
  'bearer token', 'access_token', 'access-token',
  'credential', 'credentials',
  'session cookie', 'session_cookie',
] as const;

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
] as const;

const BASE64_BLOCK_RE = /[A-Za-z0-9+/]{80,}={0,2}/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

export type AnomalySeverity = 'high' | 'medium' | 'low';

export interface OutputAnomaly {
  type: string;
  severity: AnomalySeverity;
  value?: string;
  count?: number;
}

export function detectAnomalousOutput(agentOutput: unknown, agentId = 'unknown'): OutputAnomaly[] {
  const anomalies: OutputAnomaly[] = [];
  if (agentOutput == null) return anomalies;

  let outputStr: string;
  try {
    outputStr = typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput);
  } catch {
    anomalies.push({ type: 'unserialisable_output', severity: 'high' });
    return anomalies;
  }
  if (!outputStr) return anomalies;

  const lower = outputStr.toLowerCase();

  try {
    const urls = outputStr.match(URL_RE) ?? [];
    for (const url of urls) {
      const { allowed, hostname } = isOutboundAllowed(url);
      if (!allowed) {
        anomalies.push({ type: 'unexpected_url', severity: 'high', value: hostname ?? url.slice(0, 120) });
      }
    }
  } catch {}

  try {
    const b64 = outputStr.match(BASE64_BLOCK_RE) ?? [];
    const suspicious = b64.filter(b => b.length >= 120);
    if (suspicious.length > 0) {
      anomalies.push({ type: 'possible_base64_exfiltration', severity: 'medium', count: suspicious.length });
    }
  } catch {}

  const sensitiveHits: string[] = [];
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

  for (const term of EXFIL_TERMS) {
    if (lower.includes(term)) {
      anomalies.push({ type: 'explicit_exfiltration_verbiage', severity: 'high', value: term });
      break;
    }
  }

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
      anomalies.push({ type: 'credential_in_output', severity: 'high' });
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

export function highSeverityAnomalies(agentOutput: unknown, agentId?: string): OutputAnomaly[] {
  return detectAnomalousOutput(agentOutput, agentId).filter(a => a.severity === 'high');
}
