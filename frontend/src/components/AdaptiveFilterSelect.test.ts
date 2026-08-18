import { describe, expect, it } from 'vitest'
import { getAdaptivePopupWidth, getAdaptiveSelectSizing } from '../utils/adaptiveFilterSelect'

describe('筛选下拉弹层宽度', () => {
  it('为短选项保留可读的最小宽度', () => {
    expect(getAdaptivePopupWidth([{ value: 'all', label: '全部' }])).toBe(112)
  })

  it('按最长标签扩展但不超过桌面上限', () => {
    expect(getAdaptivePopupWidth([{ value: 'model', label: '这是一个很长的模型名称用于验证下拉宽度' }])).toBeGreaterThan(200)
    expect(getAdaptivePopupWidth([{ value: 'model', label: 'x'.repeat(100) }])).toBe(360)
  })

  it('让桌面触发器与弹层使用同一个固定宽度', () => {
    const sizing = getAdaptiveSelectSizing(
      [{ value: 'all', label: '全部状态' }, { value: 'error', label: '失败' }],
      { minWidth: 100, maxWidth: 200 },
    )
    expect(sizing.width).toBe(112)
    expect(sizing.matchSelectWidth).toBe(false)
  })

  it('保留移动端 flex 触发器的响应式宽度', () => {
    const sizing = getAdaptiveSelectSizing(
      [{ value: 'all', label: '全部模型' }],
      { minWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' },
    )
    expect(sizing.width).toBeUndefined()
    expect(sizing.matchSelectWidth).toBe(true)
  })
})
