import { useRef, useCallback } from 'react'

/**
 * 数据稳定性 hook：只在数据真正发生变化时才更新
 * 用于防止自动刷新时数据未变化却触发重渲染导致的闪烁
 *
 * 每次调用 useStableData() 返回一个 setIfChanged 函数。
 * 同一组件如果有多个数据源需要稳定化，应分别调用多次 useStableData()，
 * 或者传入 key 来隔离各自的缓存。
 */
export function useStableData<T = unknown>() {
  // Map 存储多个 key 的上一次 JSON 快照
  const cacheRef = useRef<Map<string, string>>(new Map())

  /**
   * 比较新旧数据（按 key 隔离缓存），只有数据发生变化时才调用 setter
   * @param newData 新数据
   * @param setter  React setState 函数
   * @param key     隔离标识，同一组件多处调用时用不同 key 区分（默认 'default'）
   */
  const setIfChanged = useCallback(<D>(newData: D, setter: (v: D) => void, key = 'default') => {
    const newJson = JSON.stringify(newData)
    const prev = cacheRef.current.get(key) ?? ''
    if (newJson !== prev) {
      cacheRef.current.set(key, newJson)
      setter(newData)
    }
  }, [])

  return { setIfChanged }
}
