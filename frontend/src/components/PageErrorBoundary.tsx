import React from 'react'
import { useLocation } from 'react-router-dom'

interface BoundaryState {
  hasError: boolean
}

class Boundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { hasError: false }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[PageErrorBoundary] 页面渲染失败', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <section className="not-found" aria-labelledby="page-error-title">
        <div className="not-found__panel">
          <div className="not-found__code" aria-hidden="true">!</div>
          <h1 id="page-error-title" className="not-found__title">页面加载失败</h1>
          <p className="not-found__description">当前页面遇到异常，其他功能仍可继续使用。</p>
          <div className="page-error__actions">
            <button type="button" className="not-found__link page-error__button" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <a className="not-found__link page-error__secondary" href="#/">返回仪表盘</a>
          </div>
        </div>
      </section>
    )
  }
}

export default function PageErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  return <Boundary key={location.pathname}>{children}</Boundary>
}
