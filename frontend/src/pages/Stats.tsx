/**
 * Stats.tsx — 全量数据统计页面（v6.1）
 *
 * v6.1 修复：
 * - 图表图例底部预留足够空间（bottom: 56），使用 scroll 类型避免重叠
 * - PC端饼图：右侧图例宽度自适应，模型名完整显示
 * - 移动端图表：图例水平可滚动，图表高度适当增加
 * - 新增顶部日期范围筛选（默认近七天，与首页一致）
 * - 饼图 PC端 center/radius 调整，给右侧图例留出更多空间
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Table, Tag, Space, Row, Col, Statistic, DatePicker
} from 'antd'
import { TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import type { ColumnsType } from 'antd/es/table'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'
import Header from '../components/Header'
import {
  fetchDaily,
  fetchModelStats,
  fetchErrorAnalysis,
  fetchHourly,
  fetchProviderStats,
} from '../api/stats'
import { useFilter } from '../context/FilterContext'
import { useTheme } from '../context/ThemeContext'
import type { ModelStats, ErrorAnalysis, HourlyStat, DailyData, ProviderStats } from '../types'
import { fmtTokens as fmtTokensUtil, fmtAxis, fmtMs as fmtMsUtil, pctStr as pctStrUtil, latencyColor as latencyColorUtil } from '../utils/format'
import { PAGE_ICON_STYLE, getVendorColor } from '../components/Charts/chartTheme'

const CHART_HEIGHT = 280
const CHART_HEIGHT_MOBILE = 240

// ──────────────────────────────────────────
// 工具函数（全部从 utils/format 导入，统一单位 K/W/亿）
// ──────────────────────────────────────────
const fmtMs = fmtMsUtil
const fmtTokens = fmtTokensUtil
const pctStr = pctStrUtil
const latencyColor = latencyColorUtil

// ECharts 通用主题色
// 厂商颜色列表（已迁移到 getVendorColor 全局方案）
const SERIES_COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#a78bfa', '#f43f5e', '#38bdf8', '#34d399']

// 通用空状态占位
function EmptyPlaceholder({ text = '暂无数据' }: { text?: string }) {
  return (
    <div style={{
      height: CHART_HEIGHT,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--text-muted)',
      fontSize: 13,
    }}>
      {text}
    </div>
  )
}

// ── 通用图例配置（底部可滚动）──
// 预留 56px 给图例（scroll类型），避免重叠
function legendBottom(textStyle?: object) {
  return {
    type: 'scroll' as const,
    bottom: 4,
    left: 'center' as const,
    itemWidth: 10,
    itemHeight: 10,
    textStyle: { fontSize: 11, ...textStyle },
    ...PAGE_ICON_STYLE,
  }
}

// ── 通用 grid 配置（底部为图例留出空间）──
// bottom: 60 确保图例不与图表重叠；带多系列时用 70
const gridWithLegend = { left: 52, right: 20, top: 30, bottom: 60 }
const gridWithLegendLarge = { left: 52, right: 20, top: 30, bottom: 80 }
const gridNoLegend = { left: 52, right: 20, top: 30, bottom: 30 }

// 动态 X 轴 rotate
function xAxisRotate(dataLen: number) {
  if (dataLen > 10) return 45
  if (dataLen > 6) return 30
  return 0
}

// Y 轴 splitLine（根据主题）
function splitLine(isDark: boolean) {
  return {
    lineStyle: {
      color: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(168,162,158,0.2)',
      type: 'dashed' as const,
    },
  }
}

// ──────────────────────────────────────────
// 子组件：按模型统计表（v7 优化）
// 列名缩短，均思考支持排序，全列居中，横向滚动
// ──────────────────────────────────────────
function ModelStatsTable({ data, loading }: { data: ModelStats[]; loading: boolean }) {
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 }
  const cellCenter: React.CSSProperties = { textAlign: 'center', verticalAlign: 'middle' }

  const columns: ColumnsType<ModelStats> = [
    {
      title: '模型',
      dataIndex: 'model',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (v: string) => {
        const vc = getVendorColor(v)
        return (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Tag color="" style={{ background: vc.bg, color: vc.color, border: 'none', fontSize: 11, borderRadius: 2, margin: 0, fontWeight: 600 }}>{v}</Tag>
          </div>
        )
      },
    },
    {
      title: '总请求',
      dataIndex: 'total_requests',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.total_requests - b.total_requests,
      render: (v: number) => <span style={mono}>{v.toLocaleString()}</span>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.success_rate - b.success_rate,
      render: (v: number) => (
        <span style={{ color: v >= 0.99 ? '#10b981' : v >= 0.95 ? '#f59e0b' : '#f43f5e', ...mono }}>
          {pctStr(v)}
        </span>
      ),
    },
    {
      // 列名：流/非流（原"流式/非流式"，移动端节省空间）
      title: '流/非流',
      key: 'stream',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, r) => (
        <span style={{ fontSize: 11, ...mono, color: 'var(--text-secondary)' }}>
          {r.stream_requests}/{r.non_stream_requests}
        </span>
      ),
    },
    {
      title: '总 Token',
      dataIndex: 'total_tokens',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.total_tokens - b.total_tokens,
      render: (v: number) => <span style={mono}>{fmtTokens(v)}</span>,
    },
    {
      // 均入 Token
      title: '均入 Token',
      dataIndex: 'avg_prompt_tokens',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (v: number) => <span style={mono}>{fmtTokens(v)}</span>,
    },
    {
      // 均出 Token
      title: '均出 Token',
      dataIndex: 'avg_completion_tokens',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (v: number) => <span style={mono}>{fmtTokens(v)}</span>,
    },
    {
      title: '缓存命中率',
      dataIndex: 'avg_cache_hit_rate',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.avg_cache_hit_rate - b.avg_cache_hit_rate,
      render: (v: number) => (
        <span style={{ color: v >= 0.8 ? '#10b981' : v >= 0.5 ? '#f59e0b' : '#f43f5e', ...mono }}>
          {pctStr(v)}
        </span>
      ),
    },
    {
      // 均耗时（原"均总耗时"）
      title: '均耗时',
      dataIndex: 'avg_total_latency_ms',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => (a.avg_total_latency_ms ?? 0) - (b.avg_total_latency_ms ?? 0),
      render: (v: number) => (
        <span style={{ ...mono, color: latencyColor(v) }}>
          {fmtMs(v)}
        </span>
      ),
    },
    {
      // 均思考（原"均思考 (TTFB)"），v7 新增排序
      title: '均思考',
      dataIndex: 'avg_ttfb_ms',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => (a.avg_ttfb_ms ?? 0) - (b.avg_ttfb_ms ?? 0),
      render: (v: number | null) => (
        <span style={{ ...mono, color: 'var(--color-info)' }}>
          {v ? fmtMs(v) : '—'}
        </span>
      ),
    },
    {
      // P90（原"P90 耗时"）
      title: 'P90',
      dataIndex: 'p90_latency_ms',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.p90_latency_ms - b.p90_latency_ms,
      render: (v: number) => (
        <span style={{ ...mono, color: latencyColor(v) }}>
          {fmtMs(v)}
        </span>
      ),
    },
  ]

  return (
    <Table<ModelStats>
      columns={columns}
      dataSource={data}
      rowKey="model"
      loading={loading ? TABLE_SPIN_INDICATOR : false}
      locale={{ emptyText: loading ? <span /> : '暂无数据' }}
      size="small"
      showSorterTooltip={false}
      pagination={false}
      scroll={{ x: 'max-content' }}
    />
  )
}

// ──────────────────────────────────────────
// 图表：每日请求量趋势
// ──────────────────────────────────────────
function DailyRequestChart({ data, isDark }: { data: DailyData[]; isDark: boolean }) {
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: gridWithLegend,
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLabel: { fontSize: 10, rotate: xAxisRotate(data.length) },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10 },
      splitLine: splitLine(isDark),
    },
    series: [
      {
        name: '成功',
        type: 'bar',
        stack: 'total',
        data: data.map(d => d.success_requests),
        itemStyle: { color: '#10b981' },
      },
      {
        name: '失败',
        type: 'bar',
        stack: 'total',
        data: data.map(d => d.error_requests),
        itemStyle: { color: '#f43f5e' },
      },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：Token 消耗趋势
// ──────────────────────────────────────────
function DailyTokenChart({ data, isDark }: { data: DailyData[]; isDark: boolean }) {
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: gridWithLegend,
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLabel: { fontSize: 10, rotate: xAxisRotate(data.length) },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        fontSize: 10,
        formatter: (v: number) => fmtAxis(v),
      },
      splitLine: splitLine(isDark),
    },
    series: [
      { name: '输入', type: 'line', data: data.map(d => d.prompt_tokens), smooth: true, itemStyle: { color: '#0ea5e9' } },
      { name: '输出', type: 'line', data: data.map(d => d.completion_tokens), smooth: true, itemStyle: { color: '#10b981' } },
      { name: '缓存命中', type: 'line', data: data.map(d => d.cache_hit_tokens), smooth: true, itemStyle: { color: '#06b6d4' }, lineStyle: { type: 'dashed' } },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：每日平均耗时趋势
// ──────────────────────────────────────────
function DailyLatencyChart({ data, isDark }: { data: DailyData[]; isDark: boolean }) {
  const option = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const d = Array.isArray(params) ? params[0] : params
        return `${d.name}<br/>${d.marker} avg: ${fmtMs(d.value)}`
      },
    },
    grid: gridNoLegend,
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLabel: { fontSize: 10, rotate: xAxisRotate(data.length) },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, formatter: (v: number) => fmtMs(v) },
      splitLine: splitLine(isDark),
    },
    series: [
      {
        name: '平均耗时',
        type: 'line',
        data: data.map(d => d.avg_latency_ms),
        smooth: true,
        itemStyle: { color: '#a78bfa' },
        areaStyle: { color: 'rgba(167,139,250,0.15)' },
      },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：模型耗时对比（P50 / P90 / P99 柱状图）
// ──────────────────────────────────────────
function ModelLatencyCompare({ data, isDark }: { data: ModelStats[]; isDark: boolean }) {
  const models = data.map(d => d.model)
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: gridWithLegendLarge,
    xAxis: {
      type: 'category',
      data: models,
      axisLabel: {
        fontSize: 10,
        interval: 0,
        rotate: 45,
        overflow: 'truncate',
        width: 60,
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, formatter: (v: number) => fmtMs(v) },
      splitLine: splitLine(isDark),
    },
    series: [
      { name: 'P50', type: 'bar', data: data.map(d => d.p50_latency_ms), itemStyle: { color: '#10b981' } },
      { name: 'P90', type: 'bar', data: data.map(d => d.p90_latency_ms), itemStyle: { color: '#f59e0b' } },
      { name: 'P99', type: 'bar', data: data.map(d => d.p99_latency_ms), itemStyle: { color: '#f43f5e' } },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：耗时三段对比
// ──────────────────────────────────────────
function LatencyBreakdownChart({ data, isDark }: { data: ModelStats[]; isDark: boolean }) {
  const streamModels = data.filter(d => d.stream_requests > 0)
  if (streamModels.length === 0) return <EmptyPlaceholder text="暂无流式请求数据" />

  const models = streamModels.map(d => d.model)
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: gridWithLegendLarge,
    xAxis: {
      type: 'category',
      data: models,
      axisLabel: {
        fontSize: 10,
        interval: 0,
        rotate: 45,
        overflow: 'truncate',
        width: 60,
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, formatter: (v: number) => fmtMs(v) },
      splitLine: splitLine(isDark),
    },
    series: [
      {
        name: '思考时间 (TTFB)',
        type: 'bar',
        stack: 'latency',
        data: streamModels.map(d => d.avg_ttfb_ms ?? 0),
        itemStyle: { color: '#0ea5e9' },
      },
      {
        name: '输出时间',
        type: 'bar',
        stack: 'latency',
        data: streamModels.map(d => d.avg_output_ms ?? 0),
        itemStyle: { color: '#10b981' },
      },
      {
        name: '总耗时',
        type: 'line',
        data: streamModels.map(d => d.avg_total_latency_ms),
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: '#a78bfa' },
        lineStyle: { width: 2 },
      },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：模型 Token 分布（饼/环形图）
// PC 端：右侧竖排图例，完整展示模型名
// 移动端：底部水平滚动图例，支持触摸滑动切换
// ──────────────────────────────────────────
function ModelTokenPieChart({ data, isMobile }: { data: ModelStats[]; isMobile: boolean }) {
  const height = isMobile ? CHART_HEIGHT_MOBILE + 40 : CHART_HEIGHT + 20
  const chartRef = React.useRef<ReactECharts>(null)
  const touchStartX = React.useRef<number>(0)
  const touchStartY = React.useRef<number>(0)

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current
    const deltaY = e.changedTouches[0].clientY - touchStartY.current
    // 只有水平滑动为主（|deltaX| > |deltaY|）且足够的距离时，才切换图例
    if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 30) return
    const instance = chartRef.current?.getEchartsInstance()
    if (!instance) return
    // 向左滑动 → 图例向后翻页，向右滑动 → 图例向前翻页
    instance.dispatchAction({
      type: 'legendScroll',
      scrollDataIndex: deltaX < 0 ? 1 : -1,
      legendId: undefined,
    })
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    // 只有水平滑动为主时（|deltaX| > |deltaY| 且 > 10px），才阻止页面滚动
    // 防止触摸治流干扰上下滑动页面
    const deltaX = Math.abs(e.touches[0].clientX - touchStartX.current)
    const deltaY = Math.abs(e.touches[0].clientY - touchStartY.current)
    if (deltaX > deltaY && deltaX > 10) {
      e.stopPropagation()
    }
  }

  // PC 端：饼图在左侧 35% 位置，右侧留给图例
  // 移动端：饼图居中，图例在下方
  const option = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} tokens ({d}%)' },
    legend: isMobile
      ? {
          type: 'scroll' as const,
          orient: 'horizontal' as const,
          bottom: 0,
          left: 'center' as const,
          textStyle: { fontSize: 10 },
          // 移动端截断过长模型名（最多12字符）
          formatter: (name: string) => name.length > 12 ? name.slice(0, 12) + '…' : name,
          // 与其他图表一致的翻页图标样式
          ...PAGE_ICON_STYLE,
        }
      : {
          // PC端：右侧竖向排列，不截断，完整显示
          type: 'scroll' as const,
          orient: 'vertical' as const,
          right: 12,
          top: 'middle' as const,
          textStyle: { fontSize: 11 },
          // 不设置 formatter，完整显示
          width: 'auto',
          ...PAGE_ICON_STYLE,
        },
    series: [
      {
        type: 'pie',
        // PC端：圆心偏左，给右侧图例留空间
        // 移动端：圆心居中偏上，给下方图例留空间
        radius: isMobile ? ['38%', '62%'] : ['40%', '65%'],
        center: isMobile ? ['50%', '42%'] : ['32%', '50%'],
        data: data.map((d, i) => ({
          name: d.model,
          value: d.total_tokens,
          itemStyle: { color: getVendorColor(d.model).color },
        })),
        label: {
          show: !isMobile,
          fontSize: 10,
          // PC端标签只显示百分比，模型名在图例里
          formatter: '{d}%',
        },
        labelLine: { show: !isMobile },
      },
    ],
  }
  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      <ReactECharts ref={chartRef} option={option} style={{ height }} />
    </div>
  )
}

// ──────────────────────────────────────────
// 图表：错误码分析（按 HTTP status_code）
// ──────────────────────────────────────────
// 每种错误码分配独立颜色：大类用色调区分，同类内再用颜色池区分
const STATUS_CODE_COLORS: Record<number, string> = {}
const COLOR_POOL_5XX = ['#f43f5e', '#fb7185', '#e11d48', '#be123c', '#ff6b6b']
const COLOR_POOL_4XX = ['#f59e0b', '#f97316', '#eab308', '#d97706', '#fb923c', '#fbbf24', '#ea580c']
const COLOR_POOL_OTHER = ['#a78bfa', '#8b5cf6', '#7c3aed', '#c084fc']
const _colorIdx: Record<string, number> = { '5xx': 0, '4xx': 0, 'other': 0 }

function statusCodeColor(code: number): string {
  if (STATUS_CODE_COLORS[code]) return STATUS_CODE_COLORS[code]
  let color: string
  if (code >= 500) {
    const pool = COLOR_POOL_5XX
    color = pool[_colorIdx['5xx'] % pool.length]
    _colorIdx['5xx']++
  } else if (code >= 400) {
    const pool = COLOR_POOL_4XX
    color = pool[_colorIdx['4xx'] % pool.length]
    _colorIdx['4xx']++
  } else {
    const pool = COLOR_POOL_OTHER
    color = pool[_colorIdx['other'] % pool.length]
    _colorIdx['other']++
  }
  STATUS_CODE_COLORS[code] = color
  return color
}

function ErrorAnalysisChart({ data, isDark }: { data: ErrorAnalysis[]; isDark: boolean }) {
  if (data.length === 0) {
    return (
      <div style={{ color: 'var(--color-success)', textAlign: 'center', padding: 32, fontSize: 13, height: CHART_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        🎉 所选时间段内无错误请求
      </div>
    )
  }
  function statusCodeLabel(code: number): string {
    if (code === 0) return '连接失败'
    if (code >= 500) return '服务端错误'
    if (code >= 400) return '客户端错误'
    return ''
  }

  const option = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        const d = Array.isArray(params) ? params[0] : params
        const code = parseInt(d.name, 10)
        const item = data.find(e => String(e.status_code) === d.name)
        const label = statusCodeLabel(code)
        const codeDisplay = code === 0 ? '连接失败' : `HTTP ${d.name}`
        return `${codeDisplay}${label && code !== 0 ? ` · ${label}` : ''}<br/>数量: ${d.value} (${pctStr(item?.pct ?? 0)})`
      },
    },
    grid: { left: 80, right: 60, top: 20, bottom: 20 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 10 },
      splitLine: splitLine(isDark),
    },
    yAxis: {
      type: 'category',
      data: data.map(d => String(d.status_code)),
      axisLabel: {
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        formatter: (v: string) => v === '0' ? '连接失败' : v,
      },
    },
    series: [
      {
        type: 'bar',
        data: data.map((d) => ({
          value: d.count,
          itemStyle: { color: statusCodeColor(d.status_code) },
        })),
        label: { show: true, position: 'right', fontSize: 11 },
      },
    ],
  }
  // 固定高度与 Token 占比卡片一致，避免两张卡片高度不同产生空白
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：按小时分布
// ──────────────────────────────────────────
function HourlyChart({ data, isDark }: { data: HourlyStat[]; isDark: boolean }) {
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: { left: 44, right: 64, top: 30, bottom: 60 },
    xAxis: {
      type: 'category',
      data: data.map(d => `${String(d.hour).padStart(2, '0')}:00`),
      axisLabel: { fontSize: 10, interval: 2 },
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { fontSize: 10 },
        name: '请求数',
        nameTextStyle: { fontSize: 10 },
        splitLine: splitLine(isDark),
      },
      {
        type: 'value',
        axisLabel: { fontSize: 10, formatter: (v: number) => fmtMs(v) },
        name: '均耗时',
        nameTextStyle: { fontSize: 10 },
        position: 'right',
        splitLine: { show: false },
      },
    ],
    series: [
      { name: '总请求', type: 'bar', stack: 'req', yAxisIndex: 0, data: data.map(d => d.total_requests), itemStyle: { color: '#0ea5e9', opacity: 0.7 } },
      { name: '失败', type: 'bar', stack: 'req', yAxisIndex: 0, data: data.map(d => d.error_requests), itemStyle: { color: '#f43f5e', opacity: 0.9 } },
      { name: '均耗时', type: 'line', yAxisIndex: 1, data: data.map(d => d.avg_latency_ms), smooth: true, itemStyle: { color: '#a78bfa' }, lineStyle: { width: 2 } },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：缓存命中率（每日趋势）
// ──────────────────────────────────────────
function DailyCacheChart({ data, isDark }: { data: DailyData[]; isDark: boolean }) {
  const option = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any[]) => {
        const d = params[0]
        return `${d.name}<br/>${d.marker} 缓存命中率: ${pctStr(d.value)}`
      },
    },
    grid: gridNoLegend,
    xAxis: {
      type: 'category',
      data: data.map(d => d.date),
      axisLabel: { fontSize: 10, rotate: xAxisRotate(data.length) },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      axisLabel: { fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
      splitLine: splitLine(isDark),
    },
    series: [
      {
        name: '缓存命中率',
        type: 'line',
        data: data.map(d => d.cache_hit_rate),
        smooth: true,
        itemStyle: { color: '#f59e0b' },
        areaStyle: { color: 'rgba(245,158,11,0.15)' },
      },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：厂商 Token 消耗（饼/环形图）
// ──────────────────────────────────────────
function ProviderTokenPieChart({ data, isMobile }: { data: ProviderStats[]; isMobile: boolean }) {
  const height = isMobile ? CHART_HEIGHT_MOBILE + 40 : CHART_HEIGHT + 20
  const chartRef = React.useRef<ReactECharts>(null)
  const touchStartX = React.useRef<number>(0)
  const touchStartY = React.useRef<number>(0)

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current
    const deltaY = e.changedTouches[0].clientY - touchStartY.current
    if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 30) return
    const instance = chartRef.current?.getEchartsInstance()
    if (!instance) return
    instance.dispatchAction({ type: 'legendScroll', scrollDataIndex: deltaX < 0 ? 1 : -1, legendId: undefined })
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    const deltaX = Math.abs(e.touches[0].clientX - touchStartX.current)
    const deltaY = Math.abs(e.touches[0].clientY - touchStartY.current)
    if (deltaX > deltaY && deltaX > 10) e.stopPropagation()
  }

  const option = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} tokens ({d}%)' },
    legend: isMobile
      ? {
          type: 'scroll' as const,
          orient: 'horizontal' as const,
          bottom: 0,
          left: 'center' as const,
          textStyle: { fontSize: 10 },
          formatter: (name: string) => name.length > 12 ? name.slice(0, 12) + '…' : name,
          ...PAGE_ICON_STYLE,
        }
      : {
          type: 'scroll' as const,
          orient: 'vertical' as const,
          right: 12,
          top: 'middle' as const,
          textStyle: { fontSize: 11 },
          width: 'auto',
          ...PAGE_ICON_STYLE,
        },
    series: [
      {
        type: 'pie',
        radius: isMobile ? ['38%', '62%'] : ['40%', '65%'],
        center: isMobile ? ['50%', '42%'] : ['32%', '50%'],
        data: data.map((d, i) => ({
          name: d.provider,
          value: d.total_tokens,
          itemStyle: { color: getVendorColor(d.provider).color },
        })),
        label: { show: !isMobile, fontSize: 10, formatter: '{d}%' },
        labelLine: { show: !isMobile },
      },
    ],
  }
  return (
    <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}>
      <ReactECharts ref={chartRef} option={option} style={{ height }} />
    </div>
  )
}

// ──────────────────────────────────────────
// 图表：厂商延迟对比（P50 / P90 / P99 柱状图）
// ──────────────────────────────────────────
function ProviderLatencyCompare({ data, isDark }: { data: ProviderStats[]; isDark: boolean }) {
  const providers = data.map(d => d.provider)
  const option = {
    tooltip: { trigger: 'axis' },
    legend: legendBottom(),
    grid: gridWithLegendLarge,
    xAxis: {
      type: 'category',
      data: providers,
      axisLabel: { fontSize: 10, interval: 0, rotate: 45, overflow: 'truncate', width: 60 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, formatter: (v: number) => fmtMs(v) },
      splitLine: splitLine(isDark),
    },
    series: [
      { name: 'P50', type: 'bar', data: data.map(d => d.p50_latency_ms), itemStyle: { color: '#10b981' } },
      { name: 'P90', type: 'bar', data: data.map(d => d.p90_latency_ms), itemStyle: { color: '#f59e0b' } },
      { name: 'P99', type: 'bar', data: data.map(d => d.p99_latency_ms), itemStyle: { color: '#f43f5e' } },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 图表：厂商成功率 + 请求量对比（双轴）
// ──────────────────────────────────────────
function ProviderOverviewChart({ data, isDark }: { data: ProviderStats[]; isDark: boolean }) {
  const providers = data.map(d => d.provider)
  const option = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any[]) => {
        const lines = [params[0].axisValue]
        for (const p of params) {
          if (p.seriesName === '成功率') {
            lines.push(`${p.marker} ${p.seriesName}: ${pctStr(p.value)}`)
          } else {
            lines.push(`${p.marker} ${p.seriesName}: ${p.value.toLocaleString()}`)
          }
        }
        return lines.join('<br/>')
      },
    },
    legend: legendBottom(),
    grid: gridWithLegend,
    xAxis: {
      type: 'category',
      data: providers,
      axisLabel: { fontSize: 10, interval: 0, rotate: 45, overflow: 'truncate', width: 60 },
    },
    yAxis: [
      {
        type: 'value',
        name: '请求数',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 },
        splitLine: splitLine(isDark),
      },
      {
        type: 'value',
        name: '成功率',
        nameTextStyle: { fontSize: 10 },
        position: 'right',
        min: 0,
        max: 1,
        axisLabel: { fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '成功请求',
        type: 'bar',
        yAxisIndex: 0,
        data: data.map(d => d.success_requests),
        itemStyle: { color: '#10b981' },
      },
      {
        name: '失败请求',
        type: 'bar',
        yAxisIndex: 0,
        data: data.map(d => d.error_requests),
        itemStyle: { color: '#f43f5e' },
      },
      {
        name: '成功率',
        type: 'line',
        yAxisIndex: 1,
        data: data.map(d => d.success_rate),
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        itemStyle: { color: '#a78bfa' },
        lineStyle: { width: 2 },
      },
    ],
  }
  return <ReactECharts option={option} style={{ height: CHART_HEIGHT }} />
}

// ──────────────────────────────────────────
// 子组件：厂商统计表
// ──────────────────────────────────────────
function ProviderStatsTable({ data, loading }: { data: ProviderStats[]; loading: boolean }) {
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 }
  const cellCenter: React.CSSProperties = { textAlign: 'center', verticalAlign: 'middle' }

  const columns: ColumnsType<ProviderStats> = [
    {
      title: '厂商',
      dataIndex: 'provider',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (v: string) => {
        const vc = getVendorColor(v)
        return (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Tag color="" style={{ background: vc.bg, color: vc.color, border: 'none', fontSize: 11, borderRadius: 2, margin: 0, fontWeight: 600 }}>{v}</Tag>
          </div>
        )
      },
    },
    {
      title: '总请求',
      dataIndex: 'total_requests',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.total_requests - b.total_requests,
      render: (v: number) => <span style={mono}>{v.toLocaleString()}</span>,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.success_rate - b.success_rate,
      render: (v: number) => (
        <span style={{ color: v >= 0.99 ? '#10b981' : v >= 0.95 ? '#f59e0b' : '#f43f5e', ...mono }}>
          {pctStr(v)}
        </span>
      ),
    },
    {
      title: '总 Token',
      dataIndex: 'total_tokens',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.total_tokens - b.total_tokens,
      render: (v: number) => <span style={mono}>{fmtTokens(v)}</span>,
    },
    {
      title: '缓存命中率',
      dataIndex: 'cache_hit_rate',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.cache_hit_rate - b.cache_hit_rate,
      render: (v: number) => (
        <span style={{ color: v >= 0.8 ? '#10b981' : v >= 0.5 ? '#f59e0b' : '#f43f5e', ...mono }}>
          {pctStr(v)}
        </span>
      ),
    },
    {
      title: '均耗时',
      dataIndex: 'avg_total_latency_ms',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => (a.avg_total_latency_ms ?? 0) - (b.avg_total_latency_ms ?? 0),
      render: (v: number) => <span style={{ ...mono, color: latencyColor(v) }}>{fmtMs(v)}</span>,
    },
    {
      title: 'P90',
      dataIndex: 'p90_latency_ms',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      sorter: (a, b) => a.p90_latency_ms - b.p90_latency_ms,
      render: (v: number) => <span style={{ ...mono, color: latencyColor(v) }}>{fmtMs(v)}</span>,
    },
    {
      title: '模型',
      key: 'models',
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, r) => (
        <Space size={4} wrap>
          {r.models.slice(0, 3).map(m => {
            const vc = getVendorColor(m)
            return (
              <Tag key={m} color="" style={{ background: vc.bg, color: vc.color, border: 'none', fontSize: 10, borderRadius: 2, margin: 0, fontWeight: 500 }}>
                {m.length > 15 ? m.slice(0, 15) + '…' : m}
              </Tag>
            )
          })}
          {r.models.length > 3 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>+{r.models.length - 3}</span>}
        </Space>
      ),
    },
  ]

  return (
    <Table<ProviderStats>
      columns={columns}
      dataSource={data}
      rowKey="provider"
      loading={loading ? TABLE_SPIN_INDICATOR : false}
      locale={{ emptyText: loading ? <span /> : '暂无厂商数据' }}
      size="small"
      showSorterTooltip={false}
      pagination={false}
      scroll={{ x: 'max-content' }}
    />
  )
}

// ──────────────────────────────────────────
// 主页面
// ──────────────────────────────────────────
export default function Stats() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  // 移动端检测（用于饼图图例切换）
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const [loading, setLoading] = useState(true)
  const [modelStats, setModelStats] = useState<ModelStats[]>([])
  const [providerStats, setProviderStats] = useState<ProviderStats[]>([])
  const [errorAnalysis, setErrorAnalysis] = useState<ErrorAnalysis[]>([])
  const [hourly, setHourly] = useState<HourlyStat[]>([])
  const [dailyData, setDailyData] = useState<DailyData[]>([])
  const [hourlyDate, setHourlyDate] = useState<string>(() => dayjs().format('YYYY-MM-DD'))

  // 汇总摘要指标
  const totalRequests = modelStats.reduce((s, d) => s + d.total_requests, 0)
  const totalTokens = modelStats.reduce((s, d) => s + d.total_tokens, 0)
  const totalErrors = modelStats.reduce((s, d) => s + d.error_requests, 0)
  const avgSuccessRate = totalRequests > 0
    ? (totalRequests - totalErrors) / totalRequests
    : 1
  const avgLatency = modelStats.length > 0
    ? modelStats.reduce((s, d) => s + (d.avg_total_latency_ms ?? 0) * d.total_requests, 0) / totalRequests
    : 0

  const loadStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const params = {
        ...(dateRange.start ? { start_date: dateRange.start } : {}),
        ...(dateRange.end ? { end_date: dateRange.end } : {}),
      }
      const [ms, ps, ea, hd, dd] = await Promise.all([
        fetchModelStats(params),
        fetchProviderStats(params),
        fetchErrorAnalysis(params),
        fetchHourly(hourlyDate),
        fetchDaily(params),
      ])
      setModelStats(ms.data)
      setProviderStats(ps.data)
      setErrorAnalysis(ea.data)
      setHourly(hd.data)
      setDailyData(dd.data)
    } catch (e) {
      console.error(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateRange.start, dateRange.end, hourlyDate])

  // 响应日期变化 + 前台刷新
  useEffect(() => { loadStats() }, [loadStats, refreshTick])
  // 响应后台静默刷新
  useEffect(() => { if (backgroundTick > 0) loadStats(true) }, [backgroundTick])

  const cardStyle = { borderRadius: 6, overflow: 'hidden' as const }
  const sectionTitle = (title: string, subtitle?: string) => (
    <Space size={8} align="baseline">
      <span>{title}</span>
      {subtitle && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>{subtitle}</span>}
    </Space>
  )

  return (
    <div className="page-content">
      {/* PC端：左边显示数据统计标题，右边显示日期筛选+刷新；移动端：仅显示筛选模块 */}
      <Header pageName="数据统计" />

      {/* 摘要指标 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 10 }}>
        {[
          { title: '总请求', value: totalRequests.toLocaleString(), color: '#0ea5e9' },
          { title: '总 Token', value: fmtTokens(totalTokens), color: '#10b981' },
          { title: '总体成功率', value: pctStr(avgSuccessRate), color: avgSuccessRate >= 0.99 ? '#10b981' : '#f59e0b' },
          { title: '平均耗时', value: fmtMs(Math.round(avgLatency)), color: latencyColor(avgLatency) },
          { title: '总错误数', value: totalErrors.toLocaleString(), color: totalErrors > 0 ? '#f43f5e' : '#10b981' },
          { title: '模型数量', value: String(modelStats.length), color: '#a78bfa' },
        ].map(item => (
          <Col key={item.title} xs={12} sm={8} md={4}>
            <Card size="small" bordered={false} className="hd-card" style={cardStyle}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.title}</span>}
                value={item.value}
                valueStyle={{ fontSize: 18, fontWeight: 700, color: item.color, fontFamily: 'var(--font-mono)' }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* 模型数据：按模型详细统计表 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24}>
          <Card
            title={sectionTitle('模型数据', `${modelStats.length} 个模型`)}
            bordered={false}
            className="hd-card"
            style={cardStyle}
            size="small"
          >
            <ModelStatsTable data={modelStats} loading={loading} />
          </Card>
        </Col>
      </Row>

      {/* 厂商统计：按厂商详细统计表 */}
      {providerStats.length > 0 && (
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={24}>
            <Card
              title={sectionTitle('厂商数据', `${providerStats.length} 个厂商`)}
              bordered={false}
              className="hd-card"
              style={cardStyle}
              size="small"
            >
              <ProviderStatsTable data={providerStats} loading={loading} />
            </Card>
          </Col>
        </Row>
      )}

      {/* 厂商图表：Token 消耗 + 延迟对比 + 请求概览 */}
      {providerStats.length > 0 && (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} md={12}>
              <Card title={sectionTitle('厂商 Token 占比', '按厂商分布')} bordered={false} className="hd-card" style={cardStyle} size="small">
                <ProviderTokenPieChart data={providerStats} isMobile={isMobile} />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card title={sectionTitle('厂商延迟对比', 'P50 / P90 / P99')} bordered={false} className="hd-card" style={cardStyle} size="small">
                <ProviderLatencyCompare data={providerStats} isDark={isDark} />
              </Card>
            </Col>
          </Row>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24}>
              <Card title={sectionTitle('厂商请求概览', '请求数 + 成功率')} bordered={false} className="hd-card" style={cardStyle} size="small">
                <ProviderOverviewChart data={providerStats} isDark={isDark} />
              </Card>
            </Col>
          </Row>
        </>
      )}

      {/* 小时分布（独占一行） */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24}>
          <Card
            title={sectionTitle('按小时分布', '请求量 + 平均耗时')}
            bordered={false}
            className="hd-card"
            style={cardStyle}
            size="small"
            extra={
              <DatePicker
                size="small"
                value={dayjs(hourlyDate)}
                allowClear={false}
                onChange={(d: ReturnType<typeof dayjs> | null) => d && setHourlyDate(d.format('YYYY-MM-DD'))}
                style={{ width: 120 }}
              />
            }
          >
            {hourly.length > 0 ? <HourlyChart data={hourly} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
      </Row>

      {/* Token 趋势 + 缓存命中率 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('Token 消耗趋势', '输入/输出/缓存命中')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {dailyData.length > 0 ? <DailyTokenChart data={dailyData} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('缓存命中率趋势', '每日')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {dailyData.length > 0 ? <DailyCacheChart data={dailyData} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
      </Row>

      {/* 每日请求 + 耗时趋势 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('每日请求量', '成功/失败堆叠')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {dailyData.length > 0 ? <DailyRequestChart data={dailyData} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('每日平均耗时趋势')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {dailyData.length > 0 ? <DailyLatencyChart data={dailyData} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
      </Row>

      {/* Token 占比 + 错误码分析：各占一半，与下方两图对称 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('Token 占比', '按模型分布')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {modelStats.length > 0 ? <ModelTokenPieChart data={modelStats} isMobile={isMobile} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('错误码分析', `共 ${totalErrors} 次错误`)} bordered={false} className="hd-card" style={cardStyle} size="small">
            <ErrorAnalysisChart data={errorAnalysis} isDark={isDark} />
          </Card>
        </Col>
      </Row>

      {/* 流式耗时三段对比 + 模型耗时分布 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('流式耗时三段对比', '思考时间 / 输出时间 / 总耗时（均值）')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {modelStats.length > 0 ? <LatencyBreakdownChart data={modelStats} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={sectionTitle('模型耗时分布', 'P50 / P90 / P99')} bordered={false} className="hd-card" style={cardStyle} size="small">
            {modelStats.length > 0 ? <ModelLatencyCompare data={modelStats} isDark={isDark} /> : <EmptyPlaceholder />}
          </Card>
        </Col>
      </Row>
    </div>
  )
}
