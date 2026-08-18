import type { SelectProps } from 'antd'
import type { CSSProperties } from 'react'

type Option = NonNullable<SelectProps['options']>[number]

function optionLabel(option: Option): string {
  if (typeof option.label === 'string' || typeof option.label === 'number') return String(option.label)
  return option.value == null ? '' : String(option.value)
}

function estimateLabelWidth(label: string): number {
  return Array.from(label).reduce((width, character) => {
    // CJK/emoji glyphs occupy roughly one full UI font cell; model IDs use a
    // narrower Latin cell. This keeps the popup close to its longest option.
    const codePoint = character.codePointAt(0) ?? 0
    return width + (codePoint > 0x2e80 ? 14 : 7.5)
  }, 0)
}

export function getAdaptivePopupWidth(options: SelectProps['options'] = []): number {
  const labels = (options ?? []).map(optionLabel)
  const longest = labels.reduce((max, label) => Math.max(max, estimateLabelWidth(label)), 0)
  // 筛选项通常只有几个短标签；固定 160px 会让“全部状态/全部模式”
  // 的弹层明显比内容宽一倍。保留约 24px 的左右呼吸空间即可。
  return Math.min(360, Math.max(112, Math.ceil(longest + 24)))
}

export interface AdaptiveSelectSizing {
  /** Fixed width used by both the trigger and its popup on desktop. */
  width: number | undefined
  /** Responsive selects should let rc-select match the trigger width. */
  matchSelectWidth: boolean
}

/**
 * Resolve a stable trigger width without making mobile flex filters overflow.
 *
 * Desktop filter selects generally provide numeric min/max bounds. In that
 * case the longest option determines one fixed width for the whole control;
 * the selected label can never resize the toolbar. Mobile filters use string
 * flex/width values, so their trigger remains responsive and the popup follows
 * it through rc-select's normal width matching.
 */
export function getAdaptiveSelectSizing(
  options: SelectProps['options'] = [],
  style?: CSSProperties,
): AdaptiveSelectSizing {
  const configuredWidth = style?.width
  if (typeof configuredWidth === 'number') {
    return { width: configuredWidth, matchSelectWidth: false }
  }

  const responsive = [style?.flex, style?.flexBasis, style?.minWidth, style?.maxWidth]
    .some(value => typeof value === 'string')
  if (responsive) {
    return { width: undefined, matchSelectWidth: true }
  }

  const preferredWidth = getAdaptivePopupWidth(options)
  const minWidth = typeof style?.minWidth === 'number' ? style.minWidth : 0
  const maxWidth = typeof style?.maxWidth === 'number' ? style.maxWidth : Number.POSITIVE_INFINITY
  const width = Math.min(maxWidth, Math.max(minWidth, preferredWidth))
  return { width, matchSelectWidth: false }
}
