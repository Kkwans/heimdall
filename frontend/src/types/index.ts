export interface OverviewData {
  total_requests: number
  success_requests: number
  error_requests: number
  total_tokens: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_cache_hit_tokens: number
  cache_hit_rate: number
  avg_latency_ms: number
  p50_latency_ms: number
  p90_latency_ms: number
  p99_latency_ms: number
}

export interface DailyData {
  date: string
  total_requests: number
  success_requests: number
  error_requests: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  cache_hit_tokens: number
  avg_latency_ms: number
  cache_hit_rate: number
}

export interface ModelData {
  model: string
  total_requests: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  cache_hit_tokens: number
  avg_latency_ms: number
  cache_hit_rate: number
  success_rate: number
}

export interface RequestRecord {
  id: number
  created_at: string
  date: string
  model: string
  original_model: string
  stream: number
  messages_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  reasoning_tokens: number
  latency_ms: number
  ttfb_ms: number
  status_code: number
  success: number
  error_type: string | null
  trace_id: string | null
  client_ip: string | null
  // v4: APIKey 关联
  api_key_id?: number | null
  api_key_name?: string | null
  // v3: 详情字段（从 /api/stats/request/:id/detail 获取）
  request_body?: object | null
  response_body?: object | null
}

export interface RequestsResponse {
  total: number
  page: number
  page_size: number
  items: RequestRecord[]
}

export interface LatencyBucket {
  label: string
  count: number
}

export type DatePreset = 'today' | '7days' | '30days' | 'all' | 'custom'

export interface DateRange {
  start: string | undefined
  end: string | undefined
}

// v3 新增类型

export interface ModelStats {
  model: string
  total_requests: number
  success_requests: number
  error_requests: number
  stream_requests: number
  non_stream_requests: number
  success_rate: number
  avg_total_latency_ms: number
  avg_ttfb_ms: number | null
  avg_output_ms: number | null
  avg_prompt_tokens: number
  avg_completion_tokens: number
  avg_total_tokens: number
  total_tokens: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_cache_hit_tokens: number
  avg_cache_hit_rate: number
  p50_latency_ms: number
  p90_latency_ms: number
  p99_latency_ms: number
}

export interface ErrorAnalysis {
  status_code: number
  count: number
  pct: number
  models: string[]
}

export interface HourlyStat {
  hour: number
  total_requests: number
  success_requests: number
  error_requests: number
  total_tokens: number
  avg_latency_ms: number
}

// v3 新增：厂商维度统计
export interface ProviderStats {
  provider: string
  total_requests: number
  success_requests: number
  error_requests: number
  stream_requests: number
  avg_total_latency_ms: number
  avg_ttfb_ms: number | null
  avg_output_ms: number | null
  total_tokens: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_cache_hit_tokens: number
  avg_total_tokens: number
  cache_hit_rate: number
  success_rate: number
  models: string[]
  p50_latency_ms: number
  p90_latency_ms: number
  p99_latency_ms: number
}
