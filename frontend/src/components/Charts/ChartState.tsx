import React from 'react'

export type ChartState = 'loading' | 'data' | 'empty' | 'error' | 'refreshing'

export function ChartPlaceholder({ text = '暂无数据', height = 260 }: { text?: string; height?: number }) {
  return (
    <div
      className="chart-placeholder"
      style={{ minHeight: height }}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  )
}

export function ChartRefreshing({ text = '正在更新…' }: { text?: string }) {
  return <span className="chart-refreshing" role="status" aria-live="polite">{text}</span>
}
