export type CategoryAxisRotation = 0 | 30 | 45

export interface CategoryAxisLayoutInput {
  labels: string[]
  containerWidth: number
  gridLeft?: number
  gridRight?: number
  currentBottom?: number
  hasBottomLegend?: boolean
  fontSize?: number
}

export interface CategoryAxisLayout {
  rotate: CategoryAxisRotation
  labelWidth?: number
  gridBottom: number
}

export interface DateAxisLayout {
  formatter: (value: string) => string
  interval: (index: number) => boolean
  rotate: 0
}

function estimateTextWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, character) => {
    const isWide = (character.codePointAt(0) ?? 0) > 0xff
    return width + (isWide ? fontSize : fontSize * 0.62)
  }, 0)
}

function projectedWidth(textWidth: number, lineHeight: number, degrees: number): number {
  const radians = degrees * Math.PI / 180
  return textWidth * Math.cos(radians) + lineHeight * Math.sin(radians)
}

/**
 * 根据真实容器宽度和标签长度选择分类轴角度，并为底部图例预留独立空间。
 * 仅允许 0° / 30° / 45°，避免少量数据也被固定斜排。
 */
export function getCategoryAxisLayout({
  labels,
  containerWidth,
  gridLeft = 52,
  gridRight = 20,
  currentBottom = 0,
  hasBottomLegend = false,
  fontSize = 10,
}: CategoryAxisLayoutInput): CategoryAxisLayout {
  if (labels.length === 0 || containerWidth <= 0) {
    return { rotate: 0, gridBottom: currentBottom }
  }

  const usableWidth = Math.max(containerWidth - gridLeft - gridRight, 120)
  const slotWidth = usableWidth / labels.length
  const lineHeight = Math.ceil(fontSize * 1.4)
  const longestLabel = Math.max(...labels.map(label => estimateTextWidth(label, fontSize)))
  const availableWidth = Math.max(slotWidth - 8, 16)

  let rotate: CategoryAxisRotation = 0
  if (longestLabel > availableWidth) {
    rotate = projectedWidth(longestLabel, lineHeight, 30) <= availableWidth ? 30 : 45
  }

  const renderedTextWidth = rotate === 0
    ? longestLabel
    : Math.min(longestLabel, 120)
  const radians = rotate * Math.PI / 180
  const projectedHeight = rotate === 0
    ? lineHeight
    : Math.min(
        60,
        renderedTextWidth * Math.sin(radians) + lineHeight * Math.cos(radians),
      )
  const legendSpace = hasBottomLegend ? 44 : 20
  const gridBottom = Math.ceil(Math.max(currentBottom, projectedHeight + legendSpace))
  const labelWidth = longestLabel > availableWidth
    ? Math.round(Math.min(120, Math.max(56, slotWidth * (rotate === 45 ? 2 : 1.5))))
    : undefined

  return { rotate, labelWidth, gridBottom }
}

function dateYear(value: string): string | null {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value)
  return match?.[1] ?? null
}

/**
 * 连续日期轴始终水平展示，并根据真实容器宽度抽取少量等距节点。
 * 同一年仅显示 MM-DD；跨年才保留 YYYY，避免 PC 端也被无意义年份挤占。
 */
export function getDateAxisLayout(
  labels: string[],
  containerWidth: number,
  gridLeft = 52,
  gridRight = 20,
): DateAxisLayout {
  const years = new Set(labels.map(dateYear).filter((year): year is string => year !== null))
  const crossesYear = years.size > 1
  const count = labels.length
  const usableWidth = Math.max(containerWidth - gridLeft - gridRight, 120)
  const maxLabels = Math.max(2, Math.min(8, Math.floor(usableWidth / 110) + 1))
  const visibleIndices = new Set<number>()

  if (count <= maxLabels) {
    labels.forEach((_, index) => visibleIndices.add(index))
  } else {
    for (let slot = 0; slot < maxLabels; slot += 1) {
      visibleIndices.add(Math.round(slot * (count - 1) / (maxLabels - 1)))
    }
  }

  return {
    rotate: 0,
    interval: (index: number) => visibleIndices.has(index),
    formatter: (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
      return crossesYear ? value : value.slice(5)
    },
  }
}
