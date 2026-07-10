/**
 * 公共标签组件
 *
 * 两套标签样式：
 * - VendorTag：厂商标签，描边式（透明背景 + vc.color 文字 + vc.color 边框）
 * - ModelTag：模型标签，填充式（浅色模式用 vc.bg，深色模式用 vc.color 低透明度）
 *
 * 两套样式全局统一，通过颜色区分不同厂商
 */
import React from 'react'
import { Tag } from 'antd'
import { getVendorColor } from './Charts/chartTheme'
import { useTheme } from '../context/ThemeContext'

/**
 * 厂商标签 — 描边式（outline）
 * 透明背景 + 主题色文字 + 主题色边框
 */
export function VendorTag({ name, style }: { name: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(name)
  return (
    <Tag
      color=""
      style={{
        background: 'transparent',
        color: vc.color,
        border: `1px solid ${vc.color}`,
        fontSize: 11,
        borderRadius: 2,
        margin: 0,
        fontWeight: 600,
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}

/**
 * 模型标签 — 填充式（filled）
 * 浅色模式：vc.bg 背景 + vc.color 文字
 * 深色模式：vc.color 20% 透明度背景 + vc.color 文字
 */
export function ModelTag({ name, vendorName, style }: { name: string; vendorName?: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(vendorName || name)
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  // 深色模式：用主题色低透明度作为背景；浅色模式：用 vc.bg
  const bg = isDark ? `${vc.color}1f` : vc.bg

  return (
    <Tag
      color=""
      style={{
        background: bg,
        color: vc.color,
        border: 'none',
        fontSize: 11,
        borderRadius: 2,
        margin: 0,
        fontWeight: 600,
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}
