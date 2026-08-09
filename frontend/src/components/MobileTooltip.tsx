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

  // Tooltip 需要能够接收 ref 的原生节点；业务标签多为函数组件，统一加一层
  // 不改变尺寸的 inline-flex 触发器，避免桌面端 hover 后没有浮层。
  return (
    <Tooltip title={title} placement={placement}>
      <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }}>
        {children}
      </span>
    </Tooltip>
  )
}
