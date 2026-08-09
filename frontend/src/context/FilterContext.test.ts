import { describe, expect, it } from 'vitest'
import { getDateRange } from './dateRange'

describe('日期预设范围', () => {
  it('全部范围使用显式全量边界，避免后端回落到近七天', () => {
    expect(getDateRange('all')).toEqual({
      start: '0001-01-01',
      end: '9999-12-31',
    })
  })
})
