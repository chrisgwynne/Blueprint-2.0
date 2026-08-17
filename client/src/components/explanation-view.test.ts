/**
 * Explanation panel rendering rules (issue #60).
 *
 * These are the UI-side half of the contract: the server can be perfectly
 * honest about what it does not know and the panel can still throw that
 * away by rendering a hole as a dash, a zero, or the same colour as a real
 * finding. Each test below pins one of those failure modes shut, across the
 * same five cases the server suite covers — success, no-op, suppression,
 * fallback and failure.
 */
import { describe, test, expect } from 'bun:test'
import {
  dispositionPill, qualityStyle, causalTone, alternativePill,
  renderField, fieldCitation, needsCaution,
  type ComparableFieldView,
} from './explanation-view.js'

const known = (value: unknown, citation = 'tasks#t1'): ComparableFieldView =>
  ({ state: 'known', value, citation, reason: null })
const unknown = (reason: string): ComparableFieldView =>
  ({ state: 'unknown', value: null, citation: null, reason })
const notComparable = (reason: string): ComparableFieldView =>
  ({ state: 'not_comparable', value: null, citation: null, reason })

describe('renderField — a hole is never rendered as data', () => {
  test('a known string renders its value as data', () => {
    expect(renderField(known('checkout_conversion_rate'))).toEqual({
      text: 'checkout_conversion_rate', isReason: false,
    })
  })

  test('a known zero renders as 0, not as absent', () => {
    // The mirror-image mistake: a real measured zero must not be swallowed.
    expect(renderField(known(0))).toEqual({ text: '0', isReason: false })
    expect(renderField(known(false))).toEqual({ text: 'false', isReason: false })
  })

  test('an unknown field renders its reason, never a dash or a zero', () => {
    const r = renderField(unknown('No target metric is linked to this task.'))
    expect(r.isReason).toBe(true)
    expect(r.text).toBe('No target metric is linked to this task.')
    expect(r.text).not.toBe('—')
    expect(r.text).not.toBe('0')
    expect(r.text).not.toBe('')
  })

  test('a not_comparable field renders its reason too', () => {
    const r = renderField(notComparable('Does not apply to this decision.'))
    expect(r.isReason).toBe(true)
    expect(r.text).toContain('Does not apply')
  })

  test('an absent field falls back to an explicit statement, not a blank', () => {
    expect(renderField(null).isReason).toBe(true)
    expect(renderField(undefined).text).toBe('Not recorded.')
  })

  test('a malformed known field with no value refuses to render a blank', () => {
    const malformed: ComparableFieldView = { state: 'known', value: null, citation: 'x', reason: 'value went missing' }
    const r = renderField(malformed)
    expect(r.isReason).toBe(true)
    expect(r.text).toBe('value went missing')
  })

  test('a structured value is rendered in full rather than summarised away', () => {
    const r = renderField(known({ status: 'not_applicable', reason: 'capability restricted' }))
    expect(r.isReason).toBe(false)
    expect(r.text).toContain('capability restricted')
  })
})

describe('qualityStyle — missing and negative must never look alike', () => {
  test('missing evidence reads as a gap, not as a finding', () => {
    const q = qualityStyle('missing')
    expect(q.label).toBe('no record')
  })

  test('negative evidence reads as a finding, not as a gap', () => {
    const q = qualityStyle('negative')
    expect(q.label).toBe('negative finding')
  })

  test('the two are visually and verbally distinct', () => {
    expect(qualityStyle('missing').colour).not.toBe(qualityStyle('negative').colour)
    expect(qualityStyle('missing').label).not.toBe(qualityStyle('negative').label)
  })

  test('stale and degraded are distinguished from both fresh and missing', () => {
    const labels = ['fresh', 'stale', 'degraded', 'missing', 'negative'].map((q) => qualityStyle(q).label)
    expect(new Set(labels).size).toBe(5)
  })

  test('an unrecognised quality degrades to not_applicable rather than to "recorded"', () => {
    expect(qualityStyle('something_new').label).toBe('not applicable')
  })
})

describe('causalTone — a correlational result is never painted as verified', () => {
  test('only a verified causal claim gets the confident tone', () => {
    expect(causalTone('verified_causal')).toBe('var(--bp-green)')
    expect(causalTone('correlational')).not.toBe(causalTone('verified_causal'))
    expect(causalTone('expected_only')).not.toBe(causalTone('verified_causal'))
    expect(causalTone('not_established')).not.toBe(causalTone('verified_causal'))
  })

  test('an unknown claim never inherits the confident tone', () => {
    expect(causalTone('definitely_caused_it')).not.toBe(causalTone('verified_causal'))
  })
})

describe('dispositionPill — a no-op, a suppression and a deferral all render', () => {
  test('every disposition has its own treatment', () => {
    for (const d of ['acted', 'in_progress', 'awaiting_decision', 'no_op', 'suppressed', 'deferred', 'rejected', 'failed']) {
      expect(dispositionPill(d)).toBeTruthy()
    }
  })

  test('suppressed is visually distinct from both acted and rejected', () => {
    expect(dispositionPill('suppressed')).not.toBe(dispositionPill('acted'))
    expect(dispositionPill('suppressed')).not.toBe(dispositionPill('rejected'))
  })

  test('failure is distinct from a deliberate no-op', () => {
    expect(dispositionPill('failed')).not.toBe(dispositionPill('no_op'))
  })

  test('a suppressed alternative is distinct from a merely rejected one', () => {
    expect(alternativePill('suppressed')).not.toBe(alternativePill('rejected'))
    expect(alternativePill('gated')).not.toBe(alternativePill('rejected'))
  })
})

describe('fieldCitation — only a known field may claim a citation', () => {
  test('a known field cites its record', () => {
    expect(fieldCitation(known('x', 'signals#s1'), null)).toBe('signals#s1')
  })

  test('an unknown field does not borrow a citation from its own state', () => {
    const stolen: ComparableFieldView = { state: 'unknown', value: null, citation: 'signals#s1', reason: 'no record' }
    expect(fieldCitation(stolen, null)).toBeNull()
  })

  test('a source is used as the fallback attribution when there is one', () => {
    expect(fieldCitation(unknown('no record'), 'tasks#t1.target_metric')).toBe('tasks#t1.target_metric')
  })
})

describe('needsCaution — the five cases, and when the panel must warn', () => {
  const clean = {
    confidence: { degraded: false },
    evidence: { missing_keys: [], stale_keys: [], degraded_keys: [] },
    policy: { reconstructed_from_current: false },
  }

  test('success: a fully evidenced, non-degraded explanation shows no caution band', () => {
    expect(needsCaution(clean)).toBe(false)
  })

  test('no-op: an explanation with evidence holes warns', () => {
    expect(needsCaution({ ...clean, evidence: { missing_keys: ['source_signal'], stale_keys: [], degraded_keys: [] } })).toBe(true)
  })

  test('suppression: a reconstructed policy citation warns', () => {
    expect(needsCaution({ ...clean, policy: { reconstructed_from_current: true } })).toBe(true)
  })

  test('fallback: a degraded decision always warns', () => {
    expect(needsCaution({ ...clean, confidence: { degraded: true } })).toBe(true)
  })

  test('failure: stale or degraded evidence warns', () => {
    expect(needsCaution({ ...clean, evidence: { missing_keys: [], stale_keys: ['signal'], degraded_keys: [] } })).toBe(true)
    expect(needsCaution({ ...clean, evidence: { missing_keys: [], stale_keys: [], degraded_keys: ['provider'] } })).toBe(true)
  })
})
