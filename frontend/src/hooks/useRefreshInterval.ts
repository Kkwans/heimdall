/**
 * useRefreshInterval — 刷新间隔管理 Hook
 *
 * 功能：
 * - 管理自动刷新的时间间隔（30s / 60s / 300s / 0=关闭）
 * - 提供倒计时显示（countdown）
 * - 将用户设置持久化到 localStorage
 * - 每次计时到期时调用 onTick 回调
 *
 * Feature: heimdall-v4, Property 3: 刷新间隔 Round-Trip
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export const REFRESH_INTERVAL_KEY = 'heimdall_refresh_interval'

export const INTERVAL_OPTIONS = [
  { label: '3秒', value: 3 },
  { label: '10秒', value: 10 },
  { label: '30秒', value: 30 },
  { label: '1分钟', value: 60 },
  { label: '5分钟', value: 300 },
  { label: '关闭', value: 0 },
] as const

function readFromStorage(): number {
  try {
    const v = localStorage.getItem(REFRESH_INTERVAL_KEY)
    if (v !== null) {
    const n = parseInt(v, 10)
    if (!isNaN(n) && [0, 3, 10, 30, 60, 300].includes(n)) return n
    }
  } catch {
    // localStorage 不可用，降级为内存
  }
  return 0 // 默认关闭自动刷新
}

function writeToStorage(val: number): void {
  try {
    localStorage.setItem(REFRESH_INTERVAL_KEY, String(val))
  } catch {
    // ignore
  }
}

interface UseRefreshIntervalOptions {
  /** 每次计时到期时调用（触发后台静默刷新） */
  onTick: () => void
}

interface UseRefreshIntervalReturn {
  /** 当前间隔秒数（0 = 关闭） */
  intervalSec: number
  /** 更新间隔（并持久化） */
  setIntervalSec: (v: number) => void
  /** 倒计时剩余秒数（intervalSec=0 时为 0） */
  countdown: number
  /** 手动重置倒计时 */
  resetCountdown: () => void
}

export function useRefreshInterval({ onTick }: UseRefreshIntervalOptions): UseRefreshIntervalReturn {
  const [intervalSec, setIntervalSecState] = useState<number>(readFromStorage)
  const [countdown, setCountdown] = useState<number>(readFromStorage)

  const onTickRef = useRef(onTick)
  onTickRef.current = onTick

  const resetCountdown = useCallback(() => {
    setIntervalSecState(prev => {
      setCountdown(prev)
      return prev
    })
  }, [])

  const setIntervalSec = useCallback((v: number) => {
    writeToStorage(v)
    setIntervalSecState(v)
    setCountdown(v)
  }, [])

  // 每秒递减倒计时
  useEffect(() => {
    if (intervalSec === 0) {
      setCountdown(0)
      return
    }

    setCountdown(intervalSec)

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // 到期：触发 tick，重置计时
          onTickRef.current()
          return intervalSec
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [intervalSec])

  return { intervalSec, setIntervalSec, countdown, resetCountdown }
}
