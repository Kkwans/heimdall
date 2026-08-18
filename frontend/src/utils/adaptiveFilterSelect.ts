import type { SelectProps } from 'antd'

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
