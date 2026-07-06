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
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import Header from '../components/Header'
import {
  fetchProviders, createProvider, updateProvider, deleteProvider,
  fetchModels, createModel, updateModel, deleteModel,
  fetchApiKeys, createApiKey, updateApiKey, deleteApiKey,
  type Provider, type Model, type ApiKey,
  type ProviderCreateData, type ModelCreateData, type ApiKeyCreateData,
} from '../api/admin'

const { Text } = Typography

// ==========================================
// 厂商管理组件
// ==========================================

function ProviderManager() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [form] = Form.useForm()

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

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  const handleAdd = () => {
    setEditingProvider(null)
    form.resetFields()
    setModalOpen(true)
  }

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider)
    form.setFieldsValue({
      name: provider.name,
      display_name: provider.display_name,
      openai_url: provider.openai_url || '',
      anthropic_url: provider.anthropic_url || '',
      base_url: provider.base_url,
      api_key: provider.api_key,
      enabled: provider.enabled,
      priority: provider.priority,
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

  const columns: ColumnsType<Provider> = [
    {
      title: '厂商',
      dataIndex: 'name',
      key: 'name',
      width: 100,
      fixed: 'left' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: '显示名',
      dataIndex: 'display_name',
      key: 'display_name',
      width: 100,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: 'OpenAI URL',
      dataIndex: 'openai_url',
      key: 'openai_url',
      width: 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string, record: Provider) => url || record.base_url || '-',
    },
    {
      title: 'Anthropic URL',
      dataIndex: 'anthropic_url',
      key: 'anthropic_url',
      width: 200,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (url: string) => url || '-',
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      key: 'api_key',
      width: 150,
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (key: string) => (
        <Text copyable={{ text: key }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {key.substring(0, 12)}...
        </Text>
      ),
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
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 60,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 60,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'red'}>{enabled ? '启用' : '禁用'}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right' as const,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
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
        pagination={false}
        scroll={{ x: 950 }}
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
          <Form.Item name="name" label="厂商标识" rules={[{ required: true, message: '请输入厂商标识' }]}>
            <Input placeholder="例如: deepseek（用于 model 参数前缀）" />
          </Form.Item>
          <Form.Item name="display_name" label="显示名称">
            <Input placeholder="例如: DeepSeek" />
          </Form.Item>
          <Form.Item name="openai_url" label="OpenAI 协议地址" rules={[{ required: true, message: '请输入 OpenAI 协议地址' }]} help="用于 /v1/chat/completions 和 /v1/responses">
            <Input placeholder="例如: https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item name="anthropic_url" label="Anthropic 协议地址" help="用于 /v1/messages，如不支持 Anthropic 协议可留空">
            <Input placeholder="例如: https://api.deepseek.com/anthropic" />
          </Form.Item>
          <Form.Item name="base_url" label="通用 API 地址" help="当上面两个地址为空时使用此地址作为 fallback">
            <Input placeholder="例如: https://api.deepseek.com" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Space>
            <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
            <Form.Item name="priority" label="优先级" initialValue={0}>
              <InputNumber min={0} max={100} />
            </Form.Item>
            <Form.Item name="plan_type" label="计费类型" initialValue="api" style={{ width: 120 }}>
              <Select options={[{ value: 'api', label: 'API 按量' }, { value: 'token_plan', label: 'Token Plan' }]} />
            </Form.Item>
          </Space>
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

  useEffect(() => {
    if (selectedProvider) {
      loadModels(selectedProvider)
    }
  }, [selectedProvider, loadModels])

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
      context_window: model.context_window,
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

  const columns: ColumnsType<Model> = [
    {
      title: '模型名称',
      dataIndex: 'model_name',
      key: 'model_name',
      width: 150,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: '上游模型名',
      dataIndex: 'upstream_model',
      key: 'upstream_model',
      width: 150,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (upstream: string | null) => upstream || <Text type="secondary">同上</Text>,
    },
    {
      title: '上下文窗口',
      dataIndex: 'context_window',
      key: 'context_window',
      width: 120,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (window: number | null) => window ? `${(window / 1000).toFixed(0)}K` : '-',
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'red'}>{enabled ? '启用' : '禁用'}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
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
        pagination={false}
        scroll={{ x: 600 }}
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
          <Form.Item name="model_name" label="模型名称" rules={[{ required: true, message: '请输入模型名称' }]}>
            <Input placeholder="例如: deepseek-chat" />
          </Form.Item>
          <Form.Item name="upstream_model" label="上游模型名" help="如果上游 API 使用不同的模型名，可在此配置">
            <Input placeholder="留空则使用模型名称" />
          </Form.Item>
          <Form.Item name="context_window" label="上下文窗口">
            <InputNumber min={0} placeholder="例如: 32000" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
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

  useEffect(() => {
    loadApiKeys()
  }, [loadApiKeys])

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
      allowed_models: key.allowed_models,
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

  const columns: ColumnsType<ApiKey> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
    },
    {
      title: 'API Key',
      dataIndex: 'key_preview',
      key: 'key_preview',
      width: 200,
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
      ellipsis: true,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (models: string | null) => (
        models ? (
          <Space wrap size={4}>
            {models.split(',').map(m => <Tag key={m}>{m.trim()}</Tag>)}
          </Space>
        ) : <Tag color="blue">全部</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (enabled: boolean) => (
        <Tag color={enabled ? 'green' : 'red'}>{enabled ? '启用' : '禁用'}</Tag>
      ),
    },
    {
      title: '最后使用',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      width: 160,
      align: 'center',
      onHeaderCell: () => ({ style: { textAlign: 'center' as const } }),
      onCell: () => ({ style: cellCenter }),
      render: (time: string | null) => time || <Text type="secondary">未使用</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
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
        pagination={false}
        scroll={{ x: 700 }}
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
            <Form.Item name="key_value" label="API Key" help="留空则自动生成">
              <Input placeholder="留空自动生成 heimdall-xxx" />
            </Form.Item>
          )}
          <Form.Item name="allowed_models" label="允许的模型" help="多个模型用逗号分隔，留空则允许所有模型">
            <Input placeholder="例如: deepseek-chat,gpt-4" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
            <Switch />
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
      <Header pageName="设置" />
      <section className="section">
        <Card className="hd-card" styles={{ body: { padding: '0' } }}>
          <div style={{ padding: '0 16px' }}>
            <Tabs items={tabItems} defaultActiveKey="providers" />
          </div>
        </Card>
      </section>
    </div>
  )
}
