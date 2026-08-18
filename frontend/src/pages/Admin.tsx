/**
 * Admin.tsx — 设置页面
 *
 * 功能：
 * 1. 厂商管理（CRUD）
 * 2. 模型管理（CRUD）
 * 3. API Key 管理（CRUD）
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Table, Button, Form, Input, Switch, InputNumber, Select,
  Space, Tag, Tooltip, Popconfirm, message, Tabs, Divider, Typography
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, SaveOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { TableSkeleton } from '../components/LoadingSkeleton'
import { VendorTag, ModelTag } from '../components/CommonTag'
import { useIsMobile } from '../hooks/useMediaQuery'
import MobileTooltip from '../components/MobileTooltip'
import { getVendorColor } from '../components/Charts/chartTheme'
import Header from '../components/Header'
import AppModal from '../components/AppModal'
import { useFilter } from '../context/FilterContext'
import AdaptiveFilterSelect from '../components/AdaptiveFilterSelect'
import {
  fetchProviders, createProvider, updateProvider, deleteProvider,
  fetchModels, createModel, updateModel, deleteModel,
  fetchApiKeys, createApiKey, updateApiKey, deleteApiKey,
  copyApiKey,
  fetchProviderApiKeys, createProviderApiKey, updateProviderApiKey, deleteProviderApiKey,
  type Provider, type Model, type ApiKey, type ProviderApiKey,
  type ProviderCreateData, type ModelCreateData, type ApiKeyCreateData,
  getApiErrorMessage,
} from '../api/admin'
import { copyText } from '../utils/clipboard'

const { Text } = Typography

function showRequestError(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'errorFields' in error) return
  message.error(getApiErrorMessage(error, fallback))
}

// 厂商预设类型
interface VendorPreset {
  name: string
  plans: Record<string, { label: string; openai_url: string | null; anthropic_url: string | null }>
  default_plan: string
  models: string[]
}

interface ManagerProps {
  /** 由 Tab 工具栏触发新增，桌面端不再占用内容区一整行。 */
  addSignal?: number
  /** 移动端保留内容区内按钮，桌面端按钮放在 Tab 行右侧。 */
  showInlineAdd?: boolean
}

// ==========================================
// 厂商管理组件
// ==========================================

function ProviderManager({ addSignal = 0, showInlineAdd = true }: ManagerProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [form] = Form.useForm()
  const [vendorPresets, setVendorPresets] = useState<Record<string, VendorPreset>>({})
  const [selectedPreset, setSelectedPreset] = useState<string>('')
  const [selectedPlan, setSelectedPlan] = useState<string>('')

  // 加载厂商预设
  useEffect(() => {
    const loadPresets = async () => {
      try {
        const resp = await fetch('/api/vendor-presets')
        const data = await resp.json()
        setVendorPresets(data.vendors || {})
      } catch { /* silent */ }
    }
    loadPresets()
  }, [])

  // 选择预设后自动填充
  const handlePresetChange = (presetKey: string) => {
    setSelectedPreset(presetKey)
    if (!presetKey) {
      form.resetFields()
      return
    }
    const preset = vendorPresets[presetKey]
    if (!preset) return

    const defaultPlan = preset.default_plan
    const plan = preset.plans[defaultPlan]
    setSelectedPlan(defaultPlan)

    form.setFieldsValue({
      name: presetKey,
      display_name: preset.name,
      openai_url: plan?.openai_url || '',
      anthropic_url: plan?.anthropic_url || '',
      api_key: '',
      priority: 0,
      plan_type: defaultPlan,
    })
  }

  // 切换计费类型
  const handlePlanChange = (planKey: string) => {
    setSelectedPlan(planKey)
    const preset = vendorPresets[selectedPreset]
    if (!preset) return
    const plan = preset.plans[planKey]
    if (!plan) return
    form.setFieldsValue({
      openai_url: plan.openai_url || '',
      anthropic_url: plan.anthropic_url || '',
    })
  }

  const loadProviders = useCallback(async () => {
    setLoading(true)
    try {
      const { providers } = await fetchProviders()
      setProviders(providers)
    } catch (err) {
      showRequestError(err, '加载厂商列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const { refreshTick } = useFilter()

  useEffect(() => {
    loadProviders()
  }, [loadProviders, refreshTick])

  const handleAdd = () => {
    setEditingProvider(null)
    form.resetFields()
    setSelectedPreset('')
    setSelectedPlan('')
    setModalOpen(true)
  }

  useEffect(() => {
    if (addSignal <= 0) return
    const timer = window.setTimeout(handleAdd, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addSignal])

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider)
    // 尝试匹配预设
    const matchedPreset = Object.entries(vendorPresets).find(([key]) => key === provider.name)
    if (matchedPreset) {
      setSelectedPreset(matchedPreset[0])
      setSelectedPlan(matchedPreset[1].default_plan)
    } else {
      setSelectedPreset('')
      setSelectedPlan('')
    }
    form.setFieldsValue({
      name: provider.name,
      display_name: provider.display_name,
      openai_url: provider.openai_url || '',
      anthropic_url: provider.anthropic_url || '',
      plan_type: provider.plan_type,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteProvider(id)
      message.success('删除成功')
      loadProviders()
    } catch (err) {
      showRequestError(err, '删除失败')
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      // 验证至少填写了一个 URL
      if (!values.openai_url && !values.anthropic_url) {
        message.error('OpenAI 和 Anthropic 协议地址至少填写一个')
        return
      }
      if (editingProvider) {
        await updateProvider(editingProvider.id, values)
        message.success('更新成功')
      } else {
        await createProvider(values as ProviderCreateData)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadProviders()
    } catch (err) {
      showRequestError(err, editingProvider ? '更新厂商失败' : '创建厂商失败')
    }
  }

  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false)
  const [managingKeysProvider, setManagingKeysProvider] = useState<Provider | null>(null)
  const [providerApiKeys, setProviderApiKeys] = useState<ProviderApiKey[]>([])
  const [priorityDrafts, setPriorityDrafts] = useState<Record<number, number>>({})
  const [newApiKey, setNewApiKey] = useState('')
  const [newApiPriority, setNewApiPriority] = useState(0)

  const loadProviderApiKeys = async (providerId: number) => {
    try {
      const { keys } = await fetchProviderApiKeys(providerId)
      setProviderApiKeys(keys)
      setPriorityDrafts(Object.fromEntries(keys.map((key) => [key.id, key.priority])))
    } catch (err) {
      showRequestError(err, '加载 API Key 列表失败')
    }
  }

  const handleManageKeys = (provider: Provider) => {
    setManagingKeysProvider(provider)
    setApiKeyModalOpen(true)
    loadProviderApiKeys(provider.id)
  }

  const handleAddApiKey = async () => {
    if (!managingKeysProvider || !newApiKey) return
    try {
      await createProviderApiKey(managingKeysProvider.id, { api_key: newApiKey, priority: newApiPriority })
      message.success('API Key 添加成功')
      setNewApiKey('')
      setNewApiPriority(0)
      loadProviderApiKeys(managingKeysProvider.id)
    } catch (err) {
      showRequestError(err, '添加失败')
    }
  }

  const handleDeleteApiKey = async (id: number) => {
    if (!managingKeysProvider) return
    try {
      await deleteProviderApiKey(id)
      message.success('删除成功')
      loadProviderApiKeys(managingKeysProvider.id)
    } catch (err) {
      showRequestError(err, '删除失败')
    }
  }

  const handleToggleApiKey = async (id: number, enabled: boolean) => {
    if (!managingKeysProvider) return
    try {
      await updateProviderApiKey(id, { enabled })
      loadProviderApiKeys(managingKeysProvider.id)
    } catch (err) {
      showRequestError(err, '操作失败')
    }
  }

  const handleSaveKeyPriority = async (id: number) => {
    if (!managingKeysProvider) return
    const priority = priorityDrafts[id]
    if (priority === undefined) return
    try {
      await updateProviderApiKey(id, { priority })
      message.success('优先级已保存')
      loadProviderApiKeys(managingKeysProvider.id)
    } catch (err) {
      showRequestError(err, '更新失败')
    }
  }

  const cellCenter: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' }
  const cellCenterFixed: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center', background: 'var(--bg-surface, #fff)' }
  const isMobile = useIsMobile()

  const columns: ColumnsType<Provider> = [
    {
      title: '厂商',
      dataIndex: 'name',
      key: 'name',
      width: isMobile ? 80 : 100,
      fixed: 'left' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const, background: 'var(--bg-secondary, #f5f5f4)' } }),
      onCell: () => ({ style: cellCenterFixed }),
      render: (name: string) => {
        const vc = getVendorColor(name)
        return <VendorTag name={vc.label || name} />
      },
    },
    {
      title: '显示名',
      dataIndex: 'display_name',
      key: 'display_name',
      width: isMobile ? 80 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: 'OpenAI URL',
      dataIndex: 'openai_url',
      key: 'openai_url',
      width: isMobile ? 100 : 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string) => url ? (
        <MobileTooltip title={url}>
          <Text copyable={{ text: url }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxWidth: isMobile ? 80 : undefined }} ellipsis>
            {url}
          </Text>
        </MobileTooltip>
      ) : '-',
    },
    {
      title: 'Anthropic URL',
      dataIndex: 'anthropic_url',
      key: 'anthropic_url',
      width: isMobile ? 100 : 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string) => url ? (
        <MobileTooltip title={url}>
          <Text copyable={{ text: url }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxWidth: isMobile ? 80 : undefined }} ellipsis>
            {url}
          </Text>
        </MobileTooltip>
      ) : '-',
    },
    {
      title: '模型',
      dataIndex: 'model_count',
      key: 'model_count',
      width: 60,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: '厂商 API Key',
      key: 'api_keys',
      width: 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => {
        const count = (record as Provider & { api_key_count?: number }).api_key_count || 0
        return (
          <Button type="link" size="small" onClick={() => handleManageKeys(record)}>
            {count > 0 ? `${count} 个` : '添加'}
          </Button>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean, record) => (
        <Switch
          aria-label={`${record.display_name || record.name} ${enabled ? '已启用' : '已禁用'}`}
          size="small"
          checked={enabled}
          onChange={async (checked) => {
            try {
              await updateProvider(record.id, { enabled: checked })
              message.success(checked ? '已启用' : '已禁用')
              loadProviders()
            } catch {
              message.error('操作失败')
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑厂商 ${record.display_name || record.name}`} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该厂商？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除厂商 ${record.display_name || record.name}`} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 移动端隐藏次要列
  const filteredColumns = isMobile
    ? columns.filter(c => c.key !== 'display_name')
    : columns

  return (
    <>
      {showInlineAdd && (
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加厂商
          </Button>
        </div>
      )}

      {loading && providers.length === 0 ? (
        <TableSkeleton columns={isMobile ? 5 : 8} rows={5} compact />
      ) : (
        <Table
          columns={filteredColumns}
          dataSource={providers}
          rowKey="id"
          locale={{ emptyText: '暂无数据' }}
          size="small"
          showSorterTooltip={false}
          pagination={{
            pageSize: 15,
            showSizeChanger: true,
            pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
            showTotal: (t) => `共 ${t} 条`,
          }}
          scroll={{ x: isMobile ? 'max-content' : 950 }}
        />
      )}

      <AppModal
        title={editingProvider ? '编辑厂商' : '添加厂商'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        
      >
        <Form form={form} layout="vertical">
          <Form.Item label="选择厂商预设">
            <Select
              value={selectedPreset}
              onChange={handlePresetChange}
              placeholder="选择内置厂商（可选）"
              allowClear
              options={Object.entries(vendorPresets).map(([key, v]) => ({
                label: v.name,
                value: key,
              }))}
            />
          </Form.Item>
          {selectedPreset && Object.keys(vendorPresets[selectedPreset]?.plans || {}).length > 1 && (
            <Form.Item label="计费类型">
              <Select
                value={selectedPlan}
                onChange={handlePlanChange}
                options={Object.entries(vendorPresets[selectedPreset].plans).map(([key, plan]) => ({
                  label: plan.label,
                  value: key,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item name="name" label="厂商标识" rules={[{ required: true, message: '请输入厂商标识' }]}>
            <Input placeholder="例如: deepseek（用于 model 参数前缀）" />
          </Form.Item>
          <Form.Item name="display_name" label="显示名称">
            <Input placeholder="例如: DeepSeek" />
          </Form.Item>
          <Form.Item name="openai_url" label="OpenAI 协议地址">
            <Input placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item name="anthropic_url" label="Anthropic 协议地址">
            <Input placeholder="https://api.anthropic.com/v1" />
          </Form.Item>
          {!editingProvider && (
            <Form.Item
              name="api_key"
              label="首个厂商 API Key"
              rules={[{ required: true, whitespace: true, message: '请输入首个厂商 API Key' }]}
              extra="创建成功后只显示掩码，可在厂商 API Key 管理中继续添加或停用。"
            >
              <Input.Password placeholder="请输入厂商提供的 API Key" autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </AppModal>

      {/* API Key 管理弹窗 */}
      <AppModal
        title={`管理厂商 API Key · ${managingKeysProvider?.display_name || managingKeysProvider?.name || ''}`}
        open={apiKeyModalOpen}
        onCancel={() => setApiKeyModalOpen(false)}
        width={600}
        destroyOnClose
        footer={null}
        
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, marginBottom: 12 }}>
            <Input.Password
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="输入新的 API Key"
              style={{ flex: 1 }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <MobileTooltip title="数字越大优先级越高，优先使用高优先级 Key，失败时自动切换到下一个">
                <InputNumber
                  value={newApiPriority}
                  onChange={(v) => setNewApiPriority(v || 0)}
                  placeholder="优先级"
                  min={0}
                  max={100}
                  style={{ width: isMobile ? 'flex' : 80, flex: isMobile ? 1 : undefined }}
                />
              </MobileTooltip>
              <Button type="primary" onClick={handleAddApiKey} disabled={!newApiKey}>
                添加
              </Button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            优先级越高越优先使用。429/5xx 错误时自动切换到下一个 Key。
          </div>
        </div>

        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={providerApiKeys}
          columns={[
            {
              title: 'API Key',
              dataIndex: 'api_key_preview',
              key: 'api_key_preview',
              align: 'center' as const,
              onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
              onCell: () => ({ style: { textAlign: 'center', verticalAlign: 'middle' } }),
              render: (v: string) => <Text style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{v}</Text>,
            },
            {
              title: '优先级',
              dataIndex: 'priority',
              key: 'priority',
              width: 80,
              align: 'center' as const,
              onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
              onCell: () => ({ style: { textAlign: 'center', verticalAlign: 'middle' } }),
              render: (v: number, record: ProviderApiKey) => (
                <InputNumber
                  size="small"
                  value={priorityDrafts[record.id] ?? v}
                  min={0}
                  max={100}
                  className="priority-input"
                  style={{ width: 60 }}
                  onChange={(val) => val !== null && setPriorityDrafts((current) => ({ ...current, [record.id]: val }))}
                />
              ),
            },
            {
              title: '状态',
              dataIndex: 'enabled',
              key: 'enabled',
              width: 80,
              align: 'center' as const,
              render: (enabled: boolean, record: ProviderApiKey) => (
                <Switch aria-label={`厂商 API Key ${record.api_key_preview} ${enabled ? '已启用' : '已禁用'}`} size="small" checked={enabled} onChange={(c) => handleToggleApiKey(record.id, c)} />
              ),
            },
            {
              title: '操作',
              key: 'action',
              width: 96,
              align: 'center' as const,
              render: (_: unknown, record: ProviderApiKey) => (
                <Space size={2}>
                  <Tooltip title="保存优先级">
                    <Button
                      type="text"
                      size="small"
                      icon={<SaveOutlined />}
                      aria-label={`保存厂商 API Key ${record.api_key_preview} 的优先级`}
                      disabled={(priorityDrafts[record.id] ?? record.priority) === record.priority}
                      onClick={() => handleSaveKeyPriority(record.id)}
                    />
                  </Tooltip>
                  <Popconfirm title="确定删除？" onConfirm={() => handleDeleteApiKey(record.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除厂商 API Key ${record.api_key_preview}`} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </AppModal>
    </>
  )
}

// ==========================================
// 模型管理组件
// ==========================================

function ModelManager({ addSignal = 0, showInlineAdd = true }: ManagerProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selectedProvider, setSelectedProvider] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [form] = Form.useForm()
  const pricingConfigured = Form.useWatch('pricing_configured', form)
  const cellCenter: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' }
  const cellCenterFixed: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center', background: 'var(--bg-surface, #fff)' }

  const loadProviders = useCallback(async () => {
    try {
      const { providers } = await fetchProviders()
      setProviders(providers)
      if (providers.length > 0 && !selectedProvider) {
        setSelectedProvider(providers[0].id)
      }
    } catch (err) {
      showRequestError(err, '加载厂商列表失败')
    }
  }, [selectedProvider])

  const loadModels = useCallback(async (providerId: number) => {
    setLoading(true)
    try {
      const { models } = await fetchModels(providerId)
      setModels(models)
    } catch (err) {
      showRequestError(err, '加载模型列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  const { refreshTick } = useFilter()

  useEffect(() => {
    if (selectedProvider) {
      loadModels(selectedProvider)
    }
  }, [selectedProvider, loadModels, refreshTick])

  const handleAdd = () => {
    if (!selectedProvider) {
      message.warning('请先选择厂商')
      return
    }
    setEditingModel(null)
    form.resetFields()
    form.setFieldsValue({ pricing_configured: false })
    setModalOpen(true)
  }

  useEffect(() => {
    if (addSignal <= 0) return
    const timer = window.setTimeout(handleAdd, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addSignal])

  const handleEdit = (model: Model) => {
    setEditingModel(model)
    form.setFieldsValue({
      model_name: model.model_name,
      upstream_model: model.upstream_model,
      enabled: model.enabled,
      context_window: model.context_window,
      price_input: model.price_input,
      price_output: model.price_output,
      price_cache_read: model.price_cache_read,
      price_cache_write: model.price_cache_write,
      pricing_configured: model.pricing_configured,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteModel(id)
      message.success('删除成功')
      if (selectedProvider) loadModels(selectedProvider)
    } catch (err) {
      showRequestError(err, '删除失败')
    }
  }

  const handleSubmit = async () => {
    if (!selectedProvider) return
    try {
      const values = await form.validateFields()
      if (editingModel) {
        await updateModel(editingModel.id, values)
        message.success('更新成功')
      } else {
        await createModel(selectedProvider, values as ModelCreateData)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadModels(selectedProvider)
    } catch (err) {
      showRequestError(err, editingModel ? '更新模型失败' : '添加模型失败')
    }
  }

  const isMobile = useIsMobile()

  const vendorName = providers.find(p => p.id === selectedProvider)?.name || ''

  const columns: ColumnsType<Model> = [
    {
      title: '模型名称',
      dataIndex: 'model_name',
      key: 'model_name',
      width: isMobile ? 100 : 150,
      fixed: 'left' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const, background: 'var(--bg-secondary, #f5f5f4)' } }),
      onCell: () => ({ style: cellCenterFixed }),
      render: (v: string) => <ModelTag name={v} vendorName={vendorName} />,
    },
    {
      title: '上游模型名',
      dataIndex: 'upstream_model',
      key: 'upstream_model',
      width: isMobile ? 100 : 150,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (upstream: string | null) => upstream || <Text type="secondary">-</Text>,
    },
    {
      title: '上下文窗口',
      dataIndex: 'context_window',
      key: 'context_window',
      width: isMobile ? 90 : 110,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (value: number | null) => value ? value.toLocaleString('zh-CN') : '-',
    },
    {
      title: '输入价格',
      dataIndex: 'price_input',
      key: 'price_input',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number, record) => record.pricing_configured ? `¥${price}` : '-',
    },
    {
      title: '输出价格',
      dataIndex: 'price_output',
      key: 'price_output',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number, record) => record.pricing_configured ? `¥${price}` : '-',
    },
    {
      title: '缓存读取',
      dataIndex: 'price_cache_read',
      key: 'price_cache_read',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number, record) => record.pricing_configured ? `¥${price}` : '-',
    },
    {
      title: '缓存写入',
      dataIndex: 'price_cache_write',
      key: 'price_cache_write',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number, record) => record.pricing_configured ? `¥${price}` : '-',
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 70,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean, record) => (
        <Switch
          aria-label={`模型 ${record.model_name} ${enabled ? '已启用' : '已禁用'}`}
          size="small"
          checked={enabled}
          onChange={async (checked) => {
            try {
              await updateModel(record.id, { enabled: checked })
              message.success(checked ? '已启用' : '已禁用')
              if (selectedProvider) loadModels(selectedProvider)
            } catch {
              message.error('操作失败')
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑模型 ${record.model_name}`} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该模型？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除模型 ${record.model_name}`} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 移动端隐藏次要列
  const filteredModelColumns = isMobile
    ? columns.filter(c => c.key !== 'context_window' && c.key !== 'price_cache_read' && c.key !== 'price_cache_write')
    : columns

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between' }}>
        <AdaptiveFilterSelect
          style={{ width: 200, maxWidth: '100%' }}
          placeholder="选择厂商"
          value={selectedProvider}
          onChange={setSelectedProvider}
          options={providers.map(p => ({ label: p.display_name || p.name, value: p.id }))}
        />
        {showInlineAdd && (
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加模型
          </Button>
        )}
      </div>

      {loading && models.length === 0 ? (
        <TableSkeleton columns={isMobile ? 5 : 8} rows={6} compact />
      ) : (
        <Table
          columns={filteredModelColumns}
          dataSource={models}
          rowKey="id"
          locale={{ emptyText: '暂无数据' }}
          size="small"
          showSorterTooltip={false}
          pagination={{
            pageSize: 15,
            showSizeChanger: true,
            pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
            showTotal: (t) => `共 ${t} 条`,
          }}
          scroll={{ x: isMobile ? 'max-content' : 800 }}
        />
      )}

      <AppModal
        title={editingModel ? '编辑模型' : '添加模型'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        
      >
        <Form form={form} layout="vertical">
          <Form.Item name="upstream_model" label="上游模型名" rules={[{ required: true, message: '请输入上游模型名' }]}
            tooltip="上游厂商 API 要求的模型名称，必须与厂商文档一致，例如 deepseek-v4-flash、mimo-v2.5-pro">
            <Input placeholder="例如: deepseek-v4-flash" onChange={(e) => {
              const val = e.target.value
              if (!form.getFieldValue('model_name')) {
                form.setFieldsValue({ model_name: val })
              }
            }} />
          </Form.Item>
          <Form.Item name="model_name" label="模型名称" rules={[{ required: true, message: '请输入模型名称' }]}
            tooltip="调用方请求时使用的模型名称，可自定义。例如上游是 mimo-v2.5-pro，可简化为 mimo">
            <Input placeholder="自动填充，可修改" />
          </Form.Item>
          <Form.Item
            name="context_window"
            label="上下文窗口"
            tooltip="模型可处理的最大 Token 数；留空时继续使用内置默认值。"
            rules={[{ type: 'integer', min: 1, message: '请输入大于 0 的整数' }]}
          >
            <InputNumber min={1} precision={0} placeholder="例如: 128000" style={{ width: '100%' }} />
          </Form.Item>
          <Divider plain>定价配置（元/百万 tokens）</Divider>
          <Form.Item
            name="pricing_configured"
            label="价格状态"
            valuePropName="checked"
            extra="关闭表示价格未知；开启后允许所有价格为 0，表示免费模型。"
          >
            <Switch checkedChildren="已配置" unCheckedChildren="未知" />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item name="price_input" label="输入价格">
              <InputNumber min={0} step={0.01} placeholder="0" disabled={!pricingConfigured} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_output" label="输出价格">
              <InputNumber min={0} step={0.01} placeholder="0" disabled={!pricingConfigured} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_cache_read" label="缓存读取">
              <InputNumber min={0} step={0.01} placeholder="0" disabled={!pricingConfigured} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_cache_write" label="缓存写入">
              <InputNumber min={0} step={0.01} placeholder="0" disabled={!pricingConfigured} style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>
      </AppModal>
    </>
  )
}

// ==========================================
// API Key 管理组件
// ==========================================

function ApiKeyManager({ addSignal = 0, showInlineAdd = true }: ManagerProps) {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
  const [newKeyTitle, setNewKeyTitle] = useState('API Key 创建成功')
  const [resetKeyPending, setResetKeyPending] = useState(false)
  const [copyingKeyId, setCopyingKeyId] = useState<number | null>(null)
  const [form] = Form.useForm()
  const cellCenter: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' }
  const cellCenterFixed: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center', background: 'var(--bg-surface, #fff)' }
  const [allModels, setAllModels] = useState<string[]>([])

  const loadApiKeys = useCallback(async () => {
    setLoading(true)
    try {
      const { keys } = await fetchApiKeys()
      setApiKeys(keys)
    } catch (err) {
      showRequestError(err, '加载 API Key 列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载所有模型列表
  const loadAllModels = useCallback(async () => {
    try {
      const { providers } = await fetchProviders()
      const modelGroups = await Promise.all(
        providers.map(async p => {
          const { models: pModels } = await fetchModels(p.id)
          // 模型名称在 Heimdall 中全局唯一；厂商仅用于路由和详情展示。
          return pModels.map(m => m.model_name)
        }),
      )
      const models = modelGroups.flat()
      setAllModels(models)
    } catch (err) {
      showRequestError(err, '加载可用模型失败')
    }
  }, [])

  const { refreshTick } = useFilter()

  useEffect(() => {
    loadApiKeys()
    loadAllModels()
  }, [loadApiKeys, loadAllModels, refreshTick])

  const handleAdd = () => {
    setEditingKey(null)
    setResetKeyPending(false)
    form.resetFields()
    setModalOpen(true)
  }

  useEffect(() => {
    if (addSignal <= 0) return
    const timer = window.setTimeout(handleAdd, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addSignal])

  const handleEdit = (key: ApiKey) => {
    setEditingKey(key)
    setResetKeyPending(false)
    form.setFieldsValue({
      name: key.name,
      enabled: key.enabled,
      allowed_models: key.allowed_models ? key.allowed_models.split(',').map(m => m.trim().split('/').pop() || m.trim()) : [],
    })
    setModalOpen(true)
  }

  const resetApiKeyForm = () => {
    setResetKeyPending(false)
    if (editingKey) {
      form.setFieldsValue({
        name: editingKey.name,
        enabled: editingKey.enabled,
        allowed_models: editingKey.allowed_models
          ? editingKey.allowed_models.split(',').map(model => model.trim().split('/').pop() || model.trim())
          : [],
      })
    } else {
      form.resetFields()
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteApiKey(id)
      message.success('删除成功')
      loadApiKeys()
    } catch (err) {
      showRequestError(err, '删除失败')
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      // 将模型数组转为逗号分隔字符串
      if (Array.isArray(values.allowed_models)) {
        values.allowed_models = values.allowed_models.join(',')
      }
      if (editingKey) {
        const result = await updateApiKey(editingKey.id, {
          ...values,
          reset_key: resetKeyPending,
        })
        if (result.key_value) {
          setNewKeyTitle('API Key 重置成功')
          setNewKeyValue(result.key_value)
        }
        message.success('更新成功')
      } else {
        const result = await createApiKey(values as ApiKeyCreateData)
        setNewKeyTitle('API Key 创建成功')
        setNewKeyValue(result.key_value)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadApiKeys()
    } catch (err) {
      showRequestError(err, editingKey ? '更新 API Key 失败' : '创建 API Key 失败')
    }
  }

  const handleCopyKey = async (key: string) => {
    try {
      await copyText(key)
      message.success('已复制到剪贴板')
    } catch {
      message.error('复制失败，请重试')
    }
  }

  const handleCopyStoredKey = async (record: ApiKey) => {
    setCopyingKeyId(record.id)
    try {
      const { key_value } = await copyApiKey(record.id)
      await copyText(key_value)
      message.success(`已复制 ${record.name || 'API Key'}`)
    } catch (err) {
      showRequestError(err, '复制 API Key 失败')
    } finally {
      setCopyingKeyId(null)
    }
  }

  const isMobile = useIsMobile()

  const columns: ColumnsType<ApiKey> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: isMobile ? 90 : 120,
      fixed: 'left' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const, background: 'var(--bg-secondary, #f5f5f4)' } }),
      onCell: () => ({ style: cellCenterFixed }),
    },
    {
      title: 'API Key',
      dataIndex: 'key_preview',
      key: 'key_preview',
      width: isMobile ? 140 : 200,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (preview: string, record) => (
        <Space size={4}>
          <Text style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {preview}
          </Text>
          <Tooltip title="复制完整 Key">
            <Button
              type="text"
              size="small"
              className="hd-copy-button"
              loading={copyingKeyId === record.id}
              icon={copyingKeyId === record.id ? undefined : <CopyOutlined />}
              aria-label={`复制客户端 API Key ${record.name}`}
              onClick={() => handleCopyStoredKey(record)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '允许的模型',
      dataIndex: 'allowed_models',
      key: 'allowed_models',
      width: isMobile ? 120 : undefined,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (models: string | null) => (
        models ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
            {models.split(',').map(m => {
              const normalized = m.trim().split('/').pop() || m.trim()
              return <ModelTag key={m} name={normalized} />
            })}
          </div>
        ) : <Tag color="blue" style={{ margin: 0 }}>全部</Tag>
      ),
    },
    {
      title: '最后使用',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      width: isMobile ? 120 : 160,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (time: string | null) => time || <Text type="secondary">未使用</Text>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 70,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean, record) => (
        <Switch
          aria-label={`客户端 API Key ${record.name} ${enabled ? '已启用' : '已禁用'}`}
          size="small"
          checked={enabled}
          onChange={async (checked) => {
            try {
              await updateApiKey(record.id, { enabled: checked })
              message.success(checked ? '已启用' : '已禁用')
              loadApiKeys()
            } catch {
              message.error('操作失败')
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 116,
      
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑客户端 API Key ${record.name}`} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该 API Key？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除客户端 API Key ${record.name}`} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      {showInlineAdd && (
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            创建 API Key
          </Button>
        </div>
      )}

      {loading && apiKeys.length === 0 ? (
        <TableSkeleton columns={isMobile ? 4 : 7} rows={5} compact />
      ) : (
        <Table
          columns={columns}
          dataSource={apiKeys}
          rowKey="id"
          locale={{ emptyText: '暂无数据' }}
          size="small"
          showSorterTooltip={false}
          pagination={{
            pageSize: 15,
            showSizeChanger: true,
            pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
            showTotal: (t) => `共 ${t} 条`,
          }}
          scroll={{ x: isMobile ? 'max-content' : 800 }}
        />
      )}

      <AppModal
        title={editingKey ? '编辑 API Key' : '创建 API Key'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        footer={(
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Button onClick={resetApiKeyForm}>恢复原值</Button>
            <Space>
              <Button onClick={() => setModalOpen(false)}>取消</Button>
              <Button type="primary" onClick={handleSubmit}>确定</Button>
            </Space>
          </div>
        )}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称">
            <Input placeholder="例如: 我的应用" />
          </Form.Item>
          {!editingKey && (
            <Form.Item name="key_value" label="API Key">
              <Input placeholder="留空自动生成" />
            </Form.Item>
          )}
          {editingKey && (
            <Form.Item
              label="API Key"
              extra={resetKeyPending
                ? '点击“确定”后才会生成并应用新 Key；旧 Key 随即失效。'
                : '列表复制会按需读取当前完整 Key；重置操作不会在点击确定前生效。'}
            >
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  readOnly
                  value={resetKeyPending ? '已准备重置，尚未保存' : editingKey.key_preview}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
                <Button
                  danger={!resetKeyPending}
                  onClick={() => setResetKeyPending(pending => !pending)}
                >
                  {resetKeyPending ? '取消重置' : '重置 Key'}
                </Button>
              </Space.Compact>
            </Form.Item>
          )}
          <Form.Item name="allowed_models" label="允许的模型">
            <Select
              mode="multiple"
              placeholder="留空则允许所有模型"
              allowClear
              options={allModels.map(m => ({ label: m, value: m }))}
              maxTagCount={undefined}
              showSearch
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase()) ?? false
              }
            />
          </Form.Item>
        </Form>
      </AppModal>

      {/* 新 Key 创建成功后的提示弹窗 */}
      <AppModal
        title={newKeyTitle}
        open={!!newKeyValue}
        onOk={() => setNewKeyValue(null)}
        onCancel={() => setNewKeyValue(null)}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => newKeyValue && handleCopyKey(newKeyValue)}>
            复制 Key
          </Button>,
          <Button key="close" onClick={() => setNewKeyValue(null)}>
            关闭
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 8 }}>
          <Text type="warning">完整 Key 仅在创建、重置结果或主动复制时返回，不会随列表加载。</Text>
        </div>
        <div style={{
          padding: 12,
          background: 'var(--bg-secondary)',
          borderRadius: 6,
          fontFamily: 'monospace',
          fontSize: 14,
          wordBreak: 'break-all',
        }}>
          {newKeyValue}
        </div>
      </AppModal>
    </>
  )
}

// ==========================================
// 主页面
// ==========================================

export default function Admin() {
  const isMobile = useIsMobile()
  const [activeKey, setActiveKey] = useState('providers')
  const [addSignals, setAddSignals] = useState({ providers: 0, models: 0, apikeys: 0 })

  const triggerAdd = (key: keyof typeof addSignals) => {
    setAddSignals(current => ({ ...current, [key]: current[key] + 1 }))
  }

  const tabAction = !isMobile ? (
    <Button
      type="primary"
      icon={<PlusOutlined />}
      onClick={() => triggerAdd(activeKey as keyof typeof addSignals)}
    >
      {activeKey === 'providers' ? '添加厂商' : activeKey === 'models' ? '添加模型' : '创建 API Key'}
    </Button>
  ) : undefined

  const tabItems = [
    {
      key: 'providers',
      label: '厂商管理',
      children: <ProviderManager addSignal={addSignals.providers} showInlineAdd={isMobile} />,
    },
    {
      key: 'models',
      label: '模型管理',
      children: <ModelManager addSignal={addSignals.models} showInlineAdd={isMobile} />,
    },
    {
      key: 'apikeys',
      label: 'API Key 管理',
      children: <ApiKeyManager addSignal={addSignals.apikeys} showInlineAdd={isMobile} />,
    },
  ]

  return (
    <div className="page-content">
      <Header pageName="系统配置" hideDatePicker />
      <section className="section" style={{ marginBottom: 8 }}>
        <Card className="hd-card" styles={{ body: { padding: '0' } }}>
          <div className="hd-admin-tabs" style={{ padding: isMobile ? '0 4px 4px' : '0 16px 8px' }}>
            <Tabs
              items={tabItems}
              activeKey={activeKey}
              onChange={setActiveKey}
              tabBarExtraContent={tabAction}
            />
          </div>
        </Card>
      </section>
    </div>
  )
}
