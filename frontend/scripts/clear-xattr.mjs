import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const result = spawnSync('xattr', ['-rc', 'dist'], { stdio: 'inherit' })
if (result.error || result.status !== 0) {
  console.warn('可选的 xattr 清理未完成，不影响已通过的 TypeScript 和 Vite 构建。')
}
