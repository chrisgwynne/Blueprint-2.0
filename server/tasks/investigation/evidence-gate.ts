/**
 * Investigation Evidence Gate (issue #43)
 *
 * `executeInvestigation()` used to trust the LLM's self-reported confidence
 * and recommendation unconditionally: a single-shot investigation over
 * whatever metrics happened to already be in the DB could claim high
 * `primary_confidence` and still get marked `complete`, even when the task
 * explicitly required specific external evidence (an exact landing-page
 * URL, an HTTP status/redirect chain, canonical consistency, product
 * availability, a Merchant Center/Shopify mapping, ...) that was never
 * actually collected — and even when the model's own recommendation was
 * `investigate_further`.
 *
 * This module is the gate that closes that hole:
 *   1. parseRequiredEvidence()   — reads the task's description/acceptance
 *      criteria and extracts which evidence categories it demands.
 *   2. assessEvidenceCoverage()  — checks, against data Blueprint actually
 *      gathered (real connector-sourced metrics, real theme file reads —
 *      never the LLM's own prose), which of those categories were verified.
 *   3. capConfidenceToEvidence() — confidence can never exceed what the
 *      evidence coverage supports.
 *   4. decideCompletionGate()    — refuses `complete` when required evidence
 *      is missing, especially when the model's own recommendation concedes
 *      more investigation is needed (self-contradictory otherwise).
 *   5. spawnEvidenceGapTask()    — creates an explicit, blocked-on-evidence
 *      follow-up rather than silently completing.
 *   6. sanitiseEvidenceValue()   — strips query strings from URLs before
 *      anything gets persisted to outcome_data or the KB.
 */
import db, { generateId } from '../../db/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RequiredEvidenceItem {
  key: string;
  label: string;
  matched_text: string;
}

export interface EvidenceCheck {
  key: string;
  label: string;
  verified: boolean;
  detail: string;
  source: string | null;
  observed_at: string | null;
}

export interface EvidenceCoverage {
  required: RequiredEvidenceItem[];
  checks: EvidenceCheck[];
  verifiedCount: number;
  requiredCount: number;
  coverageRatio: number;
  missing: EvidenceCheck[];
}

export interface EvidenceGateContext {
  current_metrics?: Record<string, Record<string, { value?: unknown; data?: unknown; recorded_at?: string }>>;
  theme_files?: Record<string, string> | null;
  relevant_connectors?: string[];
}

interface EvidenceTaskLike {
  title?: string | null;
  description?: string | null;
}

interface EvidenceParentTask {
  id: string;
  business_id: string;
  title: string;
  signal_id?: string | null;
  project_id?: string | null;
}

// ─── Evidence category dictionary ──────────────────────────────────────────────

interface EvidenceCategory {
  key: string;
  label: string;
  /** Phrases in the task text that make this evidence mandatory. */
  patterns: RegExp[];
  /** Human-readable name of the evidence source that would satisfy this check. */
  evidenceSource: string;
  /** Real (non-LLM-claimed) signal that proves this evidence was gathered. */
  isSatisfied: (ctx: EvidenceGateContext) => boolean;
}

function hasNonEmptyMetrics(ctx: EvidenceGateContext, connectorTypes: string[]): boolean {
  const metrics = ctx.current_metrics ?? {};
  return connectorTypes.some((type) => {
    const m = metrics[type];
    return !!m && Object.keys(m).length > 0;
  });
}

function hasThemeFiles(ctx: EvidenceGateContext): boolean {
  return !!ctx.theme_files && Object.keys(ctx.theme_files).length > 0;
}

const EVIDENCE_CATEGORIES: EvidenceCategory[] = [
  {
    key: 'landing_page_url',
    label: 'Exact landing-page URL',
    patterns: [/landing[- ]page url/i, /exact url/i, /final url/i, /destination url/i, /specific url/i],
    evidenceSource: 'gsc/pagespeed/theme',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['gsc', 'pagespeed']) || hasThemeFiles(ctx),
  },
  {
    key: 'http_status',
    label: 'HTTP status / redirect chain',
    patterns: [/http status/i, /status code/i, /redirect chain/i, /redirects?\b/i, /3\d\d\s+redirect/i],
    evidenceSource: 'gsc/pagespeed/server-access',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['gsc', 'pagespeed', 'server-access']),
  },
  {
    key: 'canonical_consistency',
    label: 'Canonical tag consistency',
    patterns: [/canonical/i],
    evidenceSource: 'gsc/theme',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['gsc']) || hasThemeFiles(ctx),
  },
  {
    key: 'product_availability',
    label: 'Product availability',
    patterns: [/product availab/i, /in[- ]stock/i, /out[- ]of[- ]stock/i, /\bavailability\b/i],
    evidenceSource: 'shopify',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['shopify']),
  },
  {
    key: 'merchant_mapping',
    label: 'Merchant Center / Shopify product mapping',
    patterns: [/merchant center/i, /merchant feed/i, /shopify (?:product )?mapping/i, /product feed/i, /\bgtin\b/i, /\bmpn\b/i, /sku mapping/i],
    evidenceSource: 'shopify',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['shopify']),
  },
  {
    key: 'api_resource_id',
    label: 'API resource ID confirmation',
    patterns: [/resource id/i, /product id/i, /listing id/i, /\bapi id\b/i],
    evidenceSource: 'shopify/gsc',
    isSatisfied: (ctx) => hasNonEmptyMetrics(ctx, ['shopify', 'gsc']),
  },
];

// ─── 1. Parse required evidence from the task ──────────────────────────────────

export function parseRequiredEvidence(task: EvidenceTaskLike): RequiredEvidenceItem[] {
  const text = `${task.title ?? ''}\n${task.description ?? ''}`;
  const required: RequiredEvidenceItem[] = [];
  for (const category of EVIDENCE_CATEGORIES) {
    for (const pattern of category.patterns) {
      const match = text.match(pattern);
      if (match) {
        required.push({ key: category.key, label: category.label, matched_text: match[0] });
        break;
      }
    }
  }
  return required;
}

// ─── 2. Assess coverage against real gathered evidence ─────────────────────────

export function assessEvidenceCoverage(
  required: RequiredEvidenceItem[],
  context: EvidenceGateContext
): EvidenceCoverage {
  const observedAt = new Date().toISOString();
  const checks: EvidenceCheck[] = required.map((req) => {
    const category = EVIDENCE_CATEGORIES.find((c) => c.key === req.key);
    const verified = category ? category.isSatisfied(context) : false;
    return {
      key: req.key,
      label: req.label,
      verified,
      detail: verified
        ? `Backed by real ${category!.evidenceSource} data gathered during this investigation.`
        : `Required by the task ("${req.matched_text}") but no ${category?.evidenceSource ?? 'external'} evidence was collected — this investigation only had pre-existing internal metrics available.`,
      source: verified ? category!.evidenceSource : null,
      observed_at: verified ? observedAt : null,
    };
  });

  const verifiedCount = checks.filter((c) => c.verified).length;
  const requiredCount = checks.length;
  return {
    required,
    checks,
    verifiedCount,
    requiredCount,
    coverageRatio: requiredCount === 0 ? 1 : verifiedCount / requiredCount,
    missing: checks.filter((c) => !c.verified),
  };
}

// ─── 3. Confidence must be constrained by evidence provenance ──────────────────

export interface ConfidenceCapResult {
  confidence: number | null;
  capped: boolean;
  cap: number;
}

/**
 * No direct URL/page/feed comparison performed (coverage 0) caps confidence
 * well below the 0.85 seen in the reported bug. Full coverage relaxes the
 * cap close to (but never above) 1, so a fully-evidenced investigation can
 * still report high confidence.
 */
export function capConfidenceToEvidence(
  rawConfidence: number | null | undefined,
  coverage: EvidenceCoverage
): ConfidenceCapResult {
  const raw = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) ? rawConfidence : null;

  // No specific external evidence was demanded by the task — nothing to cap.
  if (coverage.requiredCount === 0) {
    return { confidence: raw, capped: false, cap: 1 };
  }

  const cap = Math.round((0.3 + 0.65 * coverage.coverageRatio) * 100) / 100;
  if (raw == null) return { confidence: null, capped: false, cap };
  if (raw > cap) return { confidence: cap, capped: true, cap };
  return { confidence: raw, capped: false, cap };
}

// ─── 4. Completion gate ─────────────────────────────────────────────────────────

export interface CompletionGateResult {
  canComplete: boolean;
  finalStatus: 'complete' | 'blocked' | 'manual_review';
  reason: string | null;
}

export function decideCompletionGate(params: {
  recommendation: string | null | undefined;
  coverage: EvidenceCoverage;
}): CompletionGateResult {
  const { recommendation, coverage } = params;

  if (coverage.missing.length === 0) {
    return { canComplete: true, finalStatus: 'complete', reason: null };
  }

  const missingLabels = coverage.missing.map((m) => m.label).join(', ');

  // Self-contradictory: the investigation itself says more work is needed,
  // yet the evidence that would justify closing it out was never gathered.
  if (recommendation === 'investigate_further') {
    return {
      canComplete: false,
      finalStatus: 'manual_review',
      reason: `Recommendation was 'investigate_further' and required evidence was never collected (${missingLabels}) — cannot complete on unsupported confidence.`,
    };
  }

  return {
    canComplete: false,
    finalStatus: 'blocked',
    reason: `Required evidence not collected: ${missingLabels}.`,
  };
}

// ─── 5. Explicit follow-up when evidence is missing ─────────────────────────────

export function spawnEvidenceGapTask(parentTask: EvidenceParentTask, missing: EvidenceCheck[]): { id: string } {
  const id = generateId() as string;
  const bulletList = missing.map((m) => `- ${m.label}`).join('\n');

  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, description, status,
      proposed_by, trust_tier, priority, action_type,
      parent_task_id, signal_id, project_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 'proposed',
      'conductor:investigation', 'green', 'p2', 'deep_investigation',
      ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(
    id,
    parentTask.business_id,
    `Gather missing evidence: ${parentTask.title}`,
    `The investigation "${parentTask.title}" could not reach a supportable conclusion because required ` +
      `evidence was never collected:\n\n${bulletList}\n\n` +
      `This follow-up exists specifically to gather that evidence (using the read-only tool loop) before ` +
      `any conclusion on the original task is trusted.`,
    parentTask.id,
    parentTask.signal_id ?? null,
    parentTask.project_id ?? null
  );

  return { id };
}

// ─── 6. Sanitise evidence before persistence ────────────────────────────────────

// Matches a URL-like token immediately followed by a `?query=string` and
// captures everything up to (not including) the `?`. Deliberately requires
// at least one query-string-shaped character right after `?` so ordinary
// prose ending in a question mark is left untouched.
const URL_QUERY_STRING = /([^\s"'<>()]+)\?([\w%.\-=&+:]+)/g;

function stripQueryStrings(value: string): string {
  return value.replace(URL_QUERY_STRING, '$1');
}

/**
 * Recursively strips query strings from any URL-shaped substrings before
 * evidence is written to outcome_data or the KB. Query parameters can carry
 * session tokens, discount codes, tracking IDs, etc. — sensitive enough that
 * they should never be persisted just because an LLM echoed them back.
 */
export function sanitiseEvidenceValue<T>(value: T): T {
  if (typeof value === 'string') {
    return stripQueryStrings(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitiseEvidenceValue(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitiseEvidenceValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
