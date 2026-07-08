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
  Card, Table, Button, Modal, Form, Input, Switch, InputNumber, Select,
  Space, Tag, Tooltip, Popconfirm, message, Tabs, Divider, Typography
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import { getVendorColor } from '../components/Charts/chartTheme'
import Header from '../components/Header'
import { useFilter } from '../context/FilterContext'
import {
  fetchProviders, createProvider, updateProvider, deleteProvider,
  fetchModels, createModel, updateModel, deleteModel,
  fetchApiKeys, createApiKey, updateApiKey, deleteApiKey,
  type Provider, type Model, type ApiKey,
  type ProviderCreateData, type ModelCreateData, type ApiKeyCreateData,
} from '../api/admin'

const { Text } = Typography

// 厂商预设类型
interface VendorPreset {
  name: string
  plans: Record<string, { label: string; openai_url: string | null; anthropic_url: string | null }>
  default_plan: string
  models: string[]
}

// ==========================================
// 厂商管理组件
// ==========================================

function ProviderManager() {
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
      message.error('加载厂商列表失败')
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
      api_key: provider.api_key || '',
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
      message.error('删除失败')
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
      // 表单验证失败或其他错误
    }
  }

  const cellCenter: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center' }
  const cellCenterFixed: React.CSSProperties = { verticalAlign: 'middle', textAlign: 'center', background: 'var(--bg-surface, #fff)' }
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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
        return <Tag color={vc.color} style={{ fontWeight: 600, fontSize: 12, background: vc.bg, border: `1px solid ${vc.color}30` }}>{vc.label || name}</Tag>
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
      width: isMobile ? 120 : 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string) => url ? (
        <Tooltip title={url} placement="top">
          <Text copyable={{ text: url }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} ellipsis>
            {url}
          </Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: 'Anthropic URL',
      dataIndex: 'anthropic_url',
      key: 'anthropic_url',
      width: isMobile ? 120 : 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string) => url ? (
        <Tooltip title={url} placement="top">
          <Text copyable={{ text: url }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} ellipsis>
            {url}
          </Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      key: 'api_key',
      width: isMobile ? 100 : 150,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (key: string) => {
        if (!key) return '—'
        const masked = key.length > 12 ? key.substring(0, 6) + '****' + key.substring(key.length - 4) : '****'
        return (
          <Tooltip title="点击复制完整 Key">
            <Tag
              style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              onClick={() => {
                navigator.clipboard.writeText(key)
                message.success('已复制到剪贴板')
              }}
            >
              {masked}
            </Tag>
          </Tooltip>
        )
      },
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
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean, record) => (
        <Switch
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
      fixed: 'right' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenterFixed }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该厂商？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加厂商
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={providers}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        locale={{ emptyText: loading ? <span /> : '暂无数据' }}
        size="small"
        showSorterTooltip={false}
        pagination={{
          pageSize: 15,
          showSizeChanger: true,
          pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: isMobile ? 650 : 950 }}
      />

      <Modal
        title={editingProvider ? '编辑厂商' : '添加厂商'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        styles={{ body: { padding: '16px 24px' } }}
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
          <Form.Item name="api_key" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password placeholder="sk-..." />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ==========================================
// 模型管理组件
// ==========================================

function ModelManager() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selectedProvider, setSelectedProvider] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [form] = Form.useForm()
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
      message.error('加载厂商列表失败')
    }
  }, [selectedProvider])

  const loadModels = useCallback(async (providerId: number) => {
    setLoading(true)
    try {
      const { models } = await fetchModels(providerId)
      setModels(models)
    } catch (err) {
      message.error('加载模型列表失败')
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
    setModalOpen(true)
  }

  const handleEdit = (model: Model) => {
    setEditingModel(model)
    form.setFieldsValue({
      model_name: model.model_name,
      upstream_model: model.upstream_model,
      enabled: model.enabled,
      price_input: model.price_input,
      price_output: model.price_output,
      price_cache_read: model.price_cache_read,
      price_cache_write: model.price_cache_write,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteModel(id)
      message.success('删除成功')
      if (selectedProvider) loadModels(selectedProvider)
    } catch (err) {
      message.error('删除失败')
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
      // 表单验证失败或其他错误
    }
  }

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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
      render: (v: string) => <Tag color="blue" style={{ fontSize: 11 }}>{v}</Tag>,
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
      title: '输入价格',
      dataIndex: 'price_input',
      key: 'price_input',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number) => price ? `¥${price}` : '-',
    },
    {
      title: '输出价格',
      dataIndex: 'price_output',
      key: 'price_output',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number) => price ? `¥${price}` : '-',
    },
    {
      title: '缓存读取',
      dataIndex: 'price_cache_read',
      key: 'price_cache_read',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number) => price ? `¥${price}` : '-',
    },
    {
      title: '缓存写入',
      dataIndex: 'price_cache_write',
      key: 'price_cache_write',
      width: isMobile ? 70 : 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (price: number) => price ? `¥${price}` : '-',
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
      width: 100,
      fixed: 'right' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该模型？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Select
          style={{ width: 200 }}
          placeholder="选择厂商"
          value={selectedProvider}
          onChange={setSelectedProvider}
          options={providers.map(p => ({ label: p.display_name || p.name, value: p.id }))}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加模型
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={models}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        locale={{ emptyText: loading ? <span /> : '暂无数据' }}
        size="small"
        showSorterTooltip={false}
        pagination={{
          pageSize: 15,
          showSizeChanger: true,
          pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: isMobile ? 650 : 800 }}
      />

      <Modal
        title={editingModel ? '编辑模型' : '添加模型'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        styles={{ body: { padding: '16px 24px' } }}
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
          <Divider plain>定价配置（元/百万 tokens）</Divider>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item name="price_input" label="输入价格">
              <InputNumber min={0} step={0.01} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_output" label="输出价格">
              <InputNumber min={0} step={0.01} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_cache_read" label="缓存读取">
              <InputNumber min={0} step={0.01} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="price_cache_write" label="缓存写入">
              <InputNumber min={0} step={0.01} placeholder="0" style={{ width: '100%' }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  )
}

// ==========================================
// API Key 管理组件
// ==========================================

function ApiKeyManager() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
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
      message.error('加载 API Key 列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载所有模型列表
  const loadAllModels = useCallback(async () => {
    try {
      const { providers } = await fetchProviders()
      const models: string[] = []
      for (const p of providers) {
        const { models: pModels } = await fetchModels(p.id)
        for (const m of pModels) {
          models.push(`${p.name}/${m.model_name}`)
        }
      }
      setAllModels(models)
    } catch { /* silent */ }
  }, [])

  const { refreshTick } = useFilter()

  useEffect(() => {
    loadApiKeys()
    loadAllModels()
  }, [loadApiKeys, loadAllModels, refreshTick])

  const handleAdd = () => {
    setEditingKey(null)
    form.resetFields()
    setModalOpen(true)
  }

  const handleEdit = (key: ApiKey) => {
    setEditingKey(key)
    form.setFieldsValue({
      name: key.name,
      enabled: key.enabled,
      allowed_models: key.allowed_models ? key.allowed_models.split(',').map(m => m.trim()) : [],
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteApiKey(id)
      message.success('删除成功')
      loadApiKeys()
    } catch (err) {
      message.error('删除失败')
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
        await updateApiKey(editingKey.id, values)
        message.success('更新成功')
      } else {
        const result = await createApiKey(values as ApiKeyCreateData)
        setNewKeyValue(result.key_value)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadApiKeys()
    } catch (err) {
      // 表单验证失败或其他错误
    }
  }

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    message.success('已复制到剪贴板')
  }

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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
        <Space>
          <Text copyable={{ text: record.key_value }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {preview || record.key_value}
          </Text>
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
            {models.split(',').map(m => <Tag key={m} style={{ margin: 0 }}>{m.trim()}</Tag>)}
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
      width: 100,
      fixed: 'right' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm title="确定删除该 API Key？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          创建 API Key
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={apiKeys}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        locale={{ emptyText: loading ? <span /> : '暂无数据' }}
        size="small"
        showSorterTooltip={false}
        pagination={{
          pageSize: 15,
          showSizeChanger: true,
          pageSizeOptions: ['5', '10', '15', '20', '30', '50'],
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: isMobile ? 620 : 800 }}
      />

      <Modal
        title={editingKey ? '编辑 API Key' : '创建 API Key'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
        styles={{ body: { padding: '16px 24px' } }}
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
          <Form.Item name="allowed_models" label="允许的模型">
            <Select
              mode="multiple"
              placeholder="留空则允许所有模型"
              allowClear
              options={allModels.map(m => ({ label: m, value: m }))}
              maxTagCount={3}
              showSearch
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase()) ?? false
              }
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新 Key 创建成功后的提示弹窗 */}
      <Modal
        title="API Key 创建成功"
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
          <Text type="warning">请立即复制保存，此 Key 只会显示一次！</Text>
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
      </Modal>
    </>
  )
}

// ==========================================
// 主页面
// ==========================================

export default function Admin() {
  const tabItems = [
    {
      key: 'providers',
      label: '厂商管理',
      children: <ProviderManager />,
    },
    {
      key: 'models',
      label: '模型管理',
      children: <ModelManager />,
    },
    {
      key: 'apikeys',
      label: 'API Key 管理',
      children: <ApiKeyManager />,
    },
  ]

  return (
    <div className="page-content">
      <Header pageName="系统配置" hideDatePicker />
      <section className="section">
        <Card className="hd-card" styles={{ body: { padding: '0' } }}>
          <div style={{ padding: isMobile ? '0 8px 4px' : '0 16px 8px' }}>
            <Tabs items={tabItems} defaultActiveKey="providers" />
          </div>
        </Card>
      </section>
    </div>
  )
}
