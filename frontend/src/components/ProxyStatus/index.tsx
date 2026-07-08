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
  message, Divider,
} from 'antd'
import {
  PlayCircleOutlined, StopOutlined, EditOutlined,
  ReloadOutlined, SettingOutlined,
} from '@ant-design/icons'
import axios from 'axios'
import { useFilter } from '../../context/FilterContext'
import styles from './ProxyStatus.module.css'

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────
interface ProxyStatus {
  running: boolean
  port: number
  pid: number | null
}

interface ProxyConfig {
  proxy_port: number
  dashboard_port: number
  proxy_path: string
  upstream_url: string
  request_timeout: number
  autostart_enabled: boolean
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
      const fallback = { running: false, port: 8888, pid: null }
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
  }, [refreshTick])

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
        } catch {
          message.error('停止失败')
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
  // oldPort: 端口变更场景传入旧端口，先停旧端口进程再启新端口
  const handleRestart = async (oldPort?: number) => {
    setRestarting(true)
    try {
      const { data } = await axios.post('/api/proxy/restart')
      if (data.success) {
        message.success(data.message || '代理已重启')
        await fetchStatus()
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
      proxy_port: cfg?.proxy_port ?? 8888,
      request_timeout: cfg?.request_timeout ?? 120,
    })
    setEditOpen(true)
  }

  const handleEditSave = async () => {
    let values: Record<string, unknown>
    try {
      values = await editForm.validateFields()
    } catch {
      return // 表单校验失败，不继续
    }

    const portChanged = cfg?.proxy_port !== values.proxy_port
    const pathChanged = cfg?.proxy_path !== values.proxy_path
    const oldPort = cfg?.proxy_port

    // ── 端口变更：先弹风险确认弹窗，用户取消则不保存配置 ──
    if (portChanged) {
      Modal.confirm({
        centered: true,
        title: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: '#fff7e6',
              border: '1.5px solid #fa8c16',
              color: '#fa8c16',
              fontSize: 13,
              fontWeight: 700,
              flexShrink: 0,
            }}>!</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary, #1c1917)' }}>
              确认修改代理端口？
            </span>
          </div>
        ),
        icon: null,
        width: 420,
        content: (
          <div style={{ lineHeight: 1.75, fontSize: 13, paddingTop: 4 }}>
            <p style={{ marginBottom: 12, color: 'var(--text-secondary, #374151)' }}>
              你正在将代理端口从{' '}
              <strong style={{ color: '#1d1d1f', fontWeight: 700 }}>{oldPort}</strong>{' '}
              修改为{' '}
              <strong style={{ color: '#1d1d1f', fontWeight: 700 }}>{values.proxy_port as number}</strong>。
            </p>
            <div style={{
              background: 'rgba(244,63,94,0.06)',
              border: '1px solid rgba(244,63,94,0.2)',
              borderRadius: 8,
              padding: '10px 12px',
              color: '#be123c',
              fontSize: 13,
              lineHeight: 1.7,
            }}>
              原端口 <strong style={{ fontWeight: 700 }}>{oldPort}</strong> 将停止服务，所有配置了旧端口的调用方（如 AI 客户端、脚本等）均需更新端口配置，否则请求将失败。
            </div>
          </div>
        ),
        okText: '立即重启',
        cancelText: '取消',
        okButtonProps: { danger: true },
        // 用户点取消：不保存，弹窗关闭，编辑框保持打开
        onCancel: () => { /* 什么都不做，保持 editOpen=true */ },
        onOk: async () => {
          // 用户确认：才保存配置，再重启
          setEditSaving(true)
          try {
            const { data } = await axios.put('/api/proxy/config', values)
            if (!data.success) {
              message.error(data.message || '保存失败')
              return
            }
            await fetchConfig()
            setEditOpen(false)
            await handleRestart(oldPort) // 传旧端口，先停旧端口再启新端口
          } catch {
            message.error('保存或重启失败，请重试')
          } finally {
            setEditSaving(false)
          }
        },
      })
      return // 弹窗处理，handleEditSave 直接返回
    }

    // ── 非端口变更：直接保存 ──
    setEditSaving(true)
    try {
      const { data } = await axios.put('/api/proxy/config', values)
      if (!data.success) {
        message.error(data.message || '保存失败')
        return
      }
      await fetchConfig()
      setEditOpen(false)

      if (pathChanged && isRunning) {
        Modal.confirm({
          centered: true,
          title: '需要重启代理',
          content: '代理路径已修改，需重启代理才能生效。是否立即重启？',
          okText: '立即重启',
          cancelText: '稍后手动重启',
          onOk: () => handleRestart(),
        })
      } else if (pathChanged) {
        message.info('配置已保存，下次启动代理时生效')
      } else {
        message.success('配置已保存，立即生效')
      }
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setEditSaving(false)
    }
  }

  const isRunning = status?.running ?? false
  const autostart = cfg?.autostart_enabled ?? false
  const proxyAddrOpenAI = cfg ? `localhost:${cfg.proxy_port}/openai` : `localhost:${status?.port ?? 8888}/openai`
  const proxyAddrAnthropic = cfg ? `localhost:${cfg.proxy_port}/anthropic` : `localhost:${status?.port ?? 8888}/anthropic`

  const borderColor = isRunning ? 'var(--color-success-bg)' : 'var(--color-danger-bg)'
  const bgGrad = isRunning ? 'var(--color-success-bg)' : 'var(--color-danger-bg)'

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
                className={`${styles.autostartBtn} ${autostart ? styles.autostartOn : styles.autostartOff}`}
                onClick={() => !autostartBusy && toggleAutostart(!autostart)}
                disabled={autostartBusy}
                title={autostart ? '已开机自启，点击关闭' : '未开机自启，点击开启'}
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
          <InfoCell label="BaseURL-OpenAI" value={proxyAddrOpenAI} className={styles.infoCellFull} />
          <VSep />
          <InfoCell label="BaseURL-Anthropic" value={proxyAddrAnthropic} className={styles.infoCellFull} />
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
              value={cfg ? String(cfg.proxy_port) : '—'}
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
      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EditOutlined style={{ color: '#6366f1' }} />
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
        styles={{
          body: { padding: '12px 24px 4px' },
        }}
      >
        <Form
          form={editForm}
          layout="vertical"
          requiredMark={false}
          style={{ marginTop: 4 }}
        >
          {/* 代理端口 + 超时时间（同行等宽两列） */}
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              label="代理端口"
              name="proxy_port"
              rules={[
                { required: true, message: '请输入端口' },
                { type: 'number', min: 1024, max: 65535, message: '端口范围 1024–65535' },
              ]}
              style={{ flex: 1 }}
            >
              <InputNumber
                min={1024}
                max={65535}
                style={{ width: '100%' }}
                placeholder="8888"
                suffix={<span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>重启生效</span>}
              />
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
            <span style={{ color: '#6366f1', fontWeight: 500 }}>💡</span>
            {' '}超时时间<strong style={{ color: 'var(--text-secondary)' }}>立即生效</strong>；代理端口需<strong style={{ color: 'var(--text-secondary)' }}>重启代理</strong>后生效。
          </div>
        </Form>
      </Modal>
    </>
  )
}
