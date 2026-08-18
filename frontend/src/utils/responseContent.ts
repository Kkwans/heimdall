export type ResponseFormat = 'json' | 'sse' | 'text'

export interface SseFrame {
  index: number
  raw: string
  event: unknown | null
}

export interface ResponseDisplay {
  format: ResponseFormat
  rawText: string
  parsed: unknown | null
  frames: SseFrame[]
  renderedText: string
  reasoningText: string
}

export interface RequestDisplay {
  format: 'json' | 'text'
  rawText: string
  parsed: unknown | null
  renderedText: string
  excludedSystemCount: number
}

/** Preserve intentional single line breaks without disabling Markdown parsing. */
export function normalizeMarkdownForDisplay(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  return lines.map((line, index) => {
    const fence = /^\s*(```|~~~)/.test(line)
    const result = inFence || fence || index === lines.length - 1 || line.trim() === '' || lines[index + 1]?.trim() === ''
      ? line
      : `${line}  `
    if (fence) inFence = !inFence
    return result
  }).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyRaw(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function textFromPart(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFromPart).join('')
  if (!isRecord(value)) return ''

  if (typeof value.text === 'string') return value.text
  if (typeof value.output_text === 'string') return value.output_text
  if ('content' in value) return textFromPart(value.content)
  return ''
}

function contentFromObject(value: Record<string, unknown>): string {
  const direct = [value.output_text, value.content, value.text]
    .map(textFromPart)
    .find(Boolean)
  if (direct) return direct

  if (isRecord(value.message)) {
    const messageText = textFromPart(value.message.content)
    if (messageText) return messageText
  }

  if (Array.isArray(value.choices)) {
    const choicesText = value.choices.map(choice => {
      if (!isRecord(choice)) return ''
      const delta = isRecord(choice.delta) ? textFromPart(choice.delta.content) : ''
      const message = isRecord(choice.message) ? textFromPart(choice.message.content) : ''
      return delta || message || textFromPart(choice.text) || textFromPart(choice.content)
    }).join('')
    if (choicesText) return choicesText
  }

  if (Array.isArray(value.output)) {
    const outputText = value.output.map(textFromPart).join('')
    if (outputText) return outputText
  }

  return ''
}

function roleOf(value: unknown): string {
  return isRecord(value) && typeof value.role === 'string' ? value.role.toLowerCase() : ''
}

function userMessageText(value: unknown): string {
  if (!isRecord(value)) return textFromPart(value)
  return textFromPart(value.content ?? value.input ?? value.text ?? value.output_text)
}

function extractUserMessages(values: unknown[]): { text: string; excludedSystemCount: number } {
  const userTexts: string[] = []
  const fallbackTexts: string[] = []
  let excludedSystemCount = 0

  values.forEach(value => {
    const role = roleOf(value)
    const text = userMessageText(value)
    if (role === 'system' || role === 'developer') {
      if (text.trim()) excludedSystemCount += 1
      return
    }
    if (role === 'user') {
      if (text.trim()) userTexts.push(text.trim())
      return
    }
    if (text.trim()) fallbackTexts.push(text.trim())
  })

  const selected = userTexts.length > 0 ? userTexts : fallbackTexts
  return { text: selected.join('\n\n'), excludedSystemCount }
}

/**
 * Extract the user-visible input from the common Chat, Anthropic Messages and
 * Responses request shapes while keeping the original request available.
 * System/developer messages are deliberately excluded from the rendered view.
 */
export function extractRequestDisplay(data: unknown): RequestDisplay {
  const rawText = stringifyRaw(data)
  const parsed = typeof data === 'string' ? parseJson(data) : data ?? null
  if (parsed == null || !isRecord(parsed)) {
    return {
      format: 'text',
      rawText,
      parsed,
      renderedText: typeof data === 'string' ? data : '',
      excludedSystemCount: 0,
    }
  }

  let renderedText = ''
  let excludedSystemCount = 0
  if (Array.isArray(parsed.messages)) {
    const extracted = extractUserMessages(parsed.messages)
    renderedText = extracted.text
    excludedSystemCount = extracted.excludedSystemCount
  }

  if (!renderedText && Array.isArray(parsed.input)) {
    const extracted = extractUserMessages(parsed.input)
    renderedText = extracted.text
    excludedSystemCount += extracted.excludedSystemCount
  }

  if (!renderedText && typeof parsed.input === 'string') renderedText = parsed.input
  if (!renderedText && typeof parsed.prompt === 'string') renderedText = parsed.prompt
  if (!renderedText && typeof parsed.query === 'string') renderedText = parsed.query

  if (parsed.system != null && textFromPart(parsed.system).trim()) excludedSystemCount += 1

  return {
    format: 'json',
    rawText,
    parsed,
    renderedText,
    excludedSystemCount,
  }
}

function reasoningFromObject(value: Record<string, unknown>): string {
  const direct = textFromPart(value.reasoning_content) || textFromPart(value.thinking)
  if (direct) return direct

  if (isRecord(value.message)) {
    const messageReasoning = textFromPart(value.message.reasoning_content) || textFromPart(value.message.thinking)
    if (messageReasoning) return messageReasoning
  }

  if (Array.isArray(value.choices)) {
    const choicesReasoning = value.choices.map(choice => {
      if (!isRecord(choice)) return ''
      const delta = isRecord(choice.delta) ? textFromPart(choice.delta.reasoning_content) : ''
      const message = isRecord(choice.message) ? textFromPart(choice.message.reasoning_content) : ''
      return delta || message
    }).join('')
    if (choicesReasoning) return choicesReasoning
  }

  return ''
}

function parseJson(raw: string): unknown | null {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseSseFrames(raw: string): SseFrame[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const dataLines = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
      const payload = dataLines.join('\n')
      return {
        index,
        raw: block,
        event: payload === '[DONE]' ? null : parseJson(payload),
      }
    })
}

function streamTextFromEvent(event: Record<string, unknown>): { content: string; reasoning: string } {
  const choices = Array.isArray(event.choices) ? event.choices : []
  const chatContent = choices.map(choice => {
    if (!isRecord(choice)) return { content: '', reasoning: '' }
    const delta = isRecord(choice.delta) ? choice.delta : {}
    return {
      content: textFromPart(delta.content) || textFromPart(choice.text),
      reasoning: textFromPart(delta.reasoning_content),
    }
  })

  const eventType = typeof event.type === 'string' ? event.type : ''
  const responseContent = eventType.includes('output_text')
    ? textFromPart(event.delta) || textFromPart(event.text) || textFromPart(event.content)
    : ''
  const anthropicContent = eventType === 'content_block_delta' || isRecord(event.delta)
    ? textFromPart(isRecord(event.delta) ? event.delta.text : '')
    : ''

  return {
    content: [
      ...chatContent.map(item => item.content),
      responseContent,
      anthropicContent,
    ].join(''),
    reasoning: chatContent.map(item => item.reasoning).join('') || textFromPart(event.reasoning_content),
  }
}

export function extractResponseDisplay(data: unknown, isStream: boolean): ResponseDisplay {
  const rawText = stringifyRaw(data)
  const parsed = typeof data === 'string' ? parseJson(data) : data ?? null
  const looksLikeSse = isStream && typeof data === 'string' && /^\s*(?:event:|data:)/m.test(data)
  const format: ResponseFormat = parsed != null ? 'json' : looksLikeSse ? 'sse' : 'text'

  if (format === 'sse') {
    const frames = parseSseFrames(rawText)
    let renderedText = ''
    let reasoningText = ''
    for (const frame of frames) {
      if (!isRecord(frame.event)) continue
      const extracted = streamTextFromEvent(frame.event)
      renderedText += extracted.content
      reasoningText += extracted.reasoning
    }
    return { format, rawText, parsed: null, frames, renderedText, reasoningText }
  }

  if (format === 'json' && isRecord(parsed)) {
    return {
      format,
      rawText,
      parsed,
      frames: [],
      renderedText: contentFromObject(parsed),
      reasoningText: reasoningFromObject(parsed),
    }
  }

  return {
    format,
    rawText,
    parsed,
    frames: [],
    renderedText: typeof data === 'string' ? data : '',
    reasoningText: '',
  }
}
