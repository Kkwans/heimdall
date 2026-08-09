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
