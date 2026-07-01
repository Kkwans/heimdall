import React, { useEffect, useState, useCallback, memo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card } from 'antd'
import { fetchDaily } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { DailyData } from '../../types'
import { CHART_COLORS, chartBaseOption, emptyOption, tooltipStyle, axisStyle, legendStyle } from './chartTheme'

const RequestTrend = memo(function RequestTrend() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const [data, setData] = useState<DailyData[]>([])
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetchDaily({ start_date: dateRange.start, end_date: dateRange.end })
      if (silent) {
        setIfChanged(res.data, setData)
      } else {
        setData(res.data)
      }
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
      <Card title="请求量趋势" className="chart-card" bordered={false}>
        <ReactECharts option={emptyOption('暂无数据')} style={{ height: 260 }} />
      </Card>
    )
  }

  const option = {
    ...chartBaseOption,
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle,
    },
    legend: {
      data: ['总请求', '成功', '失败'],
      ...legendStyle,
    },
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLine: axisStyle.line,
      axisLabel: axisStyle.label,
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: axisStyle.splitLine,
      axisLabel: axisStyle.label,
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
    <Card title="请求量趋势" className="chart-card" bordered={false} loading={loading}>
      <ReactECharts option={option} style={{ height: 260 }} notMerge />
    </Card>
  )
})

export default RequestTrend
