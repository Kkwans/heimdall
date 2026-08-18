import React, { useMemo } from 'react'
import { Select } from 'antd'
import type { SelectProps } from 'antd'
import { getAdaptivePopupWidth } from '../utils/adaptiveFilterSelect'

/** Select used by dense filter toolbars; the popup follows its longest label. */
export default function AdaptiveFilterSelect(props: SelectProps) {
  const popupWidth = useMemo(() => getAdaptivePopupWidth(props.options), [props.options])
  const styles = useMemo(() => {
    const incoming = props.styles && typeof props.styles === 'object' ? props.styles : {}
    const popup = incoming.popup && typeof incoming.popup === 'object' ? incoming.popup : {}
    const root = popup.root && typeof popup.root === 'object' ? popup.root : {}
    return {
      ...incoming,
      popup: {
        ...popup,
        root: {
          ...root,
          width: popupWidth,
          minWidth: popupWidth,
          maxWidth: 'calc(100vw - 24px)',
        },
      },
    } as SelectProps['styles']
  }, [popupWidth, props.styles])

  return (
    <Select
      {...props}
      popupMatchSelectWidth={false}
      styles={styles}
    />
  )
}
