import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card } from 'antd'
import { fetchModels } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { ModelData } from '../../types'
import { emptyOption, getTooltipForTheme, PAGE_ICON_STYLE, getVendorColor, chartText } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'

const ModelDistribution = memo(function ModelDistribution() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [data, setData] = useState<ModelData[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()

  // 移动端检测（< 768px）
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetchModels({ start_date: dateRange.start, end_date: dateRange.end })
      if (silent) { setIfChanged(res.data, setData) } else { setData(res.data) }
    } catch (e) {
      if (!silent) console.error(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateRange.start, dateRange.end])

  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])
  useEffect(() => { if (backgroundTick > 0) fetchData(true) }, [backgroundTick])

  if (!loading && data.length === 0) {
    return (
      <Card title="模型使用分布" className="chart-card" bordered={false}>
        <ReactECharts option={emptyOption('暂无数据')} style={{ height: 260 }} />
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
      formatter: (p: any) => {
        const d: ModelData = p.data.raw
        const t = isDark ? chartText.dark : chartText.light
        return `
          <div style="font-weight:600;margin-bottom:6px;color:${t.primary}">${p.name}</div>
          <div style="color:${t.secondary}">请求数: <b style="color:${t.primary}">${p.data.value}</b> (${p.percent}%)</div>
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
        data: data.map((d, i) => ({
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
    <Card title="模型使用分布" className="chart-card" bordered={false} loading={loading}>
      <ReactECharts option={option} style={{ height: chartHeight }} notMerge />
    </Card>
  )
})

export default ModelDistribution
