export interface LogLine {
  id: number
  raw: string
  level: 'success' | 'error' | 'warning' | 'info' | 'muted'
  timeShort: string
  fullTime: string
  levelTag: string
  body: string
  extra: string[]
}

let lineIdCounter = 0

export function shortenTime(full: string): string {
  const match = full.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/)
  return match ? `${match[1]} ${match[2]}` : full
}

export function parseLogLine(raw: string): LogLine {
  lineIdCounter++
  const stdMatch = raw.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?) - (\w+) - (.*)$/)

  let timeShort = ''
  let fullTime = ''
  let levelTag = ''
  let body = raw

  if (stdMatch) {
    fullTime = stdMatch[1]
    timeShort = shortenTime(fullTime)
    levelTag = stdMatch[2].toUpperCase()
    body = stdMatch[3]
  }

  let level: LogLine['level'] = 'info'
  const trimmedBody = body.trim()
  if (trimmedBody.length >= 3 && /^=+$/.test(trimmedBody)) {
    level = 'muted'
  } else if (levelTag === 'ERROR' || body.includes('Exception') || body.includes('Traceback') || body.includes('Error:')) {
    level = 'error'
  } else if (body.includes('[❌') && /5\d\d/.test(body)) {
    level = 'error'
  } else if (
    (body.includes('[⚠') && /[45]\d\d/.test(body)) ||
    (body.includes('[❌') && /4\d\d/.test(body)) ||
    levelTag === 'WARNING' || levelTag === 'WARN' ||
    (body.includes('Port') && body.includes('use')) ||
    body.includes('Address already')
  ) {
    level = 'warning'
  } else if (body.includes('[✅') || body.includes('✅') || body.startsWith('HTTP 2')) {
    level = 'success'
  } else if (trimmedBody === '') {
    level = 'muted'
  }

  return { id: lineIdCounter, raw, level, timeShort, fullTime, levelTag, body, extra: [] }
}

function isTraceContinuation(body: string, previousBody: string): boolean {
  if (!body) return false
  if (/^\s+/.test(body)) return true
  if (/^Traceback \(most recent call last\):/.test(body)) return true
  if (/^(During handling of the above exception|The above exception was the direct cause)/.test(body)) return true
  if (/^[A-Z]\w*(Error|Exception|Warning|Interrupt)(?::|$)/.test(body.trim())) return true
  if (body === ':' || body.trim() === '') return true
  if (/^[A-Z]\w+(Error|Exception|Warning|Interrupt)$/.test(previousBody.trim())) return true
  if (previousBody.trimEnd().endsWith(':') && body.length < 200) return true
  return false
}

/**
 * 每条带时间戳的日志都是独立事件。只有 Python logging 输出的无时间戳
 * traceback 续行才归入上一条错误记录。
 */
export function mergeLogLines(lines: LogLine[]): LogLine[] {
  const result: LogLine[] = []

  for (const line of lines) {
    if (line.level === 'muted') {
      result.push(line)
      continue
    }

    const last = result[result.length - 1]
    const previousBody = last?.extra.length
      ? last.extra[last.extra.length - 1]
      : last?.body ?? ''

    if (
      !line.fullTime &&
      last &&
      (last.level === 'error' || last.level === 'warning' || last.extra.length > 0) &&
      isTraceContinuation(line.body || line.raw, previousBody)
    ) {
      last.extra.push(line.body || line.raw)
      continue
    }

    result.push({ ...line, extra: [] })
  }

  return result
}

export function getLogHeaderMetadata(line: LogLine, isSystemFile = false): string[] {
  const metadata = [isSystemFile ? '系统事件' : '业务事件']
  const statusMatch = line.body.match(/\[(?:✅|⚠️|❌|💥)\s*(\d{3})\]/u)

  if (statusMatch) {
    metadata[0] = '代理请求'
    metadata.push(`HTTP ${statusMatch[1]}`)
    if (/\s〜\s*\|/.test(line.body)) metadata.push('SSE 流式')
    else if (/\s—\s*\|/.test(line.body)) metadata.push('JSON 非流式')
  }

  if (line.extra.length > 0) metadata.push(`后续 ${line.extra.length} 行`)
  return metadata
}
