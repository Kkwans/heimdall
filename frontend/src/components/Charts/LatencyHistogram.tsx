import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts, { type ChartTooltipParam } from './EChart'
import { Card } from 'antd'
import { fetchLatencyDistribution } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { LatencyBucket } from '../../types'
import { CHART_COLORS, chartBaseOption, getTooltipForTheme, getAxisForTheme, chartText } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'
import { ChartSkeleton } from '../LoadingSkeleton'
import { useLatestAsyncRequest } from '../../hooks/useLatestAsyncRequest'
import { ChartPlaceholder } from './ChartState'

const LatencyHistogram = memo(function LatencyHistogram() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [data, setData] = useState<LatencyBucket[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()
  const { begin, isCurrent, isForegroundCurrent } = useLatestAsyncRequest()

  const fetchData = useCallback(async (silent = false) => {
    const token = begin(silent)
    if (!silent) setLoading(true)
    try {
      const res = await fetchLatencyDistribution({ start_date: dateRange.start, end_date: dateRange.end })
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
      <Card title="耗时分布" className="chart-card" bordered={false}>
        <ChartSkeleton height={260} />
      </Card>
    )
  }

  if (!loading && data.length === 0) {
    return (
      <Card title="耗时分布" className="chart-card" bordered={false}>
        <ChartPlaceholder />
      </Card>
    )
  }

  // 根据延迟区间给柱子着色（快→慢：绿→橙→红）
  const colors = [
    CHART_COLORS.success,
    CHART_COLORS.success,
    CHART_COLORS.warning,
    CHART_COLORS.danger,
    CHART_COLORS.danger,
  ]

  const option = {
    ...chartBaseOption,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...getTooltipForTheme(isDark),
      formatter: (params: ChartTooltipParam[]) => {
        const p = params[0]
        const t = isDark ? chartText.dark : chartText.light
        return `<b style="color:${t.primary}">${p.axisValue}</b><br/><span style="color:${t.secondary}">请求数: <b style="color:${t.primary}">${p.value}</b></span>`
      },
    },
    xAxis: {
      type: 'category',
      data: data.map(d => d.label),
      axisLine: getAxisForTheme(isDark).line,
      axisLabel: getAxisForTheme(isDark).label,
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: getAxisForTheme(isDark).splitLine,
      axisLabel: getAxisForTheme(isDark).label,
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: data.map((d, i) => ({
          value: d.count,
          itemStyle: {
            color: colors[i] ?? CHART_COLORS.primary,
            borderRadius: [3, 3, 0, 0],
          },
        })),
        barMaxWidth: 48,
        label: {
          show: true,
          position: 'top',
          color: isDark ? '#78716c' : '#a8a29e',
          fontSize: 11,
          formatter: (p: ChartTooltipParam) => (p.value > 0 ? p.value : ''),
        },
      },
    ],
  }

  return (
    <Card title="耗时分布" className="chart-card" bordered={false}>
      <ReactECharts option={option} style={{ height: 260 }} />
    </Card>
  )
})

export default LatencyHistogram
