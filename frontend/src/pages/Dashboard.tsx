import React from 'react'
import { Row, Col } from 'antd'
import Overview from '../components/Overview'
import RequestTrend from '../components/Charts/RequestTrend'
import TokenTrend from '../components/Charts/TokenTrend'
import ModelDistribution from '../components/Charts/ModelDistribution'
import LatencyHistogram from '../components/Charts/LatencyHistogram'
import ModelTokenBar from '../components/Charts/ModelTokenBar'
import CacheHitTrend from '../components/Charts/CacheHitTrend'
import ProxyStatusCard from '../components/ProxyStatus'
import Header from '../components/Header'

export default function Dashboard() {
  return (
    <div className="page-content">
      {/* PC端：左边显示仪表盘标题，右边显示日期筛选+刷新；移动端：仅显示筛选模块 */}
      <Header pageName="仪表盘" />

      {/* 代理状态卡片（占满整行） */}
      <section className="section">
        <div style={{ marginBottom: 12 }}>
          <ProxyStatusCard />
        </div>
        <Overview />
      </section>

      {/* 图表区：2 列网格 */}
      <section className="section">
        <div className="charts-grid">
          <RequestTrend />
          <TokenTrend />
          <ModelDistribution />
          <LatencyHistogram />
          <ModelTokenBar />
          <CacheHitTrend />
        </div>
      </section>
    </div>
  )
}
