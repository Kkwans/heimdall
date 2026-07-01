import React, { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import MobileDrawer from './MobileDrawer'
import RefreshModule from '../Header/RefreshModule'

// 路由 → 页面名称映射
const PAGE_NAMES: Record<string, string> = {
  '/': '仪表盘',
  '/requests': '请求明细',
  '/stats': '数据统计',
  '/logs': '实时日志',
  '/credit': 'AI Credit',
}

// 路由 → 页面专属图标映射（与 Sidebar.tsx 保持一致）
const PAGE_ICONS: Record<string, React.ReactNode> = {
  '/': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  '/requests': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="12" y2="16" />
    </svg>
  ),
  '/stats': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  ),
  '/logs': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  '/credit': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  ),
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  // 路由变化时自动关闭抽屉
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  const pageName = PAGE_NAMES[location.pathname] ?? 'Heimdall'
  const pageIcon = PAGE_ICONS[location.pathname] ?? PAGE_ICONS['/']

  return (
    <div className="layout">
      {/* 桌面端左侧边栏 */}
      <div className="layout-sidebar">
        <Sidebar />
      </div>

      {/* 内容区 */}
      <main className="layout-content">
        {/* 移动端顶部导航栏 */}
        <div className="mobile-topbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="mobile-topbar-brand">
            {pageIcon}
            <span className="mobile-topbar-title">{pageName}</span>
          </div>
          {/* 右侧：compact 刷新按钮 */}
          <RefreshModule compact />
        </div>

        {children}
      </main>

      {/* 移动端抽屉式侧边栏 */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  )
}
