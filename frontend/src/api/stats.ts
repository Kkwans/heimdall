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

export interface DashboardSummary {
  overview: OverviewData
  daily: DailyData[]
  models: ModelData[]
}

const dashboardSummaryInflight = new Map<string, Promise<DashboardSummary>>()

async function fetchDashboardSummary(params: DateParams): Promise<DashboardSummary> {
  const key = JSON.stringify(params)
  const existing = dashboardSummaryInflight.get(key)
  if (existing) return existing
  const pending = api
    .get<DashboardSummary>('/api/dashboard/summary', { params })
    .then(response => response.data)
    .finally(() => dashboardSummaryInflight.delete(key))
  dashboardSummaryInflight.set(key, pending)
  return pending
}

export async function fetchDashboardOverview(params: DateParams): Promise<OverviewData> {
  return (await fetchDashboardSummary(params)).overview
}

export async function fetchDashboardDaily(params: DateParams): Promise<{ data: DailyData[] }> {
  return { data: (await fetchDashboardSummary(params)).daily }
}

export async function fetchDashboardModels(params: DateParams): Promise<{ data: ModelData[] }> {
  return { data: (await fetchDashboardSummary(params)).models }
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

export interface CostSummary {
  total_cost: number
  currency: 'CNY'
  priced_requests: number
  price_eligible_requests: number
  coverage_rate: number
  priced_billable_tokens: number
  eligible_billable_tokens: number
  avg_cost_per_million_tokens: number | null
  historical_estimate_requests: number
}

export interface CostGroup {
  id: number | string | null
  name: string
  price_eligible_requests: number
  priced_requests: number
  total_cost: number
  billable_tokens: number
  coverage_rate: number
  avg_cost_per_million_tokens: number | null
  cost_share: number
  is_deleted: boolean
}

export interface CostStats {
  summary: CostSummary
  by_client_key: CostGroup[]
  by_model: CostGroup[]
}

export async function fetchCostStats(params: DateParams): Promise<CostStats> {
  const { data } = await api.get('/api/stats/costs', { params })
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
  protocol?: string
  stream?: string
  provider?: string
  client_key_id?: number | string
  /** v4：后端全量排序字段 */
  sort_by?: string
  /** v4：排序方向 'asc' | 'desc' */
  sort_order?: string
}): Promise<RequestsResponse> {
  const { data } = await api.get('/api/stats/requests', { params })
  return data
}

export interface RequestRetentionConfig {
  enabled: boolean
  retention_days: number
  updated_at: string | null
  last_run_at: string | null
  last_deleted_count: number
  last_deleted_body_bytes: number
  last_error: string | null
  min_days?: number
  max_days?: number
  schedule?: string
  vacuum_enabled?: boolean
  success?: boolean
  cleanup_started?: boolean
  message?: string
}

export interface RequestRetentionPreview {
  retention_days: number
  cutoff_date: string
  request_count: number
  request_body_bytes: number
  response_body_bytes: number
  total_body_bytes: number
  affected_dates: number
  daily_stats_count: number
  confirmation_token: string
  confirmation_expires_in: number
}

export async function fetchRequestRetention(): Promise<RequestRetentionConfig> {
  const { data } = await api.get('/api/requests/retention')
  return data
}

export async function previewRequestRetention(
  retention_days: number,
): Promise<RequestRetentionPreview> {
  const { data } = await api.post('/api/requests/retention/preview', { retention_days })
  return data
}

export async function updateRequestRetention(values: {
  enabled: boolean
  retention_days: number
  confirmation_token?: string
}): Promise<RequestRetentionConfig> {
  const { data } = await api.put('/api/requests/retention', values)
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

export interface RequestFilterOptions {
  providers: string[]
  protocols: string[]
  client_keys: Array<{ id: number; name: string; is_deleted: boolean }>
}

export async function fetchRequestFilterOptions(): Promise<RequestFilterOptions> {
  const { data } = await api.get<RequestFilterOptions>('/api/stats/request-filters')
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
  cursor?: number
}): Promise<{
  lines: string[]
  date: string
  total: number
  empty_file?: boolean
  has_more: boolean
  next_cursor: number | null
}> {
  const { data } = await api.get('/api/logs/history', {
    params: {
      log_file: params.log_file ?? 'business',
      date: params.date,
      lines: params.lines ?? 200,
      cursor: params.cursor ?? 0,
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
  api_key_deleted: boolean
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
  api_key_deleted: boolean
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
