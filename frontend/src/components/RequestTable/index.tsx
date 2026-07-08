import React, { useEffect, useState, useCallback } from 'react'
import { Table, Tag, Select, Badge, Tooltip, Space, Card } from 'antd'
import { TABLE_SPIN_INDICATOR } from '../SpinRing'
import type { ColumnsType } from 'antd/es/table'
import { fetchRequests, fetchModelList } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import type { RequestRecord } from '../../types'
import styles from './RequestTable.module.css'
import { fmtTokens } from '../../utils/format'
import { getVendorColor } from '../Charts/chartTheme'

/**
 * 耗时分段颜色（与日志页/后端规则统一）
 * < 2s   → 绿（极快）
 * < 10s  → 蓝（快）
 * < 30s  → 默认（正常）
 * < 60s  → 橙（慢）
 * ≥ 60s  → 红（龟速）
 */
function latencyColor(ms: number): string {
  if (ms < 2_000) return '#10b981'
  if (ms < 10_000) return '#60a5fa'
  if (ms < 30_000) return '#8b949e'
  if (ms < 60_000) return '#f59e0b'
  return '#ef4444'
}

/**
 * 耗时格式化（与后端/日志页规则统一）
 * < 1s → ms；< 60s → s（保留1位小数）；≥ 60s → min（保留1位小数）
 */
function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms.toLocaleString()}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

function speedIcon(ms: number): string {
  if (ms < 2_000) return ' ⚡'
  if (ms < 10_000) return ' 🚀'
  if (ms < 30_000) return ''
  if (ms < 60_000) return ' ⏳'
  return ' 🐢'
}

export default function RequestTable() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()

  const [data, setData] = useState<RequestRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [modelFilter, setModelFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [models, setModels] = useState<string[]>([])

  // 加载请求数据（支持静默刷新）
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [reqRes, modelRes] = await Promise.all([
        fetchRequests({
          page,
          page_size: pageSize,
          model: modelFilter,
          status: statusFilter,
          start_date: dateRange.start,
          end_date: dateRange.end,
        }),
        fetchModelList(),
      ])
      setData(reqRes.items)
      setTotal(reqRes.total)
      setModels(modelRes.data)
    } catch (e) {
      if (!silent) console.error(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, pageSize, modelFilter, statusFilter, dateRange.start, dateRange.end])

  // 前台刷新（显示 loading）
  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])

  // 后台静默刷新
  useEffect(() => { if (backgroundTick > 0) fetchData(true) }, [backgroundTick])

  // 切换筛选条件时重置到第一页
  useEffect(() => {
    setPage(1)
  }, [modelFilter, statusFilter, dateRange.start, dateRange.end])

  const columns: ColumnsType<RequestRecord> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => (
        <span className={styles.mono}>{v}</span>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 160,
      render: (v: string, record) => {
        const vc = getVendorColor(v)
        return (
          <Tooltip title={record.original_model !== v ? `原始: ${record.original_model}` : undefined}>
            <Tag color={vc.color} style={{ fontSize: 11, background: vc.bg, border: `1px solid ${vc.color}30` }} className={styles.modelTag}>{v}</Tag>
          </Tooltip>
        )
      },
    },
    {
      title: '模式',
      dataIndex: 'stream',
      width: 60,
      render: (v: number) => (
        <Tag color={v ? 'purple' : 'default'} style={{ fontSize: 11 }}>
          {v ? 'SSE' : 'JSON'}
        </Tag>
      ),
    },
    {
      title: '输入 Token',
      dataIndex: 'prompt_tokens',
      width: 90,
      align: 'right',
      render: (v: number) => <span className={styles.mono}>{fmtTokens(v)}</span>,
    },
    {
      title: '输出 Token',
      dataIndex: 'completion_tokens',
      width: 90,
      align: 'right',
      render: (v: number) => <span className={styles.mono}>{fmtTokens(v)}</span>,
    },
    {
      title: '缓存命中',
      dataIndex: 'cache_hit_tokens',
      width: 90,
      align: 'right',
      render: (v: number, record) => {
        const rate = record.prompt_tokens > 0
          ? ((v / record.prompt_tokens) * 100).toFixed(0)
          : '0'
        return (
          <Tooltip title={`命中率 ${rate}%`}>
            <span className={styles.mono} style={{ color: v > 0 ? '#faad14' : '#8b949e' }}>
              {fmtTokens(v)}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: '推理 Token',
      dataIndex: 'reasoning_tokens',
      width: 90,
      align: 'right',
      render: (v: number) => (
        <span className={styles.mono} style={{ color: v > 0 ? '#b37feb' : '#8b949e' }}>
          {fmtTokens(v)}
        </span>
      ),
    },
    {
      title: '总耗时',
      dataIndex: 'latency_ms',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.latency_ms - b.latency_ms,
      render: (v: number) => (
        <Tooltip title={`${v.toLocaleString()}ms`}>
          <span className={styles.mono} style={{ color: latencyColor(v), fontWeight: 600 }}>
            {fmtDuration(v)}{speedIcon(v)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'TTFB',
      dataIndex: 'ttfb_ms',
      width: 90,
      align: 'right',
      render: (v: number, record) => (
        record.stream
          ? (
            <Tooltip title={`首字节 ${v.toLocaleString()}ms`}>
              <span className={styles.mono} style={{ color: 'var(--text-muted)' }}>{fmtDuration(v)}</span>
            </Tooltip>
          )
          : <span style={{ color: 'var(--text-disabled)' }}>—</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'success',
      width: 80,
      render: (v: number, record) => (
        v
          ? <Badge status="success" text={<span style={{ color: 'var(--color-success)', fontSize: 12 }}>{record.status_code}</span>} />
          : <Badge status="error" text={
            <Tooltip title={record.error_type}>
              <span style={{ color: 'var(--color-danger)', fontSize: 12 }}>{record.status_code}</span>
            </Tooltip>
          } />
      ),
    },
    {
      title: 'TraceID',
      dataIndex: 'trace_id',
      width: 100,
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <span className={styles.mono} style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            {v.slice(0, 10)}…
          </span>
        </Tooltip>
      ) : <span style={{ color: 'var(--text-disabled)' }}>—</span>,
    },
  ]

  return (
    <Card
      title={
        <Space size={16}>
          <span>请求明细</span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}>
            共 {total} 条记录
          </span>
        </Space>
      }
      extra={
        <Space>
          <Select
            size="small"
            value={modelFilter}
            onChange={setModelFilter}
            style={{ width: 160 }}
            options={[
              { value: 'all', label: '全部模型' },
              ...models.map(m => ({ value: m, label: m })),
            ]}
          />
          <Select
            size="small"
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 100 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'success', label: '成功' },
              { value: 'error', label: '失败' },
            ]}
          />
        </Space>
      }
      className={styles.card}
      bordered={false}
    >
      <Table<RequestRecord>
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        size="small"
        showSorterTooltip={false}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100'],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p)
            setPageSize(ps)
          },
        }}
        scroll={{ x: 1100 }}
        className={styles.table}
      />
    </Card>
  )
}
