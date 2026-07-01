# Heimdall

> 本地 AI 请求代理 + 实时监控面板

在 AI 客户端（OpenClaw / Cursor / 任何 OpenAI SDK）与上游 API 之间运行一个轻量代理，拦截并转发请求，同时在独立的 Web 面板上实时展示请求统计、Token 消耗、延迟分析、AI Credit 余额等数据。

---

## 架构

![Heimdall 系统架构](docs/architecture-diagram.png)

代理进程与面板进程**完全解耦**，两个进程均由 **macOS launchd 独立守护**（崩溃自动重启、开机自动启动），互不影响。

---

## 目录结构

```
Heimdall/
├── backend/                    后端 Python 服务
│   ├── proxy.py                  主入口：双进程启动、日志系统、launchd 集成
│   ├── stats_api.py              统计 API + 代理管理 API + Dashboard 静态托管
│   ├── credit_api.py             AI Credit 代理 API（Friday 余额/消耗记录）
│   ├── db.py                     SQLite 数据库操作层（WAL 模式）
│   └── config.py                 全局配置（端口、路径、模型映射等）
│
├── frontend/                   前端 React 项目
│   ├── src/
│   │   ├── pages/                5 个功能页面（仪表盘 / 请求明细 / 数据统计 / 实时日志 / AI Credit）
│   │   ├── components/
│   │   │   ├── Charts/           ECharts 图表组件（趋势图、饼图、热力图、直方图等）
│   │   │   ├── Header/           顶栏（刷新控制、自动刷新间隔、日期筛选）
│   │   │   ├── Layout/           侧边栏 / 底部导航 / 移动端抽屉
│   │   │   ├── Overview/         数据总览卡片
│   │   │   ├── ProxyStatus/      代理状态卡片（启停、配置编辑、自启管理）
│   │   │   └── RequestTable/     请求记录表格（展开查看完整 prompt/response）
│   │   ├── context/              全局状态（筛选条件、主题切换）
│   │   ├── hooks/                自定义 Hook（刷新间隔、数据稳定化）
│   │   ├── api/                  后端接口封装
│   │   └── types/                TypeScript 类型定义
│   ├── dist/                   构建产物（由面板进程静态托管，git 忽略）
│   ├── public/                 静态资源（favicon、图标）
│   ├── vite.config.ts
│   └── package.json
│
├── data/                       运行时数据（git 忽略）
│   ├── heimdall.db               SQLite 请求记录数据库（WAL 模式）
│   └── runtime_config.json       运行时可编辑配置（面板内修改后持久化）
│
├── logs/                       日志文件（按日归档，保留 30 天，git 忽略）
│   ├── proxy-business.log        业务日志（请求拦截、转发、Token 统计摘要）
│   ├── proxy-system.log          系统日志（启动信息、stderr 输出、错误堆栈）
│   └── *.log.YYYY-MM-DD          历史归档日志（每日零点自动归档）
│
├── scripts/                    服务管理脚本
│   ├── heimdall.sh               全局命令：两者同时控制 + 开机自启安装
│   ├── proxy.sh                  代理服务独立命令
│   ├── dashboard.sh              统计面板独立命令
│   └── _common.sh                公共变量与函数库（被上面三个脚本 source）
│
├── docs/                       项目文档与参考资料
│   ├── architecture-diagram.png  系统架构图（高清 PNG）
│   ├── architecture-diagram.html 架构图源文件（HTML/CSS）
│   ├── friday-models.html        FRIDAY 大模型导航（可视化列表）
│   └── friday-models.md          FRIDAY 大模型导航（Markdown 版本）
│
└── README.md
```

---

## 快速开始

### 环境依赖

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| macOS | 12+ | launchd 守护进程支持 |
| Python | 3.9+ | 系统自带 `/usr/bin/python3` 即可 |
| Node.js | 18+ | 仅修改前端代码时需要 |

安装 Python 依赖：

```bash
pip3 install flask requests
```

### 首次安装

执行一次 install，自动注册开机自启并安装三个全局命令（`heimdall` / `proxy` / `dashboard`）：

```bash
./scripts/heimdall.sh install
```

安装完成后，系统每次登录时代理与面板自动在后台启动，无需手动操作。两个进程均由 launchd 独立守护，崩溃后 5 秒内自动重启。

### 客户端配置

在 OpenClaw、Cursor 或任何支持自定义 API 地址的客户端中填入：

```
API Base URL:  http://localhost:8888/v1/openai/native
API Key:       <上游服务的真实 Key，或任意字符串>
```

> 代理完全透明，原样传递 Authorization Header，无需修改 Key。

统计面板地址：**http://localhost:8889/dashboard/**

---

## 服务管理

安装后可使用三个全局命令，语义清晰，各自独立：

### `heimdall` — 全局管理

```bash
heimdall start      # 同时启动代理 + 面板
heimdall stop       # 同时停止代理 + 面板
heimdall restart    # 同时重启代理 + 面板
heimdall status     # 查看两者运行状态
heimdall install    # 首次安装：启动服务 + 开机自启 + 注册全局命令
heimdall enable     # 仅开启开机自启（服务和全局命令不受影响）
heimdall disable    # 仅关闭开机自启（服务和全局命令不受影响）
heimdall uninstall  # ⚠️  完全卸载：停止服务 + 关闭开机自启 + 移除全局命令
                    #     执行后 heimdall 命令消失，需用绝对路径重新安装：
                    #     bash ./scripts/heimdall.sh install
heimdall logs       # 实时查看业务日志
```

### `proxy` — 代理服务（:8888）

```bash
proxy start    # 启动代理
proxy stop     # 停止代理（面板不受影响）
proxy restart  # 重启代理
proxy status   # 查看代理状态
```

### `dashboard` — 统计面板（:8889）

```bash
dashboard start    # 启动面板
dashboard stop     # 停止面板（代理不受影响）
dashboard restart  # 重启面板
dashboard status   # 查看面板状态
```

> **尚未执行 `install` 时**，可用 `./scripts/heimdall.sh <命令>` 代替 `heimdall <命令>`，其余两个命令同理。

---

## 配置说明

所有配置项在 `backend/config.py` 中定义，支持通过环境变量覆盖；也可在面板的**编辑代理配置**弹窗中在线修改，修改后持久化到 `data/runtime_config.json`。

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `HEIMDALL_PORT` | `8888` | 代理服务端口 |
| `HEIMDALL_DASHBOARD_PORT` | `8889` | 面板服务端口 |
| `HEIMDALL_PROXY_PATH` | `/v1/openai/native` | 代理请求路径前缀 |
| `HEIMDALL_TIMEOUT` | `120` | 上游请求超时（秒） |
| `HEIMDALL_DETAIL_LOG` | `false` | 是否记录完整 prompt/response（开启后磁盘占用增大） |
| `HEIMDALL_LOG_BACKUP_DAYS` | `30` | 日志保留天数（也可在日志页面在线修改） |

---

## 功能一览

| 页面 | 功能 |
|------|------|
| **仪表盘** | 总览卡片（请求数、成功率、Token、P50/P90/P99 延迟、缓存命中率）、请求趋势图、Token 趋势图、模型分布饼图、各模型 Token 消耗条形图、延迟直方图、缓存命中趋势图、代理状态卡片（启停/重启/配置编辑/开机自启管理） |
| **请求明细** | 全量请求记录，支持按模型、日期、状态筛选和多字段排序，可展开查看完整 prompt/response（需开启 `HEIMDALL_DETAIL_LOG`），支持查看错误详情 |
| **数据统计** | 按模型维度统计请求量、成功率、Token、延迟；错误码分布分析；每小时请求热力图；每日请求趋势（成功/失败堆叠）；每日 Token 消耗趋势；每日缓存命中率趋势；每日平均耗时趋势；Token 按模型占比饼图；流式请求三段耗时对比（TTFT/传输/总耗时） |
| **实时日志** | SSE 实时推送日志流（今日）；支持查看历史归档日志（任意日期）；业务日志 / 系统日志切换；按 INFO / WARN / ERROR 级别筛选；支持在线修改日志保留天数 |
| **AI Credit** | 查询 Friday AI Credit 余额、配额、有效期；每日消耗趋势图 + 按产品占比饼图；消耗记录明细表格；支持本机浏览器 Cookie 一键自动同步（免登录）；远程设备通过服务端持久化 Cookie 访问 |

---

## AI Credit 功能说明

**AI Credit** 页面用于实时查看 friday.sankuai.com 的 AI Credit 账户状态，无需打开浏览器。

### 认证方式

**本机访问**（推荐）：点击"一键同步 Cookie"，自动从本机 Chrome/Safari 读取 friday.sankuai.com 的登录态，存入服务端，后续无需手动操作。

**远程访问**（Tailscale 等场景）：在本机完成 Cookie 同步后，其他设备通过 Tailscale IP 访问时，服务端自动使用已存储的 Cookie，无需远程设备登录。

**手动粘贴**：从浏览器开发者工具复制 Cookie 字符串，粘贴到输入框保存。

### 缓存策略

- 历史数据（T-1 及之前）：每天首次请求成功后落库，之后直接读本地缓存，不重复请求 Friday
- 今日数据：每次实时请求 Friday（数据随时变化）
- Friday 接口不可用时：返回本地历史缓存 + 标注今日数据不可用

---

## 日志系统

### 日志文件

| 文件 | 内容 |
|------|------|
| `proxy-business.log` | 每次 AI 请求的摘要：模型、Token、延迟、状态码 |
| `proxy-system.log` | 进程启动/停止、系统错误、未捕获异常的完整堆栈 |

### 自动归档

进程每天零点自动将当天以前的日志按日期归档（如 `proxy-system.log.2026-06-18`），当前日志文件始终只保留今日内容。超过保留天数（默认 30 天）的归档文件自动删除。

进程重启时会补充归档历史遗漏的日志（跨天未运行时不会丢失日志）。

---

## launchd 守护机制

安装后，两个服务均通过 macOS launchd 管理：

| plist | 说明 |
|-------|------|
| `~/Library/LaunchAgents/com.heimdall.proxy.plist` | 代理服务（:8888） |
| `~/Library/LaunchAgents/com.heimdall.dashboard.plist` | Dashboard 服务（:8889） |

两者均配置 `KeepAlive`（非正常退出自动重启）、`ThrottleInterval=5s`（防止崩溃循环）、`RunAtLoad`（登录即启动）。

这确保了即使进程因 macOS TCC 权限刷新、内存压力等原因崩溃，也会在 5 秒内自动恢复，用户无感知。

---

## 前端构建

修改前端代码后需要重新构建，构建产物由面板进程直接托管：

```bash
cd frontend
npm install
npm run build     # 产物输出至 frontend/dist/，重启面板后生效
```

重启面板使新构建生效：

```bash
dashboard restart
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python 3.9 · Flask 3.x · SQLite（WAL 模式） |
| 进程守护 | macOS launchd（`~/Library/LaunchAgents/`） |
| 前端 | React 18 · TypeScript · Ant Design 5.x · Apache ECharts |
| 构建工具 | Vite · Node.js 18+ |
| 实时推送 | Server-Sent Events（SSE）日志流 |
| 数据缓存 | SQLite 本地缓存（AI Credit 历史数据） |
