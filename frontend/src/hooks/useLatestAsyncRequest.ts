import { useCallback, useEffect, useRef } from 'react'

export interface AsyncRequestToken {
  sequence: number
  foregroundSequence: number
}

/**
 * Keep asynchronous page data ordered without making background refreshes
 * toggle the foreground loading state. A response started before a newer
 * request is ignored, so quick date/model changes cannot paint stale charts.
 */
export function useLatestAsyncRequest() {
  const sequenceRef = useRef(0)
  const foregroundSequenceRef = useRef(0)

  const begin = useCallback((silent = false): AsyncRequestToken => {
    const sequence = ++sequenceRef.current
    if (!silent) foregroundSequenceRef.current = sequence
    return {
      sequence,
      foregroundSequence: foregroundSequenceRef.current,
    }
  }, [])

  const isCurrent = useCallback(
    (token: AsyncRequestToken) => token.sequence === sequenceRef.current,
    [],
  )

  const isForegroundCurrent = useCallback(
    (token: AsyncRequestToken) => token.foregroundSequence === foregroundSequenceRef.current,
    [],
  )

  useEffect(() => () => {
    sequenceRef.current += 1
    foregroundSequenceRef.current += 1
  }, [])

  return { begin, isCurrent, isForegroundCurrent }
}
