// 图表颜色 — 与设计规范对齐
export const CHART_COLORS = {
  primary: '#0ea5e9',   // 电光蓝（输入/主色调）
  success: '#10b981',   // 翡翠绿（输出/成功）
  warning: '#f59e0b',   // 琥珀橙（警告/中等）
  danger: '#f43f5e',    // 珊瑚红（错误/危险）
  accent: '#8b5cf6',    // 紫（推理/延迟）
  cache: '#06b6d4',     // 青（缓存命中）
  orange: '#f97316',    // 橙红
  purple: '#a78bfa',    // 浅紫
}

// 图表通用 tooltip 样式 (浅色风格)
export const tooltipStyle = {
  backgroundColor: '#ffffff',
  borderColor: '#e7e5e4',
  borderWidth: 1,
  borderRadius: 4,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  textStyle: { color: '#1c1917', fontSize: 12 },
  extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.08);',
}

// 深色模式 tooltip 样式
export const tooltipStyleDark = {
  backgroundColor: '#292524',
  borderColor: '#44403c',
  borderWidth: 1,
  borderRadius: 4,
  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  textStyle: { color: '#fafaf9', fontSize: 12 },
  extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.4);',
}

// 图表通用坐标轴样式 (浅色)
export const axisStyle = {
  line: { lineStyle: { color: '#e7e5e4' } },
  label: { color: '#a8a29e', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(168,162,158,0.2)', type: 'dashed' as const } },
}

// 深色模式坐标轴样式
export const axisStyleDark = {
  line: { lineStyle: { color: '#44403c' } },
  label: { color: '#78716c', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' as const } },
}

/**
 * 根据主题返回对应的 tooltip 配置
 */
export function getTooltipForTheme(isDark: boolean) {
  return isDark ? tooltipStyleDark : tooltipStyle
}

/**
 * 根据主题返回对应的坐标轴配置
 */
export function getAxisForTheme(isDark: boolean) {
  return isDark ? axisStyleDark : axisStyle
}

/**
 * 图表文字颜色（用于 tooltip formatter 中的 HTML）
 */
export const chartText = {
  light: { primary: '#1c1917', secondary: '#57534e', muted: '#a8a29e' },
  dark:  { primary: '#fafaf9', secondary: '#d6d3d1', muted: '#78716c' },
}

/**
 * 图表图例文字颜色
 */
export const legendTextStyle = {
  light: { color: '#57534e', fontSize: 11 },
  dark:  { color: '#d6d3d1', fontSize: 11 },
}

// 基础 grid 配置（底部留足空间给图例）
export const chartBaseOption = {
  backgroundColor: 'transparent',
  grid: {
    top: 40,
    right: 16,
    bottom: 52,   // 从 40 增至 52，为底部图例留出更多空间
    left: 48,
    containLabel: false,
  },
}

export function emptyOption(text: string = '暂无数据') {
  return {
    backgroundColor: 'transparent',
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: 'middle',
        style: {
          text,
          fontSize: 14,
          fill: '#a8a29e',
        },
      },
    ],
  }
}

// 图例样式：底部可滚动
export const legendStyle = {
  type: 'scroll' as const,
  textStyle: { color: '#57534e', fontSize: 11 },
  bottom: 0,
  left: 'center' as const,
  itemWidth: 10,
  itemHeight: 10,
  pageButtonItemGap: 4,
}

// 翻页图标样式常量（所有 type: 'scroll' 图例通用）
export const PAGE_ICON_STYLE = {
  pageIconColor: '#0ea5e9',
  pageIconInactiveColor: '#c7c3bf',
  pageIconSize: [14, 12],
  pageButtonItemGap: 4,
  pageTextStyle: { fontSize: 11, color: '#a8a29e' },
}

// ============================================================
// 厂商主题色 — 全局统一配色
// 每个厂商有固定的主色，用于图表、Tag、状态指示等
// ============================================================
export const VENDOR_COLORS: Record<string, { color: string; bg: string; label: string }> = {
  mimo:          { color: '#FF6900', bg: '#fff7ed', label: 'MiMo' },
  deepseek:      { color: '#4D6BFE', bg: '#dbeafe', label: 'DeepSeek' },
  openai:        { color: '#10a37f', bg: '#d1fae5', label: 'OpenAI' },
  anthropic:     { color: '#D97706', bg: '#fef3c7', label: 'Anthropic' },
  claude:        { color: '#D97706', bg: '#fef3c7', label: 'Claude' },
  google:        { color: '#4285F4', bg: '#dbeafe', label: 'Google' },
  gemini:        { color: '#4285F4', bg: '#dbeafe', label: 'Gemini' },
  minimax:       { color: '#E11D48', bg: '#ffe4e6', label: 'MiniMax' },
  longcat:       { color: '#FFD000', bg: '#fefce8', label: 'LongCat' },
  moonshot:      { color: '#7C3AED', bg: '#ede9fe', label: 'Moonshot' },
  kimi:          { color: '#7C3AED', bg: '#ede9fe', label: 'Kimi' },
  zhipu:         { color: '#3266FE', bg: '#dbeafe', label: '智谱' },
  glm:           { color: '#3266FE', bg: '#dbeafe', label: 'GLM' },
  hunyuan:       { color: '#0052D9', bg: '#dbeafe', label: '混元' },
  qwen:          { color: '#FF6A00', bg: '#ffedd5', label: '通义千问' },
  alibaba:       { color: '#FF6A00', bg: '#ffedd5', label: '阿里' },
  baidu:         { color: '#2563eb', bg: '#dbeafe', label: '百度' },
  ernie:         { color: '#2563eb', bg: '#dbeafe', label: '文心' },
  siliconflow:   { color: '#06b6d4', bg: '#cffafe', label: 'SiliconFlow' },
  together:      { color: '#7c3aed', bg: '#ede9fe', label: 'Together' },
  fireworks:     { color: '#dc2626', bg: '#fee2e2', label: 'Fireworks' },
  groq:          { color: '#f97316', bg: '#ffedd5', label: 'Groq' },
  mistral:       { color: '#f43f5e', bg: '#ffe4e6', label: 'Mistral' },
  cohere:        { color: '#8b5cf6', bg: '#ede9fe', label: 'Cohere' },
  aws:           { color: '#f59e0b', bg: '#fef3c7', label: 'AWS' },
  bedrock:       { color: '#f59e0b', bg: '#fef3c7', label: 'Bedrock' },
  azure:         { color: '#0ea5e9', bg: '#e0f2fe', label: 'Azure' },
  vertex:        { color: '#4285f4', bg: '#dbeafe', label: 'Vertex' },
  xai:           { color: '#1a1a1a', bg: '#f5f5f4', label: 'xAI' },
  grok:          { color: '#1a1a1a', bg: '#f5f5f4', label: 'Grok' },
  yi:            { color: '#0d9488', bg: '#ccfbf1', label: '零一万物' },
  step:          { color: '#6366f1', bg: '#e0e7ff', label: '阶跃星辰' },
  baichuan:      { color: '#2563eb', bg: '#dbeafe', label: '百川' },
  spark:         { color: '#f97316', bg: '#ffedd5', label: '讯飞星火' },
  iflytek:       { color: '#f97316', bg: '#ffedd5', label: '讯飞' },
  volcengine:    { color: '#2563eb', bg: '#dbeafe', label: '火山引擎' },
  doubao:        { color: '#2563eb', bg: '#dbeafe', label: '豆包' },
}

// 默认回退颜色列表（未知厂商按序轮询）
const VENDOR_FALLBACK_COLORS = [
  '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6',
  '#06b6d4', '#f97316', '#a78bfa', '#ec4899', '#14b8a6',
]

/**
 * 根据厂商名称获取主题色
 * 支持模糊匹配（如 deepseek-chat 匹配 deepseek）
 */
export function getVendorColor(vendorName: string): { color: string; bg: string; label: string } {
  if (!vendorName) {
    return { color: VENDOR_FALLBACK_COLORS[0], bg: '#e0f2fe', label: '' }
  }
  const lower = vendorName.toLowerCase()
  // 精确匹配
  if (VENDOR_COLORS[lower]) return VENDOR_COLORS[lower]
  // 模糊匹配（名称包含关键字）
  for (const [key, val] of Object.entries(VENDOR_COLORS)) {
    if (lower.includes(key) || key.includes(lower)) return val
  }
  // 回退：根据名称 hash 分配颜色
  let hash = 0
  for (let i = 0; i < lower.length; i++) {
    hash = ((hash << 5) - hash + lower.charCodeAt(i)) | 0
  }
  const idx = Math.abs(hash) % VENDOR_FALLBACK_COLORS.length
  return { color: VENDOR_FALLBACK_COLORS[idx], bg: VENDOR_FALLBACK_COLORS[idx] + '1a', label: vendorName }
}

/**
 * 获取厂商颜色列表（用于图表）
 * 按厂商名称顺序返回颜色数组
 */
export function getVendorColorList(vendorNames: string[]): string[] {
  return vendorNames.map(v => getVendorColor(v).color)
}
