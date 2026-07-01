/**
 * RefreshModule — 自动刷新胶囊控件
 *
 * PC 端：Select（间隔选择） + 倒计时/刷新按钮 融合为一个圆角胶囊，整体作为一个视觉单元。
 * compact 模式（移动端 topbar）：仅显示倒计时/刷新按钮，无 Select 部分。
 *
 * Props:
 *   compact?: boolean — compact 模式（移动端 topbar 使用）
 */
import React from 'react'
import { Select, Tooltip } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useFilter } from '../../context/FilterContext'
import { useRefreshInterval, INTERVAL_OPTIONS } from '../../hooks/useRefreshInterval'
import styles from './Header.module.css'

interface RefreshModuleProps {
  compact?: boolean
}

export default function RefreshModule({ compact = false }: RefreshModuleProps) {
  const { triggerRefresh, triggerBackground } = useFilter()

  const { intervalSec, setIntervalSec, countdown } = useRefreshInterval({
    onTick: triggerBackground,
  })

  const countdownLabel = (() => {
    if (intervalSec === 0) return '刷新'
    if (countdown >= 60) return `${Math.ceil(countdown / 60)}min`
    return `${countdown}s`
  })()
  const isCountingDown = intervalSec > 0

  // compact 模式（移动端 topbar）：只显示一个简洁的刷新按钮
  if (compact) {
    return (
      <Tooltip title="手动刷新">
        <button
          className={`${styles.countdownRefreshBtn} ${isCountingDown ? styles.countdownRefreshBtnActive : ''}`}
          style={{
            border: '1px solid var(--border-default, rgba(0,0,0,0.15))',
            borderRadius: 6,
            height: 28,
            padding: '0 8px 0 6px',
          }}
          onClick={triggerRefresh}
          type="button"
        >
          <span className={`${styles.countdownText} ${isCountingDown ? styles.countdownTextActive : ''}`}>
            {countdownLabel}
          </span>
          <ReloadOutlined className={styles.refreshIcon} />
        </button>
      </Tooltip>
    )
  }

  // PC 端：胶囊式 Select + 按钮整体
  // 使用外层 div 设定整体边框和圆角，内部两个元素无独立边框
  return (
    <div
      className={`${styles.refreshModule} ${isCountingDown ? styles.refreshModuleActive : ''}`}
    >
      {/* 左侧：自动刷新间隔选择，使用 borderless 去掉自身边框 */}
      <Select
        size="small"
        value={intervalSec}
        onChange={setIntervalSec}
        variant="borderless"
        popupMatchSelectWidth={false}
        options={INTERVAL_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
        style={{ width: 74, flexShrink: 0 }}
        styles={{ popup: { root: { minWidth: 90 } } }}
        className="hd-refresh-select"
      />
      {/* 分隔线 */}
      <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-default, rgba(0,0,0,0.1))', flexShrink: 0 }} />
      {/* 右侧：倒计时文字 + 刷新图标 */}
      <Tooltip title="手动刷新">
        <button
          className={`${styles.countdownRefreshBtn} ${isCountingDown ? styles.countdownRefreshBtnActive : ''}`}
          onClick={triggerRefresh}
          type="button"
        >
          <span className={`${styles.countdownText} ${isCountingDown ? styles.countdownTextActive : ''}`}>
            {countdownLabel}
          </span>
          <ReloadOutlined className={styles.refreshIcon} />
        </button>
      </Tooltip>
    </div>
  )
}
