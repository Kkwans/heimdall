import { describe, expect, it } from 'vitest'
import {
  getLogHeaderMetadata,
  mergeLogLines,
  parseLogLine,
  shortenTime,
} from '../utils/logDisplay'

describe('日志展示语义', () => {
  it('同一秒内的独立请求不会被合并', () => {
    const lines = mergeLogLines([
      parseLogLine('2026-08-09 00:58:10,101 - INFO - [✅ 200] [alpha] 🤖 model-a — | ⏱ 20ms'),
      parseLogLine('2026-08-09 00:58:10,812 - INFO - [✅ 200] [alpha] 🤖 model-a 〜 | ⏱ 25ms'),
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0].extra).toEqual([])
    expect(lines[1].extra).toEqual([])
  })

  it('只有无时间戳的 traceback 续行才会并入错误记录', () => {
    const lines = mergeLogLines([
      parseLogLine('2026-08-09 01:00:00,123 - ERROR - 请求失败'),
      parseLogLine('Traceback (most recent call last):'),
      parseLogLine('  File "proxy.py", line 42, in handler'),
      parseLogLine('普通无时间戳业务日志'),
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0].extra).toEqual([
      'Traceback (most recent call last):',
      '  File "proxy.py", line 42, in handler',
    ])
    expect(lines[1].body).toBe('普通无时间戳业务日志')
  })

  it('桌面摘要返回扩展元数据而不是正文副本', () => {
    const line = parseLogLine('2026-08-09 01:02:03,456 - INFO - [✅ 200] [mimo] 🤖 mimo-v2.5 〜 | ⏱ 22ms')

    expect(getLogHeaderMetadata(line)).toEqual(['代理请求', 'HTTP 200', 'SSE 流式'])
    expect(shortenTime(line.fullTime)).toBe('2026-08-09 01:02:03')
  })
})
