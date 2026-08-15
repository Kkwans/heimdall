import { useEffect, useState } from 'react'

function readMatch(query: string): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') return window.matchMedia(query).matches
  // 兼容不提供 matchMedia 的测试环境；生产浏览器走标准 MediaQueryList。
  const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1]
  return maxWidth ? window.innerWidth <= Number(maxWidth) : false
}

/** Subscribe to one media query without scattering resize listeners. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatch(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener?.('change', onChange)
    // Safari < 14 compatibility.
    if (!media.addEventListener) media.addListener(onChange)
    return () => {
      media.removeEventListener?.('change', onChange)
      if (!media.removeEventListener) media.removeListener(onChange)
    }
  }, [query])

  return matches
}

export const useIsMobile = () => useMediaQuery('(max-width: 768px)')
