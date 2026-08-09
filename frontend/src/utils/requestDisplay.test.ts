import { describe, expect, it } from 'vitest'
import { formatRequestType } from './requestDisplay'

describe('formatRequestType', () => {
  it('labels streaming requests as SSE', () => {
    expect(formatRequestType(true)).toBe('SSE 流式')
    expect(formatRequestType(1)).toBe('SSE 流式')
  })

  it('labels non-streaming requests as JSON', () => {
    expect(formatRequestType(false)).toBe('JSON 非流式')
    expect(formatRequestType(0)).toBe('JSON 非流式')
  })
})
