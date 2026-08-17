/**
 * Executive command centre (#59) — the cross-business decision view.
 *
 * Every number on this page is computed server-side in
 * server/executive/command-centre.ts, which in turn only aggregates what
 * the owning modules already decided (#61 decisions, #63 taxonomy/ROI, #65
 * connector health, #70 receipts). This page classifies nothing and
 * recomputes nothing — it selects, links and labels.
 *
 * Three rules the layout exists to enforce:
 *
 *   1. Activity is not value. The work ladder keeps proposed / approved /
 *      executed / verified / outcome-measured visually separate, because
 *      collapsing them is exactly how a dashboard comes to imply results it
 *      does not have.
 *   2. Every card drills down. Nothing here is a figure with no way back to
 *      the record it came from; each item carries the server's evidence
 *      href into the surface that owns it.
 *   3. Degradation is visible. A business whose section failed renders with
 *      a degraded badge and the reason, never as a zero — "we could not
 *      look" and "there is nothing there" are different answers.
 *
 * Detailed operations stay in their source surfaces: reviewing a decision
 * happens in DecisionCentre.tsx, receipts in Receipts.tsx, ROI in ROI.tsx.
 * There is deliberately no approve button on this page.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronDown, ChevronRight,
  Clock, Gavel, Plug, RefreshCw, ShieldAlert, TrendingDown, Target,
} from 'lucide-react'
import { formatRelative } from '../lib/time.js'
import useStore from '../lib/store.js'
import { getCommandCentre, getCommandCentreScope } from '../lib/api.js'

// ─── Types (mirror server/executive/command-centre.ts) ──────────────────────

type Lane = 'manual_review' | 'policy_gated' | 'routine'
type Tier = 'green' | 'yellow' | 'orange' | 'red'
type WorkState = 'proposed' | 'approved' | 'executed' | 'verified' | 'outcome_measured'
type TaxonomyState = 'activity' | 'verified_action' | 'outcome_measured' | 'roi_not_measurable'
type Severity = 'critical' | 'high' | 'medium'

interface EvidenceLink {
  kind: string
  id: string
  business_id: string
  href: string
  label: string
}

interface SectionEnvelope<T> {
  status: 'ok' | 'failed'
  as_of: string
  data_as_of: string | null
  error: { message: string; code: string } | null
  data: T | null
}

interface DecisionsSection {
  total: number
  lanes: Record<Lane, number>
  by_risk_tier: Record<Tier, number>
  oldest_pending_hours: number | null
  policy: { citation: string; policy_version: number; policy_scope: string }
  items: Array<{
    task_id: string
    title: string
    lane: Lane
    lane_reason: string
    risk_tier: Tier
    policy_recommendation: 'approve_allowed' | 'human_required' | 'hold'
    requires_override_reason: boolean
    hold_reasons: string[]
    priority: string
    proposed_by: string
    evidence_count: number
    created_at: string
    evidence: EvidenceLink
  }>
}

interface WorkLadder {
  counts: Record<WorkState, number>
  taxonomy_counts: Record<TaxonomyState, number>
  not_progressed: number
  items: Array<{
    task_id: string
    title: string
    state: WorkState
    evidence_source: string
    reason: string
    occurred_at: string | null
    evidence: EvidenceLink
    taxonomy_state: TaxonomyState | null
  }>
  window_start: string
  window_end: string
}

interface VerifiedChangesSection {
  verified_count: number
  executed_unverified_count: number
  needs_attention_count: number
  items: Array<{
    receipt_id: string
    task_id: string
    title: string | null
    action_type: string | null
    state: string
    result_status: string
    result_summary: string | null
    ladder_state: WorkState
    external_system: string | null
    external_permalink: string | null
    independently_verified: boolean
    occurred_at: string | null
    anomaly_count: number
    evidence: EvidenceLink
  }>
}

interface OutcomesSection {
  confidence_level: string
  outcomes_count: number
  attributed_value_usd_per_month: number
  attributed_decline_usd_per_month: number
  total_cost_usd: number
  roi_ratio: number | null
  narrative: string
  taxonomy_counts: Record<TaxonomyState, number>
  declines: Array<{
    task_id: string
    task_title: string | null
    metric_name: string | null
    change_pct: number | null
    evidence: EvidenceLink
  }>
  period_start: string
  period_end: string
  evidence: EvidenceLink
}

interface ConnectorsSection {
  total: number
  by_state: Record<string, number>
  unhealthy: Array<{
    connector_id: string
    type: string
    name: string
    state: string
    summary: string
    impact: string | null
    next_step: string | null
    last_success: string | null
    evidence: EvidenceLink
  }>
  freshest_success: string | null
  stalest_success: string | null
}

interface BusinessSummary {
  business_id: string
  business_name: string
  status: 'ok' | 'degraded' | 'unavailable'
  failed_sections: string[]
  unavailable_reason: string | null
  decisions: SectionEnvelope<DecisionsSection>
  work_states: SectionEnvelope<WorkLadder>
  verified_changes: SectionEnvelope<VerifiedChangesSection>
  outcomes: SectionEnvelope<OutcomesSection>
  connectors: SectionEnvelope<ConnectorsSection>
}

interface AttentionItem {
  id: string
  business_id: string
  business_name: string
  severity: Severity
  source: string
  headline: string
  detail: string
  occurred_at: string | null
  evidence: EvidenceLink
}

interface CommandCentre {
  generated_at: string
  window_start: string
  window_end: string
  window_days: number
  requested_business_ids: string[]
  selection_notice: string | null
  portfolio: { id: string; name: string; business_ids: string[] } | null
  businesses: BusinessSummary[]
  portfolio_totals: {
    businesses_ok: number
    businesses_degraded: number
    businesses_unavailable: number
    pending_decisions: number
    decisions_by_lane: Record<Lane, number>
    decisions_by_risk_tier: Record<Tier, number>
    work_states: Record<WorkState, number>
    taxonomy_counts: Record<TaxonomyState, number>
    verified_changes: number
    executed_unverified: number
    unhealthy_connectors: number
    attributed_value_usd_per_month: number
    attributed_decline_usd_per_month: number
    excluded: Array<{ business_id: string; section: string; reason: string }>
  }
  attention: AttentionItem[]
}

interface ScopeOption { id: string; name: string }
interface PortfolioOption { id: string; name: string; business_ids: string[] }

// ─── Presentation constants ─────────────────────────────────────────────────

/**
 * The ladder's five rungs, in order, with the wording that keeps them
 * honest. "Executed" deliberately says the external system accepted it —
 * an acknowledgement is not proof the change took effect (#70), and
 * "verified" is deliberately distinct from "outcome measured" (#63).
 */
const WORK_STATE_META: Record<WorkState, { label: string; blurb: string; colour: string }> = {
  proposed: {
    label: 'PROPOSED',
    blurb: 'Waiting on a human decision. Nothing has happened yet.',
    colour: 'var(--bp-amber)',
  },
  approved: {
    label: 'APPROVED',
    blurb: 'Authorised, but execution has not started.',
    colour: 'var(--bp-blue)',
  },
  executed: {
    label: 'EXECUTED',
    blurb: 'Blueprint ran it and the external system accepted it. Nothing has checked the result.',
    colour: 'var(--bp-cyan)',
  },
  verified: {
    label: 'VERIFIED',
    blurb: 'An independent later check confirmed the change took effect.',
    colour: 'var(--bp-green)',
  },
  outcome_measured: {
    label: 'OUTCOME MEASURED',
    blurb: 'A business metric was actually measured against it — up, down or flat.',
    colour: 'var(--bp-green)',
  },
}

const TAXONOMY_META: Record<TaxonomyState, { label: string; blurb: string }> = {
  activity: { label: 'Activity', blurb: 'Work was attempted. Nothing more can honestly be claimed.' },
  verified_action: { label: 'Verified action', blurb: 'Confirmed done, but no metric is linked — no outcome is measurable.' },
  outcome_measured: { label: 'Outcome measured', blurb: 'A real measurement exists.' },
  roi_not_measurable: { label: 'Not yet measurable', blurb: 'Metric linked, measurement window still open. ROI must not be claimed.' },
}

const LANE_META: Record<Lane, { label: string; colour: string }> = {
  manual_review: { label: 'Needs investigation', colour: 'var(--bp-red)' },
  policy_gated: { label: 'Held by policy', colour: 'var(--bp-amber)' },
  routine: { label: 'Routine review', colour: 'var(--bp-blue)' },
}

const TIER_COLOUR: Record<Tier, string> = {
  green: 'var(--bp-green)',
  yellow: 'var(--bp-amber)',
  orange: 'var(--bp-amber)',
  red: 'var(--bp-red)',
}

const SEVERITY_META: Record<Severity, { label: string; colour: string }> = {
  critical: { label: 'CRITICAL', colour: 'var(--bp-red)' },
  high: { label: 'HIGH', colour: 'var(--bp-amber)' },
  medium: { label: 'MEDIUM', colour: 'var(--bp-blue)' },
}

// ─── Small building blocks ──────────────────────────────────────────────────

const MONO = 'var(--bp-font-mono)'
const DISPLAY = 'var(--bp-font-display)'

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{
        fontFamily: DISPLAY, fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--bp-text-3)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {children}
      </div>
      {right}
    </div>
  )
}

/**
 * The freshness indicator. Shows the age of the DATA, not of the request —
 * conflating the two is how a stale dashboard looks current. When they
 * differ meaningfully the tooltip spells both out.
 */
function Freshness({ env, label = 'data' }: { env: SectionEnvelope<unknown>; label?: string }) {
  if (env.status === 'failed') {
    return (
      <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-red)' }}>
        could not load
      </span>
    )
  }
  const title = env.data_as_of
    ? `Newest ${label}: ${env.data_as_of}\nComputed: ${env.as_of}`
    : `No ${label} in this window.\nComputed: ${env.as_of}`
  return (
    <span title={title} style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Clock size={9} />
      {env.data_as_of ? formatRelative(env.data_as_of) : 'no data in window'}
    </span>
  )
}

/** A section that failed renders its reason, never a zero. */
function SectionFailed({ env }: { env: SectionEnvelope<unknown> }) {
  return (
    <div style={{
      border: '1px solid var(--bp-red)', borderRadius: 6, padding: '10px 12px',
      background: 'rgba(239,68,68,0.06)',
    }}>
      <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <AlertTriangle size={11} /> This section could not be loaded
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5 }}>
        {env.error?.message ?? 'Unknown error.'} Everything else on this business is real —
        only this section is missing.
      </div>
    </div>
  )
}

function Stat({ label, value, colour, hint }: { label: string; value: React.ReactNode; colour?: string; hint?: string }) {
  return (
    <div title={hint} style={{
      background: 'var(--bp-surface-2)', border: '1px solid var(--bp-border)',
      borderRadius: 6, padding: '10px 12px', minWidth: 0,
    }}>
      <div style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600, color: colour ?? 'var(--bp-text)', lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
    </div>
  )
}

/**
 * Drill-down link. Every item on this page has one; none are decorative.
 *
 * The target surfaces (DecisionCentre.tsx, Receipts.tsx, ROI.tsx, ...) each
 * scope themselves to the store's `currentBusiness` and do not read the
 * business out of the URL. This page is the only one in the app that spans
 * businesses, so following a link from business B while the store still
 * points at business A would land the user on the right page showing the
 * WRONG business's data — a silently incorrect drill-down, which is worse
 * than none at all.
 *
 * Switching the store's current business as part of the navigation is
 * therefore part of the link, not an afterthought. Done here rather than by
 * teaching every target page to parse a query param, so no surface owned by
 * another issue has to change.
 */
function Evidence({ link, children }: { link: EvidenceLink; children?: React.ReactNode }) {
  const businesses = useStore((s) => s.businesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)

  const target = businesses.find((b: { id: string }) => b.id === link.business_id)

  return (
    <Link
      to={link.href}
      onClick={() => { if (target) setCurrentBusiness(target) }}
      title={`Open ${link.kind} ${link.id}`}
      style={{
        fontFamily: MONO, fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
      }}
    >
      {children ?? 'Evidence'} <ArrowRight size={10} />
    </Link>
  )
}

// ─── The work ladder ────────────────────────────────────────────────────────

/**
 * Five rungs, always all five, even at zero. Hiding an empty rung would let
 * a business with nothing verified look the same as one where verification
 * simply isn't shown.
 */
function WorkLadderBar({ counts }: { counts: Record<WorkState, number> }) {
  const order: WorkState[] = ['proposed', 'approved', 'executed', 'verified', 'outcome_measured']
  const total = order.reduce((s, k) => s + (counts[k] ?? 0), 0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
      {order.map((state) => {
        const meta = WORK_STATE_META[state]
        const n = counts[state] ?? 0
        return (
          <div
            key={state}
            title={meta.blurb}
            style={{
              background: 'var(--bp-surface-2)',
              border: '1px solid var(--bp-border)',
              borderTop: `2px solid ${n > 0 ? meta.colour : 'var(--bp-border)'}`,
              borderRadius: 4, padding: '8px 8px 7px',
            }}
          >
            <div style={{ fontFamily: DISPLAY, fontSize: 17, fontWeight: 600, color: n > 0 ? meta.colour : 'var(--bp-text-3)', lineHeight: 1 }}>
              {n}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 8, color: 'var(--bp-text-3)', marginTop: 5, letterSpacing: '0.05em', lineHeight: 1.3 }}>
              {meta.label}
            </div>
            {total > 0 && (
              <div style={{ marginTop: 5, height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(n / total) * 100}%`, background: meta.colour }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TaxonomyStrip({ counts }: { counts: Record<TaxonomyState, number> }) {
  const order: TaxonomyState[] = ['activity', 'verified_action', 'roi_not_measurable', 'outcome_measured']
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {order.map((t) => (
        <span
          key={t}
          title={TAXONOMY_META[t].blurb}
          className="bp-pill bp-pill-grey"
          style={{ fontSize: 9, padding: '2px 7px' }}
        >
          {TAXONOMY_META[t].label}: {counts[t] ?? 0}
        </span>
      ))}
    </div>
  )
}

// ─── Per-business card ──────────────────────────────────────────────────────

function BusinessCard({ b }: { b: BusinessSummary }) {
  const [open, setOpen] = useState(true)

  if (b.status === 'unavailable') {
    return (
      <div className="bp-card" style={{ borderLeft: '3px solid var(--bp-red)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Building2 size={14} style={{ color: 'var(--bp-text-3)' }} />
          <span style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 600, color: 'var(--bp-text)' }}>
            {b.business_name}
          </span>
          <span className="bp-pill bp-pill-red" style={{ fontSize: 9 }}>UNAVAILABLE</span>
        </div>
        <p style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 8, lineHeight: 1.5 }}>
          {b.unavailable_reason}
        </p>
      </div>
    )
  }

  const dec = b.decisions.data
  const ladder = b.work_states.data
  const changes = b.verified_changes.data
  const roi = b.outcomes.data
  const conn = b.connectors.data

  return (
    <div
      className="bp-card"
      style={{ borderLeft: `3px solid ${b.status === 'degraded' ? 'var(--bp-amber)' : 'var(--bp-border)'}` }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          {open ? <ChevronDown size={14} style={{ color: 'var(--bp-text-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--bp-text-3)' }} />}
          <Building2 size={14} style={{ color: 'var(--bp-text-3)' }} />
          <span style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 600, color: 'var(--bp-text)' }}>
            {b.business_name}
          </span>
          {b.status === 'degraded' && (
            <span
              className="bp-pill bp-pill-amber"
              style={{ fontSize: 9 }}
              title={`Could not load: ${b.failed_sections.join(', ')}. Everything else shown is real.`}
            >
              PARTIAL — {b.failed_sections.join(', ')}
            </span>
          )}
        </button>
        {dec && (
          <Evidence
            link={{
              kind: 'decision-centre', id: b.business_id, business_id: b.business_id,
              href: `/decision-centre?business=${encodeURIComponent(b.business_id)}`,
              label: b.business_name,
            }}
          >
            Decision Centre
          </Evidence>
        )}
      </div>

      {!open ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* ── Priority / risk / outcome stat row ─────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            <Stat
              label="Pending decisions"
              value={dec ? dec.total : '—'}
              colour={dec && dec.total > 0 ? 'var(--bp-amber)' : undefined}
              hint={dec ? `Oldest has been waiting ${dec.oldest_pending_hours ?? 0}h.` : b.decisions.error?.message}
            />
            <Stat
              label="Needs investigation"
              value={dec ? dec.lanes.manual_review : '—'}
              colour={dec && dec.lanes.manual_review > 0 ? 'var(--bp-red)' : undefined}
              hint="Blueprint does not know what happened, or cannot carry it out."
            />
            <Stat
              label="Red / orange risk"
              value={dec ? dec.by_risk_tier.red + dec.by_risk_tier.orange : '—'}
              colour={dec && dec.by_risk_tier.red > 0 ? 'var(--bp-red)' : undefined}
              hint="Risk tier calculated under this business's operating policy."
            />
            <Stat
              label="Verified changes"
              value={changes ? changes.verified_count : '—'}
              colour={changes && changes.verified_count > 0 ? 'var(--bp-green)' : undefined}
              hint="Independently confirmed to have taken effect."
            />
            <Stat
              label="Ran, unverified"
              value={changes ? changes.executed_unverified_count : '—'}
              hint="The external system accepted it; nothing has checked the result."
            />
            <Stat
              label="Unhealthy connectors"
              value={conn ? conn.unhealthy.length : '—'}
              colour={conn && conn.unhealthy.length > 0 ? 'var(--bp-amber)' : undefined}
              hint={conn ? `${conn.total} connector(s) configured.` : b.connectors.error?.message}
            />
          </div>

          {/* ── Work ladder ────────────────────────────────────────────── */}
          <div>
            <SectionTitle right={<Freshness env={b.work_states} label="task activity" />}>
              <Target size={11} /> Work state
              <span style={{ fontFamily: MONO, fontSize: 9, textTransform: 'none', letterSpacing: 0, color: 'var(--bp-text-3)' }}>
                — activity is not value
              </span>
            </SectionTitle>
            {b.work_states.status === 'failed' ? <SectionFailed env={b.work_states} /> : ladder && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <WorkLadderBar counts={ladder.counts} />
                <TaxonomyStrip counts={ladder.taxonomy_counts} />
                {ladder.items.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {ladder.items.slice(0, 6).map((item) => (
                      <div
                        key={item.task_id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
                          borderBottom: '1px solid rgba(255,255,255,0.04)',
                        }}
                      >
                        <span
                          className="bp-pill"
                          title={WORK_STATE_META[item.state].blurb}
                          style={{
                            fontSize: 8, padding: '1px 6px', flexShrink: 0,
                            color: WORK_STATE_META[item.state].colour,
                            border: `1px solid ${WORK_STATE_META[item.state].colour}`,
                            background: 'transparent',
                          }}
                        >
                          {WORK_STATE_META[item.state].label}
                        </span>
                        <span
                          title={item.reason}
                          style={{
                            flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-2)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          {item.title}
                        </span>
                        {item.evidence_source !== 'receipt' && item.evidence_source !== 'outcome_measurement' && (
                          <span
                            title="Based on Blueprint's own task status rather than an external receipt — weaker evidence."
                            style={{ fontFamily: MONO, fontSize: 8, color: 'var(--bp-text-3)', flexShrink: 0 }}
                          >
                            no receipt
                          </span>
                        )}
                        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0 }}>
                          {item.occurred_at ? formatRelative(item.occurred_at) : '—'}
                        </span>
                        <Evidence link={item.evidence} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Pending decisions ──────────────────────────────────────── */}
          <div>
            <SectionTitle right={<Freshness env={b.decisions} label="pending decision" />}>
              <Gavel size={11} /> Pending decisions
              {dec && (
                <span style={{ fontFamily: MONO, fontSize: 9, textTransform: 'none', letterSpacing: 0, color: 'var(--bp-text-3)' }}>
                  — under {dec.policy.citation}
                </span>
              )}
            </SectionTitle>
            {b.decisions.status === 'failed' ? <SectionFailed env={b.decisions} /> : dec && (
              dec.items.length === 0 ? (
                <p style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
                  Nothing is waiting on a human for this business.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {dec.items.map((d) => (
                    <div
                      key={d.task_id}
                      style={{
                        border: '1px solid var(--bp-border)',
                        borderLeft: `3px solid ${LANE_META[d.lane].colour}`,
                        borderRadius: 5, padding: '9px 11px',
                        background: 'var(--bp-surface-2)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <span className="bp-pill" style={{ fontSize: 8, padding: '1px 6px', color: LANE_META[d.lane].colour, border: `1px solid ${LANE_META[d.lane].colour}`, background: 'transparent' }}>
                          {LANE_META[d.lane].label}
                        </span>
                        <span
                          className="bp-pill"
                          title="Risk tier under this business's operating policy."
                          style={{ fontSize: 8, padding: '1px 6px', color: TIER_COLOUR[d.risk_tier], border: `1px solid ${TIER_COLOUR[d.risk_tier]}`, background: 'transparent' }}
                        >
                          {d.risk_tier.toUpperCase()}
                        </span>
                        {d.requires_override_reason && (
                          <span
                            className="bp-pill bp-pill-red"
                            style={{ fontSize: 8, padding: '1px 6px' }}
                            title={d.hold_reasons.join(' ')}
                          >
                            HELD — OVERRIDE NEEDED
                          </span>
                        )}
                        <span style={{ flex: 1 }} />
                        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }}>
                          {formatRelative(d.created_at)}
                        </span>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text)', marginBottom: 4 }}>
                        {d.title}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.5, marginBottom: 6 }}>
                        {d.lane_reason}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }}>
                          {d.evidence_count} evidence item(s) · proposed by {d.proposed_by}
                        </span>
                        <span style={{ flex: 1 }} />
                        <Evidence link={d.evidence}>Review</Evidence>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {/* ── Recent verified changes ────────────────────────────────── */}
          <div>
            <SectionTitle right={<Freshness env={b.verified_changes} label="receipt" />}>
              <CheckCircle2 size={11} /> Recent changes
            </SectionTitle>
            {b.verified_changes.status === 'failed' ? <SectionFailed env={b.verified_changes} /> : changes && (
              changes.items.length === 0 ? (
                <p style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
                  Nothing executed in this window.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {changes.items.map((c) => (
                    <div key={c.receipt_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <span
                        title={c.independently_verified
                          ? 'An independent later measurement confirmed this took effect.'
                          : 'The external system accepted it. Nothing has checked the result — this is not verification.'}
                        style={{
                          fontFamily: MONO, fontSize: 8, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
                          color: c.independently_verified ? 'var(--bp-green)' : 'var(--bp-cyan)',
                          border: `1px solid ${c.independently_verified ? 'var(--bp-green)' : 'var(--bp-cyan)'}`,
                        }}
                      >
                        {c.independently_verified ? 'VERIFIED' : 'ACKNOWLEDGED'}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.title ?? c.task_id}
                      </span>
                      {c.anomaly_count > 0 && (
                        <span className="bp-pill bp-pill-red" style={{ fontSize: 8, padding: '1px 5px', flexShrink: 0 }} title={`${c.anomaly_count} anomaly/anomalies recorded.`}>
                          {c.anomaly_count} anomaly
                        </span>
                      )}
                      <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0 }}>
                        {c.occurred_at ? formatRelative(c.occurred_at) : '—'}
                      </span>
                      <Evidence link={c.evidence}>Receipt</Evidence>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {/* ── Outcome / ROI ─────────────────────────────────────────── */}
          <div>
            <SectionTitle right={<Freshness env={b.outcomes} label="measurement" />}>
              <TrendingDown size={11} /> Measured outcomes
            </SectionTitle>
            {b.outcomes.status === 'failed' ? <SectionFailed env={b.outcomes} /> : roi && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
                  <Stat label="Attributed / mo" value={`$${roi.attributed_value_usd_per_month.toLocaleString()}`} colour="var(--bp-green)" />
                  <Stat label="Declines / mo" value={`$${roi.attributed_decline_usd_per_month.toLocaleString()}`} colour={roi.attributed_decline_usd_per_month > 0 ? 'var(--bp-red)' : undefined} />
                  <Stat label="Confidence" value={roi.confidence_level} hint="How much data this attribution rests on." />
                  <Stat label="ROI ratio" value={roi.roi_ratio == null ? 'n/a' : `${roi.roi_ratio}×`} hint="Null until there is enough data to say honestly." />
                </div>
                <p style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.6, margin: 0 }}>
                  {roi.narrative}
                </p>
                {roi.declines.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {roi.declines.map((d) => (
                      <div key={d.task_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <TrendingDown size={11} style={{ color: 'var(--bp-red)', flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.task_title ?? d.task_id} — {d.metric_name ?? 'metric'}
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)', flexShrink: 0 }}>
                          {d.change_pct == null ? '—' : `${d.change_pct.toFixed(1)}%`}
                        </span>
                        <Evidence link={d.evidence} />
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Evidence link={roi.evidence}>Full ROI report</Evidence>
                </div>
              </div>
            )}
          </div>

          {/* ── Connector trust ───────────────────────────────────────── */}
          {b.connectors.status === 'failed' ? (
            <div>
              <SectionTitle><Plug size={11} /> Data sources</SectionTitle>
              <SectionFailed env={b.connectors} />
            </div>
          ) : conn && conn.unhealthy.length > 0 && (
            <div>
              <SectionTitle right={<Freshness env={b.connectors} label="sync" />}>
                <Plug size={11} /> Data sources needing attention
              </SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {conn.unhealthy.map((c) => (
                  <div key={c.connector_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span className="bp-pill bp-pill-amber" style={{ fontSize: 8, padding: '1px 5px', flexShrink: 0 }}>
                      {c.state.replace(/_/g, ' ').toUpperCase()}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-2)' }}>{c.summary}</div>
                      {c.impact && (
                        <div style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', marginTop: 3, lineHeight: 1.5 }}>{c.impact}</div>
                      )}
                    </div>
                    <Evidence link={c.evidence} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

function ExecutiveCommandCentre() {
  const [scope, setScope] = useState<{ businesses: ScopeOption[]; portfolios: PortfolioOption[] }>({ businesses: [], portfolios: [] })
  const [selected, setSelected] = useState<string[]>([])
  const [windowDays, setWindowDays] = useState(30)
  const [data, setData] = useState<CommandCentre | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The selector is built from /scope, not from the global business list, so
  // the options offered are exactly the ones the summary will honour.
  useEffect(() => {
    getCommandCentreScope()
      .then((s) => {
        setScope({ businesses: s?.businesses ?? [], portfolios: s?.portfolios ?? [] })
        setSelected((prev) => (prev.length ? prev : (s?.businesses ?? []).map((b: ScopeOption) => b.id)))
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const fetchData = useCallback(async () => {
    try {
      setError(null)
      const params: Record<string, string | number> = { window_days: windowDays }
      if (selected.length > 0) params.business_ids = selected.join(',')
      setData(await getCommandCentre(params))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selected, windowDays])

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 120_000)
    return () => clearInterval(iv)
  }, [fetchData])

  const totals = data?.portfolio_totals
  const attention = data?.attention ?? []

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const degradedNote = useMemo(() => {
    if (!totals) return null
    const parts: string[] = []
    if (totals.businesses_degraded > 0) parts.push(`${totals.businesses_degraded} partially loaded`)
    if (totals.businesses_unavailable > 0) parts.push(`${totals.businesses_unavailable} unavailable`)
    return parts.length > 0 ? parts.join(', ') : null
  }, [totals])

  return (
    <div style={{ padding: 24, maxWidth: 1600, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, color: 'var(--bp-text)', margin: 0 }}>
            Executive Command Centre
          </h1>
          <p style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-3)', marginTop: 3 }}>
            Priorities, risks, decisions and measured outcomes across the businesses you select.
            {data && ` Window: last ${data.window_days} days.`}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="bp-input"
            style={{ fontFamily: MONO, fontSize: 11, padding: '5px 8px' }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button
            onClick={async () => { setRefreshing(true); await fetchData(); setRefreshing(false) }}
            disabled={refreshing}
            className="bp-btn bp-btn-secondary"
            style={{ fontSize: 11 }}
          >
            <RefreshCw size={12} style={{ animation: refreshing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Business selector */}
      <div className="bp-card" style={{ marginBottom: 16 }}>
        <SectionTitle
          right={
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setSelected(scope.businesses.map((b) => b.id))} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>All</button>
              <button onClick={() => setSelected([])} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>Clear</button>
            </div>
          }
        >
          <Building2 size={11} /> Scope
        </SectionTitle>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {scope.businesses.length === 0 && (
            <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>No businesses in scope.</span>
          )}
          {scope.businesses.map((b) => {
            const on = selected.includes(b.id)
            return (
              <button
                key={b.id}
                onClick={() => toggle(b.id)}
                style={{
                  fontFamily: MONO, fontSize: 10, padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                  background: on ? 'rgba(59,130,246,0.12)' : 'transparent',
                  color: on ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                }}
              >
                {b.name}
              </button>
            )
          })}
        </div>
        {scope.portfolios.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Saved portfolios
            </span>
            {scope.portfolios.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelected(p.business_ids)}
                title={`Select the ${p.business_ids.length} business(es) in this policy portfolio.`}
                className="bp-btn bp-btn-ghost"
                style={{ fontSize: 10, padding: '2px 8px' }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="bp-card" style={{ borderLeft: '3px solid var(--bp-red)', marginBottom: 16 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-red)' }}>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="bp-card"><div className="skeleton" style={{ height: 120, borderRadius: 4 }} /></div>
      ) : !data ? null : (
        <>
          {/* ── Portfolio rollup ────────────────────────────────────────── */}
          <div className="bp-card" style={{ marginBottom: 16 }}>
            <SectionTitle
              right={
                <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }} title={`Generated ${data.generated_at}`}>
                  generated {formatRelative(data.generated_at)}
                </span>
              }
            >
              Portfolio totals
              {degradedNote && (
                <span
                  className="bp-pill bp-pill-amber"
                  style={{ fontSize: 9 }}
                  title={data.portfolio_totals.excluded.map((e) => `${e.business_id} / ${e.section}: ${e.reason}`).join('\n')}
                >
                  {degradedNote}
                </span>
              )}
            </SectionTitle>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 14 }}>
              <Stat label="Businesses" value={data.businesses.length} />
              <Stat label="Pending decisions" value={totals!.pending_decisions} colour={totals!.pending_decisions > 0 ? 'var(--bp-amber)' : undefined} />
              <Stat label="Needs investigation" value={totals!.decisions_by_lane.manual_review} colour={totals!.decisions_by_lane.manual_review > 0 ? 'var(--bp-red)' : undefined} />
              <Stat label="Verified changes" value={totals!.verified_changes} colour="var(--bp-green)" />
              <Stat label="Ran, unverified" value={totals!.executed_unverified} />
              <Stat label="Unhealthy sources" value={totals!.unhealthy_connectors} colour={totals!.unhealthy_connectors > 0 ? 'var(--bp-amber)' : undefined} />
            </div>

            <div style={{ marginBottom: 10 }}>
              <WorkLadderBar counts={totals!.work_states} />
            </div>
            <TaxonomyStrip counts={totals!.taxonomy_counts} />

            {data.selection_notice && (
              <p style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-amber)', marginTop: 10, lineHeight: 1.6 }}>
                {data.selection_notice}
              </p>
            )}

            {totals!.excluded.length > 0 && (
              <p style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-amber)', marginTop: 10, lineHeight: 1.6 }}>
                These totals exclude {totals!.excluded.length} section(s) that could not be loaded
                ({totals!.excluded.map((e) => `${e.business_id}/${e.section}`).join(', ')}). They are
                a lower bound, not a complete picture.
              </p>
            )}
          </div>

          {/* ── What to look at first ───────────────────────────────────── */}
          <div className="bp-card" style={{ marginBottom: 16 }}>
            <SectionTitle>
              <ShieldAlert size={11} /> What needs attention first
            </SectionTitle>
            {attention.length === 0 ? (
              <p style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>
                Nothing is waiting on a human, and no measured declines or failing data sources
                were found in this window.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {attention.slice(0, 12).map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span
                      className="bp-pill"
                      style={{
                        fontSize: 8, padding: '1px 6px', flexShrink: 0, marginTop: 1,
                        color: SEVERITY_META[a.severity].colour,
                        border: `1px solid ${SEVERITY_META[a.severity].colour}`,
                        background: 'transparent',
                      }}
                    >
                      {SEVERITY_META[a.severity].label}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text)' }}>
                        {a.headline}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', marginTop: 3, lineHeight: 1.5 }}>
                        {a.business_name} · {a.detail}
                      </div>
                    </div>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)', flexShrink: 0 }}>
                      {a.occurred_at ? formatRelative(a.occurred_at) : '—'}
                    </span>
                    <Evidence link={a.evidence} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Per-business ────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {data.businesses.length === 0 ? (
              <div className="bp-card">
                <p style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-3)' }}>
                  Select at least one business above.
                </p>
              </div>
            ) : (
              data.businesses.map((b) => <BusinessCard key={b.business_id} b={b} />)
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default ExecutiveCommandCentre
