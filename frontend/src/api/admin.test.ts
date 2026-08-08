import { describe, expect, it } from 'vitest'

import { getApiErrorMessage } from './admin'


describe('getApiErrorMessage', () => {
  it('优先显示服务端可操作错误', () => {
    const error = {
      isAxiosError: true,
      response: { data: { error: '厂商名称已存在' } },
    }

    expect(getApiErrorMessage(error, '保存失败')).toBe('厂商名称已存在')
  })

  it('请求超时时返回中文提示', () => {
    const error = {
      isAxiosError: true,
      code: 'ECONNABORTED',
    }

    expect(getApiErrorMessage(error, '保存失败')).toBe('请求超时，请稍后重试')
  })

  it('未知错误使用调用方提供的回退提示', () => {
    expect(getApiErrorMessage(new Error('unknown'), '保存失败')).toBe('保存失败')
  })
})
