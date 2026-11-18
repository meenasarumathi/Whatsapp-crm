import { describe, expect, it } from 'vitest'
import {
  fillContactPlaceholders,
  isWithinSchedule,
  localClock,
  normalizePhone,
  orderedTemplateParams,
  parseNumberList,
  ruleAppliesToTags,
} from './schedule'

// 2026-11-06 is a Friday. 12:30 UTC = 18:00 IST.
const FRI_1800_IST = new Date('2026-11-06T12:30:00Z')
const SAT_0200_IST = new Date('2026-11-06T20:30:00Z')
const SAT_1000_IST = new Date('2026-11-07T04:30:00Z')

const rule = (over: Partial<{ days: number[]; start_time: string; end_time: string; timezone: string }> = {}) => ({
  days: [1, 2, 3, 4, 5],
  start_time: '09:00',
  end_time: '18:00',
  timezone: 'Asia/Kolkata',
  ...over,
})

describe('localClock', () => {
  it('reads weekday and minutes in the given timezone', () => {
    expect(localClock(FRI_1800_IST, 'Asia/Kolkata')).toEqual({ day: 5, minutes: 18 * 60 })
    expect(localClock(FRI_1800_IST, 'UTC')).toEqual({ day: 5, minutes: 12 * 60 + 30 })
  })
  it('falls back to UTC for an unknown zone', () => {
    expect(localClock(FRI_1800_IST, 'Not/AZone')).toEqual({ day: 5, minutes: 12 * 60 + 30 })
  })
})

describe('isWithinSchedule', () => {
  it('same-day window: end is exclusive', () => {
    expect(isWithinSchedule(rule(), new Date('2026-11-06T12:29:00Z'))).toBe(true)
    expect(isWithinSchedule(rule(), FRI_1800_IST)).toBe(false)
  })
  it('respects the days list', () => {
    expect(isWithinSchedule(rule(), SAT_1000_IST)).toBe(false)
    expect(isWithinSchedule(rule({ days: [6] }), SAT_1000_IST)).toBe(true)
  })
  it('over-midnight window counts the early hours as the previous day', () => {
    const offHours = rule({ start_time: '18:00', end_time: '09:00' })
    expect(isWithinSchedule(offHours, FRI_1800_IST)).toBe(true)
    // 02:00 Saturday belongs to Friday's window (Friday is in the list).
    expect(isWithinSchedule(offHours, SAT_0200_IST)).toBe(true)
    // Friday-only evening rule still answers at 02:00 Saturday, not 10:00.
    const fri = rule({ days: [5], start_time: '18:00', end_time: '09:00' })
    expect(isWithinSchedule(fri, SAT_0200_IST)).toBe(true)
    expect(isWithinSchedule(fri, SAT_1000_IST)).toBe(false)
  })
  it('start == end means the whole day', () => {
    expect(isWithinSchedule(rule({ days: [6], start_time: '00:00', end_time: '00:00' }), SAT_1000_IST)).toBe(true)
  })
  it('no days or bad times never match', () => {
    expect(isWithinSchedule(rule({ days: [] }), FRI_1800_IST)).toBe(false)
    expect(isWithinSchedule(rule({ start_time: '25:00' }), FRI_1800_IST)).toBe(false)
  })
})

describe('ruleAppliesToTags', () => {
  it('empty list = everyone', () => {
    expect(ruleAppliesToTags({ tag_ids: [] }, [])).toBe(true)
  })
  it('needs any one of the lists', () => {
    expect(ruleAppliesToTags({ tag_ids: ['a', 'b'] }, ['x', 'b'])).toBe(true)
    expect(ruleAppliesToTags({ tag_ids: ['a'] }, ['x'])).toBe(false)
  })
})

describe('placeholders and template params', () => {
  it('fills contact name with a fallback', () => {
    expect(fillContactPlaceholders('Hi {{contact.name}}!', { name: 'Asha' })).toBe('Hi Asha!')
    expect(fillContactPlaceholders('Hi {{ contact.name }}!', { name: '' })).toBe('Hi there!')
  })
  it('orders params numerically, past 9', () => {
    const vars = { '10': 'j', '2': 'b', '1': '{{contact.name}}' }
    expect(orderedTemplateParams(vars, { name: 'Ravi' })).toEqual(['Ravi', 'b', 'j'])
  })
})

describe('phone parsing', () => {
  it('normalises Indian numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('919876543210')
    expect(normalizePhone('+91 98765-43210')).toBe('919876543210')
    expect(normalizePhone('09876543210')).toBe('919876543210')
    expect(normalizePhone('0091 9876543210')).toBe('919876543210')
    expect(normalizePhone('+1 415 555 0100')).toBe('14155550100')
    expect(normalizePhone('12')).toBeNull()
  })
  it('reads pasted lines, CSV with names, and dedupes', () => {
    const input = 'name,phone\nAsha,9876543210\n"Ravi Kumar",+91 91234 56789\n9876543210\n98450 11111, 98450 22222\nphone'
    expect(parseNumberList(input)).toEqual([
      { phone: '919876543210', name: 'Asha' },
      { phone: '919123456789', name: 'Ravi Kumar' },
      { phone: '919845011111', name: null },
      { phone: '919845022222', name: null },
    ])
  })
})
