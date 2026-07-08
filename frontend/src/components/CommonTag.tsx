/**
 * 公共标签组件
 * 厂商标签和模型标签的统一样式
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
      color={vc.color}
      style={{
        fontWeight: 600,
        fontSize: 11,
        borderRadius: 3,
        margin: 0,
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}

/**
 * 模型标签（使用蓝色系）
 */
export function ModelTag({ name, style }: { name: string; style?: React.CSSProperties }) {
  return (
    <Tag
      color="blue"
      style={{
        fontSize: 11,
        borderRadius: 3,
        margin: 0,
        ...style,
      }}
    >
      {name}
    </Tag>
  )
}
