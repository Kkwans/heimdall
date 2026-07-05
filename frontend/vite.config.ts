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
