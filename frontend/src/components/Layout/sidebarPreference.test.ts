import { describe, expect, it, vi } from 'vitest'
import {
  readSidebarCollapsedPreference,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  writeSidebarCollapsedPreference,
} from './sidebarPreference'

describe('侧栏偏好', () => {
  it('首次访问默认折叠', () => {
    expect(readSidebarCollapsedPreference({ getItem: () => null })).toBe(true)
  })

  it('恢复用户保存的展开或折叠状态', () => {
    expect(readSidebarCollapsedPreference({ getItem: () => '0' })).toBe(false)
    expect(readSidebarCollapsedPreference({ getItem: () => '1' })).toBe(true)
  })

  it('使用稳定的本地存储键保存状态', () => {
    const setItem = vi.fn()
    writeSidebarCollapsedPreference({ setItem }, false)
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, '0')
  })
})
