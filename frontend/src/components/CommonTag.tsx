/**
 * 公共标签组件
 *
 * 厂商标签和模型标签使用相同的组件样式，只通过颜色区分。
 * 样式：浅色背景 + 主题色文字 + 无边框（与原始 ce35081 一致）
 */
import React from 'react'
import { Tag } from 'antd'
import { getVendorColor } from './Charts/chartTheme'

/**
 * 厂商标签（使用厂商主题色）
 */
export function VendorTag({ name, style }: { name: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(name)
  return (
    <Tag
      color=""
      style={{
        background: vc.bg,
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

/**
 * 模型标签（使用所属厂商的主题色）
 * 样式与 VendorTag 完全一致，通过 vendorName 区分颜色
 */
export function ModelTag({ name, vendorName, style }: { name: string; vendorName?: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(vendorName || name)
  return (
    <Tag
      color=""
      style={{
        background: vc.bg,
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
