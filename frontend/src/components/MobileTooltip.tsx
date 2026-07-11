/**
 * MobileTooltip — 移动端不显示 Tooltip，PC端 hover 显示
 */
import React from 'react'
import { Tooltip } from 'antd'

interface MobileTooltipProps {
  title: string | React.ReactNode
  children: React.ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

export default function MobileTooltip({ title, children, placement = 'top' }: MobileTooltipProps) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768

  // 移动端不显示 tooltip
  if (isMobile) {
    return <>{children}</>
  }

  return <Tooltip title={title} placement={placement}>{children as React.ReactElement}</Tooltip>
}
