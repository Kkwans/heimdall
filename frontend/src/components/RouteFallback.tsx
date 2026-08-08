export default function RouteFallback() {
  return (
    <div className="route-skeleton" role="status" aria-live="polite" aria-label="页面加载中">
      <span className="sr-only">页面加载中</span>
      <div className="route-skeleton__header" aria-hidden="true" />
      <div className="route-skeleton__grid" aria-hidden="true">
        <div className="route-skeleton__card" />
        <div className="route-skeleton__card" />
        <div className="route-skeleton__card" />
      </div>
      <div className="route-skeleton__line" aria-hidden="true" />
    </div>
  )
}
