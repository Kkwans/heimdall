/**
 * format.ts 工具函数单元测试
 *
 * 测试覆盖：fmtTokens、fmtMs、pctStr、latencyColor
 * 单位规范：W / 亿（不使用 K 和 M；小于 1W 直接显示原数字）
 * 重点验证边界值（9999/10000, 99999999/100000000）和 null/undefined 处理
 */
import { describe, it, expect } from 'vitest'
import { fmtTokens, fmtMs, pctStr, latencyColor } from './format'

// ──────────────────────────────
// fmtTokens
// ──────────────────────────────
describe('fmtTokens', () => {
  it('null 返回 —', () => {
    expect(fmtTokens(null)).toBe('—')
  })

  it('undefined 返回 —', () => {
    expect(fmtTokens(undefined)).toBe('—')
  })

  it('0 返回 "0"', () => {
    expect(fmtTokens(0)).toBe('0')
  })

  it('999 不带单位，直接显示原数字', () => {
    expect(fmtTokens(999)).toBe('999')
  })

  it('1000 不带单位（< 1W）', () => {
    expect(fmtTokens(1000)).toBe('1,000')
  })

  it('9999 不带单位（< 1W）', () => {
    expect(fmtTokens(9999)).toBe('9,999')
  })

  it('10000 带 W 单位（1.00W）', () => {
    expect(fmtTokens(10_000)).toBe('1.00W')
  })

  it('50000 带 W 单位（5.00W）', () => {
    expect(fmtTokens(50_000)).toBe('5.00W')
  })

  it('1000000 带 W 单位（100.00W）', () => {
    expect(fmtTokens(1_000_000)).toBe('100.00W')
  })

  it('99999999 带 W 单位（四舍五入进位为 10000.00W）', () => {
    expect(fmtTokens(99_999_999)).toBe('10000.00W')
  })

  it('100000000 带 亿 单位（1.00亿）', () => {
    expect(fmtTokens(100_000_000)).toBe('1.00亿')
  })

  it('250000000 带 亿 单位（2.50亿）', () => {
    expect(fmtTokens(250_000_000)).toBe('2.50亿')
  })

  it('普通数字 500 直接返回', () => {
    expect(fmtTokens(500)).toBe('500')
  })
})

// ──────────────────────────────
// fmtMs
// ──────────────────────────────
describe('fmtMs', () => {
  it('null 返回 —', () => {
    expect(fmtMs(null)).toBe('—')
  })

  it('undefined 返回 —', () => {
    expect(fmtMs(undefined)).toBe('—')
  })

  it('0 返回 "0ms"', () => {
    expect(fmtMs(0)).toBe('0ms')
  })

  it('500ms 格式化为 "500ms"', () => {
    expect(fmtMs(500)).toBe('500ms')
  })

  it('999ms 格式化为 "999ms"', () => {
    expect(fmtMs(999)).toBe('999ms')
  })

  it('1000ms 格式化为 "1.0s"', () => {
    expect(fmtMs(1000)).toBe('1.0s')
  })

  it('2500ms 格式化为 "2.5s"', () => {
    expect(fmtMs(2500)).toBe('2.5s')
  })

  it('非整数 ms 四舍五入', () => {
    expect(fmtMs(999.6)).toBe('1000ms')
  })
})

// ──────────────────────────────
// pctStr
// ──────────────────────────────
describe('pctStr', () => {
  it('null 返回 —', () => {
    expect(pctStr(null)).toBe('—')
  })

  it('undefined 返回 —', () => {
    expect(pctStr(undefined)).toBe('—')
  })

  it('0 返回 "0.0%"', () => {
    expect(pctStr(0)).toBe('0.0%')
  })

  it('0.5 返回 "50.0%"', () => {
    expect(pctStr(0.5)).toBe('50.0%')
  })

  it('1.0 返回 "100.0%"', () => {
    expect(pctStr(1.0)).toBe('100.0%')
  })

  it('0.999 返回 "99.9%"', () => {
    expect(pctStr(0.999)).toBe('99.9%')
  })
})

// ──────────────────────────────
// latencyColor
// ──────────────────────────────
describe('latencyColor', () => {
  it('0ms 返回绿色', () => {
    expect(latencyColor(0)).toBe('#10b981')
  })

  it('1999ms 返回绿色（< 2000 阈值）', () => {
    expect(latencyColor(1999)).toBe('#10b981')
  })

  it('2000ms 返回橙色（>= 2000 阈值）', () => {
    expect(latencyColor(2000)).toBe('#f59e0b')
  })

  it('5000ms 返回橙色', () => {
    expect(latencyColor(5000)).toBe('#f59e0b')
  })

  it('9999ms 返回橙色（< 10000 阈值）', () => {
    expect(latencyColor(9999)).toBe('#f59e0b')
  })

  it('10000ms 返回红色（>= 10000 阈值）', () => {
    expect(latencyColor(10000)).toBe('#f43f5e')
  })

  it('30000ms 返回红色', () => {
    expect(latencyColor(30000)).toBe('#f43f5e')
  })
})
