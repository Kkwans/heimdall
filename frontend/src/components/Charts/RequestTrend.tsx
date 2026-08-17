import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from './EChart'
import { Card } from 'antd'
import { fetchDashboardDaily } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { DailyData } from '../../types'
import { CHART_COLORS, chartBaseOption, getTooltipForTheme, getAxisForTheme, legendStyle } from './chartTheme'
import { useTheme } from '../../context/ThemeContext'
import { ChartSkeleton } from '../LoadingSkeleton'
import { useLatestAsyncRequest } from '../../hooks/useLatestAsyncRequest'
import { ChartPlaceholder } from './ChartState'

const RequestTrend = memo(function RequestTrend() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [data, setData] = useState<DailyData[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()
  const { begin, isCurrent, isForegroundCurrent } = useLatestAsyncRequest()

  const fetchData = useCallback(async (silent = false) => {
    const token = begin(silent)
    if (!silent) setLoading(true)
    try {
      const res = await fetchDashboardDaily({ start_date: dateRange.start, end_date: dateRange.end })
      if (!isCurrent(token)) return
      if (silent) {
        setIfChanged(res.data, setData)
      } else {
        setData(res.data)
      }
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
      <Card title="请求量趋势" className="chart-card" bordered={false}>
        <ChartSkeleton height={260} />
      </Card>
    )
  }

  if (!loading && data.length === 0) {
    return (
      <Card title="请求量趋势" className="chart-card" bordered={false}>
        <ChartPlaceholder />
      </Card>
    )
  }

  const option = {
    ...chartBaseOption,
    tooltip: {
      trigger: 'axis',
      ...getTooltipForTheme(isDark),
    },
    legend: {
      data: ['总请求', '成功', '失败'],
      ...legendStyle,
    },
    xAxis: {
      type: 'category',
      heimdallAxisType: 'date',
      data: data.map(d => d.date),
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
        name: '总请求',
        type: 'line',
        data: data.map(d => d.total_requests),
        smooth: true,
        lineStyle: { color: CHART_COLORS.primary, width: 2 },
        itemStyle: { color: CHART_COLORS.primary },
        areaStyle: { color: 'rgba(14,165,233,0.08)' },
        symbol: 'circle',
        symbolSize: 5,
      },
      {
        name: '成功',
        type: 'line',
        data: data.map(d => d.success_requests),
        smooth: true,
        lineStyle: { color: CHART_COLORS.success, width: 2 },
        itemStyle: { color: CHART_COLORS.success },
        areaStyle: { color: 'rgba(16,185,129,0.06)' },
        symbol: 'circle',
        symbolSize: 5,
      },
      {
        name: '失败',
        type: 'line',
        data: data.map(d => d.error_requests),
        smooth: true,
        lineStyle: { color: CHART_COLORS.danger, width: 2 },
        itemStyle: { color: CHART_COLORS.danger },
        symbol: 'circle',
        symbolSize: 5,
      },
    ],
  }

  return (
    <Card title="请求量趋势" className="chart-card" bordered={false}>
      <ReactECharts option={option} style={{ height: 260 }} />
    </Card>
  )
})

export default RequestTrend
