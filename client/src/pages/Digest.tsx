/**
 * "What happened while I was away?" (issue #62).
 *
 * The catch-up page. Its job is to let someone who has been away for a day
 * or a fortnight re-enter safely, and the layout encodes what "safely"
 * means: the four sections are ordered by what it would cost to miss them,
 * not by volume or recency.
 *
 *   1. Failures & stale data — read this FIRST. If connectors are broken,
 *      everything below is being computed from data that stopped updating,
 *      and a quiet digest may mean a blind one.
 *   2. Needs your decision — the only section with an action attached.
 *   3. Verified outcomes — things that were actually measured.
 *   4. Activity — work happened. No outcome claimed. Collapsed by default,
 *      because this is the section that used to drown out the other three.
 *
 * Everything rendered here is computed server-side in
 * server/digest/away-digest.ts. This page classifies nothing, ranks
 * nothing and summarises nothing on its own — if it did, the UI could
 * disagree with the acknowledgement the server records.
 *
 * Every item shows its source row, because an item you cannot check is an
 * item you should not act on.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Activity, Check, CheckCircle2, ChevronDown, ChevronRight,
  ExternalLink, Gavel, History, Inbox, RotateCcw, TrendingUp,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import useStore from '../lib/store.js'
import { acknowledgeDigest, getAwayDigest } from '../lib/api.js'

type Section =
  | 'failures_and_stale_data'
  | 'pending_decisions'
  | 'verified_outcomes'
  | 'informational_activity'

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

interface DigestSource {
  kind: string
  table: string
  row_id: string
  href: string
  external_permalink?: string | null
  evidence: Record<string, unknown>
}

interface DigestEscalation {
  reason: string
  from_severity: Severity
  to_severity: Severity
  from_source: DigestSource
  to_source: DigestSource
}

interface DigestItem {
  dedup_key: string
  change_fingerprint: string
  section: Section
  business_id: string
  business_name: string | null
  status: string
  severity: Severity
  title: string
  detail: string | null
  occurred_at: string
  source: DigestSource
  occurrences: DigestSource[]
  occurrence_count: number
  first_occurrence_at: string
  last_occurrence_at: string
  escalation: DigestEscalation | null
  previously_seen: boolean
  replay_reason: string | null
}

interface BusinessGroup {
  business_id: string
  business_name: string | null
  sections: Record<Section, DigestItem[]>
  status_counts: Record<Section, Record<string, number>>
  total_items: number
}

interface Digest {
  digest_schema_version: number
  digest_id: string
  operator_key: string
  scope: string
  window: {
    start: string
    end: string
    source: 'watermark' | 'explicit_since' | 'default_lookback'
    watermark_applied: boolean
    watermark_at: string | null
  }
  generated_at: string
  businesses: BusinessGroup[]
  totals: Record<string, number>
  suppressed_as_seen: number
  acknowledgeable: Record<string, string>
}

// Ordered by cost-of-missing, not by volume. See the file docstring.
const SECTION_ORDER: Section[] = [
  'failures_and_stale_data', 'pending_decisions', 'verified_outcomes', 'informational_activity',
]

const SECTION_META: Record<Section, {
  label: string
  blurb: string
  colour: string
  Icon: typeof AlertTriangle
  defaultOpen: boolean
}> = {
  failures_and_stale_data: {
    label: 'FAILURES & STALE DATA',
    blurb: 'Something is broken or out of date. Anything below may be computed from data that stopped updating.',
    colour: 'var(--bp-red)',
    Icon: AlertTriangle,
    defaultOpen: true,
  },
  pending_decisions: {
    label: 'NEEDS YOUR DECISION',
    blurb: 'Waiting on a human. Nothing here proceeds on its own.',
    colour: 'var(--bp-amber)',
    Icon: Gavel,
    defaultOpen: true,
  },
  verified_outcomes: {
    label: 'VERIFIED OUTCOMES',
    blurb: 'Actually measured, with the measurement record attached. Not "a task completed".',
    colour: 'var(--bp-green)',
    Icon: TrendingUp,
    defaultOpen: true,
  },
  informational_activity: {
    label: 'ACTIVITY',
    blurb: 'Work happened. No outcome is claimed for any of it.',
    colour: 'var(--bp-text-3)',
    Icon: Activity,
    defaultOpen: false,
  },
}

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: 'var(--bp-red)',
  high: 'var(--bp-red)',
  medium: 'var(--bp-amber)',
  low: 'var(--bp-blue)',
  info: 'var(--bp-text-3)',
}

const mono = 'var(--bp-font-mono)'

function rel(iso?: string | null): string {
  if (!iso) return '—'
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return '—' }
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: mono, fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
      color: 'var(--bp-text-3)', marginBottom: 4,
    }}>{children}</div>
  )
}

/**
 * The citation. Deliberately shows the raw table and row id alongside the
 * link: the link is convenience, the row is the evidence, and a reader
 * should be able to go and look the record up directly.
 */
function SourceLine({ source }: { source: DigestSource }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
      <Link
        to={source.href}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontFamily: mono, fontSize: 10, color: 'var(--bp-blue)',
        }}
      >
        <ExternalLink size={10} /> View source
      </Link>
      <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)' }}>
        {source.table} · {String(source.row_id).slice(0, 12)}
      </span>
      {source.external_permalink && (
        <a
          href={source.external_permalink}
          target="_blank"
          rel="noreferrer"
          style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-blue)' }}
        >
          external record
        </a>
      )}
    </div>
  )
}

function ItemCard({ item }: { item: DigestItem }) {
  const [open, setOpen] = useState(false)
  const colour = SEVERITY_COLOUR[item.severity] ?? 'var(--bp-text-3)'

  return (
    <div
      className="bp-card"
      style={{ padding: 14, marginBottom: 8, borderLeft: `3px solid ${colour}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
        <span className="bp-pill" style={{ fontSize: 9, color: colour, borderColor: colour }}>
          {item.status}
        </span>

        {/* A collapsed repeat says so, and says how many. */}
        {item.occurrence_count > 1 && (
          <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)' }}>
            ×{item.occurrence_count} · first {rel(item.first_occurrence_at)}
          </span>
        )}

        {/* A previously-acknowledged item that came back is never presented
            as new — the reason it returned is stated. */}
        {item.previously_seen && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: mono, fontSize: 10, color: 'var(--bp-amber)',
          }}>
            <History size={10} /> seen before · changed
          </span>
        )}

        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginLeft: 'auto' }}>
          {rel(item.occurred_at)}
        </span>
      </div>

      <div style={{
        fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 13,
        color: 'var(--bp-text)', marginBottom: 3,
      }}>{item.title}</div>

      {item.detail && (
        <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
          {item.detail}
        </div>
      )}

      {/* An escalation inside a dedup group is the one thing that must not
          be readable as "just another repeat". */}
      {item.escalation && (
        <div style={{
          marginTop: 8, padding: 8, borderRadius: 4,
          background: 'rgba(255, 82, 82, 0.08)', border: '1px solid var(--bp-red)',
        }}>
          <Label>Escalated — not just a repeat</Label>
          <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-2)', lineHeight: 1.5 }}>
            {item.escalation.reason}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
            <Link to={item.escalation.from_source.href} style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-blue)' }}>
              first occurrence ({item.escalation.from_severity})
            </Link>
            <Link to={item.escalation.to_source.href} style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-blue)' }}>
              escalated occurrence ({item.escalation.to_severity})
            </Link>
          </div>
        </div>
      )}

      {item.replay_reason && !item.escalation && (
        <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-amber)', marginTop: 6 }}>
          {item.replay_reason}
        </div>
      )}

      <SourceLine source={item.source} />

      <button
        className="bp-btn bp-btn-ghost"
        style={{ marginTop: 8, fontSize: 10, padding: '3px 8px' }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide evidence' : 'Show evidence'}
      </button>

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--bp-border)' }}>
          <Label>Evidence (copied from the source record)</Label>
          <pre style={{
            fontFamily: mono, fontSize: 10, color: 'var(--bp-text-2)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
          }}>{JSON.stringify(item.source.evidence, null, 2)}</pre>

          {item.occurrence_count > 1 && (
            <div style={{ marginTop: 8 }}>
              <Label>All {item.occurrence_count} occurrences</Label>
              {item.occurrences.map((occurrence, i) => (
                <div key={`${occurrence.table}:${occurrence.row_id}:${i}`}>
                  <SourceLine source={occurrence} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SectionBlock({ section, items, statusCounts }: {
  section: Section
  items: DigestItem[]
  statusCounts: Record<string, number>
}) {
  const meta = SECTION_META[section]
  const [open, setOpen] = useState(meta.defaultOpen)
  const { Icon } = meta

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 4 }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={13} style={{ color: meta.colour }} /> : <ChevronRight size={13} style={{ color: meta.colour }} />}
        <Icon size={13} style={{ color: meta.colour }} />
        <span style={{
          fontFamily: mono, fontSize: 10, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: meta.colour, fontWeight: 700,
        }}>{meta.label}</span>
        <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-3)' }}>
          {items.length}
        </span>
      </div>

      <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginBottom: 8, paddingLeft: 21 }}>
        {meta.blurb}
      </div>

      {open && (
        <div style={{ paddingLeft: 21 }}>
          {/* Grouped by status, so "3 failing, 2 stale" is legible before
              reading a single card. */}
          {Object.keys(statusCounts).length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {Object.entries(statusCounts).map(([status, count]) => (
                <span key={status} className="bp-pill" style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
                  {status} · {count}
                </span>
              ))}
            </div>
          )}

          {items.length === 0
            ? <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-3)' }}>Nothing in this section.</div>
            : items.map((item) => <ItemCard key={item.dedup_key} item={item} />)}
        </div>
      )}
    </div>
  )
}

export default function DigestPage() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const businessId = currentBusiness?.id ?? null

  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acknowledging, setAcknowledging] = useState(false)

  // The "since date" override. Empty = default catch-up (use the watermark).
  const [sinceOverride, setSinceOverride] = useState('')
  const [appliedSince, setAppliedSince] = useState<string | null>(null)

  const load = useCallback(async (since: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string> = {}
      if (since) params.since = since
      const data = await getAwayDigest(businessId, params)
      setDigest(data)
      setAppliedSince(since)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => { void load(null) }, [load])

  const onAcknowledge = useCallback(async () => {
    if (!digest) return
    setAcknowledging(true)
    try {
      await acknowledgeDigest({
        business_id: digest.scope === '*' ? null : digest.scope,
        acknowledged_through: digest.window.end,
        digest_id: digest.digest_id,
        items: digest.acknowledgeable,
      })
      // Reload as a default catch-up so the effect of acknowledging is
      // immediately visible rather than asserted.
      setSinceOverride('')
      await load(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAcknowledging(false)
    }
  }, [digest, load])

  const totalItems = digest?.totals?.total ?? 0

  const windowDescription = useMemo(() => {
    if (!digest) return ''
    const { source, start, end } = digest.window
    const startLabel = new Date(start).toLocaleString()
    const endLabel = new Date(end).toLocaleString()
    if (source === 'watermark') return `Since you last caught up — ${startLabel} to ${endLabel}`
    if (source === 'explicit_since') return `You asked for ${startLabel} to ${endLabel} (watermark ignored)`
    return `First catch-up — last 7 days (${startLabel} to ${endLabel})`
  }, [digest])

  return (
    <div style={{ padding: 20, maxWidth: 980, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Inbox size={16} style={{ color: 'var(--bp-blue)' }} />
          <h1 style={{
            fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 18,
            color: 'var(--bp-text)', margin: 0,
          }}>What happened while I was away?</h1>
        </div>
        <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--bp-text-3)' }}>
          {windowDescription}
        </div>
      </div>

      {/* Controls: acknowledge, and the explicit "since" override. */}
      <div className="bp-card" style={{ padding: 14, marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <Label>Show me everything since</Label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="bp-input"
                type="date"
                value={sinceOverride}
                onChange={(e) => setSinceOverride(e.target.value)}
                style={{ fontSize: 11, padding: '4px 8px' }}
              />
              <button
                className="bp-btn bp-btn-secondary"
                style={{ fontSize: 11 }}
                disabled={!sinceOverride || loading}
                onClick={() => void load(new Date(`${sinceOverride}T00:00:00Z`).toISOString())}
              >
                Re-read period
              </button>
              {appliedSince && (
                <button
                  className="bp-btn bp-btn-ghost"
                  style={{ fontSize: 11 }}
                  disabled={loading}
                  onClick={() => { setSinceOverride(''); void load(null) }}
                >
                  <RotateCcw size={11} /> Back to catch-up
                </button>
              )}
            </div>
          </div>

          <div style={{ marginLeft: 'auto' }}>
            <button
              className="bp-btn bp-btn-primary"
              style={{ fontSize: 11 }}
              disabled={acknowledging || loading || !digest || totalItems === 0}
              onClick={() => void onAcknowledge()}
            >
              <Check size={12} /> {acknowledging ? 'Marking…' : `Mark ${totalItems} item(s) as read`}
            </button>
          </div>
        </div>

        {/* An explicit re-read must not silently cost you your catch-up
            position, so the page says so rather than leaving it to be
            discovered. */}
        {appliedSince && (
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 8 }}>
            Re-reading a period ignores your catch-up point but does not move it.
            {digest?.window.watermark_at
              ? ` You last caught up ${rel(digest.window.watermark_at)}.`
              : ' You have not acknowledged a digest yet.'}
          </div>
        )}

        {/* "Nothing new" and "nothing happened" are different answers. */}
        {!appliedSince && (digest?.suppressed_as_seen ?? 0) > 0 && (
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 8 }}>
            {digest!.suppressed_as_seen} unchanged item(s) hidden because you already acknowledged them.
          </div>
        )}
      </div>

      {loading && (
        <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--bp-text-3)' }}>Assembling digest…</div>
      )}

      {error && (
        <div className="bp-card" style={{ padding: 14, borderLeft: '3px solid var(--bp-red)' }}>
          <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--bp-red)' }}>{error}</div>
        </div>
      )}

      {!loading && !error && digest && digest.businesses.length === 0 && (
        <div className="bp-card" style={{ padding: 20, textAlign: 'center' }}>
          <CheckCircle2 size={20} style={{ color: 'var(--bp-green)', marginBottom: 6 }} />
          <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--bp-text-2)' }}>
            Nothing to report for this period.
          </div>
          {digest.suppressed_as_seen > 0 && (
            <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--bp-text-3)', marginTop: 4 }}>
              ({digest.suppressed_as_seen} unchanged item(s) you have already acknowledged are hidden.)
            </div>
          )}
        </div>
      )}

      {!loading && !error && digest?.businesses.map((group) => (
        <div key={group.business_id} style={{ marginBottom: 28 }}>
          {/* The business header only earns its space in a multi-business
              digest; scoped to one business it is redundant chrome. */}
          {digest.scope === '*' && (
            <div style={{
              fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14,
              color: 'var(--bp-text)', marginBottom: 10,
              paddingBottom: 6, borderBottom: '1px solid var(--bp-border)',
            }}>
              {group.business_name ?? group.business_id}
              <span style={{ fontFamily: mono, fontWeight: 400, fontSize: 11, color: 'var(--bp-text-3)', marginLeft: 8 }}>
                {group.total_items} item(s)
              </span>
            </div>
          )}

          {SECTION_ORDER.map((section) => (
            <SectionBlock
              key={section}
              section={section}
              items={group.sections[section] ?? []}
              statusCounts={group.status_counts[section] ?? {}}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
