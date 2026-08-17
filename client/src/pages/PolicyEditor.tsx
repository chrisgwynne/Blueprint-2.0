/**
 * Per-business Operating Policy editor (#68).
 *
 * Deliberately scoped to the ONE business currently selected in the
 * sidebar — there is no "all businesses" mode, because editing governance
 * across businesses by accident is exactly the failure this feature exists
 * to prevent. Portfolio-scope policies are read here (as inherited values)
 * and authored through the portfolio API.
 *
 * Follows the layout conventions of TrustOps.tsx: bp-panel sections,
 * bp-input/bp-btn controls, inline styles with CSS custom properties.
 */
import React, { useEffect, useMemo, useState } from 'react'
import useStore from '../lib/store.js'
import {
  cancelScheduledOperatingPolicy,
  getOperatingPolicy,
  previewOperatingPolicy,
  rollbackOperatingPolicy,
  saveOperatingPolicy,
} from '../lib/api.js'

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'grey'

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bp-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>
        {subtitle ? <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bp-text-3)', lineHeight: 1.45 }}>{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Pill({ children, tone = 'grey' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`bp-pill bp-pill-${tone}`} style={{ fontSize: 10, padding: '2px 6px' }}>{children}</span>
}

function toneForState(state: string): Tone {
  if (state === 'active') return 'green'
  if (state === 'scheduled') return 'amber'
  return 'grey'
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--bp-text-2)' }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 10, color: 'var(--bp-text-3)', lineHeight: 1.4 }}>{hint}</span> : null}
    </label>
  )
}

/** Text input that maps '' to null, so "uncapped" is expressible. */
function NullableNumberInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <input
      className="bp-input"
      type="number"
      placeholder="uncapped"
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

function NumberInput({ value, onChange, step }: { value: number; onChange: (v: number) => void; step?: string }) {
  return (
    <input className="bp-input" type="number" step={step} value={Number.isFinite(value) ? String(value) : ''}
      onChange={(e) => onChange(Number(e.target.value))} />
  )
}

function CsvInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <input
      className="bp-input"
      placeholder={placeholder}
      value={value.join(', ')}
      onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
    />
  )
}

const TIERS = ['green', 'yellow', 'orange', 'red'] as const

/* eslint-disable @typescript-eslint/no-explicit-any -- policy documents are
   validated server-side; mirroring the full nested type in the client would
   duplicate the schema without adding a guarantee. */
type Doc = any

function ViolationList({ violations }: { violations: Array<{ code: string; field: string; message: string; waivable: boolean }> }) {
  if (violations.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {violations.map((v, i) => (
        <div key={`${v.code}-${i}`} style={{ border: '1px solid var(--bp-red)', borderRadius: 6, padding: 10, background: 'rgba(255,0,0,0.06)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
            <Pill tone="red">{v.code}</Pill>
            <span style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>{v.field}</span>
            {v.waivable ? <Pill tone="amber">acknowledgeable</Pill> : null}
          </div>
          <div style={{ fontSize: 12, color: 'var(--bp-text)', lineHeight: 1.45 }}>{v.message}</div>
        </div>
      ))}
    </div>
  )
}

export default function PolicyEditor() {
  const business = useStore((s) => s.currentBusiness)
  const [state, setState] = useState<any>({ loading: true })
  const [draft, setDraft] = useState<Doc | null>(null)
  const [reason, setReason] = useState('')
  const [effectiveAt, setEffectiveAt] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null)

  async function load() {
    if (!business) return
    setState((s: any) => ({ ...s, loading: true, error: null }))
    try {
      const data = await getOperatingPolicy(business.id)
      setState({ loading: false, ...data })
      // Edit against the EFFECTIVE document (inheritance applied), which is
      // what the operator is actually changing the behaviour of.
      setDraft(JSON.parse(JSON.stringify(data.effective.document)))
      setPreview(null)
    } catch (err: any) {
      setState({ loading: false, error: err.message })
    }
  }
  useEffect(() => { load(); setReason(''); setEffectiveAt(''); setNotice(null) }, [business?.id])

  const activeVersion = state.active?.version ?? 0
  const violations = useMemo(() => (preview?.violations ?? []) as any[], [preview])

  function edit(section: string, key: string, value: unknown) {
    setDraft((d: Doc) => ({ ...d, [section]: { ...d[section], [key]: value } }))
    setPreview(null)
    setNotice(null)
  }
  function editTop(key: string, value: unknown) {
    setDraft((d: Doc) => ({ ...d, [key]: value }))
    setPreview(null)
    setNotice(null)
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setNotice(null)
    try {
      await fn()
    } catch (err: any) {
      setNotice({ tone: 'red', text: `${label} failed: ${err.message}` })
    } finally {
      setBusy(false)
    }
  }

  async function doPreview() {
    if (!business || !draft) return
    await run('Preview', async () => {
      const res: any = await previewOperatingPolicy(business.id, draft, effectiveAt || null)
      setPreview(res.preview)
      setNotice(res.preview.valid
        ? { tone: 'green', text: `Valid. ${res.preview.changes.length} field(s) would change; nothing has been saved.` }
        : { tone: 'red', text: `${res.preview.violations.length} problem(s) — fix them before saving.` })
    })
  }

  async function doSave() {
    if (!business || !draft) return
    await run('Save', async () => {
      await saveOperatingPolicy(business.id, {
        patch: draft,
        effective_at: effectiveAt || null,
        change_reason: reason || null,
        base_version: activeVersion || null,
      })
      setNotice({ tone: 'green', text: effectiveAt ? `Scheduled to take effect at ${effectiveAt}.` : 'Saved and active now.' })
      setReason(''); setEffectiveAt('')
      await load()
    })
  }

  async function doRollback(version: number) {
    if (!business) return
    await run('Rollback', async () => {
      await rollbackOperatingPolicy(business.id, version, reason || `Rolled back to version ${version} from the policy editor.`)
      setNotice({ tone: 'green', text: `Version ${version} restored as a new version. Full history is retained.` })
      setReason('')
      await load()
    })
  }

  async function doCancel(version: number) {
    if (!business) return
    await run('Cancel schedule', async () => {
      await cancelScheduledOperatingPolicy(business.id, version, reason || null)
      setNotice({ tone: 'green', text: `Scheduled version ${version} cancelled.` })
      await load()
    })
  }

  if (!business) return <div className="p-6">No business selected.</div>
  if (state.loading) return <div className="p-6">Loading operating policy...</div>
  if (state.error) return <div className="p-6 text-red-400">{state.error}</div>
  if (!draft) return <div className="p-6">No policy document available.</div>

  const effective = state.effective
  const scheduled = (state.scheduled ?? []) as any[]

  return (
    <div className="page" style={{ padding: 24, display: 'grid', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 24, margin: 0 }}>Operating Policy</h1>
        <p style={{ color: 'var(--bp-text-3)', marginTop: 4 }}>
          Thresholds, approval requirements, autonomy limits, priorities and connector rules for <strong>{business.name}</strong> — and nothing else.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Pill tone={effective.policy_version ? 'green' : 'grey'}>in force: v{effective.policy_version}</Pill>
          <Pill tone="blue">{effective.policy_scope}</Pill>
          {effective.portfolio_id ? <Pill tone="amber">inherits portfolio v{effective.portfolio_policy_version ?? '—'}</Pill> : null}
          <span style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>{effective.citation}</span>
        </div>
      </div>

      {notice ? (
        <div className="bp-panel" style={{ padding: 12, borderColor: `var(--bp-${notice.tone === 'red' ? 'red' : notice.tone === 'green' ? 'green' : 'amber'})` }}>
          <span style={{ fontSize: 12 }}>{notice.text}</span>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        <Section title="Risk thresholds" subtitle="Where an action crosses from routine into review, and from review into blocked. Review thresholds must sit strictly below their block thresholds.">
          <Field label="Financial exposure — review (GBP, at or above)">
            <NumberInput value={draft.thresholds.financial_exposure_review_gbp} onChange={(v) => edit('thresholds', 'financial_exposure_review_gbp', v)} />
          </Field>
          <Field label="Financial exposure — block (GBP, at or above)">
            <NumberInput value={draft.thresholds.financial_exposure_block_gbp} onChange={(v) => edit('thresholds', 'financial_exposure_block_gbp', v)} />
          </Field>
          <Field label="Affected records — review (above)">
            <NumberInput value={draft.thresholds.affected_records_review} onChange={(v) => edit('thresholds', 'affected_records_review', v)} />
          </Field>
          <Field label="Affected records — block (above)">
            <NumberInput value={draft.thresholds.affected_records_block} onChange={(v) => edit('thresholds', 'affected_records_block', v)} />
          </Field>
          <Field label="Minimum agent confidence" hint="A probability between 0 and 1 — 0.55, not 55.">
            <NumberInput step="0.01" value={draft.thresholds.min_agent_confidence} onChange={(v) => edit('thresholds', 'min_agent_confidence', v)} />
          </Field>
        </Section>

        <Section title="Approval requirements" subtitle="Who must sign off on what. 'Not enforced' leaves approval mode and the executor's own gates in charge, exactly as before this policy existed.">
          <Field label="Highest tier auto-approvable without a human" hint="'red' is never permitted; 'orange' must be acknowledged as a risk below.">
            <select className="bp-input" value={draft.approvals.auto_approve_max_tier ?? ''} onChange={(e) => edit('approvals', 'auto_approve_max_tier', e.target.value === '' ? null : e.target.value)}>
              <option value="">not enforced by policy</option>
              <option value="none">none — always require a human</option>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Always require a human at or above tier">
            <select className="bp-input" value={draft.approvals.require_human_approval_at_or_above} onChange={(e) => edit('approvals', 'require_human_approval_at_or_above', e.target.value)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Require a second reviewer at or above tier">
            <select className="bp-input" value={draft.approvals.second_reviewer_at_or_above} onChange={(e) => edit('approvals', 'second_reviewer_at_or_above', e.target.value)}>
              <option value="none">none</option>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Action types that always need a human" hint="Comma-separated registered action types, e.g. shopify_product_update, github_pr">
            <CsvInput value={draft.approvals.always_require_human_action_types} onChange={(v) => edit('approvals', 'always_require_human_action_types', v)} placeholder="none" />
          </Field>
        </Section>

        <Section title="Autonomy limits" subtitle="What Blueprint may do unattended. None of this constrains a human approving through the dashboard.">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={draft.autonomy.allow_autonomous_execution} onChange={(e) => edit('autonomy', 'allow_autonomous_execution', e.target.checked)} />
            Allow autonomous execution (master switch)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={draft.autonomy.dry_run} onChange={(e) => edit('autonomy', 'dry_run', e.target.checked)} />
            Dry run — evaluate and record, act on nothing
          </label>
          <Field label="Max autonomous approvals per day" hint="Blank means uncapped. Use the master switch, not 0, to stop autonomy.">
            <NullableNumberInput value={draft.autonomy.max_autonomous_tasks_per_day} onChange={(v) => edit('autonomy', 'max_autonomous_tasks_per_day', v)} />
          </Field>
          <Field label="Max autonomous spend per day (GBP)">
            <NullableNumberInput value={draft.autonomy.max_autonomous_spend_gbp_per_day} onChange={(v) => edit('autonomy', 'max_autonomous_spend_gbp_per_day', v)} />
          </Field>
        </Section>

        <Section title="Connector applicability" subtitle="Which data sources this business may act through. A connector cannot be both allowed and blocked, and a required connector cannot be blocked.">
          <Field label="Allowed connector types" hint="Blank means no restriction.">
            <CsvInput value={draft.connectors.allowed_connector_types} onChange={(v) => edit('connectors', 'allowed_connector_types', v)} placeholder="no restriction" />
          </Field>
          <Field label="Blocked connector types">
            <CsvInput value={draft.connectors.blocked_connector_types} onChange={(v) => edit('connectors', 'blocked_connector_types', v)} placeholder="none" />
          </Field>
          <Field label="Required connector types" hint="Must be connected before autonomous action is permitted.">
            <CsvInput value={draft.connectors.required_connector_types} onChange={(v) => edit('connectors', 'required_connector_types', v)} placeholder="none" />
          </Field>
          <Field label="Maximum data age (hours)" hint="Over 336 hours with autonomy on must be acknowledged as a risk.">
            <NumberInput value={draft.connectors.max_data_age_hours} onChange={(v) => edit('connectors', 'max_data_age_hours', v)} />
          </Field>
        </Section>

        <Section title="Priorities" subtitle="How competing work is weighted. Objective weights must sum to 1.0 when any is set.">
          <Field label="Objective weights" hint='JSON object, e.g. {"revenue": 0.6, "risk_reduction": 0.4}. Leave as {} for default ranking.'>
            <textarea
              className="bp-input" rows={3}
              value={JSON.stringify(draft.priorities.objective_weights, null, 0)}
              onChange={(e) => {
                try { edit('priorities', 'objective_weights', JSON.parse(e.target.value || '{}')) }
                catch { /* keep the last parseable value; the server validates the final document */ }
              }}
            />
          </Field>
          <Field label="Maximum open tasks" hint="Blank means uncapped.">
            <NullableNumberInput value={draft.priorities.max_open_tasks} onChange={(v) => edit('priorities', 'max_open_tasks', v)} />
          </Field>
          <Field label="Acknowledged risks" hint="Validation codes an operator has explicitly accepted, e.g. unsafe_auto_approve_orange.">
            <CsvInput value={draft.acknowledged_risks} onChange={(v) => editTop('acknowledged_risks', v)} placeholder="none" />
          </Field>
          <Field label="Notes">
            <textarea className="bp-input" rows={2} value={draft.notes ?? ''} onChange={(e) => editTop('notes', e.target.value || null)} />
          </Field>
        </Section>

        <Section title="Preview, schedule and save" subtitle="Preview validates and computes the impact without writing anything. A future effective time schedules the change instead of applying it.">
          <Field label="Reason for this change" hint="Recorded in the policy audit trail.">
            <input className="bp-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Reduced autonomy during migration" />
          </Field>
          <Field label="Effective at" hint="Leave blank to apply immediately.">
            <input className="bp-input" type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="bp-btn" disabled={busy} onClick={doPreview}>Preview</button>
            <button className="bp-btn bp-btn-primary" disabled={busy} onClick={doSave}>
              {effectiveAt ? 'Schedule' : 'Save and activate'}
            </button>
            <button className="bp-btn" disabled={busy} onClick={load}>Discard changes</button>
          </div>
          <ViolationList violations={violations} />
          {preview ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>
                v{preview.current_version} → v{preview.next_version} · {preview.would_activate_immediately ? 'immediate' : `scheduled for ${preview.effective_at}`}
              </div>
              {preview.changes.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--bp-text-3)' }}>No field differs from the policy in force.</div>
              ) : (
                <div style={{ display: 'grid', gap: 4 }}>
                  {preview.changes.map((c: any) => (
                    <div key={c.field} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 11 }}>
                      <span style={{ color: 'var(--bp-text-2)' }}>{c.field}</span>
                      <span style={{ color: 'var(--bp-text-3)' }}>{JSON.stringify(c.from)} → {JSON.stringify(c.to)}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.impacts.map((i: any, n: number) => (
                <div key={`${i.kind}-${n}`} style={{ fontSize: 11, color: 'var(--bp-text-2)', borderLeft: '2px solid var(--bp-border)', paddingLeft: 8 }}>
                  <strong>{i.kind}</strong> — {i.summary}
                </div>
              ))}
            </div>
          ) : null}
        </Section>
      </div>

      {scheduled.length > 0 ? (
        <Section title="Scheduled changes" subtitle="Not yet in force. Cancelling one keeps it in the history rather than deleting it.">
          <div style={{ display: 'grid', gap: 8 }}>
            {scheduled.map((v: any) => (
              <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                <Pill tone="amber">v{v.version}</Pill>
                <span style={{ color: 'var(--bp-text-2)' }}>effective {v.effective_at}</span>
                <span style={{ color: 'var(--bp-text-3)' }}>{v.change_reason ?? 'no reason recorded'}</span>
                <button className="bp-btn" disabled={busy} onClick={() => doCancel(v.version)}>Cancel</button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Version history" subtitle="Every version ever written, newest first. Rolling back re-activates a prior version as a new version — nothing is deleted.">
        {(state.versions ?? []).length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--bp-text-3)' }}>No policy has been authored for this business yet; system defaults are in force.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {(state.versions as any[]).map((v) => (
              <div key={v.id} style={{ border: '1px solid var(--bp-border)', borderRadius: 6, padding: 10 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Pill tone={toneForState(v.state)}>v{v.version} · {v.state}</Pill>
                  <Pill tone="grey">{v.source}</Pill>
                  <span style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>{v.created_by} · {v.created_at}</span>
                  {v.state !== 'active' ? (
                    <button className="bp-btn" disabled={busy} style={{ marginLeft: 'auto' }} onClick={() => doRollback(v.version)}>
                      Roll back to v{v.version}
                    </button>
                  ) : null}
                </div>
                {v.change_reason ? <div style={{ fontSize: 12, color: 'var(--bp-text-2)', marginTop: 6 }}>{v.change_reason}</div> : null}
                {v.rolled_back_from_version != null ? (
                  <div style={{ fontSize: 11, color: 'var(--bp-text-3)', marginTop: 4 }}>Restored from version {v.rolled_back_from_version}.</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Audit history" subtitle="Who changed what, when and why — including edits that were rejected as unsafe.">
        {(state.events ?? []).length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--bp-text-3)' }}>No policy activity recorded for this business.</div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {(state.events as any[]).slice(0, 50).map((e) => (
              <div key={e.id} style={{ display: 'grid', gap: 4, borderBottom: '1px solid var(--bp-border)', paddingBottom: 6 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Pill tone={e.event_type === 'rejected' ? 'red' : e.event_type === 'activated' ? 'green' : 'grey'}>{e.event_type}</Pill>
                  <span style={{ fontSize: 11, color: 'var(--bp-text-2)' }}>v{e.version} · {e.actor}</span>
                  <span style={{ fontSize: 11, color: 'var(--bp-text-3)' }}>{e.created_at}</span>
                </div>
                {e.reason ? <div style={{ fontSize: 11, color: 'var(--bp-text-2)' }}>{e.reason}</div> : null}
                {(e.changed_fields ?? []).length > 0 ? (
                  <div style={{ fontSize: 10, color: 'var(--bp-text-3)' }}>
                    {(e.changed_fields as any[]).map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(' · ')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
