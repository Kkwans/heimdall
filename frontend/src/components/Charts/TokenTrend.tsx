import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card } from 'antd'
import { fetchDaily } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { DailyData } from '../../types'
import { CHART_COLORS, chartBaseOption, emptyOption, getTooltipForTheme, getAxisForTheme, chartText, legendStyle } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'
import { fmtTokens, fmtAxis } from '../../utils/format'

// fmtK 已不应再使用，改用全局 fmtAxis
const fmtK = fmtAxis

const TokenTrend = memo(function TokenTrend() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [data, setData] = useState<DailyData[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetchDaily({ start_date: dateRange.start, end_date: dateRange.end })
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
      <Card title="Token 消耗趋势" className="chart-card" bordered={false}>
        <ReactECharts option={emptyOption('暂无数据')} style={{ height: 260 }} />
      </Card>
    )
  }

  const option = {
    ...chartBaseOption,
    tooltip: {
      trigger: 'axis',
      ...getTooltipForTheme(isDark),
      formatter: (params: any[]) => {
        const t = isDark ? chartText.dark : chartText.light
        let html = `<div style="font-weight:600;margin-bottom:4px;color:${t.primary}">${params[0]?.axisValue}</div>`
        params.forEach((p: any) => {
          html += `<div style="color:${t.secondary}">${p.marker}${p.seriesName}: <b style="color:${t.primary}">${fmtTokens(p.value)}</b></div>`
        })
        return html
      },
    },
    legend: {
      data: ['输入 Token', '输出 Token', '缓存命中'],
      ...legendStyle,
    },
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLine: getAxisForTheme(isDark).line,
      axisLabel: getAxisForTheme(isDark).label,
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: getAxisForTheme(isDark).splitLine,
      axisLabel: { ...getAxisForTheme(isDark).label, formatter: fmtK },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '输入 Token',
        type: 'bar',
        stack: 'tokens',
        data: data.map(d => d.prompt_tokens - d.cache_hit_tokens),
        itemStyle: { color: CHART_COLORS.primary, borderRadius: [0, 0, 0, 0] },
        barMaxWidth: 40,
      },
      {
        name: '缓存命中',
        type: 'bar',
        stack: 'tokens',
        data: data.map(d => d.cache_hit_tokens),
        itemStyle: { color: CHART_COLORS.success },
        barMaxWidth: 40,
      },
      {
        name: '输出 Token',
        type: 'bar',
        stack: 'tokens',
        data: data.map(d => d.completion_tokens),
        itemStyle: { color: CHART_COLORS.success, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 40,
      },
    ],
  }

  return (
    <Card title="Token 消耗趋势" className="chart-card" bordered={false} loading={loading}>
      <ReactECharts option={option} style={{ height: 260 }} notMerge />
    </Card>
  )
})

export default TokenTrend
