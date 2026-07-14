import axios from 'axios'
import type {
  OverviewData,
  DailyData,
  ModelData,
  RequestsResponse,
  LatencyBucket,
  ModelStats,
  ErrorAnalysis,
  HourlyStat,
  RequestRecord,
  ProviderStats,
} from '../types'

const api = axios.create({
  baseURL: '',
  timeout: 30000,
})

interface DateParams {
  start_date?: string
  end_date?: string
}

export async function fetchOverview(params: DateParams): Promise<OverviewData> {
  const { data } = await api.get('/api/stats/overview', { params })
  return data
}

export async function fetchDaily(params: DateParams): Promise<{ data: DailyData[] }> {
  const { data } = await api.get('/api/stats/daily', { params })
  return data
}

export async function fetchModels(params: DateParams): Promise<{ data: ModelData[] }> {
  const { data } = await api.get('/api/stats/models', { params })
  return data
}

export async function fetchRequests(params: {
  page?: number
  page_size?: number
  model?: string
  date?: string
  start_date?: string
  end_date?: string
  status?: string
  /** v4：后端全量排序字段 */
  sort_by?: string
  /** v4：排序方向 'asc' | 'desc' */
  sort_order?: string
}): Promise<RequestsResponse> {
  const { data } = await api.get('/api/stats/requests', { params })
  return data
}

export async function fetchLatencyDistribution(params: {
  start_date?: string
  end_date?: string
  model?: string
}): Promise<{ data: LatencyBucket[] }> {
  const { data } = await api.get('/api/stats/latency_distribution', { params })
  return data
}

export async function fetchModelList(): Promise<{ data: string[] }> {
  const { data } = await api.get('/api/stats/models/list')
  return data
}

/**
 * 创建实时日志流（SSE，仅用于今天的实时追踪）
 * @param logFile - 'business'（默认）或 'system'
 * @param lines   - 初始加载最后 N 行（默认 200）
 */
export function createLogsStream(logFile: 'business' | 'system' = 'business', lines = 200): EventSource {
  return new EventSource(`/api/logs/stream?log_file=${logFile}&lines=${lines}`)
}

/**
 * 获取可查询的日志日期列表
 */
export async function fetchLogsDates(logFile: 'business' | 'system' = 'business'): Promise<{ data: string[] }> {
  const { data } = await api.get('/api/logs/dates', { params: { log_file: logFile } })
  return data
}

/**
 * 查询指定日期的历史日志（HTTP，非 SSE）
 */
export async function fetchLogsHistory(params: {
  log_file?: 'business' | 'system'
  date: string
  lines?: number
}): Promise<{ lines: string[]; date: string; total: number; empty_file?: boolean }> {
  const { data } = await api.get('/api/logs/history', {
    params: {
      log_file: params.log_file ?? 'business',
      date: params.date,
      lines: params.lines ?? 200,
    },
  })
  return data
}

/**
 * 查询日志保留天数配置
 */
export async function fetchLogsConfig(): Promise<{ retention_days: number }> {
  const { data } = await api.get('/api/logs/config')
  return data
}

/**
 * 更新日志保留天数配置（1-365 天）
 */
export async function updateLogsConfig(retention_days: number): Promise<{ success: boolean; retention_days?: number; message?: string }> {
  const { data } = await api.put('/api/logs/config', { retention_days })
  return data
}

// ==========================================
// v3 新增 API 函数
// ==========================================

/**
 * 按模型聚合的详细统计数据
 */
export async function fetchModelStats(params: {
  start_date?: string
  end_date?: string
}): Promise<{ data: ModelStats[] }> {
  const { data } = await api.get('/api/stats/by-model', { params })
  return data
}

/**
 * 错误类型聚合统计
 */
export async function fetchErrorAnalysis(params: {
  start_date?: string
  end_date?: string
}): Promise<{ data: ErrorAnalysis[] }> {
  const { data } = await api.get('/api/stats/error-analysis', { params })
  return data
}

/**
 * 按小时分布统计（默认今天）
 */
export async function fetchHourly(date?: string): Promise<{ data: HourlyStat[]; date: string }> {
  const { data } = await api.get('/api/stats/hourly', { params: date ? { date } : {} })
  return data
}

/**
 * 获取单条请求的完整详情（含 request_body / response_body）
 */
export async function fetchRequestDetail(id: number): Promise<RequestRecord> {
  const { data } = await api.get(`/api/stats/request/${id}/detail`)
  return data
}

// ==========================================
// v3 新增：厂商维度统计 API
// ==========================================

/**
 * 按厂商聚合的统计数据
 */
export async function fetchProviderStats(params: {
  start_date?: string
  end_date?: string
}): Promise<{ data: ProviderStats[] }> {
  const { data } = await api.get('/api/stats/by-provider', { params })
  return data
}

// ==========================================
// v4 新增：APIKey 统计 API
// ==========================================

export interface ApiKeyStat {
  api_key_id: number | null
  api_key_name: string
  total_requests: number
  success_requests: number
  error_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_cache_hit_tokens: number
  total_reasoning_tokens: number
  avg_latency_ms: number
}

export interface ApiKeyModelStat {
  api_key_id: number | null
  api_key_name: string
  model: string
  request_count: number
  total_tokens: number
  avg_latency_ms: number
}

export async function fetchApiKeyStats(params: DateParams): Promise<{ data: ApiKeyStat[] }> {
  const { data } = await api.get('/api/stats/api-keys', { params })
  return data
}

export async function fetchApiKeyModelStats(params: DateParams): Promise<{ data: ApiKeyModelStat[] }> {
  const { data } = await api.get('/api/stats/api-keys/models', { params })
  return data
}
