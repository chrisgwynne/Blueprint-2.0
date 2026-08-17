import { describe, test, expect } from 'bun:test'
import {
  eventTone, eventToneColor, formatEventDuration, relatedResourceLabel,
} from './run-event-trace-view.ts'

describe('an error_category always reads as an error', () => {
  test('error_category wins even when status sounds fine', () => {
    expect(eventTone('verified', 'provider_timeout')).toBe('error')
    expect(eventTone('attempted', 'llm_error')).toBe('error')
  })

  test('a known warn status without an error_category is warn, not error', () => {
    expect(eventTone('blocked', null)).toBe('warn')
    expect(eventTone('cancelled', undefined)).toBe('warn')
  })

  test('a known ok status is ok', () => {
    expect(eventTone('verified', null)).toBe('ok')
  })

  test('an unrecognized status is neutral, not silently ok', () => {
    expect(eventTone('attempted', null)).toBe('neutral')
    expect(eventTone(null, null)).toBe('neutral')
  })

  test('every tone maps to a distinct colour token', () => {
    const tones = ['ok', 'warn', 'error', 'neutral'] as const
    const colors = tones.map(eventToneColor)
    expect(new Set(colors).size).toBe(tones.length)
  })
})

describe('duration formatting never invents a number', () => {
  test('missing duration renders as a dash', () => {
    expect(formatEventDuration(null)).toBe('—')
    expect(formatEventDuration(undefined)).toBe('—')
    expect(formatEventDuration(NaN)).toBe('—')
  })

  test('sub-second durations render in ms', () => {
    expect(formatEventDuration(240)).toBe('240ms')
  })

  test('durations at or over a second render in seconds', () => {
    expect(formatEventDuration(1500)).toBe('1.5s')
  })
})

describe('related resource label', () => {
  test('renders type#id when both are present', () => {
    expect(relatedResourceLabel('task', 'tsk_1')).toBe('task#tsk_1')
  })

  test('omits (returns null) when either half is missing', () => {
    expect(relatedResourceLabel(null, 'tsk_1')).toBeNull()
    expect(relatedResourceLabel('task', null)).toBeNull()
    expect(relatedResourceLabel(undefined, undefined)).toBeNull()
  })
})
