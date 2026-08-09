import { describe, expect, it } from 'vitest'
import { getCategoryAxisLayout, getDateAxisLayout } from './chartLayout'

describe('分类轴自适应布局', () => {
  it('宽屏少量短标签保持水平展示', () => {
    const layout = getCategoryAxisLayout({
      labels: ['MiMo', 'DeepSeek', 'OpenAI'],
      containerWidth: 1_920,
      currentBottom: 60,
      hasBottomLegend: true,
    })

    expect(layout.rotate).toBe(0)
    expect(layout.labelWidth).toBeUndefined()
    expect(layout.gridBottom).toBe(60)
  })

  it('空间不足时逐级旋转并增加底部留白', () => {
    const layout = getCategoryAxisLayout({
      labels: [
        'provider-name-that-is-very-long-1',
        'provider-name-that-is-very-long-2',
        'provider-name-that-is-very-long-3',
        'provider-name-that-is-very-long-4',
      ],
      containerWidth: 480,
      currentBottom: 60,
      hasBottomLegend: true,
    })

    expect(layout.rotate).toBe(45)
    expect(layout.labelWidth).toBeGreaterThanOrEqual(56)
    expect(layout.gridBottom).toBeGreaterThan(60)
  })

  it('轻度拥挤时优先使用三十度而不是直接斜排四十五度', () => {
    const layout = getCategoryAxisLayout({
      labels: ['provider-name-01', 'provider-name-02', 'provider-name-03'],
      containerWidth: 390,
      hasBottomLegend: true,
    })

    expect(layout.rotate).toBe(30)
  })

  it('无底部图例时不额外占用图例空间', () => {
    const withoutLegend = getCategoryAxisLayout({
      labels: ['短标签', '另一个短标签'],
      containerWidth: 360,
      hasBottomLegend: false,
    })
    const withLegend = getCategoryAxisLayout({
      labels: ['短标签', '另一个短标签'],
      containerWidth: 360,
      hasBottomLegend: true,
    })

    expect(withLegend.gridBottom).toBeGreaterThan(withoutLegend.gridBottom)
  })
})

describe('连续日期轴自适应布局', () => {
  it('同一年只显示月日并在宽屏保留全部七个日期', () => {
    const labels = Array.from({ length: 7 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
    const layout = getDateAxisLayout(labels, 960)

    expect(layout.rotate).toBe(0)
    expect(layout.formatter(labels[0])).toBe('08-01')
    expect(labels.map((_, index) => layout.interval(index))).toEqual(Array(7).fill(true))
  })

  it('长日期范围只抽取少量等距节点并保留首尾', () => {
    const labels = Array.from({ length: 30 }, (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`)
    const layout = getDateAxisLayout(labels, 960)
    const visible = labels.map((_, index) => layout.interval(index))

    expect(visible.filter(Boolean).length).toBeLessThanOrEqual(8)
    expect(visible[0]).toBe(true)
    expect(visible[visible.length - 1]).toBe(true)
  })

  it('跨年时才保留年份', () => {
    const layout = getDateAxisLayout(['2025-12-31', '2026-01-01'], 420)
    expect(layout.formatter('2025-12-31')).toBe('2025-12-31')
  })
})
