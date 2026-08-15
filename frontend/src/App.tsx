import React from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { FilterProvider } from './context/FilterContext'
import Layout from './components/Layout'
import NotFound from './pages/NotFound'
import RouteFallback from './components/RouteFallback'
import PageErrorBoundary from './components/PageErrorBoundary'
import './styles/global.css'

// 页面按路由懒加载，避免首屏同步打入图表和管理页依赖。
const Dashboard = React.lazy(() => import('./pages/Dashboard'))
const Requests = React.lazy(() => import('./pages/Requests'))
const Logs = React.lazy(() => import('./pages/Logs'))
const Stats = React.lazy(() => import('./pages/Stats'))
const Admin = React.lazy(() => import('./pages/Admin'))

// Ant Design 主题配置（根据 ThemeContext 动态切换）
function AntdThemeWrapper({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme()

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#0ea5e9',
          colorSuccess: '#10b981',
          colorWarning: '#f59e0b',
          colorError: '#f43f5e',
          colorBgContainer: theme === 'dark' ? '#292524' : '#ffffff',
          colorBgElevated: theme === 'dark' ? '#3c3835' : '#ffffff',
          colorBorder: theme === 'dark' ? '#44403c' : '#e7e5e4',
          colorText: theme === 'dark' ? '#fafaf9' : '#1c1917',
          colorTextSecondary: theme === 'dark' ? '#d6d3d1' : '#57534e',
          colorTextPlaceholder: theme === 'dark' ? '#78716c' : '#a8a29e',
          borderRadius: 4,
          borderRadiusLG: 6,
          fontFamily: "'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Source Han Sans SC', system-ui, -apple-system, sans-serif",
        },
        components: {
          Card: {
            colorBgContainer: theme === 'dark' ? '#292524' : '#ffffff',
            headerBg: theme === 'dark' ? '#292524' : '#ffffff',
            colorBorderSecondary: theme === 'dark' ? '#44403c' : '#e7e5e4',
          },
          Table: {
            colorBgContainer: 'transparent',
            headerBg: theme === 'dark' ? '#1c1917' : '#f5f5f4',
            borderColor: theme === 'dark' ? '#44403c' : '#e7e5e4',
            rowHoverBg: theme === 'dark' ? '#1c1917' : '#f5f5f4',
          },
          Select: {
            colorBgContainer: theme === 'dark' ? '#292524' : '#ffffff',
            colorBgElevated: theme === 'dark' ? '#3c3835' : '#ffffff',
          },
          DatePicker: {
            colorBgContainer: theme === 'dark' ? '#292524' : '#ffffff',
          },
          Button: {
            colorBgContainer: theme === 'dark' ? '#292524' : '#ffffff',
          },
          Modal: {
            // 所有弹窗默认垂直居中（不偏上）
          },
        },
      }}
      modal={{ centered: true }}
    >
      {children}
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AntdThemeWrapper>
        <FilterProvider>
          <HashRouter>
            <Layout>
              <PageErrorBoundary>
                <React.Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/requests" element={<Requests />} />
                    <Route path="/stats" element={<Stats />} />
                    <Route path="/logs" element={<Logs />} />
                    <Route path="/admin" element={<Admin />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </React.Suspense>
              </PageErrorBoundary>
            </Layout>
          </HashRouter>
        </FilterProvider>
      </AntdThemeWrapper>
    </ThemeProvider>
  )
}
