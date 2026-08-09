import React from 'react'

interface TableSkeletonProps {
  columns?: number
  rows?: number
  compact?: boolean
}

function SkeletonBlock({ className = '', width }: { className?: string; width?: string }) {
  return <span className={`hd-skeleton__block ${className}`} style={width ? { width } : undefined} />
}

export function TableSkeleton({ columns = 6, rows = 7, compact = false }: TableSkeletonProps) {
  const template = `repeat(${columns}, minmax(56px, 1fr))`
  return (
    <div className={`hd-skeleton hd-table-skeleton ${compact ? 'hd-table-skeleton--compact' : ''}`} role="status" aria-live="polite" aria-label="表格加载中">
      <span className="sr-only">表格加载中…</span>
      <div className="hd-table-skeleton__row hd-table-skeleton__head" style={{ gridTemplateColumns: template }} aria-hidden="true">
        {Array.from({ length: columns }, (_, index) => (
          <SkeletonBlock key={`head-${index}`} width={index === 0 ? '68%' : '52%'} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div className="hd-table-skeleton__row" style={{ gridTemplateColumns: template }} aria-hidden="true" key={`row-${rowIndex}`}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <SkeletonBlock
              key={`cell-${rowIndex}-${columnIndex}`}
              width={`${48 + ((rowIndex * 17 + columnIndex * 11) % 38)}%`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div className="hd-skeleton hd-detail-skeleton" role="status" aria-live="polite" aria-label="详情加载中">
      <span className="sr-only">详情加载中…</span>
      <div className="hd-detail-skeleton__tabs" aria-hidden="true">
        <SkeletonBlock width="48px" />
        <SkeletonBlock width="72px" />
        <SkeletonBlock width="72px" />
      </div>
      {Array.from({ length: 4 }, (_, sectionIndex) => (
        <section className="hd-detail-skeleton__section" aria-hidden="true" key={`section-${sectionIndex}`}>
          <SkeletonBlock className="hd-detail-skeleton__title" width="72px" />
          <div className="hd-detail-skeleton__grid">
            {Array.from({ length: sectionIndex === 0 ? 3 : 6 }, (_, itemIndex) => (
              <div className="hd-detail-skeleton__item" key={`item-${sectionIndex}-${itemIndex}`}>
                <SkeletonBlock width="48px" />
                <SkeletonBlock width={`${56 + ((sectionIndex + itemIndex) % 3) * 14}%`} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function LogSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="hd-skeleton hd-log-skeleton" role="status" aria-live="polite" aria-label="日志加载中">
      <span className="sr-only">日志加载中…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="hd-log-skeleton__row" aria-hidden="true" key={`log-${index}`}>
          <SkeletonBlock width="152px" />
          <SkeletonBlock width="46px" />
          <SkeletonBlock width={`${44 + (index % 4) * 11}%`} />
        </div>
      ))}
    </div>
  )
}
