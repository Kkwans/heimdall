import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <section className="not-found" aria-labelledby="not-found-title">
      <div className="not-found__panel">
        <div className="not-found__code" aria-hidden="true">404</div>
        <h1 id="not-found-title" className="not-found__title">页面未找到</h1>
        <p className="not-found__description">访问地址不存在，或页面已被移除。</p>
        <Link className="not-found__link" to="/">返回仪表盘</Link>
      </div>
    </section>
  )
}
