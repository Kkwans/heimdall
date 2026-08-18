import { describe, expect, it } from 'vitest'
import { getAdaptivePopupWidth } from '../utils/adaptiveFilterSelect'

describe('筛选下拉弹层宽度', () => {
  it('为短选项保留可读的最小宽度', () => {
    expect(getAdaptivePopupWidth([{ value: 'all', label: '全部' }])).toBe(112)
  })

  it('按最长标签扩展但不超过桌面上限', () => {
    expect(getAdaptivePopupWidth([{ value: 'model', label: '这是一个很长的模型名称用于验证下拉宽度' }])).toBeGreaterThan(200)
    expect(getAdaptivePopupWidth([{ value: 'model', label: 'x'.repeat(100) }])).toBe(360)
  })
})
