import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/esm/core'
import type { EChartsReactProps } from 'echarts-for-react/esm/types'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { getCategoryAxisLayout } from './chartLayout'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

export interface ChartTooltipParam {
  axisValue: string | number
  marker: string
  name: string
  percent?: number
  seriesName: string
  value: number
  data?: unknown
}

export type EChartRef = ReactEChartsCore

type ChartOptionRecord = Record<string, unknown>

function numericGridValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function hasBottomLegend(option: ChartOptionRecord): boolean {
  const legends = Array.isArray(option.legend) ? option.legend : [option.legend]
  return legends.some(legend => {
    if (!legend || typeof legend !== 'object') return false
    const record = legend as ChartOptionRecord
    return record.show !== false && record.bottom !== undefined
  })
}

function adaptCategoryAxis(option: ChartOptionRecord, containerWidth: number): ChartOptionRecord {
  if (containerWidth <= 0 || !option.xAxis) return option

  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis]
  const grid = Array.isArray(option.grid) ? option.grid[0] : option.grid
  const gridRecord = grid && typeof grid === 'object' ? grid as ChartOptionRecord : {}
  const bottomLegend = hasBottomLegend(option)
  let requiredBottom = numericGridValue(gridRecord.bottom, bottomLegend ? 52 : 30)
  let changed = false

  const nextAxes = axes.map(axis => {
    if (!axis || typeof axis !== 'object') return axis
    const axisRecord = axis as ChartOptionRecord
    if (axisRecord.type !== 'category' || !Array.isArray(axisRecord.data)) return axis

    const labels = axisRecord.data.map(value => String(value ?? ''))
    const axisLabel = axisRecord.axisLabel && typeof axisRecord.axisLabel === 'object'
      ? axisRecord.axisLabel as ChartOptionRecord
      : {}
    const fontSize = numericGridValue(axisLabel.fontSize, 10)
    const layout = getCategoryAxisLayout({
      labels,
      containerWidth,
      gridLeft: numericGridValue(gridRecord.left, 52),
      gridRight: numericGridValue(gridRecord.right, 20),
      currentBottom: requiredBottom,
      hasBottomLegend: bottomLegend,
      fontSize,
    })
    requiredBottom = Math.max(requiredBottom, layout.gridBottom)
    changed = true

    const nextAxisLabel: ChartOptionRecord = {
      ...axisLabel,
      rotate: layout.rotate,
      hideOverlap: true,
    }
    if (layout.labelWidth !== undefined) {
      nextAxisLabel.width = layout.labelWidth
      nextAxisLabel.overflow = 'truncate'
    } else {
      delete nextAxisLabel.width
      delete nextAxisLabel.overflow
    }

    return { ...axisRecord, axisLabel: nextAxisLabel }
  })

  if (!changed) return option
  const nextGrid = { ...gridRecord, bottom: requiredBottom }
  return {
    ...option,
    grid: Array.isArray(option.grid) ? [nextGrid, ...option.grid.slice(1)] : nextGrid,
    xAxis: Array.isArray(option.xAxis) ? nextAxes : nextAxes[0],
  }
}

const EChart = React.forwardRef<ReactEChartsCore, Omit<EChartsReactProps, 'echarts'>>(
  function EChart(props, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [containerWidth, setContainerWidth] = useState(0)

    useLayoutEffect(() => {
      const element = containerRef.current
      if (!element) return
      const updateWidth = () => setContainerWidth(current => {
        const next = Math.round(element.clientWidth)
        return current === next ? current : next
      })
      updateWidth()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(updateWidth)
      observer.observe(element)
      return () => observer.disconnect()
    }, [])

    const option = useMemo(
      () => adaptCategoryAxis(props.option as ChartOptionRecord, containerWidth),
      [props.option, containerWidth],
    )

    return (
      <div ref={containerRef} style={{ width: '100%', minWidth: 0 }}>
        <ReactEChartsCore ref={ref} echarts={echarts} {...props} option={option} />
      </div>
    )
  },
)

export default EChart
