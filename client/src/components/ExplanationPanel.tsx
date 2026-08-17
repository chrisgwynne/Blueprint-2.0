/**
 * "Why did Blueprint do this?" — the reusable explanation panel (issue #60).
 *
 * One component for every explainable subject. It takes a `kind` and an
 * `id`, fetches the explanation, and renders it. It is deliberately dumb:
 * every meaning it displays (what 'missing' evidence means, what a causal
 * claim licenses, what a disposition is) comes from the server payload, so
 * the panel can never quietly disagree with the engine about what a word
 * means.
 *
 * Two rendering rules exist to stop the panel over-claiming:
 *
 *   1. A field that is not `known` renders its REASON, never a dash, a zero
 *      or an empty cell. "not stated" and "0" are different answers and the
 *      panel must never let them look alike.
 *   2. The causal claim and the limitations are rendered ABOVE the fold,
 *      not buried at the bottom. An explanation whose caveats can be
 *      scrolled past is a worse artefact than no explanation.
 *
 * Usage:
 *   <ExplanationPanel businessId={id} kind="task" subjectId={task.id} onClose={...} />
 */
import React, { useEffect, useState } from 'react'
import { X, HelpCircle, AlertTriangle, ExternalLink, Clock, ShieldAlert, GitBranch } from 'lucide-react'
import { getExplanation, type ExplanationKind } from '../lib/api.js'
// The rendering rules live in a pure, React-free module so they can be
// tested directly — see explanation-view.test.ts.
import {
  dispositionPill, qualityStyle, causalTone, alternativePill,
  renderField, fieldCitation, needsCaution,
  type ComparableFieldView as ComparableField,
} from './explanation-view.js'

interface EvidenceItem {
  key: string
  label: string
  quality: 'fresh' | 'stale' | 'degraded' | 'missing' | 'negative' | 'not_applicable'
  field: ComparableField
  source: string | null
  observed_at: string | null
  age_hours: number | null
  caveat: string | null
}

interface Explanation {
  schema_version: string
  subject: { kind: string; id: string; business_id: string; title: string; source_record: string; created_at: string | null }
  headline: string
  disposition: string
  disposition_meaning: string
  trigger: {
    kind: string; summary: string
    ref: { type: string; id: string; label: string | null } | null
    occurred_at: string | null; actor: string | null; unattributed: boolean
  }
  evidence: {
    items: EvidenceItem[]
    missing_keys: string[]; stale_keys: string[]; degraded_keys: string[]; negative_keys: string[]
    summary: string; captured_at: string | null
  }
  policy: {
    policy_id: string | null; policy_version: number | null; policy_scope: string | null
    citation: string; reconstructed_from_current: boolean
    provisions: Array<{ name: string; value: string; effect: string }>
  }
  confidence: {
    value: number | null; basis: string; interpretation: string; limitations: string[]
    degraded: boolean; degraded_reason: string | null
    causal_claim: string; causal_claim_meaning: string
  }
  alternatives: Array<{
    id: string | null; label: string; disposition: string; reason: string
    reconsider: { policy: string; expires_at: string | null } | null
    source: string | null
  }>
  action: {
    receipt_id: string | null; state: string | null; result_status: string | null
    stages: Array<{ stage: string; reached: boolean; at: string | null; by: string | null; detail: string | null }>
    blocked_by: string | null
    external: { system: string | null; id: string | null; permalink: string | null } | null
    attempts: number; anomalies: unknown[]; summary: string
  }
  outcome: { state: string | null; reason: string | null; citation: Record<string, unknown> | null; measurable: boolean; summary: string }
  links: Array<{ rel: string; label: string; id: string; href: string | null }>
  limitations: string[]
  generated_at: string
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const label: React.CSSProperties = {
  fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
}
const body: React.CSSProperties = {
  fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.6,
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ ...label, display: 'flex', alignItems: 'center', gap: 5 }}>
        {icon}{title}
      </div>
      {children}
    </div>
  )
}

function Box({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--bp-base)', borderRadius: 4,
      border: `1px solid ${tone ?? 'var(--bp-border)'}`,
    }}>{children}</div>
  )
}

/** Render a value only when it is actually known; otherwise render the reason. */
function FieldValue({ field }: { field: ComparableField }) {
  const { text, isReason } = renderField(field)
  return (
    <span style={{
      ...body,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      ...(isReason ? { color: 'var(--bp-text-3)', fontStyle: 'italic' as const } : {}),
    }}>{text}</span>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export interface ExplanationPanelProps {
  businessId: string | undefined
  kind: ExplanationKind
  subjectId: string
  onClose: () => void
}

export default function ExplanationPanel({ businessId, kind, subjectId, onClose }: ExplanationPanelProps) {
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!businessId || !subjectId) { setLoading(false); return }
    let cancelled = false
    setLoading(true); setError(null)
    getExplanation(businessId, kind, subjectId)
      .then((res: any) => { if (!cancelled) setExplanation(res?.explanation ?? null) })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Failed to load the explanation.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [businessId, kind, subjectId])

  const e = explanation

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 520, maxWidth: '100vw',
        background: 'var(--bp-surface)', borderLeft: '1px solid var(--bp-border)',
        zIndex: 70, display: 'flex', flexDirection: 'column',
        boxShadow: '-16px 0 48px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--bp-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14, color: 'var(--bp-text)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <HelpCircle size={14} /> Why did Blueprint do this?
          </span>
          <button onClick={onClose} aria-label="Close explanation" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bp-text-3)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[60, 90, 140, 100].map((h, i) => <div key={i} className="bp-skeleton" style={{ height: h, borderRadius: 6 }} />)}
            </div>
          ) : error ? (
            <Box tone="rgba(255,82,82,0.3)">
              <div style={{ ...body, color: 'var(--bp-red)' }}>{error}</div>
            </Box>
          ) : !e ? (
            <div style={{ ...body, color: 'var(--bp-text-3)', textAlign: 'center', padding: '60px 0' }}>
              No explanation exists for this item.
            </div>
          ) : (
            <>
              {/* Headline + disposition */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span className={`bp-pill ${dispositionPill(e.disposition)}`} style={{ padding: '1px 7px', fontSize: 9 }}>
                    {e.disposition.replace(/_/g, ' ')}
                  </span>
                  <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                    {e.subject.kind.replace(/_/g, ' ')} · {e.subject.source_record}
                  </span>
                </div>
                <h2 style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 15, color: 'var(--bp-text)', margin: '0 0 6px', lineHeight: 1.35 }}>
                  {e.subject.title}
                </h2>
                <div style={{ ...body }}>{e.headline}</div>
                <div style={{ ...body, color: 'var(--bp-text-3)', marginTop: 4 }}>{e.disposition_meaning}</div>
              </div>

              {/* Caution band — shown whenever the explanation is degraded,
                  has evidence holes, or had to reconstruct its policy. It
                  sits above everything so it cannot be scrolled past. */}
              {needsCaution(e) && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 18,
                  padding: '9px 11px', borderRadius: 4,
                  background: 'rgba(251,176,64,0.06)', border: '1px solid rgba(251,176,64,0.3)',
                }}>
                  <AlertTriangle size={11} style={{ color: 'var(--bp-amber)', flexShrink: 0, marginTop: 2 }} />
                  <div style={{ ...body, fontSize: 10, color: 'var(--bp-amber)' }}>
                    Read this with care: {[
                      e.confidence.degraded ? 'the decision came from a degraded path' : null,
                      e.evidence.missing_keys.length ? `${e.evidence.missing_keys.length} evidence item(s) have no record` : null,
                      e.evidence.stale_keys.length ? `${e.evidence.stale_keys.length} are out of date` : null,
                      e.evidence.degraded_keys.length ? `${e.evidence.degraded_keys.length} came from a degraded source` : null,
                      e.policy.reconstructed_from_current ? 'the policy shown had to be reconstructed' : null,
                    ].filter(Boolean).join('; ')}.
                  </div>
                </div>
              )}

              {/* Causal claim — deliberately near the top, not buried */}
              <Section title="What Blueprint can and cannot claim" icon={<ShieldAlert size={10} />}>
                <Box tone={`${causalTone(e.confidence.causal_claim)}55`}>
                  <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: causalTone(e.confidence.causal_claim), marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {e.confidence.causal_claim.replace(/_/g, ' ')}
                  </div>
                  <div style={body}>{e.confidence.causal_claim_meaning}</div>
                </Box>
              </Section>

              {/* Trigger */}
              <Section title="What triggered this" icon={<GitBranch size={10} />}>
                <Box tone={e.trigger.unattributed ? 'rgba(251,176,64,0.35)' : undefined}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <span className="bp-pill bp-pill-grey" style={{ padding: '1px 6px', fontSize: 9 }}>{e.trigger.kind.replace(/_/g, ' ')}</span>
                    {e.trigger.occurred_at && (
                      <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Clock size={9} /> {e.trigger.occurred_at}
                      </span>
                    )}
                  </div>
                  <div style={body}>{e.trigger.summary}</div>
                  {e.trigger.ref && (
                    <div style={{ ...body, color: 'var(--bp-text-3)', marginTop: 4 }}>
                      {e.trigger.ref.type}: {e.trigger.ref.label ?? e.trigger.ref.id}
                    </div>
                  )}
                </Box>
              </Section>

              {/* Evidence */}
              <Section title="Evidence used">
                <div style={{ ...body, color: 'var(--bp-text-3)', marginBottom: 8 }}>{e.evidence.summary}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {e.evidence.items.map((item) => {
                    const q = qualityStyle(item.quality)
                    return (
                      <div key={item.key} style={{
                        padding: '9px 11px', background: 'var(--bp-base)', borderRadius: 4,
                        border: '1px solid var(--bp-border)', borderLeft: `2px solid ${q.colour}`,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>{item.label}</span>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: q.colour, whiteSpace: 'nowrap' }}>{q.label}</span>
                        </div>
                        <FieldValue field={item.field} />
                        {item.caveat && (
                          <div style={{ ...body, color: q.colour, marginTop: 5, fontSize: 10 }}>{item.caveat}</div>
                        )}
                        {fieldCitation(item.field, item.source) && (
                          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 5 }}>
                            source: {fieldCitation(item.field, item.source)}
                            {item.age_hours != null && ` · ${Math.round(item.age_hours)}h old`}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Section>

              {/* Policy */}
              <Section title="Policy in effect">
                <Box tone={e.policy.reconstructed_from_current ? 'rgba(251,176,64,0.35)' : undefined}>
                  <div style={body}>{e.policy.citation}</div>
                  {e.policy.reconstructed_from_current && (
                    <div style={{ ...body, color: 'var(--bp-amber)', marginTop: 5, fontSize: 10 }}>
                      This record did not store which policy version it used, so the current policy is shown. It may not be the one that applied.
                    </div>
                  )}
                  {e.policy.provisions.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {e.policy.provisions.map((p) => (
                        <div key={p.name}>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-blue)' }}>{p.name}</span>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}> = {p.value}</span>
                          <div style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)' }}>{p.effect}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Box>
              </Section>

              {/* Confidence */}
              <Section title="Confidence and its limits">
                <Box tone={e.confidence.degraded ? 'rgba(255,159,90,0.4)' : undefined}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                    <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 18, color: e.confidence.value == null ? 'var(--bp-text-3)' : 'var(--bp-text)' }}>
                      {e.confidence.value == null ? 'not recorded' : `${Math.round(e.confidence.value * 100)}%`}
                    </span>
                    {e.confidence.degraded && (
                      <span className="bp-pill bp-pill-amber" style={{ padding: '1px 7px', fontSize: 9 }}>degraded</span>
                    )}
                  </div>
                  <div style={body}>{e.confidence.interpretation}</div>
                  {e.confidence.degraded_reason && (
                    <div style={{ ...body, color: 'var(--bp-orange)', marginTop: 5, fontSize: 10 }}>{e.confidence.degraded_reason}</div>
                  )}
                  {e.confidence.limitations.length > 0 && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 16 }}>
                      {e.confidence.limitations.map((l, i) => (
                        <li key={i} style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)' }}>{l}</li>
                      ))}
                    </ul>
                  )}
                </Box>
              </Section>

              {/* Alternatives */}
              {e.alternatives.length > 0 && (
                <Section title="Alternatives considered or suppressed">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {e.alternatives.map((alt, i) => (
                      <div key={`${alt.id ?? 'alt'}-${i}`} style={{
                        padding: '9px 11px', background: 'var(--bp-base)', borderRadius: 4, border: '1px solid var(--bp-border)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span className={`bp-pill ${alternativePill(alt.disposition)}`} style={{ padding: '1px 6px', fontSize: 9 }}>
                            {alt.disposition}
                          </span>
                          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>{alt.label}</span>
                        </div>
                        <div style={{ ...body, fontSize: 10 }}>{alt.reason}</div>
                        {alt.reconsider && (
                          <div style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
                            reconsider: {alt.reconsider.policy.replace(/_/g, ' ')}
                            {alt.reconsider.expires_at ? ` · after ${alt.reconsider.expires_at}` : ''}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Action state */}
              <Section title="What happened next">
                <Box tone={e.action.blocked_by ? 'rgba(255,82,82,0.3)' : undefined}>
                  <div style={body}>{e.action.summary}</div>
                  {e.action.stages.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {e.action.stages.map((s) => (
                        <div key={s.stage} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                          <span style={{
                            width: 7, height: 7, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                            background: s.reached ? 'var(--bp-green)' : 'var(--bp-border-2)',
                          }} />
                          <div style={{ minWidth: 0 }}>
                            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: s.reached ? 'var(--bp-text-2)' : 'var(--bp-text-3)' }}>
                              {s.stage.replace(/_/g, ' ')}
                            </span>
                            {s.at && <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}> · {s.at}</span>}
                            {s.by && <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}> · {s.by}</span>}
                            {s.detail && <div style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)' }}>{s.detail}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {e.action.blocked_by && (
                    <div style={{ ...body, color: 'var(--bp-red)', marginTop: 8, fontSize: 10 }}>
                      Blocked by: {e.action.blocked_by}
                    </div>
                  )}
                  {e.action.attempts > 1 && (
                    <div style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 5 }}>{e.action.attempts} attempts.</div>
                  )}
                  {e.action.external?.permalink && (
                    <a href={e.action.external.permalink} target="_blank" rel="noreferrer"
                      style={{ ...body, fontSize: 10, color: 'var(--bp-blue)', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                      <ExternalLink size={9} /> {e.action.external.system} {e.action.external.id}
                    </a>
                  )}
                </Box>
              </Section>

              {/* Outcome */}
              <Section title="Outcome">
                <Box>
                  {e.outcome.state && (
                    <span className="bp-pill bp-pill-grey" style={{ padding: '1px 7px', fontSize: 9, marginBottom: 6, display: 'inline-block' }}>
                      {e.outcome.state.replace(/_/g, ' ')}
                    </span>
                  )}
                  <div style={body}>{e.outcome.summary}</div>
                  {e.outcome.reason && <div style={{ ...body, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>{e.outcome.reason}</div>}
                </Box>
              </Section>

              {/* Links */}
              {e.links.length > 0 && (
                <Section title="Related records">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {e.links.map((l, i) => (
                      <span key={`${l.rel}-${l.id}-${i}`} style={{
                        fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-2)',
                        border: '1px solid var(--bp-border)', borderRadius: 3, padding: '2px 6px',
                      }}>
                        {l.rel}: {l.label}
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {/* Limitations */}
              <Section title="What this explanation cannot tell you" icon={<AlertTriangle size={10} />}>
                <Box tone="rgba(251,176,64,0.3)">
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {e.limitations.map((l, i) => (
                      <li key={i} style={{ ...body, fontSize: 10, marginBottom: 4 }}>{l}</li>
                    ))}
                  </ul>
                </Box>
              </Section>

              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                {e.schema_version} · generated {e.generated_at}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * The "Why?" affordance. A small, consistent button so the same question is
 * asked the same way everywhere it appears.
 */
export function WhyButton({ onClick, title = 'Why did Blueprint do this?' }: { onClick: () => void; title?: string }) {
  return (
    <button
      onClick={(ev) => { ev.stopPropagation(); onClick() }}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
        background: 'none', border: '1px solid var(--bp-border)', borderRadius: 3,
        padding: '2px 7px', color: 'var(--bp-text-3)',
        fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.04em',
      }}
    >
      <HelpCircle size={9} /> Why?
    </button>
  )
}
