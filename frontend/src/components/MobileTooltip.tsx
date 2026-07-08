/**
 * MobileTooltip — 移动端长按显示 Tooltip
 *
 * 移动端：长按显示，松开立即隐藏
 * PC端：hover 显示，移出隐藏（原生行为）
 */
import React, { useState, useRef, useCallback } from 'react'
import { Tooltip } from 'antd'

interface MobileTooltipProps {
  title: string | React.ReactNode
  children: React.ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

export default function MobileTooltip({ title, children, placement = 'top' }: MobileTooltipProps) {
  const [open, setOpen] = useState(false)
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  const timerRef = useRef<number | null>(null)

  const handleTouchStart = useCallback(() => {
    timerRef.current = window.setTimeout(() => {
      setOpen(true)
    }, 300)
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setOpen(false)
  }, [])

  if (!isMobile) {
    return <Tooltip title={title} placement={placement}>{children as React.ReactElement}</Tooltip>
  }

  return (
    <Tooltip title={title} placement={placement} open={open}>
      <span
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
    </Tooltip>
  )
}
