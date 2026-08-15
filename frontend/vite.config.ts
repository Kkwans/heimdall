import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    // Vite 8 使用 Rolldown 时，显式把共享依赖按用途分组，避免
    // React/Ant Design/ECharts 混入一个不可控的公共 chunk。上限只
    // 影响构建拆分，不改变运行时路由或组件行为。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/]react(?:-dom)?|node_modules[\\/]react-router-dom/,
              priority: 20,
              minSize: 32 * 1024,
              maxSize: 450 * 1024,
            },
            {
              name: 'antd-vendor',
              test: /node_modules[\\/](?:antd|@ant-design)[\\/]/,
              priority: 15,
              minSize: 32 * 1024,
              maxSize: 450 * 1024,
            },
            {
              name: 'echarts-vendor',
              test: /node_modules[\\/](?:echarts|echarts-for-react)[\\/]/,
              priority: 15,
              minSize: 32 * 1024,
              maxSize: 450 * 1024,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // Dashboard 服务独立端口 8889（代理服务 8888 解耦）
        target: 'http://localhost:8889',
        changeOrigin: true,
      },
      '/dashboard': {
        target: 'http://localhost:8889',
        changeOrigin: true,
      },
    },
  },
})
