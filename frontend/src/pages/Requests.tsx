import React, { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Table, Tag, Select, Badge, Tooltip, Space, Card, Modal, Tabs, Descriptions, Divider, Spin, Empty, Collapse } from 'antd'
import { SpinRing, TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import type { ColumnsType, TableProps } from 'antd/es/table'
import type { SorterResult } from 'antd/es/table/interface'
import { EyeOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { fetchRequests, fetchModelList, fetchRequestDetail } from '../api/stats'
import { useFilter } from '../context/FilterContext'
import { useStableData } from '../hooks/useStableData'
import { useTheme } from '../context/ThemeContext'
import type { RequestRecord } from '../types'
import Header from '../components/Header'
import { fmtTokens, fmtMs, latencyColor } from '../utils/format'
import { VendorTag, ModelTag } from '../components/CommonTag'

// 移动端检测
const isMobileCheck = () => window.innerWidth < 768

// ──────────────────────────────────────────
// JSON 语法高亮 + 折叠组件
// ──────────────────────────────────────────
interface JsonNodeProps {
  data: unknown
  depth: number
  defaultExpandDepth: number
}

function JsonNode({ data, depth, defaultExpandDepth }: JsonNodeProps) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth)
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const colors = isDark ? {
    key: 'var(--color-info)',
    string: 'var(--accent-blue)',
    number: 'var(--color-info)',
    boolean: 'var(--color-warning)',
    null: 'var(--text-muted)',
    bracket: 'var(--text-secondary)',
    punctuation: 'var(--text-muted)',
    arrow: 'var(--text-muted)',
    count: 'var(--text-muted)',
  } : {
    key: 'var(--color-info)',
    string: 'var(--accent-blue)',
    number: 'var(--color-info)',
    boolean: 'var(--color-warning)',
    null: 'var(--text-muted)',
    bracket: 'var(--text-primary)',
    punctuation: 'var(--text-secondary)',
    arrow: 'var(--text-secondary)',
    count: 'var(--text-secondary)',
  }

  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 }

  if (data === null) {
    return <span style={{ ...mono, color: colors.null }}>null</span>
  }
  if (typeof data === 'boolean') {
    return <span style={{ ...mono, color: colors.boolean }}>{String(data)}</span>
  }
  if (typeof data === 'number') {
    return <span style={{ ...mono, color: colors.number }}>{data}</span>
  }
  if (typeof data === 'string') {
    return <span style={{ ...mono, color: colors.string }}>"{data}"</span>
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span style={{ ...mono, color: colors.bracket }}>[]</span>
    }
    return (
      <span style={mono}>
        <span
          onClick={() => setExpanded(e => !e)}
          style={{ cursor: 'pointer', color: colors.arrow, userSelect: 'none' }}
        >
          {expanded ? '▼' : '▶'}
        </span>
        {' '}
        {!expanded ? (
          <span
            onClick={() => setExpanded(true)}
            style={{ cursor: 'pointer', color: colors.count }}
          >
            [{data.length} items]
          </span>
        ) : (
          <>
            <span style={{ color: colors.bracket }}>[</span>
            <div style={{ paddingLeft: 16 }}>
              {data.map((item, i) => (
                <div key={i}>
                  <JsonNode data={item} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
                  {i < data.length - 1 && <span style={{ color: colors.punctuation }}>,</span>}
                </div>
              ))}
            </div>
            <span style={{ color: colors.bracket }}>]</span>
          </>
        )}
      </span>
    )
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>)
    if (entries.length === 0) {
      return <span style={{ ...mono, color: colors.bracket }}>{'{}'}</span>
    }
    return (
      <span style={mono}>
        <span
          onClick={() => setExpanded(e => !e)}
          style={{ cursor: 'pointer', color: colors.arrow, userSelect: 'none' }}
        >
          {expanded ? '▼' : '▶'}
        </span>
        {' '}
        {!expanded ? (
          <span
            onClick={() => setExpanded(true)}
            style={{ cursor: 'pointer', color: colors.count }}
          >
            {'{'}…{entries.length} items{'}'}
          </span>
        ) : (
          <>
            <span style={{ color: colors.bracket }}>{'{'}</span>
            <div style={{ paddingLeft: 16 }}>
              {entries.map(([k, v], i) => (
                <div key={k}>
                  <span style={{ color: colors.key }}>"{k}"</span>
                  <span style={{ color: colors.punctuation }}>: </span>
                  <JsonNode data={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
                  {i < entries.length - 1 && <span style={{ color: colors.punctuation }}>,</span>}
                </div>
              ))}
            </div>
            <span style={{ color: colors.bracket }}>{'}'}</span>
          </>
        )}
      </span>
    )
  }

  return <span style={{ ...mono }}>{String(data)}</span>
}

function JsonViewer({ data }: { data: unknown }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  if (data == null) {
    return (
      <Empty description="暂无数据（该请求发生时尚未启用详情记录）" style={{ padding: '32px 0' }} />
    )
  }

  let parsed: unknown = data
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      // 非 JSON 字符串，直接展示
      return (
        <pre style={{
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)',
          padding: 16,
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 460,
          overflowY: 'auto',
          margin: 0,
        }}>
          {data as string}
        </pre>
      )
    }
  }

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-subtle)',
      padding: '12px 16px',
      borderRadius: 6,
      fontSize: 12,
      fontFamily: 'var(--font-mono)',
      lineHeight: 1.6,
      maxHeight: 460,
      overflowY: 'auto',
      wordBreak: 'break-word',
    }}>
      <JsonNode data={parsed} depth={0} defaultExpandDepth={2} />
    </div>
  )
}

// ──────────────────────────────────────────
// Markdown 渲染组件
// ──────────────────────────────────────────
function MarkdownContent({ content, isDark }: { content: string; isDark: boolean }) {
  return (
    <div className={isDark ? 'md-content md-content-dark' : 'md-content'}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
}

// ──────────────────────────────────────────
// 响应内容查看器：支持流式响应分区展示
// ──────────────────────────────────────────
function StreamContentBlock({ label, icon, content, isDark, defaultExpand = true }: {
  label: string; icon: string; content: string; isDark: boolean; defaultExpand?: boolean
}) {
  const isReasoning = icon === '💭'
  // 思考过程与输出内容均渲染为 Markdown，仅背景色不同
  const wrapStyle: React.CSSProperties = isReasoning ? {
    background: 'var(--accent-blue-light)',
    border: '1px solid var(--accent-blue-light)',
    borderRadius: 6,
    padding: '10px 14px',
    maxHeight: 480,
    overflowY: 'auto' as const,
  } : {
    background: 'var(--color-success-bg)',
    border: '1px solid var(--color-success-bg)',
    borderRadius: 6,
    padding: '10px 14px',
    maxHeight: 480,
    overflowY: 'auto' as const,
  }

  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
        marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <span>{icon}</span>
        <span>{label}</span>
        <span style={{ color: 'var(--text-disabled)', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>
          {content.length.toLocaleString()} 字
        </span>
      </div>
      <Collapse
        size="small"
        defaultActiveKey={defaultExpand ? ['block'] : []}
        items={[{
          key: 'block',
          label: <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{defaultExpand ? '折叠' : `展开内容（${content.split('\n').length} 行）`}</span>,
          children: (
            // 思考过程和输出内容都渲染为 Markdown
            <div style={wrapStyle}>
              <MarkdownContent content={content} isDark={isDark} />
            </div>
          ),
        }]}
        style={{
          background: 'transparent',
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
          borderRadius: 6,
        }}
      />
    </div>
  )
}

function ResponseViewer({ data, isStream, isDark }: { data: unknown; isStream: boolean; isDark: boolean }) {
  // 解析流式响应：新格式（{reasoning_content, content, _stream}）
  if (isStream && data) {
    let obj: Record<string, unknown> | null = null

    if (typeof data === 'string') {
      try { obj = JSON.parse(data) } catch { /* non-json */ }
    } else if (typeof data === 'object') {
      obj = data as Record<string, unknown>
    }

    if (obj) {
      let reasoningContent: string | null = null
      let regularContent: string | null = null

      // 新格式：顶层 reasoning_content / content（后端 v7.1+ 存储格式）
      if (typeof obj.reasoning_content === 'string') reasoningContent = obj.reasoning_content || null
      if (typeof obj.content === 'string') regularContent = obj.content || null

      // 兼容非流式 JSON 格式：choices[0].message
      if (!reasoningContent && !regularContent && Array.isArray(obj.choices) && obj.choices.length > 0) {
        const msg = (obj.choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined
        if (msg) {
          if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) reasoningContent = msg.reasoning_content
          if (typeof msg.content === 'string' && msg.content) regularContent = msg.content
        }
      }

      // 旧格式（纯文本）：当作思考内容处理
      if (!reasoningContent && !regularContent && typeof data === 'string' && data.length > 0) {
        reasoningContent = data
      }

      if (reasoningContent || regularContent) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {reasoningContent && (
              <StreamContentBlock
                label="思考过程"
                icon="💭"
                content={reasoningContent}
                isDark={isDark}
                defaultExpand={!regularContent} // 只有思考时默认展开
              />
            )}
            {regularContent && (
              <StreamContentBlock
                label="输出内容"
                icon="📝"
                content={regularContent}
                isDark={isDark}
                defaultExpand={true}
              />
            )}
            {/* 显示总字数说明 */}
            {(reasoningContent || regularContent) && (
              <div style={{ fontSize: 11, color: 'var(--text-disabled)', textAlign: 'right' }}>
                共 {((reasoningContent?.length ?? 0) + (regularContent?.length ?? 0)).toLocaleString()} 字（流式聚合）
              </div>
            )}
          </div>
        )
      }
    }
  }

  // 普通响应或无内容：用 JsonViewer 展示
  return <JsonViewer data={data} />
}

// ──────────────────────────────────────────
// 请求详情 Modal 弹窗
// ──────────────────────────────────────────
function RequestDetailModal({ recordId, onClose }: { recordId: number | null; onClose: () => void }) {
  const [detail, setDetail] = useState<RequestRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  useEffect(() => {
    if (recordId == null) { setDetail(null); return }
    setLoading(true)
    fetchRequestDetail(recordId)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [recordId])

  const rec = detail
  const cacheRate = rec && rec.prompt_tokens > 0
    ? `${((rec.cache_hit_tokens / rec.prompt_tokens) * 100).toFixed(1)}%`
    : '0%'
  const outputMs = rec ? (rec.latency_ms - rec.ttfb_ms) : 0

  const mobile = isMobileCheck()

  // ── 从 request_body / response_body 中提取额外信息 ──
  const reqBody = rec?.request_body as Record<string, unknown> | null | undefined
  const resBody = rec?.response_body as Record<string, unknown> | null | undefined

  // 工具个数：request_body.tools 数组长度
  const toolCount = Array.isArray(reqBody?.tools) ? (reqBody.tools as unknown[]).length : 0
  // 深度思考：request_body.thinking?.enabled 或 request_body.thinking
  const thinkingEnabled = !!(reqBody?.thinking)
  // 请求体大小（字节）
  const reqSize = reqBody ? new Blob([JSON.stringify(reqBody)]).size : 0
  // 响应体大小（字节）
  const resSize = resBody ? new Blob([JSON.stringify(resBody)]).size : 0

  const fmtBytes = (n: number) => n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n > 1024
    ? `${(n / 1024).toFixed(1)} KB`
    : `${n} B`

  // ── 单行组件：label固定宽 + value（用于基本信息/追踪信息） ──
  const InfoRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, minHeight: 24 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 60, minWidth: 60, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  )

  // ── 网格单元格：label上、value下（用于耗时/Token/概要模块） ──
  const GridCell = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: mobile ? 13 : 14, display: 'inline-flex', alignItems: 'center' }}>{children}</span>
    </div>
  )

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{children}</div>
  )
  const Divider = () => <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 0' }} />

  // 移动端：3列；PC端：6列
  const gridCols = mobile ? 'repeat(3, 1fr)' : 'repeat(6, 1fr)'
  const gridGap = mobile ? '10px 12px' : '10px 20px'

  // 移动端：顶部 Header 约 56px，弹窗上下各留 56px 间距
  // centered + style.margin 配合：antd centered 模式下 margin 生效作为外边距
  const MOBILE_V_MARGIN = 56  // 上下各留 56px，与顶部 tab 高度一致

  return (
    <Modal
      title={
        // 自定义标题行：标题文字 + 关闭按钮在同一 flex 行
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: mobile ? '0 12px' : '0 16px',
          height: mobile ? 44 : 48,
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1, color: 'var(--text-primary)' }}>
            请求详情
            {rec ? <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13, marginLeft: 6 }}>#{rec.id}</span> : ''}
          </span>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, border: 'none', background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', borderRadius: 6, padding: 0, flexShrink: 0,
              fontSize: 16,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >✕</button>
        </div>
      }
      open={recordId != null}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={mobile ? window.innerWidth - 24 : Math.min(860, window.innerWidth - 48)}
      className="hd-request-detail-modal"
      centered={true}
      style={mobile ? { marginTop: MOBILE_V_MARGIN, marginBottom: MOBILE_V_MARGIN, marginLeft: 12, marginRight: 12 } : undefined}
      styles={{
        header: { padding: 0, marginBottom: 0 },
        body: {
          maxHeight: mobile
            ? `calc(100svh - ${MOBILE_V_MARGIN * 2 + 44 + 20}px)`
            : 'calc(80vh - 56px)',
          overflowY: 'auto',
          padding: mobile ? '8px 0 16px' : '8px 4px 12px',
        },
      }}
    >
      {loading && <div style={{ textAlign: 'center', padding: '40px 0' }}><SpinRing size={28} /></div>}
      {!loading && rec && (
        <Tabs defaultActiveKey="overview" size="small" items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <>
                {/* ── 基本信息：单列 label+value ── */}
                <InfoRow label="请求时间">{rec.created_at}</InfoRow>
                <InfoRow label="请求模型">
                  <ModelTag name={rec.model} style={{ fontSize: 11, borderRadius: 3 }} />
                  {rec.original_model !== rec.model && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>→ {rec.original_model}</span>
                  )}
                  <span style={{ color: 'var(--text-disabled)', fontSize: 11 }}>/</span>
                  <Tag color={rec.stream ? 'purple' : 'default'} style={{ fontSize: 11, borderRadius: 3, margin: 0 }}>
                    {rec.stream ? 'SSE 流式' : 'JSON 非流式'}
                  </Tag>
                </InfoRow>

                <Divider />

                {/* ── 请求概要：状态码/消息条数/工具数/请求体/响应体/深度思考 ── */}
                <SectionTitle>请求概要</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: gridGap }}>
                  <GridCell label="状态码">
                    <span style={{ color: rec.success ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                      {rec.status_code}
                    </span>
                  </GridCell>
                  <GridCell label="消息条数">
                    <span style={{ color: 'var(--text-secondary)' }}>{rec.messages_count} 条</span>
                  </GridCell>
                  <GridCell label="工具个数">
                    <span style={{ color: toolCount > 0 ? 'var(--color-info)' : 'var(--text-disabled)' }}>
                      {toolCount > 0 ? `${toolCount} 个` : '—'}
                    </span>
                  </GridCell>
                  <GridCell label="请求体">
                    <span style={{ color: 'var(--text-secondary)' }}>{reqSize > 0 ? fmtBytes(reqSize) : '—'}</span>
                  </GridCell>
                  <GridCell label="响应体">
                    <span style={{ color: 'var(--text-secondary)' }}>{resSize > 0 ? fmtBytes(resSize) : '—'}</span>
                  </GridCell>
                  <GridCell label="深度思考">
                    <span style={{ color: thinkingEnabled ? '#10b981' : 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                      {thinkingEnabled ? '开启' : '关闭'}
                    </span>
                  </GridCell>
                </div>

                <Divider />

                {/* ── 耗时：移动端3列，PC端3列 ── */}
                <SectionTitle>耗时</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: gridGap }}>
                  <GridCell label="思考时间">
                    {rec.stream && rec.ttfb_ms > 0
                      ? <span style={{ color: 'var(--color-info)' }}>{fmtMs(rec.ttfb_ms)}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                  <GridCell label="输出时间">
                    {rec.stream && rec.ttfb_ms > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{fmtMs(outputMs)}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>{fmtMs(rec.latency_ms)}</span>}
                  </GridCell>
                  <GridCell label="总耗时">
                    <span style={{ color: latencyColor(rec.latency_ms), fontWeight: 700 }}>
                      {fmtMs(rec.latency_ms)}
                    </span>
                  </GridCell>
                </div>

                <Divider />

                {/* ── Token 统计：移动端3列×2行，PC端6列×1行 ── */}
                <SectionTitle>Token 统计</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: gridGap }}>
                  <GridCell label="输入">{rec.prompt_tokens.toLocaleString()}</GridCell>
                  <GridCell label="输出">{rec.completion_tokens.toLocaleString()}</GridCell>
                  <GridCell label="总计">{rec.total_tokens.toLocaleString()}</GridCell>
                  {(rec as any).cache_write_tokens > 0 && (
                    <GridCell label="缓存写入">
                      <span style={{ color: 'var(--color-warning)' }}>{((rec as any).cache_write_tokens as number).toLocaleString()}</span>
                    </GridCell>
                  )}
                  <GridCell label="缓存命中">
                    {rec.cache_hit_tokens > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{rec.cache_hit_tokens.toLocaleString()}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                  <GridCell label="命中率">
                    {rec.cache_hit_tokens > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{cacheRate}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                </div>

                <Divider />

                {/* ── 追踪信息 ── */}
                <SectionTitle>追踪信息</SectionTitle>
                {rec.trace_id && (
                  <InfoRow label="Trace ID">
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)', wordBreak: 'break-all', lineHeight: 1.5 }}>{rec.trace_id}</span>
                  </InfoRow>
                )}
                {rec.client_ip && (
                  <InfoRow label="客户端 IP">
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{rec.client_ip}</span>
                  </InfoRow>
                )}
              </>
            ),
          },
          {
            key: 'request',
            label: '请求内容',
            children: <JsonViewer data={rec.request_body} />,
          },
          {
            key: 'response',
            label: '响应内容',
            children: <ResponseViewer data={rec.response_body} isStream={!!rec.stream} isDark={isDark} />,
          },
        ]} />
      )}
    </Modal>
  )
}

// ──────────────────────────────────────────
// 主页面
// ──────────────────────────────────────────
export default function Requests() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()

  const [data, setData] = useState<RequestRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [loading, setLoading] = useState(true)
  const [modelFilter, setModelFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [models, setModels] = useState<string[]>([])
  const [detailId, setDetailId] = useState<number | null>(null)
  const [sortBy, setSortBy] = useState<string>('created_at')
  const [sortOrder, setSortOrder] = useState<string>('desc')
  const { setIfChanged } = useStableData()

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
          sort_by: sortBy,
          sort_order: sortOrder,
        }),
        fetchModelList(),
      ])
      if (silent) {
        setIfChanged(reqRes.items, setData, 'items')
        setIfChanged(reqRes.total, (v) => setTotal(v), 'total')
      } else {
        setData(reqRes.items)
        setTotal(reqRes.total)
      }
      setModels(modelRes.data)
    } catch (e) {
      if (!silent) console.error(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, pageSize, modelFilter, statusFilter, dateRange.start, dateRange.end, sortBy, sortOrder])

  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])
  useEffect(() => { if (backgroundTick > 0) fetchData(true) }, [backgroundTick])
  useEffect(() => { setPage(1) }, [modelFilter, statusFilter, dateRange.start, dateRange.end])

  // 只处理排序变化，不处理分页（分页由 pagination.onChange 单独处理）
  // 关键：必须判断是否真的有 sorter 字段变化，避免误处理分页点击事件
  const handleTableChange: TableProps<RequestRecord>['onChange'] = (_pagination, _filters, sorter, extra) => {
    // 只在 action 为 'sort' 时才处理排序，完全忽略分页触发的 onChange
    if (extra?.action !== 'sort') return

    const s = sorter as SorterResult<RequestRecord>
    if (s && s.field) {
      const field = String(s.field)
      setSortBy(field)
      setSortOrder(s.order === 'ascend' ? 'asc' : 'desc')
      setPage(1)
    } else if (!s.field) {
      // 清除排序（用户点击了已激活的列来取消排序）
      setSortBy('created_at')
      setSortOrder('desc')
      setPage(1)
    }
  }

  const [isMobile, setIsMobile] = useState(isMobileCheck())

  React.useEffect(() => {
    const handleResize = () => setIsMobile(isMobileCheck())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const cellStyle: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' }

  const columns: ColumnsType<RequestRecord> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: isMobile ? 90 : 96,
      fixed: isMobile ? ('left' as const) : undefined,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: string) => (
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}>
          {v ? dayjs(v).format('MM-DD HH:mm') : '—'}
        </span>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: isMobile ? 100 : 140,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: string, record) => {
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Tooltip title={record.original_model !== v ? `原始模型: ${record.original_model}` : undefined}>
              <ModelTag name={v} style={{ fontFamily: 'var(--font-mono)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />
            </Tooltip>
          </div>
        )
      },
    },
    {
      title: '模式',
      dataIndex: 'stream',
      width: 56,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number) => (
        <Tag color={v ? 'purple' : 'default'} style={{ fontSize: 10, borderRadius: 2, margin: 0, padding: '0 4px' }}>
          {v ? 'SSE' : 'JSON'}
        </Tag>
      ),
    },
    {
      title: '输入',
      dataIndex: 'prompt_tokens',
      width: 72,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtTokens(v)}</span>,
    },
    {
      title: '输出',
      dataIndex: 'completion_tokens',
      width: 72,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtTokens(v)}</span>,
    },
    {
      title: '总 Token',
      dataIndex: 'total_tokens',
      width: 88,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number, record) => (
        <Tooltip title={record.reasoning_tokens > 0 ? `推理: ${record.reasoning_tokens.toLocaleString()}` : undefined}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtTokens(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: '缓存',
      dataIndex: 'cache_hit_tokens',
      key: 'cache_hit_tokens',
      width: 72,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number, record) => {
        if (v === 0) return <span style={{ color: 'var(--text-disabled)' }}>—</span>
        const rate = record.prompt_tokens > 0
          ? `${((v / record.prompt_tokens) * 100).toFixed(0)}%`
          : ''
        return (
          <Tooltip title={`命中 ${v.toLocaleString()} tokens`}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-warning)' }}>
              {rate}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: '思考时间',
      dataIndex: 'ttfb_ms',
      key: 'ttfb_ms',
      width: 76,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number, record) => {
        if (!record.stream || !v) return <span style={{ color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
        return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-info)' }}>{fmtMs(v)}</span>
      },
    },
    {
      title: '输出时间',
      key: 'output_ms',
      width: 82,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (_: unknown, record) => {
        if (!record.stream || !record.ttfb_ms) return <span style={{ color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
        const outputMs = record.latency_ms - record.ttfb_ms
        return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-warning)' }}>{fmtMs(outputMs)}</span>
      },
    },
    {
      title: '总耗时',
      dataIndex: 'latency_ms',
      key: 'latency_ms',
      width: 82,
      align: 'center' as const,
      sorter: true,
      // 不设置 defaultSortOrder，初始不显示排序高亮
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: latencyColor(v), fontWeight: 600 }}>
          {fmtMs(v)}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'success',
      width: 68,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: number, record) => (
        v
          ? <Badge status="success" text={<span style={{ color: 'var(--color-success)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>{record.status_code}</span>} />
          : <Badge status="error" text={
            <Tooltip title={record.error_type}>
              <span style={{ color: 'var(--color-danger)', fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'help' }}>{record.status_code}</span>
            </Tooltip>
          } />
      ),
    },
    {
      title: '',
      key: 'action',
      width: 40,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (_: unknown, record) => (
        <Tooltip title="查看详情">
          <button
            onClick={() => setDetailId(record.id)}
            style={{
              width: 28, height: 28, border: 'none', background: 'transparent',
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', borderRadius: 4, padding: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-blue)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <EyeOutlined style={{ fontSize: 14 }} />
          </button>
        </Tooltip>
      ),
    },
  ]

  return (
    <>
      <div className="page-content">
        {/* PC端：左边显示请求明细标题，右边显示日期筛选+刷新；移动端：仅显示筛选模块 */}
        <Header pageName="请求明细" />

        <section className="section">
          <Card
            title={
              isMobile ? null : (
                <Space size={12}>
                  <span>请求明细</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                    共 {total.toLocaleString()} 条
                  </span>
                </Space>
              )
            }
            extra={
              !isMobile ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Select
                    size="small"
                    value={modelFilter}
                    onChange={(v) => { setModelFilter(v); setPage(1) }}
                    style={{ minWidth: 100, maxWidth: 300 }}
                    options={[
                      { value: 'all', label: '全部模型' },
                      ...models.map(m => ({ value: m, label: m })),
                    ]}
                    showSearch
                    optionFilterProp="label"
                  />
                  <Select
                    size="small"
                    value={statusFilter}
                    onChange={(v) => { setStatusFilter(v); setPage(1) }}
                    style={{ minWidth: 100, maxWidth: 200 }}
                    options={[
                      { value: 'all', label: '全部状态' },
                      { value: 'success', label: '成功' },
                      { value: 'error', label: '失败' },
                    ]}
                  />
                </div>
              ) : undefined
            }
            bordered={false}
            className="hd-card"
            style={{ borderRadius: 6, overflow: 'hidden' }}
          >
            {/* 筛选组件：独立一行，解决标题被遮挡问题 */}
            {/* 移动端：筛选框独立一行，各占约 50% 宽度 */}
            {isMobile && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <Select
                  size="small"
                  value={modelFilter}
                  onChange={(v) => { setModelFilter(v); setPage(1) }}
                  style={{ minWidth: 100, maxWidth: 'calc(50vw - 16px)', flex: 1 }}
                  options={[
                    { value: 'all', label: '全部模型' },
                    ...models.map(m => ({ value: m, label: m })),
                  ]}
                  showSearch
                  optionFilterProp="label"
                />
                <Select
                  size="small"
                  value={statusFilter}
                  onChange={(v) => { setStatusFilter(v); setPage(1) }}
                  style={{ minWidth: 100, maxWidth: 'calc(50vw - 16px)', flex: 1 }}
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'success', label: '成功' },
                    { value: 'error', label: '失败' },
                  ]}
                />
              </div>
            )}
            <Table<RequestRecord>
              columns={columns}
              dataSource={data}
              rowKey="id"
              loading={loading ? TABLE_SPIN_INDICATOR : false}
              locale={{ emptyText: loading ? <span /> : '暂无数据' }}
              size="small"
              // onChange 只处理排序，不处理分页（由 pagination.onChange 单独管理）
              onChange={handleTableChange}
              pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                showQuickJumper: false,
                // 移动端：simple 模式（上一页/页码/下一页），彻底避免末页重叠
                // PC端：showLessItems 减少显示页码数量，使末页与省略号间距更宽松
                ...(isMobile ? { simple: true } : { showLessItems: true }),
                pageSizeOptions: ['15', '30', '50', '100'],
                showTotal: (t) => `共 ${t.toLocaleString()} 条`,
                // itemRender：为省略号按钮（jump-next/jump-prev）包裹额外间距，彻底避免与末页重叠
                itemRender: (page, type, originalElement) => {
                  if (type === 'jump-next' || type === 'jump-prev') {
                    return (
                      <span style={{ display: 'inline-block', padding: '0 4px' }}>
                        {originalElement}
                      </span>
                    )
                  }
                  return originalElement
                },
                // 使用独立的分页 onChange，与表格排序完全解耦
                onChange: (p, ps) => {
                  setPage(p)
                  if (ps !== pageSize) {
                    setPageSize(ps)
                    setPage(1)
                  }
                },
                size: 'small',
              }}
              scroll={{ x: 'max-content' }}
              onRow={isMobile ? (record) => ({
                onClick: () => setDetailId(record.id),
                style: { cursor: 'pointer' },
              }) : undefined}
            />
          </Card>
        </section>
      </div>

      <RequestDetailModal recordId={detailId} onClose={() => {
        setDetailId(null)
        // 修复：Modal 关闭后强制清除 body 的 overflow:hidden（antd 在某些情况下不清理）
        requestAnimationFrame(() => {
          document.body.style.overflow = ''
          document.body.style.width = ''
        })
      }} />
    </>
  )
}
