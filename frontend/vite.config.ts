import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

/**
 * macOS com.apple.provenance xattr 消除插件
 *
 * vite build 完成后，把 dist/ 下所有文件逐一"重写"（read + write）。
 * 重新写入的文件由当前进程创建，不会继承 provenance 扩展属性。
 * 这比 `xattr -rc` 更可靠 —— xattr 命令在某些进程上下文（launchd/CI）中
 * 会静默失败，而直接文件 I/O 始终有效。
 */
function stripProvenance(): import('vite').Plugin {
  return {
    name: 'strip-provenance',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist')
      if (!fs.existsSync(distDir)) return

      let count = 0
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
          } else if (entry.isFile()) {
            try {
              const data = fs.readFileSync(full)
              fs.writeFileSync(full, data)
              count++
            } catch {
              // ignore
            }
          }
        }
      }
      walk(distDir)
      console.log(`[strip-provenance] rewrote ${count} files in dist/`)

      // 同步到 /tmp/heimdall-dist（launchd Dashboard 进程从那里读文件）
      // 这样 build 后不需要重启 Dashboard 进程也能立刻看到新版本
      const tmpDist = '/tmp/heimdall-dist'
      try {
        if (fs.existsSync(tmpDist)) {
          fs.rmSync(tmpDist, { recursive: true, force: true })
        }
        const copyDir = (src: string, dest: string) => {
          fs.mkdirSync(dest, { recursive: true })
          for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name)
            const d = path.join(dest, entry.name)
            if (entry.isDirectory()) copyDir(s, d)
            else fs.copyFileSync(s, d)
          }
        }
        copyDir(distDir, tmpDist)
        console.log(`[strip-provenance] synced to ${tmpDist}`)
      } catch (e) {
        console.warn(`[strip-provenance] sync to /tmp failed:`, e)
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), stripProvenance()],
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
