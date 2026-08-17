import type { SelectProps } from 'antd'

type Option = NonNullable<SelectProps['options']>[number]

function optionLabel(option: Option): string {
  if (typeof option.label === 'string' || typeof option.label === 'number') return String(option.label)
  return option.value == null ? '' : String(option.value)
}

export function getAdaptivePopupWidth(options: SelectProps['options'] = []): number {
  const labels = (options ?? []).map(optionLabel)
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0)
  return Math.min(560, Math.max(200, longest * 14 + 64))
}
