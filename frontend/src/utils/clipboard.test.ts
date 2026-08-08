import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('优先使用 Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await copyText('heimdall')

    expect(writeText).toHaveBeenCalledWith('heimdall')
  })

  it('Clipboard API 不可用时回退并清理临时节点', async () => {
    const remove = vi.fn()
    const textarea = {
      value: '',
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove,
    }
    const appendChild = vi.fn()
    const execCommand = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue(textarea),
      body: { appendChild },
      execCommand,
    })

    await copyText('日志内容')

    expect(textarea.value).toBe('日志内容')
    expect(textarea.select).toHaveBeenCalledOnce()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(remove).toHaveBeenCalledOnce()
  })
})
