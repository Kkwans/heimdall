import { useEffect, useState } from 'react'

/**
 * Delay a foreground loading indicator so fast requests do not flash an
 * overlay. Once visible, it is cleared on the next tick when the request
 * finishes, keeping the existing content stable while slow requests load.
 */
export function useDelayedLoading(active: boolean, delay = 180): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(active), active ? delay : 0)
    return () => window.clearTimeout(timer)
  }, [active, delay])

  return visible
}
