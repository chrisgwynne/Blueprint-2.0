/**
 * Portfolio view (#71) — businesses compared side by side.
 *
 * A separate page from ExecutiveCommandCentre.tsx (#59) because it answers a
 * different question and therefore needs a different shape. The command
 * centre is a decision queue: "what needs me, across everything?", read as
 * one section per business. This is a comparison: "which of these is doing
 * better, on what?", read as one row per METRIC with a column per business.
 * Comparison is the layout here, not something the reader is left to do in
 * their head.
 *
 * Four rules the layout exists to enforce:
 *
 *   1. NOTHING IS BLENDED THAT SHOULD NOT BE. A metric the server marked
 *      `not_comparable` renders its per-business values but no ranking, no
 *      total, and the reason in full. The honest answer to "which is
 *      better?" is sometimes "these are not the same kind of number".
 *   2. UNKNOWN IS NOT ZERO. A cell whose section failed shows an em dash and
 *      the error, never a 0 — "we could not look" and "there is nothing
 *      there" are different answers and must never look alike.
 *   3. EVERY AGGREGATE DECLARES ITSELF. Totals show how many businesses they
 *      cover out of how many, and name the ones they exclude.
 *   4. EVERY CELL DRILLS DOWN. Each number links into the business-scoped
 *      surface that owns it, switching the store's current business on the
 *      way so the target page shows the business the cell belonged to.
 *
 * All classification happens server-side in
 * server/portfolio/portfolio-comparison.ts. This page ranks nothing, sums
 * nothing and decides no comparability — it renders what it is given.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Building2, Check, ChevronDown, ChevronRight, Clock,
  History, Info, Layers, Plus, RefreshCw, Scale, Trash2, X,
} from 'lucide-react'
import { formatRelative } from '../lib/time.js'
import useStore from '../lib/store.js'
import {
  addPortfolioMembers, createPortfolio, deletePortfolio, getCommandCentreScope,
  getPortfolioComparison, getPortfolioHistory, getPortfolios, removePortfolioMembers,
} from '../lib/api.js'

// ─── Types (mirror server/portfolio/portfolio-comparison.ts) ────────────────

type FieldState = 'known' | 'unknown' | 'not_comparable'
type MetricGroup = 'goals' | 'costs' | 'outcomes' | 'risk' | 'health'
type MetricDirection = 'higher_is_better' | 'lower_is_better' | 'neutral'
type MetricUnit = 'count' | 'usd' | 'usd_per_month' | 'percent' | 'hours' | 'ratio'

interface ComparableField {
  state: FieldState
  value: number | null
  citation: string | null
  reason: string | null
}

interface EvidenceLink {
  kind: string
  id: string
  business_id: string
  href: string
  label: string
}

interface MetricCell {
  business_id: string
  field: ComparableField
  evidence: EvidenceLink
  data_as_of: string | null
  rank: number | null
  valuation_basis: 'measured_revenue' | 'estimated_proxy' | null
}

interface MetricAggregate {
  field: ComparableField
  kind: 'sum' | 'average' | 'none'
  included_business_ids: string[]
  excluded: Array<{ business_id: string; reason: string }>
}

interface MetricComparison {
  key: string
  label: string
  group: MetricGroup
  unit: MetricUnit
  direction: MetricDirection
  description: string
  comparability: 'comparable' | 'not_comparable'
  comparability_reason: string | null
  incompatible_groups: Array<{ basis: string; business_ids: string[] }> | null
  cells: MetricCell[]
  ranking: string[] | null
  aggregate: MetricAggregate
  data_as_of: string | null
}

interface ComparedBusiness {
  business_id: string
  business_name: string
  business_type: string
  business_type_inferred: boolean
  status: 'ok' | 'degraded' | 'unavailable'
  failed_sections: string[]
  unavailable_reason: string | null
  valuation_basis: 'measured_revenue' | 'estimated_proxy' | null
}

interface MembershipEvent {
  id: string
  business_id: string
  business_name: string | null
  action: 'added' | 'removed'
  actor: string
  reason: string | null
  occurred_at: string
}

interface Comparison {
  generated_at: string
  window_start: string
  window_end: string
  window_days: number
  portfolio: {
    id: string; name: string; description: string | null
    business_ids: string[]; hidden_member_count: number
  }
  businesses: ComparedBusiness[]
  metrics: MetricComparison[]
  membership_changes_in_window: MembershipEvent[]
  caveats: string[]
  coverage: {
    businesses_ok: number
    businesses_degraded: number
    businesses_unavailable: number
    not_comparable_metrics: Array<{ key: string; reason: string }>
  }
}

interface Portfolio {
  id: string
  name: string
  description: string | null
  business_ids: string[]
  hidden_member_count: number
  updated_at: string
}

// ─── Presentation constants ─────────────────────────────────────────────────

const MONO = 'var(--bp-font-mono)'
const DISPLAY = 'var(--bp-font-display)'

const GROUP_META: Record<MetricGroup, { label: string; blurb: string }> = {
  goals: { label: 'Goals', blurb: 'What each business is trying to achieve, and how far along it is.' },
  costs: { label: 'Cost', blurb: 'What Blueprint itself cost to run each business inside the window.' },
  outcomes: { label: 'Outcomes', blurb: 'What was actually measured, and what value #63 attributes to it.' },
  risk: { label: 'Risk', blurb: 'Work blocked on a human, weighted by the business’s own operating policy.' },
  health: { label: 'Data health', blurb: 'Whether the numbers above can be trusted, per #65 connector health.' },
}

const GROUP_ORDER: MetricGroup[] = ['goals', 'outcomes', 'costs', 'risk', 'health']

function formatValue(value: number | null, unit: MetricUnit): string {
  if (value == null) return '—'
  switch (unit) {
    case 'usd':
      return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    case 'usd_per_month':
      return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo`
    case 'percent':
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    case 'hours':
      return value >= 48 ? `${Math.round(value / 24)}d` : `${Math.round(value)}h`
    case 'ratio':
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}x`
    default:
      return value.toLocaleString()
  }
}

// ─── Small building blocks ──────────────────────────────────────────────────

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
      <div style={{
        fontFamily: DISPLAY, fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--bp-text-3)',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        {children}
      </div>
      {right}
    </div>
  )
}

/**
 * One cell of the comparison grid.
 *
 * The three field states render distinguishably on purpose. A `known` value
 * is a number; an `unknown` is an em dash with the reason on hover; a
 * `not_comparable` value is shown but visibly set apart, because it is a
 * true fact about its own business that simply cannot be put on one scale
 * with its neighbours.
 */
function Cell({
  cell, unit, business, isBest, notComparable,
}: {
  cell: MetricCell; unit: MetricUnit; business: ComparedBusiness | undefined
  isBest: boolean; notComparable: boolean
}) {
  const businesses = useStore((s) => s.businesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const target = businesses.find((b: { id: string }) => b.id === cell.business_id)

  const unavailable = business?.status === 'unavailable'
  const known = cell.field.state === 'known' && cell.field.value != null

  const title = known
    ? `${cell.field.citation ?? ''}${cell.data_as_of ? `\nNewest source record: ${cell.data_as_of}` : ''}`
      + (cell.valuation_basis ? `\nValuation basis: ${cell.valuation_basis}` : '')
    : cell.field.reason ?? 'No value available.'

  return (
    <td style={{
      padding: '9px 12px',
      borderBottom: '1px solid var(--bp-border)',
      background: unavailable ? 'rgba(239,68,68,0.04)' : isBest ? 'rgba(34,197,94,0.07)' : 'transparent',
      verticalAlign: 'middle',
      minWidth: 128,
    }}>
      <div title={title} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontFamily: DISPLAY, fontSize: 15, fontWeight: 600, lineHeight: 1.1,
          color: !known ? 'var(--bp-text-3)'
            : notComparable ? 'var(--bp-text-2)'
              : isBest ? 'var(--bp-green)' : 'var(--bp-text)',
          // A value that cannot be ranked is deliberately not styled like one
          // that can — the reader should never mistake it for a score.
          fontStyle: notComparable && known ? 'italic' : 'normal',
        }}>
          {known ? formatValue(cell.field.value, unit) : '—'}
        </span>
        {isBest && !notComparable && (
          <span title="Best in this portfolio on this metric." style={{ color: 'var(--bp-green)', display: 'inline-flex' }}>
            <Check size={11} />
          </span>
        )}
        {cell.rank != null && cell.rank > 1 && !notComparable && (
          <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }}>#{cell.rank}</span>
        )}
      </div>

      {!known && (
        <div
          title={cell.field.reason ?? ''}
          style={{
            fontFamily: MONO, fontSize: 8.5, color: 'var(--bp-text-3)', marginTop: 3,
            maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {cell.field.state === 'not_comparable' ? 'not comparable' : 'unknown'}
        </div>
      )}

      {/* Drill-down exists whether or not the number does. */}
      <Link
        to={cell.evidence.href}
        onClick={() => { if (target) setCurrentBusiness(target) }}
        title={`Open ${cell.evidence.label}`}
        style={{
          fontFamily: MONO, fontSize: 8.5, color: 'var(--bp-blue)', textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 3,
        }}
      >
        evidence <ArrowRight size={8} />
      </Link>
    </td>
  )
}

/** The aggregate cell — always states its own coverage. */
function AggregateCell({ metric }: { metric: MetricComparison }) {
  const agg = metric.aggregate
  const known = agg.field.state === 'known' && agg.field.value != null
  const total = metric.cells.length

  return (
    <td style={{
      padding: '9px 12px', borderBottom: '1px solid var(--bp-border)',
      borderLeft: '2px solid var(--bp-border)', background: 'var(--bp-surface-2)',
      minWidth: 140,
    }}>
      <div
        title={known ? (agg.field.citation ?? '') : (agg.field.reason ?? '')}
        style={{
          fontFamily: DISPLAY, fontSize: 15, fontWeight: 600,
          color: known ? 'var(--bp-text)' : 'var(--bp-text-3)', lineHeight: 1.1,
        }}
      >
        {known ? formatValue(agg.field.value, metric.unit) : '—'}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 8.5, color: 'var(--bp-text-3)', marginTop: 3 }}>
        {known
          ? `${agg.kind} of ${agg.included_business_ids.length}/${total}`
          : agg.field.state === 'not_comparable' ? 'not aggregated' : 'no data'}
      </div>
      {known && agg.excluded.length > 0 && (
        <div
          title={agg.excluded.map((e) => `${e.business_id}: ${e.reason}`).join('\n')}
          style={{
            fontFamily: MONO, fontSize: 8.5, color: 'var(--bp-amber)', marginTop: 2,
            display: 'inline-flex', alignItems: 'center', gap: 3,
          }}
        >
          <AlertTriangle size={8} /> excludes {agg.excluded.length}
        </div>
      )}
    </td>
  )
}

/** One metric row: label, per-business cells, aggregate. */
function MetricRow({ metric, businesses }: { metric: MetricComparison; businesses: ComparedBusiness[] }) {
  const notComparable = metric.comparability === 'not_comparable'
  const best = metric.ranking && metric.ranking.length > 1 ? metric.ranking[0] : null
  const byId = new Map(metric.cells.map((c) => [c.business_id, c]))

  return (
    <>
      <tr>
        <th
          scope="row"
          style={{
            textAlign: 'left', padding: '9px 12px', borderBottom: '1px solid var(--bp-border)',
            position: 'sticky', left: 0, background: 'var(--bp-surface)', zIndex: 1, minWidth: 210,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text)', fontWeight: 500 }}>
              {metric.label}
            </span>
            <span title={metric.description} style={{ color: 'var(--bp-text-3)', display: 'inline-flex', cursor: 'help' }}>
              <Info size={10} />
            </span>
            {notComparable && (
              <span
                className="bp-pill bp-pill-amber"
                style={{ fontSize: 8.5, padding: '1px 6px' }}
                title={metric.comparability_reason ?? ''}
              >
                not comparable
              </span>
            )}
            {metric.direction === 'neutral' && (
              <span
                className="bp-pill bp-pill-grey"
                style={{ fontSize: 8.5, padding: '1px 6px' }}
                title="Scale, not performance — this metric is deliberately never ranked."
              >
                unranked
              </span>
            )}
          </div>
          {metric.data_as_of && (
            <div
              title={`Newest source record behind this row: ${metric.data_as_of}`}
              style={{ fontFamily: MONO, fontSize: 8.5, color: 'var(--bp-text-3)', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              <Clock size={8} /> {formatRelative(metric.data_as_of)}
            </div>
          )}
        </th>

        {businesses.map((b) => {
          const c = byId.get(b.business_id)
          if (!c) return <td key={b.business_id} style={{ borderBottom: '1px solid var(--bp-border)' }} />
          return (
            <Cell
              key={b.business_id}
              cell={c}
              unit={metric.unit}
              business={b}
              isBest={best === b.business_id}
              notComparable={notComparable}
            />
          )
        })}

        <AggregateCell metric={metric} />
      </tr>

      {/* The reason a row cannot be ranked is stated in the table, not hidden
          behind a tooltip — it is the most important thing on such a row. */}
      {notComparable && metric.comparability_reason && (
        <tr>
          <td colSpan={businesses.length + 2} style={{ padding: '0 12px 9px', borderBottom: '1px solid var(--bp-border)' }}>
            <div style={{
              fontFamily: MONO, fontSize: 9.5, color: 'var(--bp-text-3)', lineHeight: 1.55,
              background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 4, padding: '7px 10px',
            }}>
              <AlertTriangle size={9} style={{ verticalAlign: -1, marginRight: 5, color: 'var(--bp-amber)' }} />
              {metric.comparability_reason}
              {metric.incompatible_groups && metric.incompatible_groups.length > 0 && (
                <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {metric.incompatible_groups.map((g) => (
                    <span key={g.basis} className="bp-pill bp-pill-grey" style={{ fontSize: 8.5 }}>
                      {g.basis.replace('business_type:', '')}: {g.business_ids.length}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Portfolio editor ───────────────────────────────────────────────────────

function MembershipEditor({
  portfolio, scope, onChanged, onClose,
}: {
  portfolio: Portfolio
  scope: Array<{ id: string; name: string }>
  onChanged: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const members = new Set(portfolio.business_ids)

  const toggle = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      if (members.has(id)) await removePortfolioMembers(portfolio.id, [id])
      else await addPortfolioMembers(portfolio.id, [id])
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bp-card" style={{ marginBottom: 16 }}>
      <SectionTitle right={
        <button onClick={onClose} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>
          <X size={11} /> Done
        </button>
      }>
        <Layers size={11} /> Membership — {portfolio.name}
      </SectionTitle>
      <p style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--bp-text-3)', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
        Every change is recorded in this portfolio’s history. A business added partway through a
        comparison window has been observed for less of it than the others, and the comparison says so.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {scope.map((b) => {
          const on = members.has(b.id)
          return (
            <button
              key={b.id}
              disabled={busy}
              onClick={() => toggle(b.id)}
              style={{
                fontFamily: MONO, fontSize: 10, padding: '4px 10px', borderRadius: 4,
                cursor: busy ? 'wait' : 'pointer',
                border: `1px solid ${on ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                background: on ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: on ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}
            >
              {on ? <Check size={10} /> : <Plus size={10} />} {b.name}
            </button>
          )
        })}
      </div>
      {portfolio.hidden_member_count > 0 && (
        <div style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--bp-amber)', marginTop: 10 }}>
          {portfolio.hidden_member_count} member(s) of this portfolio are outside your access and are not
          shown or included anywhere below.
        </div>
      )}
      {error && (
        <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-red)', marginTop: 10 }}>{error}</div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PortfolioView() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [scope, setScope] = useState<Array<{ id: string; name: string }>>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [history, setHistory] = useState<MembershipEvent[]>([])
  const [windowDays, setWindowDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newMembers, setNewMembers] = useState<string[]>([])

  const loadPortfolios = useCallback(async () => {
    try {
      const [list, scopeRes] = await Promise.all([getPortfolios(), getCommandCentreScope()])
      const items: Portfolio[] = list?.portfolios ?? []
      setPortfolios(items)
      setScope((scopeRes?.businesses ?? []).map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })))
      setActiveId((prev) => prev ?? items[0]?.id ?? null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const loadComparison = useCallback(async () => {
    if (!activeId) { setComparison(null); setLoading(false); return }
    try {
      setError(null)
      const [cmp, hist] = await Promise.all([
        getPortfolioComparison(activeId, { window_days: windowDays }),
        getPortfolioHistory(activeId, { limit: 50 }),
      ])
      setComparison(cmp)
      setHistory(hist?.events ?? [])
    } catch (e) {
      setError((e as Error).message)
      setComparison(null)
    } finally {
      setLoading(false)
    }
  }, [activeId, windowDays])

  useEffect(() => { loadPortfolios() }, [loadPortfolios])
  useEffect(() => { loadComparison() }, [loadComparison])

  const active = portfolios.find((p) => p.id === activeId) ?? null

  const grouped = useMemo(() => {
    if (!comparison) return []
    return GROUP_ORDER
      .map((g) => ({ group: g, metrics: comparison.metrics.filter((m) => m.group === g) }))
      .filter((x) => x.metrics.length > 0)
  }, [comparison])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    await loadPortfolios()
    await loadComparison()
    setRefreshing(false)
  }, [loadPortfolios, loadComparison])

  const handleCreate = async () => {
    if (!newName.trim() || newMembers.length === 0) return
    try {
      const res = await createPortfolio({ name: newName.trim(), business_ids: newMembers })
      setCreating(false)
      setNewName('')
      setNewMembers([])
      await loadPortfolios()
      setActiveId(res.portfolio.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleDelete = async () => {
    if (!active) return
    try {
      await deletePortfolio(active.id)
      setActiveId(null)
      setComparison(null)
      await loadPortfolios()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1700, margin: '0 auto' }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, color: 'var(--bp-text)', margin: 0 }}>
            Portfolio Comparison
          </h1>
          <p style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-text-3)', marginTop: 3, maxWidth: 760, lineHeight: 1.55 }}>
            Goals, outcomes, cost, risk and data health for every business in a portfolio, side by side.
            Figures that are derived differently across business types are shown but never ranked or
            summed into one number.
            {comparison && ` Window: last ${comparison.window_days} days.`}
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
          <button onClick={refreshAll} disabled={refreshing} className="bp-btn bp-btn-secondary" style={{ fontSize: 11 }}>
            <RefreshCw size={12} style={{ animation: refreshing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Portfolio picker ────────────────────────────────────────────── */}
      <div className="bp-card" style={{ marginBottom: 16 }}>
        <SectionTitle right={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setCreating((v) => !v)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>
              <Plus size={11} /> New portfolio
            </button>
            {active && (
              <>
                <button onClick={() => setEditing((v) => !v)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>
                  <Layers size={11} /> Membership
                </button>
                <button onClick={() => setShowHistory((v) => !v)} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px' }}>
                  <History size={11} /> History
                </button>
                <button onClick={handleDelete} className="bp-btn bp-btn-ghost" style={{ fontSize: 10, padding: '2px 8px', color: 'var(--bp-red)' }}>
                  <Trash2 size={11} /> Delete
                </button>
              </>
            )}
          </div>
        }>
          <Building2 size={11} /> Portfolios
        </SectionTitle>

        {portfolios.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--bp-text-3)', lineHeight: 1.6 }}>
            No portfolios yet. A portfolio is a named group of businesses you want to compare — unlike an
            operating-policy portfolio, the same business can belong to as many of these as you like.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {portfolios.map((p) => {
              const on = p.id === activeId
              return (
                <button
                  key={p.id}
                  onClick={() => { setActiveId(p.id); setEditing(false); setShowHistory(false) }}
                  title={p.description ?? undefined}
                  style={{
                    fontFamily: MONO, fontSize: 10, padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--bp-blue)' : 'var(--bp-border)'}`,
                    background: on ? 'rgba(59,130,246,0.12)' : 'transparent',
                    color: on ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                  }}
                >
                  {p.name} <span style={{ opacity: 0.65 }}>({p.business_ids.length})</span>
                </button>
              )
            })}
          </div>
        )}

        {creating && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--bp-border)', paddingTop: 12 }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Portfolio name (e.g. UK retail)"
              className="bp-input"
              style={{ fontFamily: MONO, fontSize: 11, padding: '5px 8px', width: 260, marginBottom: 8 }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {scope.map((b) => {
                const on = newMembers.includes(b.id)
                return (
                  <button
                    key={b.id}
                    onClick={() => setNewMembers((prev) => on ? prev.filter((x) => x !== b.id) : [...prev, b.id])}
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
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || newMembers.length === 0}
              className="bp-btn bp-btn-primary"
              style={{ fontSize: 11 }}
            >
              Create portfolio
            </button>
          </div>
        )}
      </div>

      {editing && active && (
        <MembershipEditor
          portfolio={active}
          scope={scope}
          onChanged={refreshAll}
          onClose={() => setEditing(false)}
        />
      )}

      {showHistory && active && (
        <div className="bp-card" style={{ marginBottom: 16 }}>
          <SectionTitle><History size={11} /> Membership history — {active.name}</SectionTitle>
          {history.length === 0 ? (
            <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-3)' }}>No recorded changes.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.map((e) => (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 10 }}>
                  <span className={`bp-pill ${e.action === 'added' ? 'bp-pill-green' : 'bp-pill-grey'}`} style={{ fontSize: 8.5 }}>
                    {e.action}
                  </span>
                  <span style={{ color: 'var(--bp-text)' }}>{e.business_name ?? e.business_id}</span>
                  <span style={{ color: 'var(--bp-text-3)' }}>{formatRelative(e.occurred_at)}</span>
                  <span style={{ color: 'var(--bp-text-3)' }}>by {e.actor}</span>
                  {e.reason && <span style={{ color: 'var(--bp-text-3)' }}>— {e.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bp-card" style={{ borderLeft: '3px solid var(--bp-red)', marginBottom: 16 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--bp-red)' }}>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="bp-card"><div className="skeleton" style={{ height: 160, borderRadius: 4 }} /></div>
      ) : !comparison ? null : (
        <>
          {/* ── Caveats: read before acting on the table ─────────────────── */}
          {comparison.caveats.length > 0 && (
            <div className="bp-card" style={{ marginBottom: 16, borderLeft: '3px solid var(--bp-amber)' }}>
              <SectionTitle><AlertTriangle size={11} /> Read this before comparing</SectionTitle>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {comparison.caveats.map((c, i) => (
                  <li key={i} style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-text-2)', lineHeight: 1.6 }}>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── The comparison grid ─────────────────────────────────────── */}
          <div className="bp-card" style={{ marginBottom: 16 }}>
            <SectionTitle right={
              <span
                style={{ fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)' }}
                title={`Computed ${comparison.generated_at}\nWindow ${comparison.window_start} → ${comparison.window_end}`}
              >
                generated {formatRelative(comparison.generated_at)}
              </span>
            }>
              <Scale size={11} /> {comparison.portfolio.name}
              <span className="bp-pill bp-pill-grey" style={{ fontSize: 8.5 }}>
                {comparison.businesses.length} business(es)
              </span>
              {comparison.coverage.businesses_degraded > 0 && (
                <span className="bp-pill bp-pill-amber" style={{ fontSize: 8.5 }}>
                  {comparison.coverage.businesses_degraded} degraded
                </span>
              )}
              {comparison.coverage.businesses_unavailable > 0 && (
                <span className="bp-pill bp-pill-red" style={{ fontSize: 8.5 }}>
                  {comparison.coverage.businesses_unavailable} unavailable
                </span>
              )}
            </SectionTitle>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={{
                      textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid var(--bp-border)',
                      position: 'sticky', left: 0, background: 'var(--bp-surface)', zIndex: 2,
                      fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)',
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>
                      Metric
                    </th>
                    {comparison.businesses.map((b) => (
                      <th key={b.business_id} style={{
                        textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid var(--bp-border)', minWidth: 128,
                      }}>
                        <div style={{ fontFamily: DISPLAY, fontSize: 12, fontWeight: 600, color: 'var(--bp-text)' }}>
                          {b.business_name}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                          <span
                            className="bp-pill bp-pill-grey"
                            style={{ fontSize: 8 }}
                            title={b.business_type_inferred
                              ? 'Business type is inferred, not human-confirmed. Confirming it in the business profile sharpens the comparability judgements below.'
                              : 'Business type confirmed in the business profile.'}
                          >
                            {b.business_type}{b.business_type_inferred ? '?' : ''}
                          </span>
                          {b.status === 'degraded' && (
                            <span className="bp-pill bp-pill-amber" style={{ fontSize: 8 }} title={`Sections that failed: ${b.failed_sections.join(', ')}`}>
                              degraded
                            </span>
                          )}
                          {b.status === 'unavailable' && (
                            <span className="bp-pill bp-pill-red" style={{ fontSize: 8 }} title={b.unavailable_reason ?? ''}>
                              unavailable
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                    <th style={{
                      textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid var(--bp-border)',
                      borderLeft: '2px solid var(--bp-border)', background: 'var(--bp-surface-2)',
                      fontFamily: MONO, fontSize: 9, color: 'var(--bp-text-3)',
                      letterSpacing: '0.08em', textTransform: 'uppercase', minWidth: 140,
                    }}>
                      Portfolio
                    </th>
                  </tr>
                </thead>

                {grouped.map(({ group, metrics }) => (
                  <tbody key={group}>
                    <tr>
                      <td colSpan={comparison.businesses.length + 2} style={{ padding: '12px 12px 5px' }}>
                        <span
                          title={GROUP_META[group].blurb}
                          style={{
                            fontFamily: DISPLAY, fontSize: 10, fontWeight: 600, letterSpacing: '0.12em',
                            textTransform: 'uppercase', color: 'var(--bp-text-3)', cursor: 'help',
                          }}
                        >
                          {GROUP_META[group].label}
                        </span>
                      </td>
                    </tr>
                    {metrics.map((m) => (
                      <MetricRow key={m.key} metric={m} businesses={comparison.businesses} />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </div>

          {/* ── Membership changes inside the window ─────────────────────── */}
          {comparison.membership_changes_in_window.length > 0 && (
            <div className="bp-card" style={{ marginBottom: 16 }}>
              <SectionTitle><History size={11} /> Membership changed during this window</SectionTitle>
              <p style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--bp-text-3)', margin: '0 0 10px', lineHeight: 1.55 }}>
                A business that joined or left partway through has not been observed for the same span as
                the others, so its column covers less time than theirs.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {comparison.membership_changes_in_window.map((e) => (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 10 }}>
                    <span className={`bp-pill ${e.action === 'added' ? 'bp-pill-green' : 'bp-pill-grey'}`} style={{ fontSize: 8.5 }}>
                      {e.action}
                    </span>
                    <span style={{ color: 'var(--bp-text)' }}>{e.business_name ?? e.business_id}</span>
                    <span style={{ color: 'var(--bp-text-3)' }}>{formatRelative(e.occurred_at)}</span>
                    {e.reason && <span style={{ color: 'var(--bp-text-3)' }}>— {e.reason}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Where to go next ────────────────────────────────────────── */}
          <div className="bp-card">
            <SectionTitle><ChevronRight size={11} /> Drill down</SectionTitle>
            <p style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--bp-text-3)', margin: '0 0 10px', lineHeight: 1.55 }}>
              Every cell above links into the business-scoped surface that owns the record. For decision
              triage across businesses rather than comparison, use the Command Centre.
            </p>
            <Link
              to="/command-centre"
              style={{ fontFamily: MONO, fontSize: 10, color: 'var(--bp-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              Executive Command Centre <ArrowRight size={10} />
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
