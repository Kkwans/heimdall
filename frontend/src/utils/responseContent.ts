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
  /** 从 Agent/客户端包装文本中提取的最新消息时间（北京时间）。 */
  timestampText?: string
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

interface LatestUserInput {
  text: string
  timestampText?: string
}

const TIMESTAMP_PATTERN = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?(?:\s+GMT([+-])(\d{1,2})(?::?(\d{2}))?)?\]\s*/gi

function formatBeijingTimestamp(match: RegExpExecArray): string {
  const datePart = match[1]
  const timePart = match[2]
  const seconds = match[3] ?? '00'
  const sign = match[4]
  const hours = match[5]
  const minutes = match[6] ?? '00'
  if (!sign || !hours) return `${datePart} ${timePart}:${seconds}`

  const offset = `${sign}${hours.padStart(2, '0')}:${minutes}`
  const parsed = new Date(`${datePart}T${timePart}:${seconds}${offset}`)
  if (Number.isNaN(parsed.getTime())) return `${datePart} ${timePart}:${seconds}`

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`
}

function latestTimestampedSegment(text: string): LatestUserInput {
  const matches: Array<{ match: RegExpExecArray; start: number; end: number }> = []
  TIMESTAMP_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TIMESTAMP_PATTERN.exec(text)) !== null) {
    matches.push({ match, start: match.index, end: TIMESTAMP_PATTERN.lastIndex })
  }
  TIMESTAMP_PATTERN.lastIndex = 0
  if (matches.length === 0) return { text: text.trim() }

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const current = matches[index]
    const end = index + 1 < matches.length ? matches[index + 1].start : text.length
    const segment = text.slice(current.end, end).trim()
    if (segment) {
      return {
        text: segment,
        timestampText: formatBeijingTimestamp(current.match),
      }
    }
  }
  const last = matches[matches.length - 1]
  return {
    text: '',
    timestampText: formatBeijingTimestamp(last.match),
  }
}

/**
 * AgentHub 等客户端可能把多轮上下文包装进同一条 user 消息。
 * 在已经选出的最新时间段内，只取最后一条显式 User: 项，避免把历史上下文
 * 当成当前输入；只有存在多条时才启用该启发式，避免误伤普通 Markdown。
 */
function extractLatestNestedUserText(text: string): string {
  const matches = Array.from(text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?User:\s*([\s\S]*?)(?=\n\s*(?:[-*]\s*)?(?:User|Assistant|System|Developer):\s*|$)/gi))
  if (matches.length < 2) return text.trim()
  return (matches[matches.length - 1][1] ?? '').trim()
}

function extractLatestUserInput(text: string): LatestUserInput {
  const segmented = latestTimestampedSegment(text)
  const nested = extractLatestNestedUserText(segmented.text)
  return {
    text: nested,
    timestampText: segmented.timestampText,
  }
}

function extractUserMessages(values: unknown[]): { text: string; excludedSystemCount: number; timestampText?: string } {
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
  const latest = selected.length > 0 ? extractLatestUserInput(selected[selected.length - 1]) : { text: '' }
  return { text: latest.text, timestampText: latest.timestampText, excludedSystemCount }
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
    const latest = typeof data === 'string' ? extractLatestUserInput(data) : { text: '' }
    return {
      format: 'text',
      rawText,
      parsed,
      renderedText: latest.text,
      excludedSystemCount: 0,
      timestampText: latest.timestampText,
    }
  }

  let renderedText = ''
  let excludedSystemCount = 0
  let timestampText: string | undefined
  if (Array.isArray(parsed.messages)) {
    const extracted = extractUserMessages(parsed.messages)
    renderedText = extracted.text
    timestampText = extracted.timestampText
    excludedSystemCount = extracted.excludedSystemCount
  }

  if (!renderedText && Array.isArray(parsed.input)) {
    const extracted = extractUserMessages(parsed.input)
    renderedText = extracted.text
    timestampText = extracted.timestampText
    excludedSystemCount += extracted.excludedSystemCount
  }

  if (!renderedText && typeof parsed.input === 'string') {
    const latest = extractLatestUserInput(parsed.input)
    renderedText = latest.text
    timestampText = latest.timestampText
  }
  if (!renderedText && typeof parsed.prompt === 'string') {
    const latest = extractLatestUserInput(parsed.prompt)
    renderedText = latest.text
    timestampText = latest.timestampText
  }
  if (!renderedText && typeof parsed.query === 'string') {
    const latest = extractLatestUserInput(parsed.query)
    renderedText = latest.text
    timestampText = latest.timestampText
  }

  if (parsed.system != null && textFromPart(parsed.system).trim()) excludedSystemCount += 1

  return {
    format: 'json',
    rawText,
    parsed,
    renderedText,
    excludedSystemCount,
    timestampText,
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
