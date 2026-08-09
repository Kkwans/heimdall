import React from 'react'
import { Modal } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import type { ModalProps } from 'antd'

interface AppModalProps extends Omit<ModalProps, 'title' | 'closable' | 'closeIcon'> {
  title: React.ReactNode
  titleMeta?: React.ReactNode
  closable?: boolean
  contentStyle?: React.CSSProperties
}

/**
 * Heimdall 通用弹窗骨架。
 *
 * 统一标题、关闭按钮、正文和底部操作区的间距；业务弹窗只负责内容，
 * 避免各页面继续手写标题栏和关闭按钮。
 */
export default function AppModal({
  title,
  titleMeta,
  className,
  children,
  closable = true,
  contentStyle,
  onCancel,
  ...props
}: AppModalProps) {
  const modalClassName = ['hd-app-modal', className].filter(Boolean).join(' ')

  return (
    <Modal
      {...props}
      className={modalClassName}
      title={null}
      closable={false}
      onCancel={onCancel}
    >
      <div className="hd-modal-header">
        <div className="hd-modal-title">
          <div className="hd-modal-title__text">{title}</div>
          {titleMeta != null && <span className="hd-modal-title__meta">{titleMeta}</span>}
        </div>
        {closable && (
          <button
            type="button"
            className="hd-modal-close"
            onClick={onCancel}
            aria-label="关闭弹窗"
            title="关闭"
          >
            <CloseOutlined />
          </button>
        )}
      </div>
      <div className="hd-modal-body-content" style={contentStyle}>
        {children}
      </div>
    </Modal>
  )
}
