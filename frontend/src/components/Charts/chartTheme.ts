// 图表颜色 — 与设计规范对齐
export const CHART_COLORS = {
  primary: '#0ea5e9',   // 电光蓝
  success: '#10b981',   // 翡翠绿
  warning: '#f59e0b',   // 琥珀橙
  danger: '#f43f5e',    // 珊瑚红
  accent: '#8b5cf6',    // 紫
  cyan: '#06b6d4',      // 青
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
