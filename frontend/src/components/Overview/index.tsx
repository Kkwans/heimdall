import React, { useEffect, useState, useCallback } from 'react'
import { Card, Row, Col, Tooltip } from 'antd'
import {
  ThunderboltOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
} from '@ant-design/icons'
import { fetchOverview } from '../../api/stats'
import { useFilter } from '../../context/FilterContext'
import { useStableData } from '../../hooks/useStableData'
import type { OverviewData } from '../../types'
import styles from './Overview.module.css'
import { fmtTokens as formatTokens } from '../../utils/format'

export default function Overview() {
  const { dateRange, refreshTick, backgroundTick } = useFilter()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const { setIfChanged } = useStableData()

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const result = await fetchOverview({ start_date: dateRange.start, end_date: dateRange.end })
      if (silent) {
        // 后台刷新：只在数据变化时才更新，防止无意义重渲染闪烁
        setIfChanged(result, setData)
      } else {
        setData(result)
      }
    } catch (e) {
      if (!silent) console.error(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [dateRange.start, dateRange.end])

  // 前台刷新（参数变化 or 手动刷新）
  useEffect(() => { fetchData(false) }, [fetchData, refreshTick])

  // 后台静默刷新（不显示 loading，数据无变化不重渲染）
  useEffect(() => {
    if (backgroundTick > 0) fetchData(true)
  }, [backgroundTick])

  const successRate = data
    ? data.total_requests > 0
      ? ((data.success_requests / data.total_requests) * 100).toFixed(1)
      : '100.0'
    : '-'

  const cacheHitPct = data
    ? (data.cache_hit_rate * 100).toFixed(1)
    : '-'

  return (
    <Row gutter={[16, 16]} className={styles.row}>
      {/* 卡片1：请求总数 */}
      <Col xs={24} sm={12} lg={6}>
        <Card className={styles.card} loading={loading} bordered={false}>
          <div className={styles.cardInner}>
            <div className={styles.iconWrap} style={{ background: 'rgba(14,165,233,0.10)' }}>
              <ApiOutlined style={{ color: '#0ea5e9', fontSize: 20 }} />
            </div>
            <div className={styles.stats}>
              <div className={styles.label}>总请求数</div>
              <div className={styles.value}>{data ? data.total_requests.toLocaleString() : '-'}</div>
              <div className={styles.sub}>
                成功率{' '}
                <span style={{ color: 'var(--color-success)' }}>{successRate}%</span>
                {data && data.error_requests > 0 && (
                  <span style={{ color: 'var(--color-danger)', marginLeft: 8 }}>
                    {data.error_requests} 失败
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      </Col>

      {/* 卡片2：Token 消耗 */}
      <Col xs={24} sm={12} lg={6}>
        <Card className={styles.card} loading={loading} bordered={false}>
          <div className={styles.cardInner}>
            <div className={styles.iconWrap} style={{ background: 'rgba(245,158,11,0.10)' }}>
              <DatabaseOutlined style={{ color: 'var(--color-warning)', fontSize: 20 }} />
            </div>
            <div className={styles.stats}>
              <div className={styles.label}>总 Token 消耗</div>
              <div className={styles.value}>{data ? formatTokens(data.total_tokens) : '-'}</div>
              <div className={styles.sub}>
                <Tooltip title={`输入: ${data?.total_prompt_tokens?.toLocaleString() ?? 0}`}>
                  <span style={{ color: '#0ea5e9' }}>↑{formatTokens(data?.total_prompt_tokens ?? 0)}</span>
                </Tooltip>
                {' '}
                <Tooltip title={`输出: ${data?.total_completion_tokens?.toLocaleString() ?? 0}`}>
                  <span style={{ color: 'var(--color-success)' }}>↓{formatTokens(data?.total_completion_tokens ?? 0)}</span>
                </Tooltip>
              </div>
            </div>
          </div>
        </Card>
      </Col>

      {/* 卡片3：平均耗时 */}
      <Col xs={24} sm={12} lg={6}>
        <Card className={styles.card} loading={loading} bordered={false}>
          <div className={styles.cardInner}>
            <div className={styles.iconWrap} style={{ background: 'rgba(16,185,129,0.10)' }}>
              <ClockCircleOutlined style={{ color: 'var(--color-success)', fontSize: 20 }} />
            </div>
            <div className={styles.stats}>
              <div className={styles.label}>平均耗时</div>
              <div className={styles.value}>
                {data
                  ? data.avg_latency_ms < 1000
                    ? `${Math.round(data.avg_latency_ms)}ms`
                    : `${(data.avg_latency_ms / 1000).toFixed(1)}s`
                  : '-'}
              </div>
              <div className={styles.sub}>
                P90{' '}
                <span style={{ color: 'var(--color-warning)' }}>
                  {data
                    ? data.p90_latency_ms < 1000
                      ? `${data.p90_latency_ms}ms`
                      : `${(data.p90_latency_ms / 1000).toFixed(1)}s`
                    : '-'}
                </span>
                {'  '}P99{' '}
                <span style={{ color: 'var(--color-danger)' }}>
                  {data
                    ? data.p99_latency_ms < 1000
                      ? `${data.p99_latency_ms}ms`
                      : `${(data.p99_latency_ms / 1000).toFixed(1)}s`
                    : '-'}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </Col>

      {/* 卡片4：缓存命中率 */}
      <Col xs={24} sm={12} lg={6}>
        <Card className={styles.card} loading={loading} bordered={false}>
          <div className={styles.cardInner}>
            <div className={styles.iconWrap} style={{ background: 'rgba(244,63,94,0.10)' }}>
              <ThunderboltOutlined style={{ color: 'var(--color-danger)', fontSize: 20 }} />
            </div>
            <div className={styles.stats}>
              <div className={styles.label}>缓存命中率</div>
              <div className={styles.value}>{cacheHitPct}%</div>
              <div className={styles.sub}>
                命中{' '}
                <span style={{ color: 'var(--color-warning)' }}>
                  {formatTokens(data?.total_cache_hit_tokens ?? 0)}
                </span>{' '}
                tokens
              </div>
            </div>
          </div>
        </Card>
      </Col>
    </Row>
  )
}
