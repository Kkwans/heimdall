import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card } from 'antd'
import { fetchDaily } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { DailyData } from '../../types'
import { CHART_COLORS, chartBaseOption, emptyOption, getTooltipForTheme, getAxisForTheme, chartText } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'

const CacheHitTrend = memo(function CacheHitTrend() {
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
      <Card title="缓存命中率趋势" className="chart-card" bordered={false}>
        <ReactECharts option={emptyOption('暂无数据')} style={{ height: 260 }} />
      </Card>
    )
  }

  const rates = data.map(d => parseFloat((d.cache_hit_rate * 100).toFixed(2)))
  const avg = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0

  const option = {
    ...chartBaseOption,
    tooltip: {
      trigger: 'axis',
      ...getTooltipForTheme(isDark),
      formatter: (params: any[]) => {
        const p = params[0]
        const t = isDark ? chartText.dark : chartText.light
        return `<b style="color:${t.primary}">${p.axisValue}</b><br/><span style="color:${t.secondary}">缓存命中率: <b style="color:${t.primary}">${p.value}%</b></span>`
      },
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
      min: 0,
      max: 100,
      splitLine: getAxisForTheme(isDark).splitLine,
      axisLabel: { ...getAxisForTheme(isDark).label, formatter: (v: number) => `${v}%` },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '缓存命中率',
        type: 'line',
        data: rates,
        smooth: true,
        lineStyle: { color: CHART_COLORS.warning, width: 2 },
        itemStyle: { color: CHART_COLORS.warning },
        areaStyle: { color: 'rgba(245,158,11,0.08)' },
        symbol: 'circle',
        symbolSize: 5,
        markLine: {
          silent: true,
          lineStyle: { color: 'rgba(245,158,11,0.5)', type: 'dashed' },
          data: [
            {
              yAxis: parseFloat(avg.toFixed(2)),
              label: {
                formatter: `均值 ${avg.toFixed(1)}%`,
                color: CHART_COLORS.warning,
                fontSize: 11,
              },
            },
          ],
        },
      },
    ],
  }

  return (
    <Card title="缓存命中率趋势" className="chart-card" bordered={false} loading={loading}>
      <ReactECharts option={option} style={{ height: 260 }} notMerge />
    </Card>
  )
})

export default CacheHitTrend
