import React, { createContext, useContext, useState, useCallback } from 'react'
import type { DatePreset, DateRange } from '../types'
import { getDateRange } from './dateRange'

interface FilterContextValue {
  datePreset: DatePreset
  dateRange: DateRange
  selectedModel: string
  /** 前台刷新 tick：参数变化时递增，组件应显示 loading */
  refreshTick: number
  /** 后台刷新 tick：定时器触发时递增，组件应静默刷新（不显示 loading） */
  backgroundTick: number
  setDatePreset: (preset: DatePreset) => void
  setCustomDateRange: (range: DateRange) => void
  setSelectedModel: (model: string) => void
  /** 手动触发前台刷新 */
  triggerRefresh: () => void
  /** 触发后台静默刷新 */
  triggerBackground: () => void
}

const FilterContext = createContext<FilterContextValue | null>(null)

export function FilterProvider({ children }: { children: React.ReactNode }) {
  const [datePreset, setDatePresetState] = useState<DatePreset>('7days')
  const [dateRange, setDateRange] = useState<DateRange>(getDateRange('7days'))
  const [selectedModel, setSelectedModel] = useState<string>('all')
  const [refreshTick, setRefreshTick] = useState(0)
  const [backgroundTick, setBackgroundTick] = useState(0)

  const setDatePreset = useCallback((preset: DatePreset) => {
    if (preset !== 'custom') {
      setDatePresetState(preset)
      setDateRange(getDateRange(preset))
    } else {
      setDatePresetState('custom')
    }
  }, [])

  const setCustomDateRange = useCallback((range: DateRange) => {
    setDatePresetState('custom')
    setDateRange(range)
  }, [])

  const triggerRefresh = useCallback(() => {
    setRefreshTick(t => t + 1)
  }, [])

  const triggerBackground = useCallback(() => {
    setBackgroundTick(t => t + 1)
  }, [])

  return (
    <FilterContext.Provider value={{
      datePreset,
      dateRange,
      selectedModel,
      refreshTick,
      backgroundTick,
      setDatePreset,
      setCustomDateRange,
      setSelectedModel,
      triggerRefresh,
      triggerBackground,
    }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilter() {
  const ctx = useContext(FilterContext)
  if (!ctx) throw new Error('useFilter must be used within FilterProvider')
  return ctx
}
