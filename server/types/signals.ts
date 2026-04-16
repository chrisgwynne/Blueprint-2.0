// ─── Signal rule and detection types ─────────────────────────────────────────

import type { SignalSeverity } from './db.js';

/** A signal rule definition from server/signals/rules.js */
export interface SignalRule {
  id: string;
  name: string;
  description: string;
  severity: SignalSeverity;
  connectors: string[];
  /** Check function: returns a match or null if no signal */
  check(data: unknown, context: SignalRuleContext): SignalMatch | null;
}

export interface SignalRuleContext {
  business_id: string;
  connector_id: string;
  connector_type: string;
  previous_data?: unknown;
  settings?: Record<string, unknown>;
}

export interface SignalMatch {
  rule_id: string;
  title: string;
  description?: string;
  severity: SignalSeverity;
  data: Record<string, unknown>;
  confidence?: number;
}

/** Output shape from the AI signal analysis (server/signals/ai-analysis.js) */
export interface AISignalAnalysis {
  signals: Array<{
    rule_id: string;
    title: string;
    description: string;
    severity: SignalSeverity;
    confidence: number;
    data: Record<string, unknown>;
  }>;
  summary?: string;
  recommendations?: string[];
}
