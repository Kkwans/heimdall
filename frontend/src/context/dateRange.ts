import dayjs from 'dayjs'
import type { DatePreset, DateRange } from '../types'

export function getDateRange(preset: DatePreset): DateRange {
  const today = dayjs().format('YYYY-MM-DD')
  switch (preset) {
    case 'today':
      return { start: today, end: today }
    case '7days':
      return { start: dayjs().subtract(6, 'day').format('YYYY-MM-DD'), end: today }
    case '30days':
      return { start: dayjs().subtract(29, 'day').format('YYYY-MM-DD'), end: today }
    case 'all':
      // 统计接口缺省日期的既定语义是“近 7 天”；使用完整 ISO 边界明确表达全量。
      return { start: '0001-01-01', end: '9999-12-31' }
    default:
      return { start: dayjs().subtract(6, 'day').format('YYYY-MM-DD'), end: today }
  }
}
