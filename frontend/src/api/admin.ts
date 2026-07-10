import axios from 'axios'

const api = axios.create({
  baseURL: '',
  timeout: 30000,
})

// ==========================================
// 厂商管理 API
// ==========================================

export interface Provider {
  id: number
  name: string
  display_name: string
  base_url: string
  openai_url: string
  anthropic_url: string
  api_key: string
  enabled: boolean
  priority: number
  plan_type: string
  model_count: number
  created_at: string
  updated_at: string
}

export interface ProviderCreateData {
  name: string
  display_name?: string
  base_url?: string
  openai_url?: string
  anthropic_url?: string
  api_key: string
  enabled?: boolean
  priority?: number
  plan_type?: string
}

export async function fetchProviders(): Promise<{ providers: Provider[] }> {
  const { data } = await api.get('/api/providers')
  return data
}

export async function fetchProvider(id: number): Promise<Provider & { models: Model[] }> {
  const { data } = await api.get(`/api/providers/${id}`)
  return data
}

export async function createProvider(providerData: ProviderCreateData): Promise<{ id: number; message: string }> {
  const { data } = await api.post('/api/providers', providerData)
  return data
}

export async function updateProvider(id: number, providerData: Partial<ProviderCreateData>): Promise<{ message: string }> {
  const { data } = await api.put(`/api/providers/${id}`, providerData)
  return data
}

export async function deleteProvider(id: number): Promise<{ message: string }> {
  const { data } = await api.delete(`/api/providers/${id}`)
  return data
}

// ==========================================
// 厂商 API Key 管理 API（多 Key 优先级轮询）
// ==========================================

export interface ProviderApiKey {
  id: number
  provider_id: number
  api_key: string
  api_key_preview: string
  priority: number
  enabled: boolean
  last_used_at: string | null
  last_error_at: string | null
  error_count: number
  created_at: string
}

export async function fetchProviderApiKeys(providerId: number): Promise<{ keys: ProviderApiKey[] }> {
  const { data } = await api.get(`/api/providers/${providerId}/api-keys`)
  return data
}

export async function createProviderApiKey(providerId: number, keyData: { api_key: string; priority?: number }): Promise<{ id: number; message: string }> {
  const { data } = await api.post(`/api/providers/${providerId}/api-keys`, keyData)
  return data
}

export async function updateProviderApiKey(id: number, keyData: Partial<{ api_key: string; priority: number; enabled: boolean }>): Promise<{ message: string }> {
  const { data } = await api.put(`/api/provider-api-keys/${id}`, keyData)
  return data
}

export async function deleteProviderApiKey(id: number): Promise<{ message: string }> {
  const { data } = await api.delete(`/api/provider-api-keys/${id}`)
  return data
}

// ==========================================
// 模型管理 API
// ==========================================

export interface Model {
  id: number
  provider_id: number
  model_name: string
  upstream_model: string | null
  enabled: boolean
  context_window: number | null
  price_input: number
  price_output: number
  price_cache_read: number
  price_cache_write: number
  created_at: string
}

export interface ModelCreateData {
  model_name: string
  upstream_model?: string
  enabled?: boolean
  context_window?: number
  price_input?: number
  price_output?: number
  price_cache_read?: number
  price_cache_write?: number
}

export async function fetchModels(providerId: number): Promise<{ models: Model[] }> {
  const { data } = await api.get(`/api/providers/${providerId}/models`)
  return data
}

export async function createModel(providerId: number, modelData: ModelCreateData): Promise<{ id: number; message: string }> {
  const { data } = await api.post(`/api/providers/${providerId}/models`, modelData)
  return data
}

export async function updateModel(modelId: number, modelData: Partial<ModelCreateData>): Promise<{ message: string }> {
  const { data } = await api.put(`/api/models/${modelId}`, modelData)
  return data
}

export async function deleteModel(modelId: number): Promise<{ message: string }> {
  const { data } = await api.delete(`/api/models/${modelId}`)
  return data
}

// ==========================================
// API Key 管理 API
// ==========================================

export interface ApiKey {
  id: number
  key_value: string
  key_preview?: string
  name: string
  enabled: boolean
  allowed_models: string | null
  created_at: string
  last_used_at: string | null
}

export interface ApiKeyCreateData {
  name?: string
  key_value?: string
  enabled?: boolean
  allowed_models?: string
}

export async function fetchApiKeys(): Promise<{ keys: ApiKey[] }> {
  const { data } = await api.get('/api/keys')
  return data
}

export async function createApiKey(keyData: ApiKeyCreateData = {}): Promise<{ id: number; key_value: string }> {
  const { data } = await api.post('/api/keys', keyData)
  return data
}

export async function updateApiKey(id: number, keyData: Partial<ApiKeyCreateData>): Promise<{ message: string }> {
  const { data } = await api.put(`/api/keys/${id}`, keyData)
  return data
}

export async function deleteApiKey(id: number): Promise<{ message: string }> {
  const { data } = await api.delete(`/api/keys/${id}`)
  return data
}
