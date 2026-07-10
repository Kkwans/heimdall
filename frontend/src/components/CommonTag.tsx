/**
 * 公共标签组件
 *
 * 两套标签样式：
 * - VendorTag：厂商标签，描边式（透明背景 + vc.color 文字 + vc.color 边框）
 * - ModelTag：模型标签，填充式（Ant Design color prop，自动适配深色模式）
 *
 * 两套样式全局统一，通过颜色区分不同厂商
 */
import React from 'react'
import { Tag } from 'antd'
import { getVendorColor } from './Charts/chartTheme'

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
 * 使用 Ant Design 的 color prop，自动适配深色模式
 * 与原 friday 标签（Tag color="blue"）行为一致
 */
export function ModelTag({ name, vendorName, style }: { name: string; vendorName?: string; style?: React.CSSProperties }) {
  const vc = getVendorColor(vendorName || name)
  return (
    <Tag
      color={vc.color}
      style={{
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
