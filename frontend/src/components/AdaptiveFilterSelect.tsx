import React, { useMemo } from 'react'
import { Select } from 'antd'
import type { SelectProps } from 'antd'
import { getAdaptivePopupWidth } from '../utils/adaptiveFilterSelect'

/** Select used by dense filter toolbars; the popup follows its longest label. */
export default function AdaptiveFilterSelect(props: SelectProps) {
  const popupWidth = useMemo(() => getAdaptivePopupWidth(props.options), [props.options])
  const dropdownStyle = useMemo(() => ({
    ...(props.dropdownStyle ?? {}),
    width: popupWidth,
    minWidth: popupWidth,
    maxWidth: 'calc(100vw - 24px)',
  }), [popupWidth, props.dropdownStyle])

  return (
    <Select
      {...props}
      popupMatchSelectWidth={false}
      dropdownStyle={dropdownStyle}
    />
  )
}
