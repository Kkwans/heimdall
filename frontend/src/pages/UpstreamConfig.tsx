/**
 * UpstreamConfig.tsx -- 上游配置页面
 *
 * 管理 AI 厂商和模型配置。保持与 Dashboard/Requests/Stats 等页面一致的设计语言。
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Card, Table, Button, Modal, Form, Input, Switch, InputNumber, Select,
  Space, Tag, Tooltip, Popconfirm, message, Typography, Divider
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined, CloudServerOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import Header from '../components/Header'
import { TABLE_SPIN_INDICATOR } from '../components/SpinRing'
import axios from 'axios'

const { Text } = Typography

// ── 类型定义 ─────────────────────────────────────────────────────────────────

interface Provider {
  id: number
  name: string
  display_name: string
  base_url: string
  api_key: string
  enabled: boolean
  priority: number
  model_count: number
}

interface Model {
  id: number
  provider_id: number
  model_name: string
  upstream_model: string | null
  enabled: boolean
  context_window: number | null
}

// ── API 函数 ─────────────────────────────────────────────────────────────────

const api = axios.create({ baseURL: '', timeout: 30000 })

async function fetchProviders(): Promise<{ providers: Provider[] }> {
  const { data } = await api.get('/api/providers')
  return data
}

async function createProvider(d: Partial<Provider>): Promise<{ id: number }> {
  const { data } = await api.post('/api/providers', d)
  return data
}

async function updateProvider(id: number, d: Partial<Provider>): Promise<void> {
  await api.put(`/api/providers/${id}`, d)
}

async function deleteProvider(id: number): Promise<void> {
  await api.delete(`/api/providers/${id}`)
}

async function fetchModels(providerId: number): Promise<{ models: Model[] }> {
  const { data } = await api.get(`/api/providers/${providerId}/models`)
  return data
}

async function createModel(providerId: number, d: Partial<Model>): Promise<{ id: number }> {
  const { data } = await api.post(`/api/providers/${providerId}/models`, d)
  return data
}

async function updateModel(id: number, d: Partial<Model>): Promise<void> {
  await api.put(`/api/models/${id}`, d)
}

async function deleteModel(id: number): Promise<void> {
  await api.delete(`/api/models/${id}`)
}

// ── 厂商管理组件 ─────────────────────────────────────────────────────────────

function ProviderManager() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { providers } = await fetchProviders()
      setProviders(providers)
    } catch {
      message.error('加载厂商列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = () => {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  const handleEdit = (p: Provider) => {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      display_name: p.display_name,
      base_url: p.base_url,
      api_key: p.api_key,
      enabled: p.enabled,
      priority: p.priority,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteProvider(id)
      message.success('删除成功')
      load()
    } catch {
      message.error('删除失败')
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await updateProvider(editing.id, values)
        message.success('更新成功')
      } else {
        await createProvider(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      load()
    } catch { /* 校验失败 */ }
  }

  const columns: ColumnsType<Provider> = [
    {
      title: '厂商',
      dataIndex: 'display_name',
      key: 'display_name',
      render: (v: string, r: Provider) => (
        <Space>
          <CloudServerOutlined style={{ color: 'var(--color-primary)' }} />
          <Text strong>{v || r.name}</Text>
        </Space>
      ),
    },
    {
      title: 'API 地址',
      dataIndex: 'base_url',
      key: 'base_url',
      ellipsis: true,
      render: (v: string) => <Text copyable={{ text: v }} style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{v}</Text>,
    },
    {
      title: 'API Key',
      dataIndex: 'api_key',
      key: 'api_key',
      width: 160,
      render: (v: string) => v
        ? <Text copyable={{ text: v }} style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{v.slice(0, 8)}...{v.slice(-4)}</Text>
        : <Text type="secondary">未设置</Text>,
    },
    {
      title: '模型数',
      dataIndex: 'model_count',
      key: 'model_count',
      width: 80,
      align: 'center',
      render: (v: number) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 80,
      align: 'center',
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, r) => (
        <Space size="small">
          <Tooltip title="编辑"><Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} /></Tooltip>
          <Popconfirm title="确定删除该厂商？关联模型将一并删除。" onConfirm={() => handleDelete(r.id)}>
            <Tooltip title="删除"><Button type="text" size="small" danger icon={<DeleteOutlined />} /></Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Text type="secondary">配置 AI 厂商的 API 地址和密钥，支持多个厂商</Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加厂商</Button>
      </div>

      <Table
        columns={columns}
        dataSource={providers}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        pagination={false}
        scroll={{ x: 800 }}
      />

      <Modal
        title={editing ? '编辑厂商' : '添加厂商'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="厂商标识" rules={[{ required: true, message: '请输入标识' }]}>
            <Input placeholder="例如: mimo, deepseek（用于 model 参数前缀）" />
          </Form.Item>
          <Form.Item name="display_name" label="显示名称">
            <Input placeholder="例如: 小米 MiMo, DeepSeek" />
          </Form.Item>
          <Form.Item name="base_url" label="API 地址" rules={[{ required: true, message: '请输入地址' }, { type: 'url', message: '请输入有效 URL' }]}>
            <Input placeholder="例如: https://api.mimo.ai/v1" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder="sk-...（留空则需要请求时通过 Header 传入）" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
            <Form.Item name="priority" label="优先级" help="无厂商前缀时使用优先级最高的" initialValue={0}>
              <InputNumber min={0} max={100} style={{ width: 100 }} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  )
}

// ── 模型管理组件 ─────────────────────────────────────────────────────────────

function ModelManager() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selectedProvider, setSelectedProvider] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Model | null>(null)
  const [form] = Form.useForm()

  const loadProviders = useCallback(async () => {
    try {
      const { providers } = await fetchProviders()
      setProviders(providers)
      if (providers.length > 0 && !selectedProvider) {
        setSelectedProvider(providers[0].id)
      }
    } catch { /* silent */ }
  }, [selectedProvider])

  const loadModels = useCallback(async (pid: number) => {
    setLoading(true)
    try {
      const { models } = await fetchModels(pid)
      setModels(models)
    } catch {
      message.error('加载模型失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadProviders() }, [loadProviders])
  useEffect(() => { if (selectedProvider) loadModels(selectedProvider) }, [selectedProvider, loadModels])

  const handleAdd = () => {
    if (!selectedProvider) { message.warning('请先选择厂商'); return }
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  const handleEdit = (m: Model) => {
    setEditing(m)
    form.setFieldsValue({
      model_name: m.model_name,
      upstream_model: m.upstream_model,
      enabled: m.enabled,
      context_window: m.context_window,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteModel(id)
      message.success('删除成功')
      if (selectedProvider) loadModels(selectedProvider)
    } catch {
      message.error('删除失败')
    }
  }

  const handleSubmit = async () => {
    if (!selectedProvider) return
    try {
      const values = await form.validateFields()
      if (editing) {
        await updateModel(editing.id, values)
        message.success('更新成功')
      } else {
        await createModel(selectedProvider, values)
        message.success('创建成功')
      }
      setModalOpen(false)
      if (selectedProvider) loadModels(selectedProvider)
    } catch { /* 校验失败 */ }
  }

  const columns: ColumnsType<Model> = [
    {
      title: '模型名称',
      dataIndex: 'model_name',
      key: 'model_name',
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '上游模型名',
      dataIndex: 'upstream_model',
      key: 'upstream_model',
      render: (v: string | null) => v || <Text type="secondary">同上</Text>,
    },
    {
      title: '上下文窗口',
      dataIndex: 'context_window',
      key: 'context_window',
      width: 120,
      render: (v: number | null) => v ? `${(v / 1000).toFixed(0)}K` : '-',
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, r) => (
        <Space size="small">
          <Tooltip title="编辑"><Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} /></Tooltip>
          <Popconfirm title="确定删除该模型？" onConfirm={() => handleDelete(r.id)}>
            <Tooltip title="删除"><Button type="text" size="small" danger icon={<DeleteOutlined />} /></Tooltip>
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
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加模型</Button>
      </div>

      <Table
        columns={columns}
        dataSource={models}
        rowKey="id"
        loading={loading ? TABLE_SPIN_INDICATOR : false}
        pagination={false}
        scroll={{ x: 600 }}
      />

      <Modal
        title={editing ? '编辑模型' : '添加模型'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="model_name" label="模型名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如: mimo-v2.5-pro, deepseek-v4-pro" />
          </Form.Item>
          <Form.Item name="upstream_model" label="上游模型名" help="如果上游 API 使用不同的模型名，可在此配置">
            <Input placeholder="留空则使用模型名称" />
          </Form.Item>
          <Form.Item name="context_window" label="上下文窗口">
            <InputNumber min={0} placeholder="例如: 1024000" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

// ── 主页面 ───────────────────────────────────────────────────────────────────

export default function UpstreamConfig() {
  return (
    <div className="page-content">
      <Header pageName="上游配置" />

      <section className="section">
        <Card
          title={
            <Space>
              <ApiOutlined />
              <span>厂商管理</span>
            </Space>
          }
          bordered={false}
          className="hd-card"
        >
          <ProviderManager />
        </Card>
      </section>

      <section className="section">
        <Card
          title={
            <Space>
              <CloudServerOutlined />
              <span>模型管理</span>
            </Space>
          }
          bordered={false}
          className="hd-card"
        >
          <ModelManager />
        </Card>
      </section>
    </div>
  )
}
