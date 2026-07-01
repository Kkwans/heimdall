/**
 * SpinRing — 纯 CSS 圆圈转圈加载指示器
 *
 * 不依赖 antd Spin 内部渲染逻辑，直接用 CSS animation（hd-spin-ring）实现。
 * 在 global.css 中定义了 .hd-spin-ring 和 @keyframes hd-spin-ring。
 *
 * 用法：
 *   // 单独展示
 *   <SpinRing />
 *   <SpinRing size={20} />
 *
 *   // 作为 antd Table / Spin 的 indicator
 *   <Table loading={{ indicator: <SpinRing /> }} ... />
 *   <Spin indicator={<SpinRing />} spinning={loading} />
 *
 *   // 整块 loading 占位
 *   <LoadingBlock minHeight={200} />
 */
import React from 'react'

interface SpinRingProps {
  /** 圆圈直径，默认 26 */
  size?: number
}

export function SpinRing({ size = 26 }: SpinRingProps) {
  return (
    <span
      className="hd-spin-ring"
      style={{ width: size, height: size, flexShrink: 0 }}
      aria-label="加载中"
    />
  )
}

interface LoadingBlockProps {
  /** 占位区块最小高度，默认 180 */
  minHeight?: number
  /** 圆圈直径，默认 28 */
  size?: number
}

/** 居中展示圆圈转圈的空白占位块，用于替代 <Spin> 包裹子组件 */
export function LoadingBlock({ minHeight = 180, size = 28 }: LoadingBlockProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight,
      }}
    >
      <SpinRing size={size} />
    </div>
  )
}

/** antd Table / Spin 专用：{ indicator: <SpinRing /> } 配置对象 */
export const TABLE_SPIN_INDICATOR = { indicator: <SpinRing size={28} /> }
