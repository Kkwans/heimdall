import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts, { type ChartTooltipParam } from './EChart'
import { Card } from 'antd'
import { fetchDashboardModels } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { ModelData } from '../../types'
import { getTooltipForTheme, PAGE_ICON_STYLE, getVendorColor, chartText } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { ChartSkeleton } from '../LoadingSkeleton'
import { useLatestAsyncRequest } from '../../hooks/useLatestAsyncRequest'
import { ChartPlaceholder } from './ChartState'

const ModelDistribution = memo(function ModelDistribution() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [data, setData] = useState<ModelData[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()
  const { begin, isCurrent, isForegroundCurrent } = useLatestAsyncRequest()

  const isMobile = useIsMobile()

  const fetchData = useCallback(async (silent = false) => {
    const token = begin(silent)
    if (!silent) setLoading(true)
    try {
      const res = await fetchDashboardModels({ start_date: dateRange.start, end_date: dateRange.end })
      if (!isCurrent(token)) return
      if (silent) { setIfChanged(res.data, setData) } else { setData(res.data) }
    } catch (e) {
      if (!silent && isCurrent(token)) console.error(e)
    } finally {
      if (!silent && isForegroundCurrent(token)) setLoading(false)
    }
  }, [begin, dateRange.start, dateRange.end, isCurrent, isForegroundCurrent, setIfChanged])

  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])
  useEffect(() => { if (backgroundTick > 0) fetchData(true) }, [backgroundTick, fetchData])

  if (loading && data.length === 0) {
    return (
      <Card title="模型使用分布" className="chart-card" bordered={false}>
        <ChartSkeleton height={isMobile ? 280 : 260} />
      </Card>
    )
  }

  if (!loading && data.length === 0) {
    return (
      <Card title="模型使用分布" className="chart-card" bordered={false}>
        <ChartPlaceholder />
      </Card>
    )
  }

  // 移动端：底部水平图例，圆心上移；PC端：右侧竖向图例
  const legend = isMobile
    ? {
        type: 'scroll' as const,
        orient: 'horizontal' as const,
        bottom: 0,
        left: 'center' as const,
        textStyle: { color: '#57534e', fontSize: 10 },
        itemWidth: 10,
        itemHeight: 10,
        formatter: (name: string) => name.length > 12 ? name.slice(0, 12) + '…' : name,
        ...PAGE_ICON_STYLE,
      }
    : {
        type: 'scroll' as const,
        orient: 'vertical' as const,
        right: 0,
        top: 'center' as const,
        textStyle: { color: '#57534e', fontSize: 11 },
        itemWidth: 10,
        itemHeight: 10,
        ...PAGE_ICON_STYLE,
        // PC 端完整展示模型名，不截断
      }

  // 移动端圆心屄5%以下小幅上移，为底部图例留适当空间，防止图例区域过大
  const pieCenter: [string, string] = isMobile ? ['50%', '44%'] : ['36%', '50%']

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      ...getTooltipForTheme(isDark),
      formatter: (p: ChartTooltipParam) => {
        const item = p.data as { raw: ModelData; value: number }
        const d = item.raw
        const t = isDark ? chartText.dark : chartText.light
        return `
          <div style="font-weight:600;margin-bottom:6px;color:${t.primary}">${p.name}</div>
          <div style="color:${t.secondary}">请求数: <b style="color:${t.primary}">${item.value}</b> (${p.percent}%)</div>
          <div style="color:${t.secondary}">Token: <b style="color:${t.primary}">${(d.total_tokens / 1000).toFixed(1)}K</b></div>
          <div style="color:${t.secondary}">成功率: <b style="color:${t.primary}">${(d.success_rate * 100).toFixed(1)}%</b></div>
          <div style="color:${t.secondary}">平均延迟: <b style="color:${t.primary}">${d.avg_latency_ms?.toFixed(0)}ms</b></div>
        `
      },
    },
    legend,
    series: [
      {
        name: '模型分布',
        type: 'pie',
        radius: ['42%', '68%'],
        center: pieCenter,
        avoidLabelOverlap: false,
        label: { show: false },
        data: data.map((d) => ({
          name: d.model,
          value: d.total_requests,
          raw: d,
          itemStyle: { color: getVendorColor(d.model).color },
        })),
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0,0,0,0.12)',
          },
        },
      },
    ],
  }

  // 移动端图表高度稍微减小（图山圆心充足与底部图例平行）
  const chartHeight = isMobile ? 280 : 260

  return (
    <Card title="模型使用分布" className="chart-card" bordered={false}>
      <ReactECharts option={option} style={{ height: chartHeight }} />
    </Card>
  )
})

export default ModelDistribution
