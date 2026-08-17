import React, { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Table, Tag, Badge, Tooltip, Space, Card, Modal, Tabs, Spin, Empty, Collapse, Button, Form, InputNumber, Switch, Alert, message } from 'antd'
import { DetailSkeleton, TableSkeleton } from '../components/LoadingSkeleton'
import type { ColumnsType, TableProps } from 'antd/es/table'
import type { SorterResult } from 'antd/es/table/interface'
import { EyeOutlined, SettingOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  fetchRequests,
  fetchModelList,
  fetchRequestFilterOptions,
  fetchRequestDetail,
  fetchRequestRetention,
  previewRequestRetention,
  updateRequestRetention,
} from '../api/stats'
import { useFilter } from '../context/FilterContext'
import { useStableData } from '../hooks/useStableData'
import { useLatestAsyncRequest } from '../hooks/useLatestAsyncRequest'
import { useTheme } from '../context/ThemeContext'
import type { RequestRecord } from '../types'
import Header from '../components/Header'
import AppModal from '../components/AppModal'
import MobileTooltip from '../components/MobileTooltip'
import { fmtCny, fmtCnyPerMillionValue, fmtTokens, fmtMs, latencyColor } from '../utils/format'
import { formatRequestType } from '../utils/requestDisplay'
import { VendorTag, ModelTag } from '../components/CommonTag'
import { useIsMobile } from '../hooks/useMediaQuery'
import AdaptiveFilterSelect from '../components/AdaptiveFilterSelect'

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
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, minHeight: 24 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 60, minWidth: 60, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, flex: 1, minWidth: 0 }}>{children}</span>
    </div>
  )
}

function GridCell({ label, children }: { label: string; children: React.ReactNode }) {
  const isMobile = useIsMobile()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-sans)', fontVariantNumeric: 'tabular-nums', fontSize: isMobile ? 13 : 14, display: 'inline-flex', alignItems: 'center' }}>{children}</span>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-secondary)', marginBottom: 9 }}>{children}</div>
}

function DetailDivider() {
  return <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 0' }} />
}

function RequestDetailModal({ recordId, onClose }: { recordId: number | null; onClose: () => void }) {
  const [detail, setDetail] = useState<RequestRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const { begin, isCurrent, isForegroundCurrent } = useLatestAsyncRequest()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const mobile = useIsMobile()

  const loadDetail = useCallback((id: number) => {
    const token = begin(false)
    setLoading(true)
    setLoadError(false)
    fetchRequestDetail(id)
      .then(value => {
        if (!isCurrent(token)) return
        setDetail(value)
        setLoadError(false)
      })
      .catch(() => {
        if (!isCurrent(token)) return
        setDetail(null)
        setLoadError(true)
      })
      .finally(() => {
        if (isForegroundCurrent(token)) setLoading(false)
      })
  }, [begin, isCurrent, isForegroundCurrent])

  useEffect(() => {
    if (recordId == null) {
      begin(false)
      setDetail(null)
      setLoadError(false)
      return
    }
    loadDetail(recordId)
  }, [begin, recordId, loadDetail])

  const rec = detail
  const cacheRate = rec && rec.prompt_tokens > 0
    ? `${((rec.cache_hit_tokens / rec.prompt_tokens) * 100).toFixed(1)}%`
    : '0%'
  const cacheWriteTokens = rec?.cache_write_tokens ?? rec?.cache_miss_tokens ?? 0
  const outputMs = rec ? (rec.latency_ms - rec.ttfb_ms) : 0

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

  // 移动端：3列；PC端：6列
  const gridCols = mobile ? 'repeat(3, 1fr)' : 'repeat(6, 1fr)'
  const gridGap = mobile ? '10px 12px' : '10px 20px'

  // 移动端：顶部 Header 约 56px，弹窗上下各留 56px 间距
  // centered + style.margin 配合：antd centered 模式下 margin 生效作为外边距
  const MOBILE_V_MARGIN = 56  // 上下各留 56px，与顶部 tab 高度一致

  return (
    <AppModal
      title="请求详情"
      titleMeta={rec ? `#${rec.id}` : undefined}
      open={recordId != null}
      onCancel={onClose}
      footer={null}
      width={mobile ? 'calc(100vw - 24px)' : 860}
      className="hd-request-detail-modal"
      centered={true}
      style={mobile ? { marginTop: MOBILE_V_MARGIN, marginBottom: MOBILE_V_MARGIN, marginLeft: 12, marginRight: 12 } : undefined}
      contentStyle={{
        maxHeight: mobile
          ? `calc(100svh - ${MOBILE_V_MARGIN * 2 + 44 + 20}px)`
          : 'calc(80vh - 56px)',
        overflowY: 'auto',
      }}
    >
      {loading && <DetailSkeleton />}
      {!loading && loadError && recordId != null && (
        <Alert
          type="error"
          showIcon
          message="请求详情加载失败"
          description="记录可能已被清理，或服务暂时不可用。"
          action={<Button size="small" onClick={() => loadDetail(recordId)}>重试</Button>}
        />
      )}
      {!loading && rec && (
        <Tabs defaultActiveKey="overview" size="small" items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <>
                {/* ── 基本信息：单列 label+value ── */}
                <InfoRow label="请求时间">
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{rec.created_at}</span>
                </InfoRow>
                <InfoRow label="请求模型">
                  {rec.provider && (
                    <>
                      <VendorTag name={rec.provider} style={{ fontSize: 11, borderRadius: 3 }} />
                      <span style={{ color: 'var(--text-disabled)', fontSize: 11 }}>/</span>
                    </>
                  )}
                  <ModelTag name={rec.model} style={{ fontSize: 11, borderRadius: 3 }} />
                </InfoRow>
                <InfoRow label="请求类型">
                  <Tag color={rec.stream ? 'purple' : 'default'} style={{ fontSize: 11, borderRadius: 3, margin: 0 }}>
                    {formatRequestType(rec.stream)}
                  </Tag>
                </InfoRow>

                <DetailDivider />

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

                <DetailDivider />

                <SectionTitle>成本估算</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: gridGap }}>
                  <GridCell label="本次花费">
                    <span style={{ color: rec.estimated_cost == null ? 'var(--text-disabled)' : 'var(--color-warning)', fontWeight: 700 }}>
                      {fmtCny(rec.estimated_cost)}
                    </span>
                  </GridCell>
                  <GridCell label="综合平均单价（￥/百万 Token）">
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {rec.estimated_cost != null && rec.billable_tokens
                        ? fmtCnyPerMillionValue(rec.estimated_cost * 1_000_000 / rec.billable_tokens)
                        : '—'}
                    </span>
                  </GridCell>
                  <GridCell label="价格来源">
                    <span style={{ color: rec.cost_source ? 'var(--text-secondary)' : 'var(--text-disabled)', fontSize: 12 }}>
                      {rec.cost_source === 'historical_estimate'
                        ? '历史估算'
                        : rec.cost_source === 'request_snapshot'
                          ? '请求时快照'
                          : '未配置价格'}
                    </span>
                  </GridCell>
                </div>

                <DetailDivider />

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

                <DetailDivider />

                {/* 缓存读取/写入是输入 Token 的组成部分，不在总计中重复相加。 */}
                <SectionTitle>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    Token 统计
                    <Tooltip title="输入总量按统一口径包含普通输入、缓存读取和缓存写入。OpenAI 通常仅返回缓存读取，Anthropic 可返回读取和写入；输出不提供缓存字段。“—”表示上游未返回或本次为 0。">
                      <span aria-label="Token 统计说明" style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 11 }}>ⓘ</span>
                    </Tooltip>
                  </span>
                </SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: gridGap }}>
                  <GridCell label="输入总量">{rec.prompt_tokens.toLocaleString()}</GridCell>
                  <GridCell label="其中缓存读取">
                    {rec.cache_hit_tokens > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{rec.cache_hit_tokens.toLocaleString()}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                  <GridCell label="其中缓存写入">
                    {cacheWriteTokens > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{cacheWriteTokens.toLocaleString()}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                  <GridCell label="输出">{rec.completion_tokens.toLocaleString()}</GridCell>
                  <GridCell label="总计">{rec.total_tokens.toLocaleString()}</GridCell>
                  <GridCell label="命中率">
                    {rec.cache_hit_tokens > 0
                      ? <span style={{ color: 'var(--color-warning)' }}>{cacheRate}</span>
                      : <span style={{ color: 'var(--text-disabled)' }}>—</span>}
                  </GridCell>
                </div>

                <DetailDivider />

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
    </AppModal>
  )
}

// ──────────────────────────────────────────
// 主页面
// ──────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export default function Requests() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const isMobile = useIsMobile()

  const [data, setData] = useState<RequestRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [modelFilter, setModelFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [protocolFilter, setProtocolFilter] = useState('all')
  const [streamFilter, setStreamFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [clientKeyFilter, setClientKeyFilter] = useState('all')
  const [models, setModels] = useState<string[]>([])
  const [filterOptions, setFilterOptions] = useState({ providers: [] as string[], protocols: [] as string[], client_keys: [] as Array<{ id: number; name: string; is_deleted: boolean }> })
  const [detailId, setDetailId] = useState<number | null>(null)
  const [sortBy, setSortBy] = useState<string>('created_at')
  const [sortOrder, setSortOrder] = useState<string>('desc')
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [retentionLoading, setRetentionLoading] = useState(false)
  const [retentionSaving, setRetentionSaving] = useState(false)
  const [retentionLastRun, setRetentionLastRun] = useState<string | null>(null)
  const [retentionLastError, setRetentionLastError] = useState<string | null>(null)
  const { begin, isCurrent, isForegroundCurrent } = useLatestAsyncRequest()
  const [retentionForm] = Form.useForm()
  const retentionEnabled = Form.useWatch<boolean>('enabled', retentionForm)
  const { setIfChanged } = useStableData()

  const openRetentionSettings = async () => {
    setRetentionOpen(true)
    setRetentionLoading(true)
    try {
      const config = await fetchRequestRetention()
      retentionForm.setFieldsValue({
        enabled: config.enabled,
        retention_days: config.retention_days,
      })
      setRetentionLastRun(config.last_run_at)
      setRetentionLastError(config.last_error)
    } catch (err: unknown) {
      const error = (err as {response?: {data?: {error?: string}}})?.response?.data?.error
      message.error(error || '读取请求保留设置失败')
      setRetentionOpen(false)
    } finally {
      setRetentionLoading(false)
    }
  }

  const saveRetentionSettings = async () => {
    let values: { enabled: boolean; retention_days: number }
    try {
      values = await retentionForm.validateFields()
    } catch {
      return
    }

    const persist = async (confirmationToken?: string) => {
      setRetentionSaving(true)
      try {
        const result = await updateRequestRetention({
          ...values,
          confirmation_token: confirmationToken,
        })
        message.success(result.message || '请求保留设置已保存')
        setRetentionOpen(false)
      } catch (err: unknown) {
        const error = (err as {response?: {data?: {error?: string}}})?.response?.data?.error
        message.error(error || '保存请求保留设置失败')
      } finally {
        setRetentionSaving(false)
      }
    }

    if (!values.enabled) {
      await persist()
      return
    }

    setRetentionSaving(true)
    try {
      const preview = await previewRequestRetention(values.retention_days)
      Modal.confirm({
        centered: true,
        title: '确认启用请求自动清理？',
        width: 460,
        content: (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <p>将保留最近 <strong>{preview.retention_days}</strong> 天的请求记录。</p>
            <p>下次每日任务预计删除 <strong>{preview.request_count.toLocaleString()}</strong> 条记录，正文约 <strong>{formatBytes(preview.total_body_bytes)}</strong>。</p>
            <p style={{ color: 'var(--text-muted)' }}>截止日期：{preview.cutoff_date} 之前；保存后不会立即删除，也不会自动执行 VACUUM。</p>
          </div>
        ),
        okText: '确认启用',
        okButtonProps: { danger: preview.request_count > 0 },
        cancelText: '取消',
        onOk: () => persist(preview.confirmation_token),
      })
    } catch (err: unknown) {
      const error = (err as {response?: {data?: {error?: string}}})?.response?.data?.error
      message.error(error || '生成清理预览失败')
    } finally {
      setRetentionSaving(false)
    }
  }

  const fetchData = useCallback(async (silent = false) => {
    const token = begin(silent)
    if (!silent) setLoading(true)
    try {
      const [reqResult, modelResult, filterResult] = await Promise.allSettled([
        fetchRequests({
          page,
          page_size: pageSize,
          model: modelFilter,
          status: statusFilter,
          protocol: protocolFilter,
          stream: streamFilter,
          provider: providerFilter,
          client_key_id: clientKeyFilter,
          start_date: dateRange.start,
          end_date: dateRange.end,
          sort_by: sortBy,
          sort_order: sortOrder,
        }),
        fetchModelList(),
        fetchRequestFilterOptions(),
      ])
      if (!isCurrent(token)) return
      if (reqResult.status === 'rejected') throw reqResult.reason
      const reqRes = reqResult.value
      if (silent) {
        setIfChanged(reqRes.items, setData, 'items')
        setIfChanged(reqRes.total, (v) => setTotal(v), 'total')
      } else {
        setData(reqRes.items)
        setTotal(reqRes.total)
      }
      if (modelResult.status === 'fulfilled') setModels(modelResult.value.data)
      if (filterResult.status === 'fulfilled') setFilterOptions(filterResult.value)
      if (!silent) setLoadError(false)
    } catch (e) {
      if (isCurrent(token) && !silent) {
        console.error(e)
        setLoadError(true)
      }
    } finally {
      if (!silent && isForegroundCurrent(token)) setLoading(false)
    }
  }, [begin, isCurrent, isForegroundCurrent, page, pageSize, modelFilter, statusFilter, protocolFilter, streamFilter, providerFilter, clientKeyFilter, dateRange.start, dateRange.end, sortBy, sortOrder, setIfChanged])

  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])
  useEffect(() => { if (backgroundTick > 0) fetchData(true) }, [backgroundTick, fetchData])
  useEffect(() => { setPage(1) }, [modelFilter, statusFilter, protocolFilter, streamFilter, providerFilter, clientKeyFilter, dateRange.start, dateRange.end])

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
      key: 'model',
      width: isMobile ? 100 : 140,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: string) => {
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <MobileTooltip title={v}>
              <ModelTag name={v} style={{ fontFamily: 'var(--font-mono)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />
            </MobileTooltip>
          </div>
        )
      },
    },
    {
      title: 'API Key',
      dataIndex: 'api_key_name',
      width: isMobile ? 70 : 90,
      align: 'center' as const,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (v: string | null, record) => (
        <Space size={4} wrap={false}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: v ? 550 : 400, color: v ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
            {v || (record.api_key_id != null ? `API Key #${record.api_key_id}` : '未关联 API Key')}
          </span>
          {record.api_key_deleted && (
            <Tag color="default" style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>已删除</Tag>
          )}
        </Space>
      ),
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
      key: 'total_tokens',
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
      title: '花费',
      dataIndex: 'estimated_cost',
      key: 'estimated_cost',
      width: 92,
      align: 'center' as const,
      sorter: true,
      onHeaderCell: () => ({ style: { textAlign: 'center' } }),
      onCell: () => ({ style: cellStyle }),
      render: (value: number | null | undefined, record) => (
        <Tooltip title={value == null
          ? '该请求对应模型未配置价格'
          : record.cost_source === 'historical_estimate'
            ? '使用当前模型价格回填的历史估算'
            : '使用请求发生时的价格快照'}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: value == null ? 'var(--text-disabled)' : 'var(--color-warning)',
          }}>
            {fmtCny(value)}
          </span>
        </Tooltip>
      ),
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
      key: 'success',
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
            type="button"
            onClick={() => setDetailId(record.id)}
            aria-label={`查看请求 ${record.id} 详情`}
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

  const mobileColumnKeys = new Set([
    'created_at',
    'model',
    'total_tokens',
    'estimated_cost',
    'success',
    'action',
  ])
  const visibleColumns = isMobile
    ? columns.filter(column => mobileColumnKeys.has(String(column.key)))
    : columns

  return (
    <>
      <div className="page-content">
        {/* PC端：左边显示请求明细标题，右边显示日期筛选+刷新；移动端：仅显示筛选模块 */}
        <Header pageName="请求明细" />

        <section className="section">
          {loadError && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 10 }}
              message="请求明细加载失败"
              action={<Button size="small" onClick={() => fetchData(false)}>重试</Button>}
            />
          )}
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
                  <Tooltip title="请求保留设置">
                    <Button
                      size="small"
                      icon={<SettingOutlined />}
                      onClick={openRetentionSettings}
                      aria-label="请求保留设置"
                    />
                  </Tooltip>
                  <AdaptiveFilterSelect
                    aria-label="模型筛选"
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
                  <AdaptiveFilterSelect
                    aria-label="状态筛选"
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
                  <AdaptiveFilterSelect
                    aria-label="协议筛选"
                    size="small"
                    value={protocolFilter}
                    onChange={(v) => { setProtocolFilter(v); setPage(1) }}
                    style={{ minWidth: 110, maxWidth: 170 }}
                    options={[
                      { value: 'all', label: '全部协议' },
                      ...filterOptions.protocols.map(protocol => ({ value: protocol, label: protocol === 'anthropic_messages' ? 'Anthropic' : protocol === 'openai_responses' ? 'Responses' : 'Chat' })),
                    ]}
                  />
                  <AdaptiveFilterSelect
                    aria-label="流式模式筛选"
                    size="small"
                    value={streamFilter}
                    onChange={(v) => { setStreamFilter(v); setPage(1) }}
                    style={{ minWidth: 100, maxWidth: 130 }}
                    options={[{ value: 'all', label: '全部模式' }, { value: 'json', label: 'JSON' }, { value: 'sse', label: 'SSE' }]}
                  />
                  <AdaptiveFilterSelect
                    aria-label="厂商筛选"
                    size="small"
                    value={providerFilter}
                    onChange={(v) => { setProviderFilter(v); setPage(1) }}
                    style={{ minWidth: 100, maxWidth: 160 }}
                    options={[{ value: 'all', label: '全部厂商' }, ...filterOptions.providers.map(provider => ({ value: provider, label: provider === 'default' ? '未关联厂商' : provider }))]}
                  />
                  <AdaptiveFilterSelect
                    aria-label="Client Access Key 筛选"
                    size="small"
                    value={clientKeyFilter}
                    onChange={(v) => { setClientKeyFilter(v); setPage(1) }}
                    style={{ minWidth: 130, maxWidth: 210 }}
                    options={[
                      { value: 'all', label: '全部 Client Key' },
                      ...filterOptions.client_keys.map(key => ({ value: String(key.id), label: key.is_deleted ? `${key.name}（已删除）` : key.name })),
                    ]}
                  />
                </div>
              ) : undefined
            }
            bordered={false}
            className="hd-card"
            style={{ borderRadius: 6, overflow: 'hidden' }}
          >
            {isMobile && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <Tooltip title="请求保留设置">
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={openRetentionSettings}
                    aria-label="请求保留设置"
                  />
                </Tooltip>
              </div>
            )}
            {/* 筛选组件：独立一行，解决标题被遮挡问题 */}
            {/* 移动端：筛选框独立一行，各占约 50% 宽度 */}
            {isMobile && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <AdaptiveFilterSelect
                  aria-label="模型筛选"
                  size="small"
                  value={modelFilter}
                  onChange={(v) => { setModelFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                  options={[
                    { value: 'all', label: '全部模型' },
                    ...models.map(m => ({ value: m, label: m })),
                  ]}
                  showSearch
                  optionFilterProp="label"
                />
                <AdaptiveFilterSelect
                  aria-label="状态筛选"
                  size="small"
                  value={statusFilter}
                  onChange={(v) => { setStatusFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'success', label: '成功' },
                    { value: 'error', label: '失败' },
                  ]}
                />
                <AdaptiveFilterSelect
                  aria-label="协议筛选"
                  size="small"
                  value={protocolFilter}
                  onChange={(v) => { setProtocolFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                  options={[
                    { value: 'all', label: '全部协议' },
                    ...filterOptions.protocols.map(protocol => ({ value: protocol, label: protocol === 'anthropic_messages' ? 'Anthropic' : protocol === 'openai_responses' ? 'Responses' : 'Chat' })),
                  ]}
                />
                <AdaptiveFilterSelect
                  aria-label="流式模式筛选"
                  size="small"
                  value={streamFilter}
                  onChange={(v) => { setStreamFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                  options={[{ value: 'all', label: '全部模式' }, { value: 'json', label: 'JSON' }, { value: 'sse', label: 'SSE' }]}
                />
                <AdaptiveFilterSelect
                  aria-label="厂商筛选"
                  size="small"
                  value={providerFilter}
                  onChange={(v) => { setProviderFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                    options={[{ value: 'all', label: '全部厂商' }, ...filterOptions.providers.map(provider => ({ value: provider, label: provider === 'default' ? '未关联厂商' : provider }))]}
                />
                <AdaptiveFilterSelect
                  aria-label="Client Access Key 筛选"
                  size="small"
                  value={clientKeyFilter}
                  onChange={(v) => { setClientKeyFilter(v); setPage(1) }}
                  style={{ minWidth: 'calc(50% - 4px)', maxWidth: 'calc(50% - 4px)', flex: '1 1 calc(50% - 4px)' }}
                  options={[
                    { value: 'all', label: '全部 Client Key' },
                    ...filterOptions.client_keys.map(key => ({ value: String(key.id), label: key.is_deleted ? `${key.name}（已删除）` : key.name })),
                  ]}
                />
              </div>
            )}
            {isMobile && (
              <div className="mobile-table-hint" role="note">
                <span aria-hidden="true">↔</span> 左右滑动查看更多信息，点击行查看详情
              </div>
            )}
            {loading && data.length === 0 ? (
              <TableSkeleton columns={isMobile ? 5 : 10} rows={10} compact />
            ) : (
              <Table<RequestRecord>
                columns={visibleColumns}
                dataSource={data}
                rowKey="id"
                locale={{ emptyText: '暂无数据' }}
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
            )}
          </Card>
        </section>
      </div>

      <AppModal
        title="请求记录保留"
        open={retentionOpen}
        onOk={saveRetentionSettings}
        onCancel={() => setRetentionOpen(false)}
        okText={retentionEnabled ? '预览并保存' : '保存设置'}
        cancelText="取消"
        confirmLoading={retentionSaving}
        width={480}
        destroyOnClose={false}
      >
        <Spin spinning={retentionLoading}>
          <Form
            form={retentionForm}
            layout="vertical"
            requiredMark={false}
            initialValues={{ enabled: false, retention_days: 30 }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
              <Form.Item
                label="自动清理"
                name="enabled"
                valuePropName="checked"
                tooltip="默认关闭；启用后由每日任务分批处理"
                style={{ flex: '1 1 180px', minWidth: 0, marginBottom: 16 }}
              >
                <Switch checkedChildren="已启用" unCheckedChildren="已关闭" />
              </Form.Item>
              <Form.Item
                label="保留天数"
                name="retention_days"
                rules={[
                  { required: true, message: '请输入保留天数' },
                  { type: 'number', min: 1, max: 3650, message: '范围 1–3650 天' },
                ]}
                style={{ flex: '0 1 170px', width: 170, maxWidth: '100%', marginBottom: 16 }}
              >
                <InputNumber min={1} max={3650} addonAfter="天" style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </Form>

          <Alert
            type="warning"
            showIcon
            banner
            style={{ marginBottom: 12 }}
            message="正文完整保存，可能包含敏感数据；启用前会预览删除范围，保存后次日分批执行。"
          />

          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            <div>执行时间：每日 00:15（Asia/Shanghai）</div>
            {retentionLastRun && <div>上次执行：{retentionLastRun}</div>}
            {retentionLastError && <div style={{ color: 'var(--color-danger)' }}>上次错误：{retentionLastError}</div>}
          </div>
        </Spin>
      </AppModal>

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
