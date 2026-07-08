import React, { useEffect, useState, useRef, useCallback } from 'react'
import { Space, Button, Segmented, Switch, Tooltip, Tag, Select, DatePicker, Popover, InputNumber, Empty, message } from 'antd'
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ClearOutlined,
  VerticalAlignBottomOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { createLogsStream, fetchLogsDates, fetchLogsHistory, fetchLogsConfig, updateLogsConfig } from '../api/stats'
import { useTheme } from '../context/ThemeContext'
import Header from '../components/Header'

type LogFile = 'business' | 'system'

// ── 耗时格式化（与后端规则一致）─────────────────────────
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toLocaleString()}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

// 速度分段规则（使用 CSS 变量）
export function speedColor(ms: number, _isDark: boolean): string {
  if (ms < 2_000) return 'var(--speed-fast)'
  if (ms < 10_000) return 'var(--speed-normal)'
  if (ms < 30_000) return 'var(--speed-default)'
  if (ms < 60_000) return 'var(--speed-slow)'
  return 'var(--speed-very-slow)'
}

export function speedIcon(ms: number): string {
  if (ms < 2_000) return ' ⚡'
  if (ms < 10_000) return ' 🚀'
  if (ms < 30_000) return ''
  if (ms < 60_000) return ' ⏳'
  return ' 🐢'
}

// ── 日志行解析 ─────────────────────────────────────────
interface LogLine {
  id: number
  raw: string
  level: 'success' | 'error' | 'warning' | 'info' | 'muted'
  timeShort: string
  fullTime: string
  levelTag: string
  body: string
  extra: string[]
}

let lineIdCounter = 0

const isMobileDevice = () => window.innerWidth < 768

function shortenTime(full: string): string {
  const m = full.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/)
  if (m) {
    if (isMobileDevice()) {
      // 移动端：包含完整日期和时间（含年份）
      return `${m[1]} ${m[2]}`
    }
    // PC端：去掉年份，保留月-日 HH:mm:ss
    const datePart = m[1].slice(5) // 去掉年份，MM-DD
    return `${datePart} ${m[2]}`
  }
  return full
}

function parseLogLine(raw: string): LogLine {
  lineIdCounter++
  const stdMatch = raw.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+) - (\w+) - (.*)$/)

  let timeShort = ''
  let fullTime = ''
  let levelTag = ''
  let body = raw

  if (stdMatch) {
    fullTime = stdMatch[1]
    timeShort = shortenTime(fullTime)
    levelTag = stdMatch[2].toUpperCase()
    body = stdMatch[3]
  }

  let level: LogLine['level'] = 'info'
  // 分隔线识别：body 全部为 '=' 字符且长度 >= 3
  const trimmedBody = body.trim()
  if (trimmedBody.length >= 3 && /^=+$/.test(trimmedBody)) {
    level = 'muted'
  } else if (levelTag === 'ERROR' || body.includes('Exception') || body.includes('Traceback') || body.includes('Error:')) {
    level = 'error'
  } else if (
    // HTTP 错误码识别：[❌ 5xx] 模式 → error
    body.includes('[❌') && /5\d\d/.test(body)
  ) {
    level = 'error'
  } else if (
    // HTTP 错误码识别：[⚠️ 4xx/5xx] 或 [❌ 4xx] 模式 → warning
    // 使用 includes 替代正则以避免 emoji 多码点匹配问题
    (body.includes('[⚠') && /[45]\d\d/.test(body)) ||
    (body.includes('[❌') && /4\d\d/.test(body)) ||
    levelTag === 'WARNING' || levelTag === 'WARN' ||
    (body.includes('Port') && body.includes('use')) ||
    body.includes('Address already')
  ) {
    level = 'warning'
  } else if (body.includes('[✅') || body.includes('✅') || body.startsWith('HTTP 2')) {
    level = 'success'
  } else if (trimmedBody === '') {
    level = 'muted'
  }

  return { id: lineIdCounter, raw, level, timeShort, fullTime, levelTag, body, extra: [] }
}

// ── 续行判断：是否是 traceback/exception 续行 ──
// 识别规则：
//   1. body 以空格或 Tab 开头（traceback indent）
//   2. body 为单独的 ":" 或很短的文本（Python exception 换行）
//   3. body 看起来是 exception message（上一行是 ExceptionType:）
//   4. body 以常见 exception 关键字结尾（SyntaxError, TypeError 等）
function _isTraceContinuation(body: string, prevBody: string): boolean {
  if (!body) return false
  // 以缩进开头的行（traceback 堆栈行）
  if (/^\s+/.test(body)) return true
  // 单独的 ":" 或极短的行（Python exception 类型和消息拆成两行的情况）
  if (body === ':' || body.trim() === '') return true
  // 上一行以 Exception 类型名结尾（如 TypeError）
  if (/^[A-Z]\w+(Error|Exception|Warning|Interrupt)$/.test(prevBody?.trim() ?? '')) return true
  // 上一行以 ":" 结尾（错误类型行）
  if ((prevBody?.trimEnd().endsWith(':')) && body.length < 200) return true
  return false
}

// ── 日志合并：同一时间戳+级别的多条日志合并为一组，续行自动追加 ──
// 相比 v6：
//   - 增强续行识别：不仅识别无时间戳续行，也识别 traceback 特征行
//   - 相同时间戳的连续同级别日志合并（应对后端每行都加时间戳的情况）
function mergeLogLines(lines: LogLine[]): LogLine[] {
  const result: LogLine[] = []
  for (const line of lines) {
    if (line.level === 'muted') {
      result.push(line)
      continue
    }
    const last = result[result.length - 1]

    // 无时间戳的续行（标准 Python logging exc_info 格式）：追加到上一条
    if (!line.fullTime && last) {
      last.extra.push(line.body || line.raw)
      continue
    }

    // 同一毫秒时间戳 + 同级别的日志合并（后端每行都加时间戳的特殊格式）
    if (last && last.fullTime && last.fullTime === line.fullTime && last.levelTag === line.levelTag) {
      last.extra.push(line.body)
      continue
    }

    // 续行识别：当前行是 traceback 的一部分
    // 条件：前一条是 error/warning 级别，且当前行满足续行特征
    if (
      last &&
      (last.level === 'error' || last.level === 'warning') &&
      (line.level === 'error' || line.level === 'warning') &&
      line.levelTag === last.levelTag &&
      _isTraceContinuation(line.body, last.extra.length > 0 ? last.extra[last.extra.length - 1] : last.body)
    ) {
      last.extra.push(line.body)
      continue
    }

    result.push({ ...line, extra: [] })
  }
  return result
}

// ── 颜色表（使用 CSS 变量，统一全局颜色方案）──
const LEVEL_COLORS: Record<LogLine['level'], string> = {
  success: 'var(--log-success)',
  error:   'var(--log-error)',
  warning: 'var(--log-warning)',
  info:    'var(--log-info)',
  muted:   'var(--log-muted)',
}

const LEVEL_TAG_COLORS: Record<string, string> = {
  INFO:     'var(--log-tag-info)',
  DEBUG:    'var(--log-tag-debug)',
  WARNING:  'var(--log-tag-warning)',
  WARN:     'var(--log-tag-warning)',
  ERROR:    'var(--log-tag-error)',
  CRITICAL: 'var(--log-tag-critical)',
}

const DEFAULT_LINES = 200
const MAX_LIVE_LINES = 2000
const getToday = () => dayjs().format('YYYY-MM-DD')

export default function Logs() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const [logFile, setLogFile]           = useState<LogFile>('business')
  const [selectedDate, setSelectedDate] = useState<string>(() => getToday())
  const [availDates, setAvailDates]     = useState<string[]>(() => [getToday()])
  const [lines, setLines]               = useState<LogLine[]>([])
  const [paused, setPaused]             = useState(false)
  const [autoScroll, setAutoScroll]     = useState(true)
  const [connected, setConnected]       = useState(false)
  const [streamEmpty, setStreamEmpty]   = useState(false)  // SSE 流为空（后端发送 empty 事件）
  const [filterLevel, setFilterLevel]   = useState<string>('all')
  const [linesLimit, setLinesLimit]     = useState<number>(DEFAULT_LINES)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [emptyFile, setEmptyFile]       = useState(false)
  // 日志保留设置
  const [retentionDays, setRetentionDays]         = useState<number>(30)
  const [retentionInput, setRetentionInput]       = useState<number>(30)
  const [retentionOpen, setRetentionOpen]         = useState(false)
  const [retentionSaving, setRetentionSaving]     = useState(false)

  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const logContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef       = useRef<HTMLDivElement>(null)

  const isToday = selectedDate === getToday()

  // ── 加载可用日期列表 ──────────────────────────────────────
  useEffect(() => {
    fetchLogsDates(logFile)
      .then(r => setAvailDates(r.data))
      .catch(() => setAvailDates([getToday()]))
  }, [logFile])

  // ── 加载日志保留天数配置 ──────────────────────────────────
  useEffect(() => {
    fetchLogsConfig()
      .then(r => { setRetentionDays(r.retention_days); setRetentionInput(r.retention_days) })
      .catch(() => {})
  }, [])

  // ── 历史日志（非今天）：HTTP 查询 ─────────────────────────
  useEffect(() => {
    if (isToday) return
    setLines([])
    setConnected(false)
    setHistoryLoading(true)
    const queryLines = linesLimit === 0 ? 9999 : linesLimit
    fetchLogsHistory({ log_file: logFile, date: selectedDate, lines: queryLines })
      .then(r => {
        setEmptyFile(r.empty_file === true)
        setLines(mergeLogLines(r.lines.map(parseLogLine)))
      })
      .catch(() => { setEmptyFile(false); setLines([]) })
      .finally(() => setHistoryLoading(false))
  }, [logFile, selectedDate, linesLimit, isToday])

  // ── 切换到今天时重置 emptyFile ──────────────────────────
  useEffect(() => {
    if (isToday) setEmptyFile(false)
  }, [isToday])

  // ── 今天实时日志：SSE ────────────────────────────────────
  useEffect(() => {
    if (!isToday) return
    setLines([])
    setConnected(false)
    setStreamEmpty(false)

    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return
      const queryLines = linesLimit === 0 ? 9999 : linesLimit
      es = createLogsStream(logFile, queryLines)
      es.onopen = () => { if (!destroyed) setConnected(true) }
      // 监听后端发送的 empty 事件：日志文件为空，直接显示「暂无系统日志」
      es.addEventListener('empty', () => { if (!destroyed) setStreamEmpty(true) })
      es.onmessage = (e) => {
        if (!destroyed) setStreamEmpty(false)  // 收到日志行，清除空状态
        if (pausedRef.current || !e.data || e.data.trim() === '') return
        const parsed = parseLogLine(e.data)
        setLines(prev => {
          let next: LogLine[]
          const last = prev[prev.length - 1]

          if (!parsed.fullTime && prev.length > 0 && last) {
            // 无时间戳的续行：追加到最后一条
            const updated = { ...last, extra: [...last.extra, parsed.body || parsed.raw] }
            next = [...prev.slice(0, -1), updated]
          } else if (
            last &&
            last.fullTime &&
            last.fullTime === parsed.fullTime &&
            last.levelTag === parsed.levelTag
          ) {
            // 同一时间戳+级别：合并为一组
            const updated = { ...last, extra: [...last.extra, parsed.body] }
            next = [...prev.slice(0, -1), updated]
          } else if (
            last &&
            (last.level === 'error' || last.level === 'warning') &&
            (parsed.level === 'error' || parsed.level === 'warning') &&
            parsed.levelTag === last.levelTag &&
            _isTraceContinuation(
              parsed.body,
              last.extra.length > 0 ? last.extra[last.extra.length - 1] : last.body
            )
          ) {
            // traceback 续行识别：以缩进或特殊模式开头的 error/warning 行
            const updated = { ...last, extra: [...last.extra, parsed.body] }
            next = [...prev.slice(0, -1), updated]
          } else {
            next = [...prev, parsed]
          }

          // 截断时保留完整日志组（不在 extra 中间截断）
          if (next.length > MAX_LIVE_LINES) {
            next = next.slice(next.length - MAX_LIVE_LINES)
          }
          return next
        })
      }
      es.onerror = () => {
        if (destroyed) return
        setConnected(false)
        es?.close()
        retryTimer = setTimeout(() => { if (!destroyed) connect() }, 3000)
      }
    }

    connect()
    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
      setConnected(false)
    }
  }, [logFile, selectedDate, linesLimit, isToday])

  // ── 自动滚底 ──────────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && !paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, autoScroll, paused])

  const handleScroll = useCallback(() => {
    const el = logContainerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 50)
  }, [])

  // ── 日志级别筛选 ─────────────────────────────────────────
  const filteredLines = filterLevel === 'all'
    ? lines
    : lines.filter(l => {
        if (filterLevel === 'INFO')  return l.level === 'info' || l.level === 'success' || l.level === 'muted'
        if (filterLevel === 'WARN')  return l.level === 'warning'
        if (filterLevel === 'ERROR') return l.level === 'error'
        return true
      })

  const timeColor = 'var(--text-muted)'

  const disabledDate = (d: Dayjs) => {
    // 未来日期始终禁用
    if (d.isAfter(dayjs(), 'day')) return true
    // 已加载完成（availDates 含有效历史日期）才启用精确过滤
    const hasHistory = availDates.length > 1 || (availDates.length === 1 && availDates[0] !== getToday())
    if (hasHistory) {
      return !availDates.includes(d.format('YYYY-MM-DD'))
    }
    // 尚未加载完成时不限制历史日期
    return false
  }

  const linesLimitLabel = linesLimit === 0 ? '全部' : `${linesLimit}条`

  return (
    <div className="page-content" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Header pageName="实时日志" hideDatePicker />

      {/* 工具栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 10,
        padding: '8px 12px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 4,
      }}>
        {/* 左侧：日志类型 + 日期 + 级别筛选 + 状态 */}
        <Space size={6} wrap>
          <Segmented
            size="small"
            value={logFile}
            onChange={(v) => { setLogFile(v as LogFile); setSelectedDate(getToday()) }}
            options={[
              { label: '业务日志', value: 'business' },
              { label: '系统日志', value: 'system' },
            ]}
          />

          {/* 日期选择器 */}
          <DatePicker
            size="small"
            value={dayjs(selectedDate)}
            disabledDate={disabledDate}
            allowClear={false}
            onChange={(d) => {
              if (d) setSelectedDate(d.format('YYYY-MM-DD'))
            }}
            style={{ width: 120 }}
          />

          {!isToday && (
            <Button
              size="small"
              type="link"
              style={{ padding: '0 4px', fontSize: 12 }}
              onClick={() => setSelectedDate(getToday())}
            >
              回到今天
            </Button>
          )}

          {/* 级别筛选：加宽到 100px，确保 ERROR 完整展示（含下拉箭头） */}
          <Select
            size="small"
            value={filterLevel}
            onChange={setFilterLevel}
            style={{ width: 100 }}
            options={[
              { label: '全部', value: 'all' },
              { label: 'INFO', value: 'INFO' },
              { label: 'WARN', value: 'WARN' },
              { label: 'ERROR', value: 'ERROR' },
            ]}
          />

          {/* 条数上限 */}
          <Select
            size="small"
            value={linesLimit}
            onChange={setLinesLimit}
            style={{ width: 72 }}
            options={[
              { label: '100条', value: 100 },
              { label: '200条', value: 200 },
              { label: '500条', value: 500 },
              { label: '全部', value: 0 },
            ]}
          />

          {/* 连接状态 */}
          {isToday ? (
            <Tag color={connected ? 'success' : 'default'} style={{ borderRadius: 2, fontSize: 11 }}>
              {connected ? '● 已连接' : '○ 断开'}
            </Tag>
          ) : (
            <Tag color="default" style={{ borderRadius: 2, fontSize: 11 }}>历史</Tag>
          )}

          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {filteredLines.length} 条
          </span>
        </Space>

        {/* 右侧：操作按钮 */}
        <Space size={6} wrap>
          {isToday ? (
            <>
              <Tooltip title={paused ? '继续' : '暂停'}>
                <Button
                  size="small"
                  type={paused ? 'primary' : 'default'}
                  icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                  onClick={() => setPaused(p => !p)}
                >
                  {paused ? '继续' : '暂停'}
                </Button>
              </Tooltip>
              <Space size={4}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>自动滚动</span>
                <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
              </Space>
            </>
          ) : (
            <Tooltip title="重新加载">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={historyLoading}
                onClick={() => {
                  setHistoryLoading(true)
                  const queryLines = linesLimit === 0 ? 9999 : linesLimit
                  fetchLogsHistory({ log_file: logFile, date: selectedDate, lines: queryLines })
                    .then(r => { setEmptyFile(r.empty_file === true); setLines(mergeLogLines(r.lines.map(parseLogLine))) })
                    .catch(() => {})
                    .finally(() => setHistoryLoading(false))
                }}
              >
                刷新
              </Button>
            </Tooltip>
          )}
          <Button size="small" icon={<ClearOutlined />} onClick={() => setLines([])}>清空</Button>
          <Tooltip title="滚到底部">
            <Button
              size="small"
              icon={<VerticalAlignBottomOutlined />}
              onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }}
            />
          </Tooltip>
          {/* 日志保留天数设置 */}
          <Popover
            open={retentionOpen}
            onOpenChange={setRetentionOpen}
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>保留天数</span>
                <InputNumber
                  size="small"
                  min={1}
                  max={365}
                  value={retentionInput}
                  onChange={(v) => setRetentionInput(v ?? 30)}
                  addonAfter="天"
                  style={{ width: 110 }}
                />
                <Button
                  size="small"
                  type="primary"
                  loading={retentionSaving}
                  onClick={() => {
                    setRetentionSaving(true)
                    updateLogsConfig(retentionInput)
                      .then(r => {
                        if (r.success) {
                          setRetentionDays(retentionInput)
                          message.success(`日志保留已设为 ${retentionInput} 天`)
                          setRetentionOpen(false)
                        } else {
                          message.error(r.message || '保存失败')
                        }
                      })
                      .catch(() => message.error('请求失败'))
                      .finally(() => setRetentionSaving(false))
                  }}
                >
                  保存
                </Button>
              </div>
            }
            title={<span style={{ fontSize: 12 }}>日志保留设置（当前 {retentionDays} 天）</span>}
          >
            <Tooltip title="日志保留设置">
              <Button size="small" icon={<SettingOutlined />} />
            </Tooltip>
          </Popover>
        </Space>
      </div>

      {/* 日志终端区 */}
      <div
        ref={logContainerRef}
        onScroll={handleScroll}
        className="log-terminal"
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'auto',
          borderRadius: 4,
          padding: '10px 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.65,
          minHeight: 300,
          maxHeight: 'calc(100vh - 260px)',
        }}
      >
        {filteredLines.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', paddingTop: 48, fontSize: 13 }}>
            {historyLoading
              ? '加载中...'
              : isToday
                ? !connected
                  ? <span style={{ color: 'var(--text-muted)' }}>正在连接日志流...</span>
                  : streamEmpty
                    ? <Empty description="暂无系统日志，系统运行正常" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: 0 }} />
                    : logFile === 'system'
                      ? <span style={{ color: 'var(--text-muted)' }}>系统日志较少，等待新日志...</span>
                      : '暂无日志，等待新日志...'
                : emptyFile
                  ? <Empty description="该日期的日志文件存在但暂无内容" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: 0 }} />
                  : logFile === 'system'
                    ? <Empty description="该日期暂无系统日志记录" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: 0 }} />
                    : '暂无日志记录'
            }
          </div>
        ) : (
          filteredLines.map(line => (
            <LogRow
              key={line.id}
              line={line}
              timeColor={timeColor}
              isDark={isDark}
              isSystemFile={logFile === 'system'}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

interface LogRowProps {
  line: LogLine
  timeColor: string
  isDark: boolean
  isSystemFile?: boolean
}

function LogRow({ line, timeColor, isDark, isSystemFile }: LogRowProps) {
  const COLORS       = LEVEL_COLORS
  const TAG_COLORS   = LEVEL_TAG_COLORS

  if (line.level === 'muted') {
    // 分隔线：全部为 '=' 字符且长度 >= 3 → 渲染为细灰线
    const trimmedBodyMuted = line.body.trim()
    if (trimmedBodyMuted.length >= 3 && /^=+$/.test(trimmedBodyMuted)) {
      return (
        <div style={{
          height: 1,
          background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)',
          margin: '5px 0',
          borderRadius: 1,
        }} />
      )
    }
    return (
      <div style={{
        color: 'var(--text-disabled)',
        padding: '1px 0',
        userSelect: 'none',
        fontSize: 11,
      }}>
        {line.body}
      </div>
    )
  }

  const bodyColor     = (isSystemFile && line.level === 'error') ? COLORS['info'] : COLORS[line.level]
  const levelTagColor = TAG_COLORS[line.levelTag] ?? 'var(--text-muted)'
  const hasExtra      = line.extra && line.extra.length > 0
  const extraColor    = 'var(--text-secondary)'

  // 格式化完整时间戳，去掉毫秒逗号改为点（2026-06-11 19:35:20,123 → 2026-06-11 19:35:20.123）
  // 若无毫秒部分，直接使用 YYYY-MM-DD HH:mm:ss 格式
  const formatFullTime = (full: string): string => {
    if (!full) return ''
    // 替换毫秒分隔符（逗号改为点）并截断毫秒（只保留秒）
    return full.replace(/,\d+$/, '').replace(',', '.')
  }

  // 级别标签背景色转换（为对应的级别选择微透明背景）
  const getLevelBg = (lv: LogLine['level']): string => {
    if (isDark) {
      const MAP: Record<LogLine['level'], string> = {
        error:   'rgba(248, 113, 113, 0.15)',
        warning: 'rgba(251, 191, 36, 0.15)',
        success: 'rgba(16, 185, 129, 0.12)',
        info:    'rgba(56, 189, 248, 0.10)',
        muted:   'transparent',
      }
      return MAP[lv] ?? 'transparent'
    } else {
      const MAP: Record<LogLine['level'], string> = {
        error:   'rgba(220, 38, 38, 0.10)',
        warning: 'rgba(180, 83, 9, 0.10)',
        success: 'rgba(5, 122, 85, 0.08)',
        info:    'rgba(3, 105, 161, 0.08)',
        muted:   'transparent',
      }
      return MAP[lv] ?? 'transparent'
    }
  }

  const levelBg = getLevelBg(line.level)

  const tagEl = (
    <span style={{
      fontSize: 11,
      fontWeight: 700,
      color: levelTagColor,
      whiteSpace: 'nowrap' as const,
      letterSpacing: '0.06em',
      background: levelBg,
      borderRadius: 3,
      padding: '1px 5px',
      display: 'inline-block',
      minWidth: 32,
      textAlign: 'center' as const,
    }}>
      {line.levelTag ? line.levelTag.slice(0, 4) : '–'}
    </span>
  )
  const bodyEl = (
    <span style={{ color: bodyColor, wordBreak: 'break-word' as const, minWidth: 0 }}>
      {highlightBody(line.body, isSystemFile ? 'info' : line.level, isDark)}
    </span>
  )

  return (
    <>
      {/* 桌面端：两行格式 */}
      {/* 第一行：时间戳行（背景色 + 左边框，辅助信息） */}
      {line.fullTime && (
        <div className="log-row-desktop" style={{
          background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)',
          borderLeft: `3px solid ${levelTagColor}`,
          padding: '2px 8px',
          fontSize: 12,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          userSelect: 'none',
          marginBottom: 2,
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
        }}>
          {formatFullTime(line.fullTime)}
        </div>
      )}
      {/* 第二行：级别标签 + body 内容 */}
      <div className="log-row-desktop" style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '2px 0',
        paddingBottom: hasExtra ? 0 : '4px',
        borderBottom: hasExtra ? 'none' : (isDark ? '1px solid rgba(255,255,255,0.015)' : '1px solid rgba(0,0,0,0.04)'),
        minWidth: 0,
      }}>
        {tagEl}
        {bodyEl}
      </div>

      {/* 桌面端：追加行（同时间戳 / 堆栈行） */}
      {hasExtra && (
        <div className="log-row-desktop" style={{
          paddingLeft: 42,
          paddingBottom: '4px',
          borderBottom: isDark ? '1px solid rgba(255,255,255,0.015)' : '1px solid rgba(0,0,0,0.04)',
        }}>
          {line.extra.map((ext, i) => (
            <div key={i} style={{ color: extraColor, fontSize: 11, lineHeight: 1.5, wordBreak: 'break-word' }}>
              {highlightBody(ext, isSystemFile ? 'info' : line.level, isDark)}
            </div>
          ))}
        </div>
      )}

      {/* 移动端：两行（时间+级别 / 内容） */}
      <div className="log-row-mobile" style={{
        padding: '4px 0',
        borderBottom: isDark ? '1px solid rgba(255,255,255,0.015)' : '1px solid rgba(0,0,0,0.04)',
        minWidth: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{
            fontSize: 13,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap',
            background: 'rgba(14,165,233,0.06)',
            borderRadius: 3,
            padding: '0 4px',
          }}>
            {line.timeShort}
          </span>
          {tagEl}
        </div>
        <div style={{ color: bodyColor, wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5 }}>
          {highlightBody(line.body, isSystemFile ? 'info' : line.level, isDark)}
        </div>
        {hasExtra && line.extra.map((ext, i) => (
          <div key={i} style={{ color: extraColor, fontSize: 11, lineHeight: 1.5, wordBreak: 'break-word', marginTop: 1 }}>
            {highlightBody(ext, isSystemFile ? 'info' : line.level, isDark)}
          </div>
        ))}
      </div>
    </>
  )
}

// ── 日志内容高亮（v6 增强版）───────────────────────────
// 新增：ERROR/Exception/Traceback（红色加粗）、WARNING/WARN（橙色加粗）、
//       SUCCESS（绿色加粗）、HTTP 状态码（按状态着色）、URL（蓝色下划线）
function highlightBody(body: string, level: LogLine['level'], isDark: boolean): React.ReactNode {
  // 合并正则：原有模式 + 新增关键字/URL
  const SPLIT_REGEX = new RegExp(
    [
      // 耗时：分钟/秒/毫秒
      String.raw`\d+(?:\.\d+)?min`,
      String.raw`\d+(?:\.\d+)?s(?=[\s|⚡🚀⏳🐢\b)]|$)`,
      String.raw`\d+(?:,\d{3})*ms`,
      // Token 数
      String.raw`\d+(?:\.\d+)?[kK]`,
      // 百分比
      String.raw`\d+%`,
      // 状态块
      String.raw`\[✅[^\]]*\]`,
      String.raw`\[💥[^\]]*\]`,
      // HTTP 状态码
      String.raw`\bHTTP\s\d{3}\b`,
      // 关键字
      String.raw`\bERROR\b`,
      String.raw`\bException\b`,
      String.raw`\bTraceback\b`,
      String.raw`\bWARNING\b`,
      String.raw`\bWARN\b`,
      String.raw`\bSUCCESS\b`,
      // URL
      String.raw`https?://[^\s)\]>"']+`,
    ].join('|'),
    'g'
  )

  const parts = body.split(SPLIT_REGEX)
  const matches: string[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(SPLIT_REGEX.source, 'g')
  while ((m = re.exec(body)) !== null) {
    matches.push(m[0])
  }

  if (parts.length <= 1) return body

  const result: React.ReactNode[] = []
  parts.forEach((part, i) => {
    if (part) result.push(part)
    if (i < matches.length) {
      const match = matches[i]
      result.push(renderHighlight(match, i, isDark))
    }
  })
  return <>{result}</>
}

function renderHighlight(part: string, key: number, _isDark: boolean): React.ReactNode {
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' }

  // 毫秒耗时
  if (/^\d+(?:,\d{3})*ms$/.test(part)) {
    const ms = parseInt(part.replace(/,/g, ''), 10)
    return <span key={key} style={{ ...mono, color: speedColor(ms, false), fontWeight: 600 }}>{part}</span>
  }
  // 秒耗时
  if (/^\d+(?:\.\d+)?s$/.test(part)) {
    const ms = parseFloat(part) * 1000
    return <span key={key} style={{ ...mono, color: speedColor(ms, false), fontWeight: 600 }}>{part}</span>
  }
  // 分钟耗时
  if (/^\d+(?:\.\d+)?min$/.test(part)) {
    const ms = parseFloat(part) * 60_000
    return <span key={key} style={{ ...mono, color: speedColor(ms, false), fontWeight: 600 }}>{part}</span>
  }
  // Token 数量
  if (/^\d+(?:\.\d+)?[kK]$/.test(part)) {
    return <span key={key} style={{ ...mono, color: 'var(--log-tag-info)' }}>{part}</span>
  }
  // 百分比
  if (/^\d+%$/.test(part)) {
    return <span key={key} style={{ ...mono, color: 'var(--log-tag-debug)' }}>{part}</span>
  }
  // 成功状态块
  if (part.startsWith('[✅')) {
    return <span key={key} style={{ color: 'var(--color-success)', fontWeight: 600 }}>{part}</span>
  }
  if (part.startsWith('[💥')) {
    return <span key={key} style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{part}</span>
  }
  // HTTP 状态码
  if (/^\bHTTP\s(\d{3})\b$/.test(part)) {
    const code = parseInt(part.replace('HTTP ', ''), 10)
    const color = code >= 500 ? 'var(--color-danger)' : code >= 400 ? 'var(--color-warning)' : 'var(--color-success)'
    return <span key={key} style={{ ...mono, color, fontWeight: 600 }}>{part}</span>
  }
  // ERROR / Exception / Traceback
  if (/^(ERROR|Exception|Traceback)$/.test(part)) {
    return <span key={key} style={{ color: 'var(--log-tag-error)', fontWeight: 700 }}>{part}</span>
  }
  // WARNING / WARN
  if (/^(WARNING|WARN)$/.test(part)) {
    return <span key={key} style={{ color: 'var(--log-tag-warning)', fontWeight: 700 }}>{part}</span>
  }
  // SUCCESS
  if (part === 'SUCCESS') {
    return <span key={key} style={{ color: 'var(--color-success)', fontWeight: 700 }}>{part}</span>
  }
  // URL
  if (/^https?:\/\//.test(part)) {
    return (
      <span key={key} style={{
        color: 'var(--log-tag-info)',
        textDecoration: 'underline',
        textDecorationColor: 'rgba(56,189,248,0.4)',
        cursor: 'default',
      }}>
        {part}
      </span>
    )
  }
  return <span key={key}>{part}</span>
}
