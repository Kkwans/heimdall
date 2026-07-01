/**
 * 全站统一格式化工具函数
 *
 * 提供 Token 数量、Credit Quota、耗时等数字的格式化，确保全站风格一致。
 *
 * 单位规范（Token / Credit 完全统一，只使用 W 和 亿）：
 *   < 1W    → 原数字（带千位分隔符）
 *   >= 1W   → W（如 1.96W）
 *   >= 1亿  → 亿（如 1.23亿）
 */

/**
 * 格式化 Token / Credit 数量（全站统一）
 * - >= 1亿（100,000,000）：亿
 * - >= 1W（10,000）：W
 * - 其他：原始数字（带千位分隔符）
 */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n === 0) return '0'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(2)}W`
  return n.toLocaleString()
}

/**
 * 格式化 Credit / Quota 数量（与 fmtTokens 完全相同的单位体系）
 * 保留此函数名供 AI Credit 页面调用，内部直接复用 fmtTokens 逻辑。
 */
export function fmtCredit(n: number | null | undefined): string {
  return fmtTokens(n)
}

/**
 * 格式化数量——用于图表坐标轴（整数显示，无小数点）
 * 适用于 Token 和 Credit 的坐标轴标签。
 */
export function fmtAxis(n: number): string {
  if (n >= 100_000_000) return `${Math.round(n / 100_000_000)}亿`
  if (n >= 10_000) return `${Math.round(n / 10_000)}W`
  return String(Math.round(n))
}

/**
 * @deprecated 请使用 fmtAxis 代替
 */
export const fmtCreditAxis = fmtAxis

/**
 * 格式化毫秒耗时
 * - < 1000ms：显示 ms
 * - >= 1000ms：显示 s（保留 1 位小数）
 */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms === 0) return '0ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

/**
 * 格式化百分比
 */
export function pctStr(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

/**
 * 耗时颜色分级
 * - < 2s：绿色（快）
 * - < 10s：橙色（中）
 * - >= 10s：红色（慢）
 */
export function latencyColor(ms: number): string {
  if (ms < 2_000) return '#10b981'
  if (ms < 10_000) return '#f59e0b'
  return '#f43f5e'
}
