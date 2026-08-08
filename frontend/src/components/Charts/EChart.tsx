import React from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import type { EChartsReactProps } from 'echarts-for-react/lib/types'
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

const EChart = React.forwardRef<ReactEChartsCore, Omit<EChartsReactProps, 'echarts'>>(
  function EChart(props, ref) {
    return <ReactEChartsCore ref={ref} echarts={echarts} {...props} />
  },
)

export default EChart
