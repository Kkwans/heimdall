import { describe, expect, it } from 'vitest'
import { extractResponseDisplay, parseSseFrames } from './responseContent'

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
})
