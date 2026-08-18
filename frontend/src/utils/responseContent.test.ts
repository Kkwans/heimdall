import { describe, expect, it } from 'vitest'
import { extractRequestDisplay, extractResponseDisplay, normalizeMarkdownForDisplay, parseSseFrames } from './responseContent'

describe('response content extraction', () => {
  it('extracts the rendered message from an OpenAI JSON response', () => {
    const result = extractResponseDisplay({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: '你好，世界' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }, false)

    expect(result.format).toBe('json')
    expect(result.renderedText).toBe('你好，世界')
    expect(result.rawText).toContain('chatcmpl-test')
  })

  it('extracts visible text from OpenAI SSE while retaining raw frames', () => {
    const raw = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      'data: [DONE]',
    ].join('\n\n')

    const result = extractResponseDisplay(raw, true)
    expect(result.format).toBe('sse')
    expect(result.renderedText).toBe('你好，世界')
    expect(result.frames).toHaveLength(4)
    expect(result.frames[3].event).toBeNull()
  })

  it('extracts Anthropic and Responses API text formats', () => {
    expect(extractResponseDisplay({ content: [{ type: 'text', text: 'Anthropic' }] }, false).renderedText)
      .toBe('Anthropic')
    expect(extractResponseDisplay({ output_text: 'Responses' }, false).renderedText)
      .toBe('Responses')
  })

  it('parses SSE data blocks without exposing event metadata as message text', () => {
    const frames = parseSseFrames('event: message_start\ndata: {"type":"message_start"}\n\ndata: [DONE]')
    expect(frames).toHaveLength(2)
    expect(frames[0].event).toEqual({ type: 'message_start' })
    expect(frames[1].event).toBeNull()
  })

  it('extracts user input while excluding system and developer messages', () => {
    const result = extractRequestDisplay({
      model: 'demo',
      messages: [
        { role: 'system', content: 'internal instructions' },
        { role: 'developer', content: 'developer instructions' },
        { role: 'user', content: '第一行\n第二行' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    })

    expect(result.renderedText).toBe('继续')
    expect(result.excludedSystemCount).toBe(2)
    expect(result.rawText).toContain('internal instructions')
  })

  it('extracts Responses input items and keeps plain text requests usable', () => {
    expect(extractRequestDisplay({
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'hidden' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'visible' }] },
      ],
    }).renderedText).toBe('visible')

    expect(extractRequestDisplay('plain request').renderedText).toBe('plain request')
  })

  it('只展示带时间上下文中的最后一条用户消息，并格式化为北京时间', () => {
    const result = extractRequestDisplay({
      messages: [{
        role: 'user',
        content: '[Tue 2026-08-18 01:00 GMT+8] 旧消息\n[Tue 2026-08-18 03:00 GMT+8] 最新消息',
      }],
    })

    expect(result.renderedText).toBe('最新消息')
    expect(result.timestampText).toBe('2026-08-18 03:00:00')
  })

  it('从同一条上下文消息中取最后一个 User 项', () => {
    const result = extractRequestDisplay({
      messages: [{
        role: 'user',
        content: '历史上下文\n- User: 第一条\n- Assistant: 回复\n- User: 请只回复 OK',
      }],
    })

    expect(result.renderedText).toBe('请只回复 OK')
  })

  it('preserves intentional line breaks without changing fenced Markdown', () => {
    const normalized = normalizeMarkdownForDisplay('第一行\n第二行\n\n```text\n原样\n内容\n```')
    expect(normalized).toContain('第一行  \n第二行')
    expect(normalized).toContain('原样\n内容')
  })
})
