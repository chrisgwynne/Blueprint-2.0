/**
 * Presentation rules for the explanation panel (issue #60).
 *
 * Pure and React-free, so the rules that decide what the operator actually
 * SEES can be tested directly. The panel is only allowed to be as honest as
 * these functions are, and every one of them exists to stop a specific way
 * a UI can quietly over-claim:
 *
 *   renderField      a field that is not `known` renders its REASON. Never
 *                    a dash, never an empty cell, and above all never a 0 —
 *                    "not stated" and "zero" must not look alike.
 *   qualityStyle     `missing` (a gap in what we know) and `negative` (a
 *                    real finding that the answer is no) get different
 *                    colours and different words, because conflating them
 *                    is how absence of evidence becomes evidence of absence.
 *   dispositionPill  a no-op, a suppression and a deferral get their own
 *                    visual treatment rather than rendering as "nothing".
 *   causalTone       the causal claim drives the colour, so a correlational
 *                    result can never be painted as a verified one.
 */

// ─── Types (mirror server/explain/explanation.ts) ───────────────────────────

export interface ComparableFieldView {
  state: 'known' | 'unknown' | 'not_comparable'
  value: unknown
  citation: string | null
  reason: string | null
}

export type EvidenceQuality =
  'fresh' | 'stale' | 'degraded' | 'missing' | 'negative' | 'not_applicable'

export type ExplanationDisposition =
  'acted' | 'in_progress' | 'awaiting_decision' | 'no_op' | 'suppressed' | 'deferred' | 'rejected' | 'failed'

export type CausalClaim =
  'verified_causal' | 'correlational' | 'expected_only' | 'not_established'

// ─── Rules ──────────────────────────────────────────────────────────────────

const DISPOSITION_PILL: Record<string, string> = {
  acted: 'bp-pill-green',
  in_progress: 'bp-pill-blue',
  awaiting_decision: 'bp-pill-amber',
  no_op: 'bp-pill-grey',
  suppressed: 'bp-pill-purple',
  deferred: 'bp-pill-grey',
  rejected: 'bp-pill-red',
  failed: 'bp-pill-red',
}

export function dispositionPill(disposition: string): string {
  return DISPOSITION_PILL[disposition] ?? 'bp-pill-grey'
}

/**
 * `missing` is amber, not red: a gap in what we know is not a failure.
 * `negative` is blue, because a recorded "no" is a genuine finding. The two
 * must never share a colour or a word.
 */
const QUALITY_STYLE: Record<EvidenceQuality, { colour: string; label: string }> = {
  fresh: { colour: 'var(--bp-green)', label: 'recorded' },
  stale: { colour: 'var(--bp-amber)', label: 'out of date' },
  degraded: { colour: 'var(--bp-orange)', label: 'degraded source' },
  missing: { colour: 'var(--bp-amber)', label: 'no record' },
  negative: { colour: 'var(--bp-blue)', label: 'negative finding' },
  not_applicable: { colour: 'var(--bp-text-3)', label: 'not applicable' },
}

export function qualityStyle(quality: string): { colour: string; label: string } {
  return QUALITY_STYLE[quality as EvidenceQuality] ?? QUALITY_STYLE.not_applicable
}

const CAUSAL_TONE: Record<CausalClaim, string> = {
  verified_causal: 'var(--bp-green)',
  correlational: 'var(--bp-amber)',
  expected_only: 'var(--bp-amber)',
  not_established: 'var(--bp-text-3)',
}

export function causalTone(claim: string): string {
  return CAUSAL_TONE[claim as CausalClaim] ?? 'var(--bp-text-3)'
}

export function alternativePill(disposition: string): string {
  if (disposition === 'suppressed') return 'bp-pill-purple'
  if (disposition === 'gated') return 'bp-pill-amber'
  return 'bp-pill-grey'
}

export interface RenderedField {
  /** The text to display. */
  text: string
  /**
   * True when the text is an explanation of ABSENCE rather than a value.
   * The panel renders these italic and muted so a reason can never be
   * mistaken for data.
   */
  isReason: boolean
}

/**
 * The single rule that keeps the panel honest about what it does not know.
 *
 * A field is rendered as a value ONLY when its state is `known`. Everything
 * else renders the recorded reason — so a missing financial exposure reads
 * "not stated on the task", never "0", and never "—".
 */
export function renderField(field: ComparableFieldView | null | undefined): RenderedField {
  if (!field || field.state !== 'known') {
    return { text: field?.reason ?? 'Not recorded.', isReason: true }
  }
  const v = field.value
  if (typeof v === 'string') return { text: v, isReason: false }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), isReason: false }
  if (v === null || v === undefined) {
    // A 'known' field with no value is a contradiction the server should
    // never emit; the panel refuses to invent a rendering for it rather
    // than showing a blank that reads as "nothing to report".
    return { text: field.reason ?? 'Recorded, but the value is missing.', isReason: true }
  }
  return { text: JSON.stringify(v, null, 2), isReason: false }
}

/** Short attribution line for the field, or null when nothing cited it. */
export function fieldCitation(field: ComparableFieldView | null | undefined, source: string | null): string | null {
  const cite = field?.state === 'known' ? field.citation : null
  return cite ?? source ?? null
}

/**
 * Whether the panel must show a prominent warning band. True whenever the
 * explanation is degraded, has evidence holes, or cites a policy it had to
 * reconstruct — the three cases where a reader would otherwise take the
 * panel at more than face value.
 */
export function needsCaution(input: {
  confidence: { degraded: boolean }
  evidence: { missing_keys: string[]; stale_keys: string[]; degraded_keys: string[] }
  policy: { reconstructed_from_current: boolean }
}): boolean {
  return input.confidence.degraded
    || input.policy.reconstructed_from_current
    || input.evidence.missing_keys.length > 0
    || input.evidence.stale_keys.length > 0
    || input.evidence.degraded_keys.length > 0
}
