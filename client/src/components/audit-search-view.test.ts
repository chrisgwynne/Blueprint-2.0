/**
 * Audit search presentation rules (issue #72).
 *
 * These assert the things a UI can get wrong in a way that changes what the
 * user BELIEVES, rather than how the page looks.
 */
import { describe, test, expect } from 'bun:test'
import {
  stateHeadline, stateTone, noResultGuidance, summaryPresentation,
  interpretationNotice, citationLabel, drilldownFor, freshnessWord, shouldWarnStale,
  type AuditSearchState,
} from './audit-search-view.ts'

describe('the four states are visually and verbally distinct', () => {
  const states: AuditSearchState[] = ['results', 'results_stale', 'no_results', 'ambiguous_query']

  test('each state has its own headline', () => {
    const headlines = states.map(stateHeadline)
    expect(new Set(headlines).size).toBe(states.length)
  })

  test('"nothing matched" never reads as "records found"', () => {
    expect(stateHeadline('no_results')).not.toBe(stateHeadline('results'))
    expect(stateHeadline('no_results')).toMatch(/matched nothing/i)
  })

  test('an unanswered question is not presented as an empty result', () => {
    expect(stateHeadline('ambiguous_query')).toMatch(/not searched/i)
  })

  test('stale results are toned as a warning, fresh ones are not', () => {
    expect(stateTone('results_stale')).toBe('warn')
    expect(stateTone('results')).toBe('ok')
  })

  test('the no-result guidance refuses to claim the event did not happen', () => {
    const text = noResultGuidance('business Acme · all record types · all time')
    expect(text).toMatch(/not evidence that the event did not occur/i)
    expect(text).toMatch(/Widen the time range/i)
  })
})

describe('an inferred summary is never dressed up as a record', () => {
  test('a grounded narrative is explicitly marked inferred', () => {
    const p = summaryPresentation('grounded_narrative')
    expect(p.markAsInferred).toBe(true)
    expect(p.heading).toMatch(/inferred/i)
  })

  test('a deterministic count is NOT marked inferred', () => {
    const p = summaryPresentation('deterministic')
    expect(p.markAsInferred).toBe(false)
  })

  test('a withheld summary is announced, not silently omitted', () => {
    const p = summaryPresentation('withheld')
    expect(p.showWithheldExplanation).toBe(true)
    expect(p.heading).toMatch(/withheld/i)
    expect(p.tone).toBe('warn')
    // And it is never presented as though a narrative had been produced.
    expect(p.markAsInferred).toBe(false)
  })
})

describe('a degraded interpretation is always announced', () => {
  test('interpreter unavailability produces a notice', () => {
    const notice = interpretationNotice('interpreter_unavailable', 'deterministic_fallback', '')
    expect(notice).toMatch(/matched literally/i)
  })

  test('a deterministic fallback is announced even if the state claims otherwise', () => {
    // Defensive: the notice keys on either signal, so a payload where only
    // one of the two says "degraded" still warns.
    const notice = interpretationNotice('interpreted', 'deterministic_fallback', 'Keyword: pricing.')
    expect(notice).toMatch(/matched literally/i)
  })

  test('a successful interpretation shows its rationale', () => {
    expect(interpretationNotice('interpreted', 'llm', 'Filtered to decisions in the last 30 days.'))
      .toBe('Filtered to decisions in the last 30 days.')
  })

  test('an un-attempted interpretation shows nothing rather than an invented one', () => {
    expect(interpretationNotice('ambiguous', 'none', '')).toBeNull()
  })
})

describe('every result shows where it came from', () => {
  test('the citation label names both the row and its table', () => {
    const label = citationLabel({
      ref: 'decision#dec_17', record_type: 'decision', record_id: 'dec_17', table: 'decisions',
    })
    expect(label).toContain('decision#dec_17')
    expect(label).toContain('decisions')
  })

  test('every record type has a real drill-down target', () => {
    const types = [
      'decision', 'task', 'receipt', 'outcome',
      'policy_event', 'connector_event', 'signal', 'agent_run', 'audit_event',
    ]
    for (const type of types) {
      const href = drilldownFor(type, null)
      expect(href).not.toBeNull()
      expect(href).not.toBe('/')
    }
  })

  test('the server-computed href wins over the type map', () => {
    expect(drilldownFor('decision', '/decisions?id=dec_1')).toBe('/decisions?id=dec_1')
  })

  test('an unknown record type gets no link rather than a dead one', () => {
    expect(drilldownFor('telepathy_log', null)).toBeNull()
  })
})

describe('freshness is surfaced honestly', () => {
  test('a missing timestamp is not rendered as "current"', () => {
    expect(freshnessWord('unknown')).toBe('no timestamp')
    expect(freshnessWord('unknown')).not.toBe(freshnessWord('fresh'))
  })

  test('stale results warn', () => {
    expect(shouldWarnStale(true, false, 0)).toBe(true)
  })

  test('old results do NOT warn when the user asked about a past period', () => {
    expect(shouldWarnStale(true, true, 0)).toBe(false)
  })

  test('a stale connector warns even when the results themselves are fresh', () => {
    // The connector is the reason a search might be missing events entirely,
    // so it warns independently of the result timestamps.
    expect(shouldWarnStale(false, false, 2)).toBe(true)
  })
})
