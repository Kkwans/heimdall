/**
 * 公共标签组件
 *
 * 两套标签样式：
 * - VendorTag：厂商标签，填充式（主题色背景+白色文字）
 * - ModelTag：模型标签，描边式（浅色背景+主题色文字+主题色边框）
 *
 * 两套样式全局统一，通过颜色区分不同厂商
 */
import React from 'react'
import { Tag } from 'antd'
import { getVendorColor } from './Charts/chartTheme'

/**
 * 厂商标签 — 填充式样式
 * 主题色背景 + 白色文字，视觉上是"实心"标签
 */
export function VendorTag({ name, style }: { name: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(name)
  return (
    <Tag
      style={{
        background: vc.color,
        color: '#fff',
        border: 'none',
        fontWeight: 600,
        fontSize: 11,
        borderRadius: 3,
        margin: 0,
        lineHeight: '18px',
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}

/**
 * 模型标签 — 描边式样式
 * 浅色背景 + 主题色文字 + 主题色边框，视觉上是"空心"标签
 */
export function ModelTag({ name, vendorName, style }: { name: string; vendorName?: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(vendorName || name)
  return (
    <Tag
      style={{
        background: vc.bg,
        color: vc.color,
        border: `1px solid ${vc.color}30`,
        fontWeight: 500,
        fontSize: 11,
        borderRadius: 3,
        margin: 0,
        lineHeight: '18px',
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}
