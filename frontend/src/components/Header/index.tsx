import React from 'react'
import { Button, DatePicker } from 'antd'
import dayjs from 'dayjs'
import { useFilter } from '../../context/FilterContext'
import type { DatePreset, DateRange } from '../../types'
import styles from './Header.module.css'
import RefreshModule from './RefreshModule'

// 页面名称 → 蓝色 SVG 图标映射（与 Layout/index.tsx 中 PAGE_ICONS 完全一致）
const PAGE_ICONS: Record<string, React.ReactNode> = {
  '仪表盘': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  '请求明细': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="12" y2="16" />
    </svg>
  ),
  '数据统计': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  ),
  '实时日志': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  '设置': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

const { RangePicker } = DatePicker

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: '7days', label: '近 7 天' },
  { key: '30days', label: '近 30 天' },
  { key: 'all', label: '全部' },
]

// 检测移动端
const isMobile = () => window.innerWidth <= 768

interface HeaderProps {
  /** 已废弃，保留向后兼容 */
  hideBrand?: boolean
  /** PC端左侧显示的页面名称（含图标）；移动端不显示 */
  pageName?: string
}

export default function Header({ pageName }: HeaderProps = {}) {
  const {
    datePreset,
    dateRange,
    setDatePreset,
    setCustomDateRange,
  } = useFilter()

  const rangePickerValue = (() => {
    if (datePreset === 'all') return null
    if (dateRange.start && dateRange.end) {
      return [dayjs(dateRange.start), dayjs(dateRange.end)] as [ReturnType<typeof dayjs>, ReturnType<typeof dayjs>]
    }
    return null
  })()

  const icon = pageName ? PAGE_ICONS[pageName] : null

  return (
    <header className={`${styles.header} ${pageName ? styles.headerWithTitle : ''}`}>
      {/* PC端页面标题：图标 + 页面名称（移动端通过 CSS 隐藏） */}
      {pageName && (
        <div className={`${styles.pageTitle} page-header-inline`}>
          {icon && <span className={styles.pageTitleIcon}>{icon}</span>}
          <span className={styles.pageTitleText}>{pageName}</span>
        </div>
      )}

      <div className={styles.controls}>
        {/* 第一行：预设按钮组 */}
        <div className={styles.presetGroup}>
          {PRESETS.map(p => (
            <Button
              key={p.key}
              size="small"
              type={datePreset === p.key ? 'primary' : 'default'}
              onClick={() => setDatePreset(p.key)}
              className={styles.presetBtn}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {/* 日期范围选择器 */}
        <RangePicker
          size="small"
          value={rangePickerValue}
          onChange={(dates) => {
            if (dates && dates[0] && dates[1]) {
              setCustomDateRange({
                start: dates[0].format('YYYY-MM-DD'),
                end: dates[1].format('YYYY-MM-DD'),
              } as DateRange)
            }
          }}
          className={styles.rangePicker}
          placeholder={['开始日期', '结束日期']}
          allowClear={false}
          format="YYYY-MM-DD"
          style={{ width: 240 }}
        />

        {/* PC端刷新模块（在日历右侧），移动端由 Layout 的 topbar 负责 */}
        {!isMobile() && <RefreshModule />}
      </div>
    </header>
  )
}
