import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import {
  Spin, Table, Tag, Tooltip, Select, DatePicker,
  Alert, Radio, Card, Progress,
} from 'antd'
import { SpinRing, LoadingBlock, TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import ReactECharts from 'echarts-for-react'
import { ReloadOutlined, CopyOutlined, CheckOutlined, SyncOutlined } from '@ant-design/icons'
import { useTheme } from '../context/ThemeContext'
import { useFilter } from '../context/FilterContext'
import PageHeader from '../components/PageHeader'
import RefreshModule from '../components/Header/RefreshModule'
import {
  chartBaseOption, tooltipStyle, axisStyle, axisStyleDark,
  CHART_COLORS, legendStyle, PAGE_ICON_STYLE,
} from '../components/Charts/chartTheme'
import { fmtCredit, fmtAxis } from '../utils/format'

const { RangePicker } = DatePicker

// 移动端日期范围选择：用两个独立 DatePicker，弹窗固定宽度并从视口左侧 8px 处展开
// 关键：popupStyle 用 fixed 定位覆盖 Ant Design 的 JS absolute 定位，确保不超出视口
const MOBILE_PICKER_POPUP_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: 8,
  right: 8,
  width: 'auto',
  maxWidth: 'calc(100vw - 16px)',
  zIndex: 9999,
}

function MobileDateRange({ value, onChange }: {
  value: [import('dayjs').Dayjs, import('dayjs').Dayjs] | null
  onChange: (v: [import('dayjs').Dayjs, import('dayjs').Dayjs] | null) => void
}) {
  const startVal = value ? value[0] : null
  const endVal = value ? value[1] : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
      <DatePicker size="small" value={startVal} placeholder="开始"
        allowClear style={{ flex: 1, minWidth: 0 }}
        popupStyle={MOBILE_PICKER_POPUP_STYLE}
        getPopupContainer={() => document.body}
        onChange={d => {
          if (!d) { onChange(null); return }
          const end = endVal && !endVal.isBefore(d) ? endVal : d
          onChange([d, end])
        }}
      />
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, lineHeight: 1 }}>→</span>
      <DatePicker size="small" value={endVal} placeholder="结束"
        allowClear style={{ flex: 1, minWidth: 0 }}
        popupStyle={MOBILE_PICKER_POPUP_STYLE}
        getPopupContainer={() => document.body}
        onChange={d => {
          if (!d) { onChange(null); return }
          const start = startVal && !startVal.isAfter(d) ? startVal : d
          onChange([start, d])
        }}
      />
    </div>
  )
}
function strRangeToDay(r: [string, string] | null): [import('dayjs').Dayjs, import('dayjs').Dayjs] | null {
  if (!r) return null
  return [dayjs(r[0]), dayjs(r[1])]
}

// ── 数据类型 ─────────────────────────────────────────────────────────────────

interface UserInfo {
  realName?: string       // 真实姓名（从 tenantName 提取）
  userName: string        // misId（兼容字段）
  misId: string
  tenantId: string
  appId: string
  org?: string            // 组织路径（完整 org）
  department: string
  avatar: string
  _raw?: Record<string, unknown>
}

interface ProductInfo {
  productName: string
  initialQuota: number
  usedQuota: number
  remainingQuota: number
  validUntil: string
}

interface RecordItem {
  productName: string
  agentId: string
  agentName: string
  usedQuota: number
  date: string
}

// ── 来源名称归一化 ────────────────────────────────────────────────────────────

const SOURCE_RENAME: Record<string, string> = { '其他': 'API 调用', '其它': 'API 调用' }
const norm = (s: string) => SOURCE_RENAME[s] || s || '未知'
const isTestProd = (n: string) => /66666/.test(n) || /^\d{5,}$/.test(n)

// ── Credit 颜色分级（5000 / 5W / 100W / 500W）────────────────────────────────

function creditColor(v: number): string {
  if (v >= 5_000_000) return '#f43f5e'
  if (v >= 1_000_000) return '#f97316'
  if (v >= 50_000)    return '#0ea5e9'
  if (v >= 5_000)     return '#f59e0b'
  return '#10b981'
}

function usageColor(r: number) {
  if (r >= 0.9) return '#f43f5e'
  if (r >= 0.7) return '#f59e0b'
  return '#10b981'
}

function fmtFull(v: number) {
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

// ── API 层 ────────────────────────────────────────────────────────────────────

async function apiFetch(url: string, opt?: RequestInit) {
  const r = await fetch(url, { credentials: 'include', ...opt })
  return r.json()
}

async function fetchSummary() {
  try {
    const j = await apiFetch('/api/credit/summary')
    if (j.code === 401) return { result: null, status: 401 }
    const raw = j.data ?? {}
    const tenantId = String(raw.tenantId ?? '')
    let products: ProductInfo[] = Array.isArray(raw.products) ? raw.products : (Array.isArray(raw) ? raw : [])
    products = products.filter(p => !isTestProd(p.productName))
    // 尝试从 summary _raw 构造用户信息（personalInfo 字段在 _raw 里）
    return { result: { products, tenantId, raw }, status: 200 }
  } catch { return { result: null, status: 0 } }
}

async function fetchMe(force = false): Promise<UserInfo | null> {
  try {
    const url = force ? '/api/credit/me?force=1' : '/api/credit/me'
    const j = await apiFetch(url)
    if (j.code === 0 && j.data) return j.data as UserInfo
    return null
  } catch { return null }
}

async function fetchLocalUserInfo(): Promise<UserInfo | null> {
  // 访客模式：直接读本地缓存，不请求 Friday
  try {
    const j = await apiFetch('/api/credit/me/local')
    if (j.code === 0 && j.data) return j.data as UserInfo
    return null
  } catch { return null }
}

/** 退出登录：删除 Heimdall 服务器存储的 Friday Cookie（不影响浏览器/Friday本身的 Cookie） */
async function doLogout(): Promise<boolean> {
  try {
    const j = await apiFetch('/api/credit/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' }),
    })
    return j.code === 0
  } catch { return false }
}

async function fetchRecords(tenantId: string) {
  try {
    const url = `/api/credit/records?pageNum=1&pageSize=500${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`
    const j = await apiFetch(url)
    if (j.code === 401) return { list: [] as RecordItem[] }
    const raw = j.data ?? {}
    let list: RecordItem[] = Array.isArray(raw.list) ? raw.list : (Array.isArray(raw) ? raw : [])
    list = list
      .filter(r => !isTestProd(r.productName))
      .map(r => ({ ...r, date: String(r.date ?? '').slice(0, 10), agentName: norm(r.agentName || '') }))
    return {
      list,
      fromCache: !!j.from_cache,
      cacheTip: j.cache_tip as string | undefined,
      todayError: !!j.today_error,
      todayErrorMsg: j.today_error_msg as string | undefined,
    }
  } catch { return { list: [] as RecordItem[] } }
}

async function fetchLocalRecords() {
  // Guest 模式：直接读本地 SQLite 缓存，不请求 Friday，tenantId 传空表示查全部
  try {
    const j = await apiFetch('/api/credit/local?tenantId=')
    const raw = j.data ?? {}
    let list: RecordItem[] = Array.isArray(raw.list) ? raw.list : []
    list = list
      .filter(r => !isTestProd(r.productName))
      .map(r => ({ ...r, date: String(r.date ?? '').slice(0, 10), agentName: norm(r.agentName || '') }))
    return list
  } catch { return [] as RecordItem[] }
}

// ── 自动刷新：统一使用全局 FilterContext（RefreshModule 组件负责 UI）────────────
// AICredit 监听 refreshTick + backgroundTick 触发重载，无需独立 hook

// ── 复制按钮 ──────────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <Tooltip title={ok ? '已复制' : '复制'}>
      <button onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500) }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-muted)', lineHeight: 1 }}>
        {ok ? <CheckOutlined style={{ fontSize: 11, color: '#10b981' }} /> : <CopyOutlined style={{ fontSize: 11 }} />}
      </button>
    </Tooltip>
  )
}

// ── 个人信息条 ────────────────────────────────────────────────────────────────

const isMobile = () => window.innerWidth < 768

/** 从 tenantName（如"黄康的个人租户"）提取真实姓名 */
function extractRealName(info: UserInfo): string {
  // 1. 后端已提取好的 realName
  if (info.realName && info.realName !== info.misId) return info.realName
  // 2. 从 _raw.tenantName 提取：去掉"的个人租户"后缀
  const tenantName = String((info._raw as Record<string, unknown>)?.tenantName ?? '')
  if (tenantName) {
    for (const sfx of ['的个人租户', 's Personal Tenant', "'s Personal"]) {
      if (tenantName.includes(sfx)) return tenantName.slice(0, tenantName.indexOf(sfx)).trim()
    }
    if (tenantName.length <= 8 && !tenantName.includes('租户')) return tenantName
  }
  return ''
}

// 分隔竖线
function Divider() {
  return (
    <div style={{
      width: 1, alignSelf: 'stretch', margin: '10px 0',
      background: 'var(--border-subtle)', flexShrink: 0,
    }} />
  )
}

// 信息格：标签 + 值 + 复制按钮
function InfoCell({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
          fontSize: 12, color: 'var(--text-secondary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{value || '—'}</span>
        {value && <CopyBtn text={value} />}
      </div>
    </div>
  )
}

function UserInfoBar({ info, onRefresh, refreshing, onLogout }: {
  info: UserInfo
  onRefresh?: () => void
  refreshing?: boolean
  onLogout?: () => void
}) {
  const raw = (info._raw ?? {}) as Record<string, unknown>
  const mobile = isMobile()

  const realName = extractRealName(info)
  const misId = info.misId || String(raw.misId ?? '')
  const tenantId = info.tenantId || String(raw.tenantId ?? '')
  const appId = info.appId || String(raw.appId ?? '')
  const org = info.org || info.department || String(raw.org ?? raw.orgFullPath ?? '')

  // 头像：先尝试加载 GIF，失败时 imgError=true 显示渐变背景
  const [imgError, setImgError] = React.useState(false)
  const avatarSrc = info.avatar || '/avatar.gif'

  if (mobile) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
        borderRadius: 10, padding: '10px 14px',
      }}>
        {/* 头像 */}
        <div style={{
          width: 36, height: 36, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
          background: 'linear-gradient(135deg,#0ea5e9,#8b5cf6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {imgError
            ? <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{(realName || misId).slice(0, 1)}</span>
            : <img src={avatarSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                alt="" onError={() => setImgError(true)} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.3 }}>
            {realName || misId || '—'}
          </div>
          {misId && realName && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{misId}</span><CopyBtn text={misId} />
            </div>
          )}
        </div>
        {tenantId && (
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>租户 ID</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tenantId}</span>
              <CopyBtn text={tenantId} />
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── PC 端：参考 Friday 的横向一行布局 ──────────────────────────────────────
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 10, padding: '0 4px', height: 64, overflow: 'hidden',
    }}>
      {/* 头像 + 姓名 + misId */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', flexShrink: 0 }}>
        {/* GIF 头像 */}
        <div style={{
          width: 40, height: 40, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
          background: 'linear-gradient(135deg,#0ea5e9,#8b5cf6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {imgError
            ? <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{(realName || misId).slice(0, 1)}</span>
            : <img src={avatarSrc} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                alt="avatar" onError={() => setImgError(true)} />}
        </div>
        {/* 姓名 + mis */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.4, whiteSpace: 'nowrap' }}>
            {realName || misId || '—'}
          </div>
          {misId && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{misId}</span>
              <CopyBtn text={misId} />
            </div>
          )}
        </div>
      </div>

      {tenantId && <><Divider /><InfoCell label="租户 ID" value={tenantId} /></>}
      {appId     && <><Divider /><InfoCell label="APP ID"  value={appId}     /></>}
      {org       && <><Divider />
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: '1 1 0', minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, whiteSpace: 'nowrap' }}>部门</div>
          <Tooltip title={org} placement="bottom">
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              cursor: 'default',
            }}>{org}</div>
          </Tooltip>
        </div>
      </>}

      {/* 操作按钮区 */}
      {(onRefresh || onLogout) && (
        <>
          <Divider />
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', flexShrink: 0 }}>
            {onRefresh && (
              <Tooltip title="刷新个人信息">
                <button onClick={onRefresh} disabled={refreshing} style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  background: 'none', border: 'none', cursor: refreshing ? 'default' : 'pointer',
                  padding: '5px 8px', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12,
                  opacity: refreshing ? 0.5 : 1,
                }}>
                  <ReloadOutlined style={{ fontSize: 12 }} spin={refreshing} />
                  <span>刷新</span>
                </button>
              </Tooltip>
            )}
            {onLogout && (
              <Tooltip title="退出登录（仅清除 Heimdall 存储的 Cookie，不影响 Friday）">
                <button onClick={onLogout} style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '5px 8px', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12,
                }}>
                  <span style={{ fontSize: 13 }}>🚪</span>
                  <span>退出</span>
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── 产品额度卡片 ─────────────────────────────────────────────────────────────
// 简洁设计：标题行（名称+有效期）、进度条、三数据一行

function ProductCard({ product, isDark }: { product: ProductInfo; isDark: boolean }) {
  const rate = product.initialQuota > 0 ? product.usedQuota / product.initialQuota : 0
  const color = usageColor(rate)
  const pct = Math.min(100, +(rate * 100).toFixed(1))
  const today = new Date().toISOString().slice(0, 10)
  const isExpired = product.validUntil && product.validUntil < today
  const mobile = isMobile()

  return (
    <div className="hd-card" style={{ flex: '1 1 260px', minWidth: mobile ? '100%' : 220, padding: '14px 16px' }}>
      {/* 卡片内标题 */}
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: '0.04em' }}>产品额度</div>
      {/* 产品名称行 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
            {product.productName}
          </span>
          {isExpired && <Tag color="error" style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '18px' }}>已到期</Tag>}
        </div>
        {product.validUntil && (
          <span style={{ fontSize: 11, color: isExpired ? '#f43f5e' : 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {product.validUntil}
          </span>
        )}
      </div>

      {/* 进度条 */}
      <Progress
        percent={pct}
        strokeColor={color}
        trailColor={isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}
        status={rate >= 0.9 ? 'exception' : 'normal'}
        format={() => null}
        style={{ marginBottom: 10 }}
        size="small"
      />

      {/* 三数据一行：percent(大) + 数值(小) */}
      <div style={{ display: 'flex', gap: 0 }}>
        {[
          { label: '已使用', val: product.usedQuota, color: '#f59e0b', pctStr: `${pct}%` },
          { label: '剩余', val: product.remainingQuota, color, pctStr: `${+(100 - pct).toFixed(1)}%` },
          { label: '总额', val: product.initialQuota, color: 'var(--text-primary)', pctStr: fmtCredit(product.initialQuota) },
        ].map((item, i) => (
          <div key={item.label} style={{ flex: 1, borderLeft: i > 0 ? '1px solid var(--border-subtle)' : 'none', paddingLeft: i > 0 ? 12 : 0 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{item.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14, color: item.color, lineHeight: 1.2 }}>
              {item.pctStr}
            </div>
            <Tooltip title={fmtFull(item.val)} placement="bottom">
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1, cursor: 'default' }}>
                {fmtCredit(item.val)}
              </span>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 折线图 ────────────────────────────────────────────────────────────────────

function TrendChart({ records, isDark, dateRange, onRangeChange }: {
  records: RecordItem[]; isDark: boolean
  dateRange: [Dayjs, Dayjs] | null
  onRangeChange: (v: [Dayjs, Dayjs] | null) => void
}) {
  const dailyMap: Record<string, number> = {}
  const today = dayjs().format('YYYY-MM-DD')
  for (const r of records) {
    const d = r.date
    if (!d || d.length < 10) continue
    const day = d.slice(0, 10)
    if (dateRange) {
      const dj = dayjs(day)
      if (dj.isBefore(dateRange[0], 'day') || dj.isAfter(dateRange[1], 'day')) continue
    }
    dailyMap[day] = (dailyMap[day] ?? 0) + r.usedQuota
  }
  // 确保今天在 dateRange 范围内时也出现（即使值为 0）
  if (!dateRange || (!dayjs(today).isBefore(dateRange[0], 'day') && !dayjs(today).isAfter(dateRange[1], 'day'))) {
    if (!(today in dailyMap) && records.some(r => r.date.slice(0, 10) === today)) {
      dailyMap[today] = 0
    }
  }
  const sorted = Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b))
  const dates = sorted.map(([d]) => d)
  const vals = sorted.map(([, v]) => v)
  const ax = isDark ? axisStyleDark : axisStyle

  const option = !dates.length
    ? { backgroundColor: 'transparent', graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: '暂无数据', fontSize: 13, fill: '#a8a29e' } }] }
    : {
      ...chartBaseOption,
      // bottom: 56 为图例预留空间，避免重叠
      grid: { left: 52, right: 20, top: 10, bottom: 56 },
      tooltip: {
        trigger: 'axis', ...tooltipStyle,
        formatter: (params: { dataIndex: number }[]) => {
          const i = params[0].dataIndex
          const isToday = dates[i] === today
          return `<div style="font-weight:600;margin-bottom:4px">${dates[i]}${isToday ? ' <span style="color:#f59e0b;font-size:10px">今日</span>' : ''}</div>` +
            `<div>消耗：<b>${fmtCredit(vals[i])}</b></div>`
        },
      },
      // 图例：底部，scroll 类型，与 Stats.tsx 一致
      legend: {
        ...legendStyle,
        textStyle: { ...(legendStyle as Record<string, unknown>).textStyle as object, color: isDark ? '#d6d3d1' : '#57534e' },
        data: ['消耗'],
      },
      xAxis: {
        type: 'category', data: dates,
        axisLine: ax.line, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: {
          ...ax.label,
          interval: isMobile() ? Math.max(0, Math.ceil(dates.length / 4) - 1) : Math.max(0, Math.floor(dates.length / 7) - 1),
          rotate: 0,
          lineHeight: isMobile() ? 14 : undefined,
          formatter: isMobile()
            ? (val: string) => { const p = val.split('-'); return p.length === 3 ? `${p[0]}\n${p[1]}-${p[2]}` : val }
            : undefined,
        },
      },
      yAxis: {
        type: 'value', splitLine: ax.splitLine, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { ...ax.label, formatter: (v: number) => fmtAxis(v) },
      },
      series: [{
        name: '消耗',
        type: 'line', data: vals, smooth: true, symbol: 'circle', symbolSize: 5,
        lineStyle: { color: CHART_COLORS.primary, width: 2 },
        itemStyle: { color: (params: { dataIndex: number }) => dates[params.dataIndex] === today ? '#f59e0b' : CHART_COLORS.primary },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: isDark ? 'rgba(14,165,233,0.25)' : 'rgba(14,165,233,0.15)' },
              { offset: 1, color: 'rgba(14,165,233,0)' },
            ],
          },
        },
      }],
    }

  return (
    <Card
      title="近期消耗趋势"
      className="chart-card hd-card"
      bordered={false}
      size="small"
      extra={
        isMobile()
          ? <MobileDateRange value={dateRange} onChange={onRangeChange} />
          : <RangePicker size="small" value={dateRange} allowClear style={{ width: 210 }}
              onChange={v => onRangeChange(v as [Dayjs, Dayjs] | null)} />
      }
    >
      <ReactECharts option={option} style={{ height: 220 }} notMerge />
    </Card>
  )
}

// ── 饼图 ──────────────────────────────────────────────────────────────────────

function PieChart({ records, isDark, dateRange, onRangeChange }: {
  records: RecordItem[]; isDark: boolean; dateRange: [Dayjs, Dayjs] | null
  onRangeChange: (v: [Dayjs, Dayjs] | null) => void
}) {
  const map: Record<string, number> = {}
  for (const r of records) {
    const d = r.date?.slice(0, 10)
    if (dateRange && d) {
      const dj = dayjs(d)
      if (dj.isBefore(dateRange[0], 'day') || dj.isAfter(dateRange[1], 'day')) continue
    }
    const name = norm(r.agentName || r.agentId || '未知')
    map[name] = (map[name] ?? 0) + r.usedQuota
  }
  const data = Object.entries(map).sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value: +value.toFixed(4) }))
  if (!data.length) return null
  const COLS = [CHART_COLORS.primary, CHART_COLORS.success, CHART_COLORS.warning, CHART_COLORS.accent, CHART_COLORS.danger, CHART_COLORS.cyan, CHART_COLORS.orange]
  const option = {
    ...chartBaseOption, grid: undefined,
    legend: { ...legendStyle, type: 'scroll' as const, bottom: 4, textStyle: { color: isDark ? '#d6d3d1' : '#57534e', fontSize: 11 }, ...PAGE_ICON_STYLE },
    tooltip: {
      ...tooltipStyle,
      formatter: (p: { name: string; value: number; percent: number }) =>
        `<div style="font-weight:600;margin-bottom:4px">${p.name}</div><div>消耗：<b>${fmtCredit(p.value)}</b>（${p.percent}%）</div>`,
    },
    series: [{
      name: '消耗来源', type: 'pie', radius: ['36%', '62%'], center: ['50%', '44%'],
      label: { show: false }, labelLine: { show: false },
      data: data.map((d, i) => ({ ...d, itemStyle: { color: COLS[i % COLS.length] } })),
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.2)' } },
    }],
  }
  return (
    <Card title="消耗来源分布" className="chart-card" bordered={false}
      size="small"
      extra={
        isMobile()
          ? <MobileDateRange value={dateRange} onChange={onRangeChange} />
          : <RangePicker size="small" value={dateRange} allowClear style={{ width: 210 }}
              onChange={v => onRangeChange(v as [Dayjs, Dayjs] | null)} />
      }
    >
      <ReactECharts option={option} style={{ height: 220 }} notMerge />
    </Card>
  )
}

// ── 消耗记录表格 ──────────────────────────────────────────────────────────────

interface DailyRow { date: string; total: number; productTotals: Record<string, number> }

function buildDaily(records: RecordItem[]): DailyRow[] {
  const m: Record<string, DailyRow> = {}
  for (const r of records) {
    if (!m[r.date]) m[r.date] = { date: r.date, total: 0, productTotals: {} }
    m[r.date].total += r.usedQuota
    m[r.date].productTotals[r.productName] = (m[r.date].productTotals[r.productName] ?? 0) + r.usedQuota
  }
  return Object.values(m).sort((a, b) => b.date.localeCompare(a.date))
}

// 与 Stats.tsx 完全一致的 mono 样式
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 }

function RecordsTable({ records, loading }: { records: RecordItem[]; loading: boolean }) {
  const [mode, setMode] = useState<'detail' | 'daily'>('detail')
  const [dateRange, setDateRange] = useState<[string, string] | null>(null)
  const [filterSource, setFilterSource] = useState('API 调用')
  const [filterProduct, setFilterProduct] = useState('')

  const srcOpts = useMemo(() => {
    const s = new Set<string>()
    records.forEach(r => s.add(norm(r.agentName || r.agentId || '-')))
    return [{ label: '全部来源', value: '' }, ...Array.from(s).sort().map(v => ({ label: v, value: v }))]
  }, [records])

  // 数据加载后，若当前 filterSource 不在选项中则重置为全部
  useEffect(() => {
    if (!loading && records.length > 0 && filterSource) {
      const srcSet = new Set(records.map(r => norm(r.agentName || r.agentId || '-')))
      if (!srcSet.has(filterSource)) setFilterSource('')
    }
  }, [loading, records]) // eslint-disable-line react-hooks/exhaustive-deps

  const prodOpts = useMemo(() => {
    const s = new Set<string>()
    records.forEach(r => s.add(r.productName))
    return [{ label: '全部产品', value: '' }, ...Array.from(s).sort().map(v => ({ label: v, value: v }))]
  }, [records])

  const filtered = useMemo(() => records.filter(r => {
    if (dateRange && (r.date < dateRange[0] || r.date > dateRange[1])) return false
    if (filterSource && norm(r.agentName || r.agentId || '-') !== filterSource) return false
    if (filterProduct && r.productName !== filterProduct) return false
    return true
  }), [records, dateRange, filterSource, filterProduct])

  const dailyRows = useMemo(() => buildDaily(filtered), [filtered])
  const allProds = useMemo(() => {
    const s = new Set<string>()
    filtered.forEach(r => s.add(r.productName))
    return Array.from(s).sort()
  }, [filtered])

  const mobile = isMobile()

  // 移动端列宽：日期90+消耗来源120+Credit消耗100=310px，三列可同时在手机上完整显示
  // PC端列宽：日期110+消耗来源160+Credit消耗130+产品120=520px，合理
  const detailCols: ColumnsType<RecordItem> = [
    {
      title: '日期', dataIndex: 'date', width: mobile ? 90 : 110, align: 'center' as const,
      sorter: (a, b) => a.date.localeCompare(b.date),
      render: (v: string) => <span style={{ ...MONO, fontSize: mobile ? 11 : 12 }}>{v}</span>,
    },
    {
      title: '消耗来源', dataIndex: 'agentName', align: 'center' as const, width: mobile ? 120 : 160,
      ellipsis: { showTitle: false },
      render: (v: string, r: RecordItem) => (
        <Tooltip title={r.agentId ? `agentId: ${r.agentId}` : undefined} placement="topLeft">
          <span style={{ fontSize: mobile ? 11 : 12 }}>{norm(v || r.agentId || '-')}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Credit 消耗', dataIndex: 'usedQuota', width: mobile ? 100 : 130, align: 'center' as const,
      sorter: (a, b) => a.usedQuota - b.usedQuota,
      render: (v: number) => (
        <Tooltip title={fmtFull(v)}>
          <span style={{ ...MONO, fontWeight: 600, color: creditColor(v), cursor: 'default', fontSize: mobile ? 11 : 12 }}>{fmtCredit(v)}</span>
        </Tooltip>
      ),
    },
    ...(!mobile ? [{
      title: '产品', dataIndex: 'productName', width: 120, align: 'center' as const,
      render: (v: string) => (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Tag color="blue" style={{ fontSize: 11, borderRadius: 2, margin: 0 }}>{v}</Tag>
        </div>
      ),
    }] : []),
  ]

  const dailyCols: ColumnsType<DailyRow> = [
    {
      title: '日期', dataIndex: 'date', width: 90, align: 'center' as const,
      sorter: (a, b) => a.date.localeCompare(b.date),
      render: (v: string) => <span style={MONO}>{v}</span>,
    },
    ...allProds.map(prod => ({
      title: prod, key: prod, width: 110, align: 'center' as const,
      render: (_: unknown, row: DailyRow) => {
        const v = row.productTotals[prod] ?? 0
        return v > 0
          ? <Tooltip title={fmtFull(v)}><span style={{ ...MONO, fontWeight: 600, color: creditColor(v), cursor: 'default' }}>{fmtCredit(v)}</span></Tooltip>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>
      },
    })),
    {
      title: '合计', dataIndex: 'total', width: 110, align: 'center' as const,
      sorter: (a, b) => a.total - b.total,
      render: (v: number) => (
        <Tooltip title={fmtFull(v)}>
          <span style={{ ...MONO, fontWeight: 700, color: creditColor(v), cursor: 'default' }}>{fmtCredit(v)}</span>
        </Tooltip>
      ),
    },
  ]

  return (
    <div>
      {/* 工具栏 */}
      {mobile ? (
        /* 移动端：两行布局
           第1行：明细/按天 | 日期范围筛选 | 计数
           第2行：消耗来源筛选 | 产品筛选 */
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Radio.Group size="small" value={mode} onChange={e => setMode(e.target.value)} buttonStyle="solid" style={{ flexShrink: 0 }}>
              <Radio.Button value="detail">明细</Radio.Button>
              <Radio.Button value="daily">按天</Radio.Button>
            </Radio.Group>
            <MobileDateRange value={strRangeToDay(dateRange)}
              onChange={v => setDateRange(v ? [v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')] : null)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Select size="small" style={{ flex: 1, minWidth: 0 }}
              options={srcOpts} value={filterSource || ''} onChange={v => setFilterSource(v)} />
            <Select size="small" style={{ flex: 1, minWidth: 0 }}
              options={prodOpts} value={filterProduct || ''} onChange={v => setFilterProduct(v)} />
          </div>
        </div>
      ) : (
        /* PC端：一行布局 */
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Radio.Group size="small" value={mode} onChange={e => setMode(e.target.value)} buttonStyle="solid">
            <Radio.Button value="detail">明细</Radio.Button>
            <Radio.Button value="daily">按天</Radio.Button>
          </Radio.Group>
          <RangePicker size="small" allowClear style={{ width: 210 }}
            onChange={(_, s) => setDateRange(s[0] && s[1] ? [s[0], s[1]] : null)} />
          <Select size="small" style={{ width: 120 }}
            options={srcOpts} value={filterSource || ''} onChange={v => setFilterSource(v)} />
          <Select size="small" style={{ width: 130 }}
            options={prodOpts} value={filterProduct || ''} onChange={v => setFilterProduct(v)} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {mode === 'detail' ? `${filtered.length} 条` : `${dailyRows.length} 天`}
          </span>
        </div>
      )}

      {mode === 'detail'
        ? <Table<RecordItem>
            columns={detailCols}
            dataSource={[...filtered].sort((a, b) => b.date.localeCompare(a.date))}
            rowKey={(r, i) => `${r.date}-${r.agentId}-${i}`}
            loading={loading ? TABLE_SPIN_INDICATOR : false}
            locale={{ emptyText: loading ? <span /> : '暂无数据' }}
            size="small"
            showSorterTooltip={false}
            scroll={mobile ? { x: true } : undefined}
            pagination={{ pageSize: 15, showSizeChanger: false, showLessItems: true, showTotal: t => `共 ${t} 条` }}
          />
        : <Table<DailyRow>
            columns={dailyCols}
            dataSource={[...dailyRows].sort((a, b) => b.date.localeCompare(a.date))}
            rowKey={r => r.date}
            loading={loading ? TABLE_SPIN_INDICATOR : false}
            locale={{ emptyText: loading ? <span /> : '暂无数据' }}
            size="small"
            showSorterTooltip={false}
            scroll={mobile ? { x: true } : undefined}
            pagination={{ pageSize: 15, showSizeChanger: false, showLessItems: true, showTotal: t => `共 ${t} 天` }}
          />
      }
    </div>
  )
}

// ── 认证遮罩（叠在需要实时数据的区域上）────────────────────────────────────────

function AuthOverlay({ isDark, onGoAuth }: { isDark: boolean; onGoAuth: () => void }) {
  return (
    <div
      onClick={onGoAuth}
      style={{
        position: 'absolute', inset: 0, zIndex: 10,
        borderRadius: 'inherit',
        cursor: 'pointer',
        // 背景：毛玻璃模糊 + 渐变遮罩
        backdropFilter: 'blur(6px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(6px) saturate(1.2)',
        background: isDark
          ? 'linear-gradient(135deg, rgba(15,23,42,0.72) 0%, rgba(30,27,75,0.68) 100%)'
          : 'linear-gradient(135deg, rgba(248,250,252,0.75) 0%, rgba(238,242,255,0.72) 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // 入场动画
        animation: 'hd-overlay-in 0.2s ease',
      }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '20px 28px', borderRadius: 14,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.7)',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(99,102,241,0.18)'}`,
        boxShadow: isDark
          ? '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)'
          : '0 8px 32px rgba(99,102,241,0.12), inset 0 1px 0 rgba(255,255,255,0.9)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        maxWidth: 280, textAlign: 'center',
      }}>
        {/* 图标：渐变圆形背景 + 锁 */}
        <div style={{
          width: 44, height: 44, borderRadius: '50%',
          background: 'linear-gradient(135deg,#6366f1,#0ea5e9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 14px rgba(99,102,241,0.4)',
          fontSize: 20, flexShrink: 0,
        }}>🔒</div>

        <div>
          <div style={{
            fontSize: 13, fontWeight: 700,
            color: isDark ? '#f1f5f9' : '#1e293b',
            marginBottom: 4, letterSpacing: '0.01em',
          }}>需要认证才能查看实时数据</div>
          <div style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b', lineHeight: 1.6 }}>
            产品额度与今日消耗<br />需要 Friday SSO Cookie 才能加载
          </div>
        </div>

        {/* CTA 按钮 */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 18px', borderRadius: 8,
          background: 'linear-gradient(135deg,#6366f1,#0ea5e9)',
          color: '#fff', fontSize: 12, fontWeight: 600,
          boxShadow: '0 2px 10px rgba(99,102,241,0.35)',
          transition: 'transform 0.15s, box-shadow 0.15s',
          marginTop: 2,
        }}>
          <span>前往认证</span>
          <span style={{ fontSize: 11, opacity: 0.9 }}>→</span>
        </div>
      </div>

      {/* 全局 keyframes（只注入一次）*/}
      <style>{`
        @keyframes hd-overlay-in {
          from { opacity: 0; backdrop-filter: blur(0px); }
          to   { opacity: 1; backdrop-filter: blur(6px); }
        }
      `}</style>
    </div>
  )
}

// ── 认证页 ────────────────────────────────────────────────────────────────────

function AuthPage({ onRetry, onGuest }: { onRetry: () => void; onGuest: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [syncOk, setSyncOk] = useState(false)
  const [cookieInput, setCookieInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [cookieStatus, setCookieStatus] = useState<{ has: boolean; preview?: string; len?: number } | null>(null)

  // 页面加载时查询当前 cookie 状态
  useEffect(() => {
    fetch('/api/credit/cookie', { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        if (j.code === 0) setCookieStatus({ has: j.has_cookie, preview: j.preview, len: j.length })
      })
      .catch(() => {})
  }, [])

  async function clearCookie() {
    await fetch('/api/credit/cookie', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' }),
    })
    setCookieStatus({ has: false })
    setSyncOk(false)
    setSyncMsg('已清除旧 Cookie，请重新同步')
  }

  async function autoSync() {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await fetch('/api/credit/auto-sync', { method: 'POST', credentials: 'include' })
      const j = await r.json()
      if (j.code === 0) {
        setSyncMsg(`✅ ${j.message}`)
        setSyncOk(true)
        setTimeout(onRetry, 1200)
      } else {
        // 包含 401（SSO验证失败）和其他错误
        setSyncMsg(`❌ ${j.message || '同步失败，请重试'}`)
      }
    } catch { setSyncMsg('❌ 请求失败，请检查服务是否正常运行') }
    setSyncing(false)
  }

  async function saveCookie() {
    if (!cookieInput.trim()) return
    setSaving(true)
    setSaveMsg('')
    try {
      const cookieVal = cookieInput.trim()
        .replace(/\r?\n/g, ' ')  // 移除换行符
        .replace(/\s{2,}/g, ' ') // 合并多余空格
      const r = await fetch('/api/credit/cookie', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: cookieVal }),
      })
      const j = await r.json()
      if (j.code === 0) {
        setSaveMsg(`✅ 已保存（${j.length} 字节），正在重新加载…`)
        setCookieInput('')
        setTimeout(onRetry, 800)
      } else setSaveMsg(`❌ ${j.message || '保存失败'}`)
    } catch { setSaveMsg('❌ 请求失败') }
    setSaving(false)
  }

  return (
    <div className="page-content">
      <PageHeader pageName="AI Credit" />

      <div style={{ maxWidth: 560, margin: '24px auto', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '28px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔐</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>需要 Friday SSO 认证</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            完成一次认证后，Cookie 持久化存储在服务器。<br />
            <b>所有客户端</b>（Mac 本机、手机、远程设备）均可无障碍访问。
          </div>
        </div>

        {/* 方式一：自动同步（主推） */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            🚀 方式一（推荐）：从本机浏览器自动同步
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
            确保已在 <a href="https://friday.sankuai.com/aiCredit/" target="_blank" rel="noreferrer" style={{ color: '#0ea5e9' }}>friday.sankuai.com/aiCredit/</a> 完成 SSO 登录，
            点击下方按钮，服务器将自动从本机浏览器读取认证 Cookie，无需手动操作。
          </div>
          <button
            onClick={autoSync}
            disabled={syncing || syncOk}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 20px', borderRadius: 6, cursor: syncing || syncOk ? 'default' : 'pointer',
              background: syncOk ? '#10b981' : '#0ea5e9', color: '#fff', border: 'none',
              fontSize: 13, fontWeight: 600, opacity: syncing ? 0.8 : 1,
            }}
          >
            {syncing ? <SyncOutlined spin /> : <SyncOutlined />}
            {syncing ? '同步中…' : syncOk ? '已同步 ✓' : '自动同步 Cookie'}
          </button>
          {syncMsg && (
            <div style={{ marginTop: 8, fontSize: 12, color: syncOk ? '#10b981' : '#f43f5e' }}>{syncMsg}</div>
          )}
        </div>

        {/* 方式二：手动粘贴 */}
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            方式二：手动粘贴 Cookie
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
            在已登录 Friday 的电脑浏览器：按 F12 → Application → Cookies → friday.sankuai.com，复制所有 Cookie 粘贴到下方。
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={cookieInput} onChange={e => setCookieInput(e.target.value)}
              placeholder="粘贴完整 Cookie 字符串…"
              style={{ flex: 1, fontSize: 11, padding: '6px 10px', border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} />
            <button onClick={saveCookie} disabled={saving || !cookieInput.trim()}
              style={{ fontSize: 12, padding: '6px 16px', borderRadius: 6, cursor: 'pointer', background: '#0ea5e9', color: '#fff', border: 'none', opacity: saving || !cookieInput.trim() ? 0.5 : 1 }}>
              保存
            </button>
          </div>
          {saveMsg && <div style={{ fontSize: 11, marginTop: 6, color: saveMsg.startsWith('✅') ? '#10b981' : '#f43f5e' }}>{saveMsg}</div>}
        </div>

        {/* 当前存储 Cookie 状态 */}
        {cookieStatus !== null && (
          <div style={{ marginBottom: 16, padding: '10px 14px', background: cookieStatus.has ? 'rgba(16,185,129,0.06)' : 'rgba(244,63,94,0.06)', border: `1px solid ${cookieStatus.has ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)'}`, borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            {cookieStatus.has ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <span style={{ color: '#10b981', fontWeight: 600 }}>✓ 已存储 Cookie</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({cookieStatus.len} 字节)</span>
                  <div style={{ marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{cookieStatus.preview}</div>
                </div>
                <button onClick={clearCookie} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', background: 'rgba(244,63,94,0.1)', color: '#f43f5e', border: '1px solid rgba(244,63,94,0.2)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  清除重试
                </button>
              </div>
            ) : (
              <span style={{ color: '#f43f5e' }}>✗ 尚未存储 Cookie（认证失败原因）</span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={onRetry} style={{ padding: '7px 22px', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: 13 }}>
            <ReloadOutlined style={{ marginRight: 6 }} />已完成，重新加载
          </button>
          <button onClick={onGuest} style={{ padding: '7px 22px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', fontSize: 13 }}>
            跳过认证（访客模式）
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export default function AICredit() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  // 统一使用全局 FilterContext，监听 refreshTick + backgroundTick 触发重载
  // RefreshModule 组件负责显示自动刷新胶囊 UI，无需在此处维护独立 sec/cd
  const { refreshTick, backgroundTick } = useFilter()
  const [key, setKey] = useState(0)
  const prevRefreshRef = useRef(refreshTick)
  const prevBgRef = useRef(backgroundTick)
  useEffect(() => {
    const refreshChanged = prevRefreshRef.current !== refreshTick
    const bgChanged = prevBgRef.current !== backgroundTick
    if (refreshChanged || bgChanged) {
      prevRefreshRef.current = refreshTick
      prevBgRef.current = backgroundTick
      setKey(k => k + 1)
    }
  }, [refreshTick, backgroundTick])

  const [state, setState] = useState<'loading' | 'auth' | 'ok' | 'guest'>('ok')
  const [productsLoading, setProductsLoading] = useState(true)   // 初始为 true，首次加载时显示骨架屏
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const [products, setProducts] = useState<ProductInfo[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [tenantId, setTenantId] = useState('')
  const [cacheTip, setCacheTip] = useState<string | null>(null)
  const [todayErr, setTodayErr] = useState<string | null>(null)
  const [infoRefreshing, setInfoRefreshing] = useState(false)  // 刷新个人信息中

  const defaultRange: [Dayjs, Dayjs] = [dayjs().subtract(6, 'day'), dayjs()]
  const [chartRange, setChartRange] = useState<[Dayjs, Dayjs] | null>(defaultRange)

  // 进入访客模式：读本地缓存数据
  const enterGuestMode = useCallback(async () => {
    // 访客模式不需要整页加载，直接切到 guest 展示本地数据
    const [localInfo, localRecs] = await Promise.all([
      fetchLocalUserInfo(),
      fetchLocalRecords(),
    ])
    setUserInfo(localInfo)
    setRecords(localRecs)
    setProducts([])         // 产品额度无法在访客模式下展示（需要实时数据）
    setRecsLoading(false)
    setState('guest')
  }, [])

  // 刷新个人信息：强制绕过缓存，重新从 Friday 拉取
  const refreshUserInfo = useCallback(async () => {
    if (infoRefreshing) return
    setInfoRefreshing(true)
    const info = await fetchMe(true)   // force=1，跳过本地缓存
    if (info && (info.misId || info.realName)) setUserInfo(info)
    setInfoRefreshing(false)
  }, [infoRefreshing])

  // 退出登录：清除 Heimdall 存储的 Friday Cookie，跳回认证页
  const handleLogout = useCallback(async () => {
    await doLogout()
    setUserInfo(null)
    setProducts([])
    setRecords([])
    setState('auth')
  }, [])

  useEffect(() => {
    let cancel = false
    async function load() {
      // 先设 loading，再清数据 —— 避免出现"暂无数据"→loading 的错误顺序
      setProductsLoading(true)
      setRecsLoading(true)
      setProducts([]); setRecords([]); setCacheTip(null); setTodayErr(null)

      const { result, status } = await fetchSummary()
      if (cancel) return
      if (status === 401 || !result) { setState('auth'); setProductsLoading(false); setRecsLoading(false); return }

      setProducts(result.products)
      setTenantId(result.tenantId)
      setProductsLoading(false)
      setState('ok')

      // 个人信息：调 /api/credit/me（后端已内置本地缓存优先逻辑，无需双请求）
      fetchMe().then(info => {
        if (cancel) return
        if (info && (info.misId || info.realName)) {
          setUserInfo(info)
        } else if (result.tenantId && !userInfo) {
          setUserInfo({
            userName: '', misId: '', tenantId: result.tenantId,
            appId: '', department: '', avatar: '',
          })
        }
      })

      const recs = await fetchRecords(result.tenantId)
      if (cancel) return
      setRecords(recs.list)
      if (recs.fromCache && recs.cacheTip) setCacheTip(recs.cacheTip)
      if (recs.todayError && recs.todayErrorMsg) setTodayErr(recs.todayErrorMsg)
      setRecsLoading(false)
    }
    load()
    return () => { cancel = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const { triggerRefresh } = useFilter()
  if (state === 'auth') return <AuthPage onRetry={triggerRefresh} onGuest={enterGuestMode} />

  // ── 访客模式渲染 ────────────────────────────────────────────────────────────
  if (state === 'guest') {
    return (
      <div className="page-content">
        <PageHeader pageName="AI Credit" extra={
          <Tooltip title="前往认证以获取实时数据">
            <button
              onClick={() => setState('auth')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 12px', borderRadius: 6, cursor: 'pointer',
                background: 'linear-gradient(135deg,#6366f1,#0ea5e9)',
                color: '#fff', border: 'none', fontSize: 12, fontWeight: 600,
              }}
            >
              🔒 前往认证
            </button>
          </Tooltip>
        } />

        {/* 访客模式提示条 */}
        <Alert
          type="info" showIcon closable
          message={
            <span>
              访客模式 — 展示本地缓存数据，产品额度需要
              <button onClick={() => setState('auth')} style={{ marginLeft: 4, marginRight: 4, color: '#0ea5e9', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600 }}>
                认证后
              </button>
              查看
            </span>
          }
          style={{ marginBottom: 12, fontSize: 12 }}
        />

        {/* 个人信息（直接展示缓存，无刷新按钮） */}
        {userInfo && (userInfo.misId || userInfo.realName || userInfo.tenantId) && (
          <section className="section"><UserInfoBar info={userInfo} /></section>
        )}
        {!userInfo && (
          <section className="section">
            <div style={{
              padding: '16px 20px',
              background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12,
              fontSize: 12, color: 'var(--text-muted)',
            }}>
              暂无缓存的个人信息，完成一次认证后将自动缓存
            </div>
          </section>
        )}

        {/* 图表（来自本地缓存，无需遮罩） */}
        <section className="section">
          <Spin spinning={recsLoading}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ flex: '1 1 340px', minWidth: 0 }}>
                <TrendChart records={records} isDark={isDark} dateRange={chartRange} onRangeChange={setChartRange} />
              </div>
              {records.length > 0 && (
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <PieChart records={records} isDark={isDark} dateRange={chartRange} onRangeChange={setChartRange} />
                </div>
              )}
            </div>
          </Spin>
        </section>

        {/* 消耗记录（来自本地缓存） */}
        <section className="section">
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${isDark ? '#21262d' : '#f0f0f0'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                消耗记录（本地缓存）{records.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>({records.length} 条)</span>}
              </span>
              <button onClick={() => window.open('https://friday.sankuai.com/aiCredit/', '_blank')}
                style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
                查看更多 ↗
              </button>
            </div>
            <RecordsTable records={records} loading={recsLoading} />
          </div>
        </section>
      </div>
    )
  }

  // ── 正常模式（已认证）─────────────────────────────────────────────────────

  const totalInit = products.reduce((s, p) => s + p.initialQuota, 0)
  const totalUsed = products.reduce((s, p) => s + p.usedQuota, 0)
  const totalRem  = products.reduce((s, p) => s + p.remainingQuota, 0)
  const rate = totalInit > 0 ? totalUsed / totalInit : 0

  return (
    <div className="page-content">
      {/* 标题栏（PC端标题 + 右侧统一刷新胶囊）*/}
      <PageHeader pageName="AI Credit" extra={<RefreshModule />} />
      {cacheTip && <div style={{ marginTop: -12, marginBottom: 8 }}><Tooltip title={cacheTip}><Tag color="warning" style={{ fontSize: 11, cursor: 'help', margin: 0 }}>📦 缓存</Tag></Tooltip></div>}

        {/* 个人信息 */}
        {userInfo && (userInfo.userName || userInfo.misId || userInfo.tenantId) && (
          <section className="section"><UserInfoBar info={userInfo} onRefresh={refreshUserInfo} refreshing={infoRefreshing} onLogout={handleLogout} /></section>
        )}

      {todayErr && <Alert type="warning" showIcon closable message={`今日数据暂不可用：${todayErr}`} style={{ marginBottom: 12, fontSize: 12 }} />}

      {/* 产品额度（标题移入卡片内部，外层不再单独显示标题）*/}
      {productsLoading ? (
        <section className="section">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {[0, 1].map(i => (
              <div key={i} className="hd-shimmer-card" style={{ flex: '1 1 220px', minWidth: 200 }} />
            ))}
          </div>
        </section>
      ) : products.length > 0 && (
        <section className="section">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {products.map((p, i) => <ProductCard key={i} product={p} isDark={isDark} />)}
          </div>
          {/* 汇总行：移动端已在 ProductCard 内展示，仅 PC 端多产品时显示汇总 */}
          {!isMobile() && products.length > 1 && (
            <div style={{ marginTop: 10, padding: '8px 14px', background: 'var(--bg-secondary)', borderRadius: 8, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { label: '总配额', val: fmtCredit(totalInit), raw: fmtFull(totalInit) },
                { label: '已使用', val: fmtCredit(totalUsed), raw: fmtFull(totalUsed), color: '#f59e0b' },
                { label: '剩余', val: fmtCredit(totalRem), raw: fmtFull(totalRem), color: usageColor(rate) },
                { label: '使用率', val: `${(rate * 100).toFixed(1)}%`, raw: '', color: usageColor(rate) },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.label}</span>
                  <Tooltip title={item.raw || undefined}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: item.color ?? 'var(--text-primary)' }}>
                      {item.val}
                    </span>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

        {/* 图表 */}
        <section className="section">
          {recsLoading ? (
            <LoadingBlock minHeight={200} />
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ flex: '1 1 340px', minWidth: 0 }}>
                <TrendChart records={records} isDark={isDark} dateRange={chartRange} onRangeChange={setChartRange} />
              </div>
              {records.length > 0 && (
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <PieChart records={records} isDark={isDark} dateRange={chartRange} onRangeChange={setChartRange} />
                </div>
              )}
            </div>
          )}
        </section>

      {/* 消耗记录 */}
      <section className="section">
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${isDark ? '#21262d' : '#f0f0f0'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
              消耗记录 {records.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>({records.length} 条)</span>}
            </span>
            <button onClick={() => window.open('https://friday.sankuai.com/aiCredit/', '_blank')}
              style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
              查看更多 ↗
            </button>
          </div>
          <RecordsTable records={records} loading={recsLoading} />
        </div>
      </section>
    </div>
  )
}

function CreditPageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.85 }}>
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  )
}
