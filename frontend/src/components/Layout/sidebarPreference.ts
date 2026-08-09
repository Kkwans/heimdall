export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'heimdall-sidebar-collapsed'

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

export function readSidebarCollapsedPreference(storage: StorageReader): boolean {
  const saved = storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  if (saved === '0') return false
  return true
}

export function writeSidebarCollapsedPreference(storage: StorageWriter, collapsed: boolean): void {
  storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
}
