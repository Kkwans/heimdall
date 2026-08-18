import React, { useMemo } from 'react'
import { Select } from 'antd'
import type { SelectProps } from 'antd'
import { getAdaptiveSelectSizing } from '../utils/adaptiveFilterSelect'

/** Select used by dense filter toolbars; the popup follows its longest label. */
export default function AdaptiveFilterSelect(props: SelectProps) {
  const sizing = useMemo(
    () => getAdaptiveSelectSizing(props.options, props.style),
    [props.options, props.style],
  )
  const options = useMemo(() => (
    props.options?.map(option => ({
      ...option,
      // rc-select 会把字符串 label 自动写入 title，导致浏览器原生 tooltip。
      // 筛选下拉本身已经完整展示文本，不需要再重复提示。
      title: '',
    }))
  ), [props.options])
  const selectStyle = useMemo(() => {
    if (sizing.width == null) return props.style
    return {
      ...(props.style ?? {}),
      width: sizing.width,
      minWidth: sizing.width,
    }
  }, [props.style, sizing.width])
  const dropdownStyle = useMemo(() => ({
    ...(props.dropdownStyle ?? {}),
    ...(sizing.width == null ? {} : {
      width: sizing.width,
      minWidth: sizing.width,
    }),
    maxWidth: 'calc(100vw - 24px)',
  }), [props.dropdownStyle, sizing.width])

  return (
    <Select
      {...props}
      style={selectStyle}
      options={options}
      title=""
      popupClassName="hd-adaptive-filter-popup"
      popupMatchSelectWidth={sizing.matchSelectWidth}
      dropdownStyle={dropdownStyle}
    />
  )
}
