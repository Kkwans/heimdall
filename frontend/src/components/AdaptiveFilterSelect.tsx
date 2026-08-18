import React, { useMemo } from 'react'
import { Select } from 'antd'
import type { SelectProps } from 'antd'
import { getAdaptivePopupWidth } from '../utils/adaptiveFilterSelect'

/** Select used by dense filter toolbars; the popup follows its longest label. */
export default function AdaptiveFilterSelect(props: SelectProps) {
  const popupWidth = useMemo(() => getAdaptivePopupWidth(props.options), [props.options])
  const options = useMemo(() => (
    props.options?.map(option => ({
      ...option,
      // rc-select 会把字符串 label 自动写入 title，导致浏览器原生 tooltip。
      // 筛选下拉本身已经完整展示文本，不需要再重复提示。
      title: '',
    }))
  ), [props.options])
  const dropdownStyle = useMemo(() => ({
    ...(props.dropdownStyle ?? {}),
    width: popupWidth,
    minWidth: popupWidth,
    maxWidth: 'calc(100vw - 24px)',
  }), [popupWidth, props.dropdownStyle])

  return (
    <Select
      {...props}
      options={options}
      title=""
      popupClassName="hd-adaptive-filter-popup"
      popupMatchSelectWidth={false}
      dropdownStyle={dropdownStyle}
    />
  )
}
