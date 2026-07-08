import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card } from 'antd'
import { fetchModels } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { ModelData } from '../../types'
import { CHART_COLORS, emptyOption, getTooltipForTheme, getAxisForTheme, chartText, legendStyle, PAGE_ICON_STYLE } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'
import { fmtTokens, fmtAxis } from '../../utils/format'

const ModelTokenBar = memo(function ModelTokenBar() {
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

  const chartHeight = isMobile ? 340 : 260  // 移动端增大高度，为图例留出更多空间

  if (!loading && data.length === 0) {
    return (
      <Card title="各模型 Token 对比" className="chart-card" bordered={false}>
        <ReactECharts option={emptyOption('暂无数据')} style={{ height: chartHeight }} />
      </Card>
    )
  }

  // 按 total_tokens 降序，最多显示前 8 个
  const sorted = [...data].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 8)

  // 移动端截断模型名（8字符），PC端截断（16字符）
  const maxNameLen = isMobile ? 8 : 16

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...getTooltipForTheme(isDark),
      formatter: (params: any[]) => {
        const model = params[0]?.axisValue
        const t = isDark ? chartText.dark : chartText.light
        let html = `<div style="font-weight:600;margin-bottom:4px;color:${t.primary}">${model}</div>`
        params.forEach((p: any) => {
          html += `<div style="color:${t.secondary}">${p.marker}${p.seriesName}: <b style="color:${t.primary}">${fmtTokens(p.value)}</b></div>`
        })
        return html
      },
    },
    legend: {
      data: ['输入', '缓存命中', '输出'],
      ...legendStyle,
      ...PAGE_ICON_STYLE,
      // 图例放底部，避免与顶部刻度值重叠
      bottom: 0,
      top: undefined,
    },
    // 移动端bottom给底部图例（约24px高）留足空间，同时right给末端分度值留足空间
    grid: {
      top: 12,
      right: isMobile ? 48 : 16,   // 移动端增大right到48px，为末端分度值"2000W"留足空间
      bottom: isMobile ? 56 : 44,  // 移动端56px给图例留足空间
      left: isMobile ? 8 : 16,
      containLabel: true,
    },
    xAxis: {
      type: 'value',
      splitNumber: isMobile ? 3 : 5,
      splitLine: getAxisForTheme(isDark).splitLine,
      axisLabel: { ...getAxisForTheme(isDark).label, formatter: fmtAxis },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: sorted.map(d => d.model),
      axisLine: getAxisForTheme(isDark).line,
      axisLabel: {
        color: isDark ? '#d6d3d1' : '#57534e',
        fontSize: 11,
        width: isMobile ? 60 : 100,
        overflow: 'truncate',
        formatter: (v: string) => v.length > maxNameLen ? v.slice(0, maxNameLen) + '…' : v,
      },
      axisTick: { show: false },
    },
    series: [
      {
        name: '输入',
        type: 'bar',
        stack: 'tokens',
        data: sorted.map(d => d.prompt_tokens - d.cache_hit_tokens),
        itemStyle: { color: CHART_COLORS.primary },
        barMaxWidth: 24,
      },
      {
        name: '缓存命中',
        type: 'bar',
        stack: 'tokens',
        data: sorted.map(d => d.cache_hit_tokens),
        itemStyle: { color: CHART_COLORS.cache },
        barMaxWidth: 24,
      },
      {
        name: '输出',
        type: 'bar',
        stack: 'tokens',
        data: sorted.map(d => d.completion_tokens),
        itemStyle: { color: CHART_COLORS.success, borderRadius: [0, 3, 3, 0] },
        barMaxWidth: 24,
      },
    ],
  }

  return (
    <Card title="各模型 Token 对比" className="chart-card" bordered={false} loading={loading}>
      <ReactECharts option={option} style={{ height: chartHeight }} notMerge />
    </Card>
  )
})

export default ModelTokenBar
