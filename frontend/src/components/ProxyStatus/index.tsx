/**
 * ProxyStatusCard — 代理服务状态卡片（v7）
 *
 * v7 修复：
 *   - 代理启动 Bug 修复：setOperating 移到轮询完成后，超时提示
 *   - 按钮风格统一：编辑/重启均为 type="default" + 文字
 *   - 停止/启动文字统一，移除双版本
 *   - 信息展示：去掉 Dashboard 端口冒号前缀，新增"代理端口"和"前端端口"
 *   - 移动端：开机自启优先展示，端口三项横向一行
 */
import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  Card, Button, Modal, Form, Input, InputNumber,
  message, Divider, Tooltip,
} from 'antd'
import {
  PlayCircleOutlined, StopOutlined, EditOutlined,
  ReloadOutlined, SettingOutlined, CopyOutlined, CheckOutlined,
} from '@ant-design/icons'
import axios from 'axios'
import { useFilter } from '../../context/FilterContext'
import { buildProxyBaseUrls } from '../../utils/proxyUrl'
import { copyText } from '../../utils/clipboard'
import AppModal from '../AppModal'
import styles from './ProxyStatus.module.css'

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────
interface ProxyStatus {
  running: boolean
  ready?: boolean
  status?: string
  health?: string | null
  port: number
  pid: number | null
}

interface ProxyConfig {
  proxy_port: number
  active_proxy_port?: number
  dashboard_port: number
  proxy_path: string
  upstream_url: string
  request_timeout: number
  autostart_enabled: boolean
  public_base_url?: string
  openai_base_url?: string
  anthropic_base_url?: string
  restart_pending?: boolean
  deployment_readonly?: string[]
  editable_fields?: string[]
}

const POLL_MS = 10_000

// ─────────────────────────────────────────────
// 信息格
// ─────────────────────────────────────────────
function InfoCell({
  label,
  value,
  className,
}: {
  label: string
  value: React.ReactNode
  className?: string
}) {
  return (
    <div className={`${styles.infoCell} ${className ?? ''}`}>
      <div className={styles.infoCellLabel}>{label}</div>
      <div className={styles.infoCellValue}>{value}</div>
    </div>
  )
}

function VSep() {
  return <div className={styles.vsep} />
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await copyText(value)
      setCopied(true)
      message.success('地址已复制')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      message.error('复制失败，请手动复制')
    }
  }

  return (
    <span className={styles.copyValue}>
      <span>{value}</span>
      <Tooltip title={copied ? '已复制' : '复制地址'}>
        <button
          type="button"
          className={styles.copyButton}
          onClick={copy}
          aria-label={copied ? '地址已复制' : '复制地址'}
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </button>
      </Tooltip>
    </span>
  )
}

// ─────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────
export default function ProxyStatusCard() {
  const { refreshTick } = useFilter()

  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [cfg, setCfg] = useState<ProxyConfig | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [operating, setOperating] = useState(false)
  const [autostartBusy, setAutostartBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editForm] = Form.useForm()
  const [editSaving, setEditSaving] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── 数据获取 ───────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await axios.get<ProxyStatus>('/api/proxy/status')
      setStatus(data)
      return data
    } catch {
      const fallback = { running: false, port: 9888, pid: null }
      setStatus(fallback)
      return fallback
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  const fetchConfig = useCallback(async () => {
    try {
      const { data } = await axios.get<ProxyConfig>('/api/proxy/config')
      setCfg(data)
    } catch { /* silent */ }
  }, [])

  const refresh = useCallback(() => {
    setLoadingStatus(true)
    fetchStatus()
    fetchConfig()
  }, [fetchStatus, fetchConfig])

  // 初始化 + 轮询
  useEffect(() => {
    refresh()
    pollRef.current = setInterval(fetchStatus, POLL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [refresh, fetchStatus])

  // 响应页面级刷新（Header 手动刷新按钮）
  useEffect(() => {
    if (refreshTick > 0) refresh()
  }, [refreshTick, refresh])

  // ── 停止代理 ──────────────────────────────
  const handleStop = () => {
    Modal.confirm({
      centered: true,
      title: '停止代理服务',
      content: 'AI 请求将无法转发，Dashboard 统计面板仍可正常访问。确认停止？',
      okText: '确认停止',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setOperating(true)
        try {
          const { data } = await axios.post('/api/proxy/stop')
          if (data.success) {
            message.success(data.message || '代理已停止')
            setTimeout(fetchStatus, 1000)
          } else {
            message.error(data.message || '停止失败')
          }
        } catch (err: unknown) {
          const errMsg = (err as {response?: {data?: {message?: string}}})?.response?.data?.message
          message.error(errMsg || '停止失败')
        } finally {
          setOperating(false)
        }
      },
    })
  }

  // ── 启动代理 ──────────────────────────────────────────
  // 后端 /api/proxy/start 已改为同步模式：
  //   - 等待端口真正绑定后（最多 10 秒）才返回成功/失败
  //   - 前端只需发一次请求，直接根据响应判断结果
  const handleStart = async () => {
    setOperating(true)
    try {
      const { data } = await axios.post('/api/proxy/start')
      if (data.success) {
        message.success(data.message || '代理已启动')
        await fetchStatus()
      } else {
        message.error(data.message || '启动失败')
      }
    } catch (err: unknown) {
      const errMsg = (err as {response?: {data?: {message?: string}}})?.response?.data?.message
      message.error(errMsg || '启动失败')
    } finally {
      setOperating(false)
    }
  }

  // ── 重启代理 ──────────────────────────────────────────
  const handleRestart = async () => {
    setRestarting(true)
    try {
      const { data } = await axios.post('/api/proxy/restart')
      if (data.success) {
        message.success(data.message || '代理已重启')
        await Promise.all([fetchStatus(), fetchConfig()])
      } else {
        message.error(data.message || '重启失败')
      }
    } catch (err: unknown) {
      const errMsg = (err as {response?: {data?: {message?: string}}})?.response?.data?.message
      message.error(errMsg || '重启失败')
    } finally {
      setRestarting(false)
    }
  }

  // ── 切换自启 ──────────────────────────────
  const toggleAutostart = async (checked: boolean) => {
    setAutostartBusy(true)
    const url = checked
      ? '/api/proxy/autostart/install'
      : '/api/proxy/autostart/uninstall'
    try {
      const { data } = await axios.post(url)
      if (data.success) {
        message.success(data.message)
        await fetchConfig()
      } else {
        message.error(data.message || '操作失败')
      }
    } catch {
      message.error('操作失败，请检查服务状态')
    } finally {
      setAutostartBusy(false)
    }
  }

  // ── 编辑弹窗 ──────────────────────────────
  const openEdit = () => {
    editForm.setFieldsValue({
      proxy_port: cfg?.proxy_port ?? cfg?.active_proxy_port ?? status?.port ?? 9888,
      openai_base_url: cfg?.openai_base_url || proxyUrls.openai,
      anthropic_base_url: cfg?.anthropic_base_url || proxyUrls.anthropic,
      request_timeout: cfg?.request_timeout ?? 120,
    })
    setEditOpen(true)
  }

  const saveConfig = async (values: Record<string, unknown>) => {
    setEditSaving(true)
    try {
      const { data } = await axios.put('/api/proxy/config', values)
      if (!data.success) {
        message.error(data.message || '保存失败')
        return
      }
      await fetchConfig()
      setEditOpen(false)

      if (data.restart_required && isRunning) {
        const changedFields = new Set<string>(data.changed_fields ?? [])
        const portChanged = changedFields.has('proxy_port')
        Modal.confirm({
          centered: true,
          title: '需要重启代理',
          content: portChanged
            ? `端口配置已保存。重启会短暂中断代理，并将监听端口从 ${cfg?.active_proxy_port ?? cfg?.proxy_port ?? status?.port ?? '当前端口'} 切换到 ${String(values.proxy_port)}；使用旧端口的客户端随后将无法连接。是否立即重启？`
            : '运行配置已保存，需重启代理才能生效。是否立即重启？',
          okText: '立即重启',
          cancelText: '稍后手动重启',
          onOk: () => handleRestart(),
        })
      } else if (data.restart_required) {
        message.info('配置已保存，下次启动代理时生效')
      } else {
        message.success(data.message || '配置未变化')
      }
    } catch (err: unknown) {
      const errMsg = (err as {response?: {data?: {message?: string}}})?.response?.data?.message
      message.error(errMsg || '保存失败，请重试')
    } finally {
      setEditSaving(false)
    }
  }

  const handleEditSave = async () => {
    let values: Record<string, unknown>
    try {
      values = await editForm.validateFields()
    } catch {
      return
    }

    const currentPort = cfg?.proxy_port ?? cfg?.active_proxy_port ?? status?.port ?? 9888
    const nextPort = Number(values.proxy_port)
    const currentOpenAIBaseUrl = proxyUrls.openai
    const currentAnthropicBaseUrl = proxyUrls.anthropic
    const nextOpenAIBaseUrl = String(values.openai_base_url ?? '').trim().replace(/\/+$/, '')
    const nextAnthropicBaseUrl = String(values.anthropic_base_url ?? '').trim().replace(/\/+$/, '')
    const portChanged = currentPort !== nextPort
    const baseUrlChanged = currentOpenAIBaseUrl !== nextOpenAIBaseUrl
      || currentAnthropicBaseUrl !== nextAnthropicBaseUrl
    const valuesToSave = {
      ...values,
      // 回显自动推导地址，但若用户未改动它，就继续保留“自动”语义，避免改端口后锁死旧地址。
      openai_base_url: !cfg?.openai_base_url && nextOpenAIBaseUrl === currentOpenAIBaseUrl
        ? ''
        : nextOpenAIBaseUrl,
      anthropic_base_url: !cfg?.anthropic_base_url && nextAnthropicBaseUrl === currentAnthropicBaseUrl
        ? ''
        : nextAnthropicBaseUrl,
    }

    if (!portChanged && !baseUrlChanged) {
      await saveConfig(valuesToSave)
      return
    }

    Modal.confirm({
      centered: true,
      title: '确认修改代理连接配置',
      width: 480,
      content: (
        <div style={{ lineHeight: 1.75 }}>
          {portChanged && (
            <p style={{ margin: '0 0 10px' }}>
              代理端口将从 <strong>{currentPort}</strong> 修改为 <strong>{nextPort}</strong>。保存后需重启 Proxy，重启期间请求会短暂中断；重启完成后，仍使用旧端口的客户端将无法连接。
            </p>
          )}
          {baseUrlChanged && (
            <p style={{ margin: 0 }}>
              OpenAI / Anthropic Base URL 将分别更新 Dashboard 中展示和复制的客户端地址。请确认两个地址都能从客户端网络实际访问；它们不会修改上游厂商地址。
            </p>
          )}
        </div>
      ),
      okText: '确认保存',
      cancelText: '返回修改',
      okButtonProps: { danger: portChanged },
      onOk: () => saveConfig(valuesToSave),
    })
  }

  const isRunning = status?.running ?? false
  const autostart = cfg?.autostart_enabled ?? false
  const activeProxyPort = cfg?.active_proxy_port ?? status?.port ?? cfg?.proxy_port ?? 9888
  const proxyUrls = buildProxyBaseUrls(
    {
      proxy_port: activeProxyPort,
      public_base_url: cfg?.public_base_url,
      openai_base_url: cfg?.openai_base_url,
      anthropic_base_url: cfg?.anthropic_base_url,
    },
    window.location,
  )

  const borderColor = isRunning ? 'rgba(16,185,129,0.35)' : 'rgba(244,63,94,0.35)'
  const bgGrad = isRunning ? 'rgba(16,185,129,0.03)' : 'rgba(244,63,94,0.03)'

  return (
    <>
      <Card
        size="small"
        loading={loadingStatus}
        bordered={false}
        style={{
          borderRadius: 8,
          border: `1px solid ${borderColor}`,
          background: bgGrad,
          transition: 'border-color 0.3s, background 0.3s',
        }}
        styles={{ body: { padding: 0 } }}
      >
        {/* ══ 标题行 ═══════════════════════════════════════════ */}
        <div className={styles.titleRow}>
          {/* 左列：服务名 + 融合模块（PC/移动端共用） */}
          <div className={styles.titleLeft}>
            <span className={styles.serviceName}>
              <SettingOutlined style={{ fontSize: 12, color: 'var(--text-muted, #a8a29e)' }} />
              代理服务
            </span>
            <Divider type="vertical" className={`${styles.titleDivider} ${styles.dividerPc}`} />
            {/* 运行状态 + 开机自启 融合模块（PC和移动端共用） */}
            <div className={styles.statusModule}>
              <span className={`${styles.statusChip} ${isRunning ? styles.statusRunning : styles.statusStopped}`}>
                <span className={styles.statusDot} />
                <span className={styles.statusText}>{isRunning ? '运行中' : '已停止'}</span>
              </span>
              <div className={styles.statusModuleDivider} />
              <button
                type="button"
                className={`${styles.autostartBtn} ${autostart ? styles.autostartOn : styles.autostartOff}`}
                onClick={() => !autostartBusy && toggleAutostart(!autostart)}
                disabled={autostartBusy}
                title={autostart ? '已开机自启，点击关闭' : '未开机自启，点击开启'}
                aria-label={autostart ? '关闭代理服务开机自启' : '开启代理服务开机自启'}
              >
                <span className={styles.autostartBtnInner}>
                  <span>开机自启</span>
                  <span className={`${styles.autostartToggleTrack} ${autostart ? styles.autostartToggleOn : ''}`}>
                    <span className={styles.autostartToggleThumb} />
                  </span>
                </span>
              </button>
            </div>
            {/* 移动端编辑按钮（在左列第2行） */}
            <Button
              type="default"
              size="small"
              icon={<EditOutlined />}
              onClick={openEdit}
              className={styles.editBtnMobile}
            >
              编辑
            </Button>
          </div>

          {/* 右列：重启+停止按钮 */}
          <div className={styles.titleRight}>
            <div className={styles.actionBtnGroup}>
              {/* PC端编辑按钮 */}
              <Button
                type="default"
                size="small"
                icon={<EditOutlined />}
                onClick={openEdit}
                className={styles.editBtnPc}
              >
                编辑
              </Button>

              {/* 重启（运行中才显示） */}
              {isRunning && (
                <Button
                  type="default"
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={restarting}
                  onClick={() => handleRestart()}
                >
                  重启
                </Button>
              )}

              <Divider type="vertical" className={`${styles.titleDivider} ${styles.dividerInline}`} />

              {/* 停止 / 启动 */}
              {isRunning ? (
                <Button
                  size="small"
                  danger
                  type="primary"
                  icon={<StopOutlined />}
                  loading={operating}
                  onClick={handleStop}
                >
                  停止
                </Button>
              ) : (
                <Button
                  size="small"
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={operating}
                  onClick={handleStart}
                  style={{ background: 'var(--color-success)', borderColor: 'var(--color-success)' }}
                >
                  启动
                </Button>
              )}
            </div>

          </div>
        </div>

        {/* ══ 信息行 ═══════════════════════════════════════════ */}
        <div className={styles.infoRow}>
          <InfoCell label="OpenAI Base URL" value={<CopyValue value={proxyUrls.openai} />} className={styles.infoCellFull} />
          <VSep />
          <InfoCell label="Anthropic Base URL" value={<CopyValue value={proxyUrls.anthropic} />} className={styles.infoCellFull} />
          <VSep />
          {/* 端口三项：超时时间 / 代理端口 / 系统端口 */}
          <div className={styles.portRow}>
            <InfoCell
              label="超时时间"
              value={cfg ? `${cfg.request_timeout}s` : '—'}
              className={styles.portCell}
            />
            <VSep />
            <InfoCell
              label="代理端口"
              value={cfg
                ? cfg.restart_pending
                  ? <span>{activeProxyPort} <small style={{ color: 'var(--color-warning)' }}>待切换至 {cfg.proxy_port}</small></span>
                  : String(activeProxyPort)
                : '—'}
              className={styles.portCell}
            />
            <VSep />
            <InfoCell
              label="系统端口"
              value={cfg ? String(cfg.dashboard_port) : '—'}
              className={styles.portCell}
            />
          </div>
        </div>
      </Card>

      {/* ══ 编辑代理配置弹窗 ══════════════════════════════════ */}
      <AppModal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EditOutlined style={{ color: 'var(--color-info)' }} />
            <span>编辑代理配置</span>
          </div>
        }
        open={editOpen}
        onOk={handleEditSave}
        onCancel={() => setEditOpen(false)}
        okText="保存配置"
        cancelText="取消"
        confirmLoading={editSaving}
        width={480}
        destroyOnClose
      >
        <Form
          form={editForm}
          layout="vertical"
          requiredMark={false}
          style={{ marginTop: 4 }}
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              label="代理端口"
              name="proxy_port"
              rules={[
                { required: true, message: '请输入代理端口' },
                { type: 'number', min: 1024, max: 65535, message: '端口范围 1024–65535' },
              ]}
              style={{ flex: 1 }}
            >
              <InputNumber min={1024} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              label="超时时间"
              name="request_timeout"
              rules={[
                { required: true, message: '请输入超时时间' },
                { type: 'number', min: 10, max: 600, message: '范围 10–600 秒' },
              ]}
              style={{ flex: 1 }}
            >
              <InputNumber
                min={10}
                max={600}
                addonAfter="秒"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </div>

          <Form.Item
            label="OpenAI Base URL"
            name="openai_base_url"
            tooltip="OpenAI 客户端使用的完整 Base URL，不会修改上游厂商地址。"
            rules={[
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve()
                  try {
                    const url = new URL(String(value))
                    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                      throw new Error('invalid')
                    }
                    return Promise.resolve()
                  } catch {
                    return Promise.reject(new Error('请输入有效的 http:// 或 https:// 地址，且不要包含账号、查询参数或锚点'))
                  }
                },
              },
            ]}
            extra="例如 http://NAS-IP:9888/openai。"
          >
            <Input placeholder="例如：https://gateway.example.com/openai" allowClear />
          </Form.Item>

          <Form.Item
            label="Anthropic Base URL"
            name="anthropic_base_url"
            tooltip="Anthropic 客户端使用的完整 Base URL，不会修改上游厂商地址。"
            rules={[
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve()
                  try {
                    const url = new URL(String(value))
                    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                      throw new Error('invalid')
                    }
                    return Promise.resolve()
                  } catch {
                    return Promise.reject(new Error('请输入有效的 http:// 或 https:// 地址，且不要包含账号、查询参数或锚点'))
                  }
                },
              },
            ]}
            extra="例如 http://NAS-IP:9888/anthropic。"
          >
            <Input placeholder="例如：https://gateway.example.com/anthropic" allowClear />
          </Form.Item>

          {/* 提示信息 */}
          <div style={{
            background: 'rgba(99,102,241,0.06)',
            border: '1px solid rgba(99,102,241,0.15)',
            borderRadius: 6,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: 12,
            color: 'var(--text-muted)',
            lineHeight: 1.7,
          }}>
            <span style={{ color: 'var(--color-info)', fontWeight: 500 }}>💡</span>
            {' '}代理端口和超时时间保存后需<strong style={{ color: 'var(--text-secondary)' }}>重启代理</strong>生效；两个 Base URL 分别更新展示和复制地址并立即生效；系统端口仍由部署配置管理。
          </div>
        </Form>
      </AppModal>
    </>
  )
}
