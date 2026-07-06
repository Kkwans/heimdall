# Heimdall

AI 请求代理 + 实时监控面板。统一 OpenAI 协议接口，支持多厂商模型路由。

## 功能特性

- **多上游路由**：根据 model 参数自动路由到对应的 AI 厂商 API
- **OpenAI 兼容**：标准 `/v1/chat/completions` 接口，兼容所有 OpenAI SDK
- **实时监控**：Dashboard 展示请求量、Token 消耗、延迟分布等统计
- **请求日志**：完整记录每个请求的 model/token/延迟/状态
- **流式支持**：支持 SSE 流式响应，记录 TTFB 和输出时间
- **厂商管理**：通过 Web 界面管理厂商配置和模型映射
- **容器管理**：支持代理服务的停止/启动/重启/开机自启

## 架构

```
客户端 ──→ Heimdall Proxy ──→ 厂商 A API
         (OpenAI 协议)      ──→ 厂商 B API
                            ──→ 厂商 C API

Heimdall Dashboard ──→ 统计 API / 管理 API / 前端静态文件
```

- **Proxy**：AI 请求转发、Token 统计、日志记录
- **Dashboard**：统计面板、厂商管理、请求详情

## 快速开始

### Docker Compose 部署

```bash
# 克隆项目
git clone https://github.com/Kkwans/heimdall.git
cd heimdall

# 构建前端
docker run --rm -v $(pwd)/frontend:/app -w /app node:20-alpine \
  sh -c "npm install && npm run build"

# 构建镜像
docker build -f Dockerfile-proxy -t heimdall-proxy:latest .
docker build -f Dockerfile-dashboard -t heimdall-dashboard:latest .

# 启动服务
docker compose up -d
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | 9888 | 代理服务外部端口 |
| `DASHBOARD_PORT` | 8889 | Dashboard 端口 |
| `HEIMDALL_PROXY_PATH` | /v1/chat/completions | 代理路径 |
| `HEIMDALL_TIMEOUT` | 120 | 请求超时（秒） |
| `HEIMDALL_DETAIL_LOG` | false | 详细日志 |
| `HEIMDALL_LOG_BACKUP_DAYS` | 30 | 日志保留天数 |

## 使用方式

### API 调用

```bash
# 非流式
curl http://localhost:9888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "provider/model-name",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'

# 流式
curl http://localhost:9888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "provider/model-name",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 模型格式

- `provider/model`：指定厂商，如 `mimo/mimo-v2.5`
- `model`：使用默认厂商（优先级最高），如 `mimo-v2.5`

### Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9888/v1",
    api_key="YOUR_API_KEY"
)

resp = client.chat.completions.create(
    model="mimo/mimo-v2.5",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=100
)
print(resp.choices[0].message.content)
```

## Dashboard

启动后访问 Dashboard：

- **面板**：`http://localhost:8889/dashboard/`
- **管理后台**：`http://localhost:8889/dashboard/#/admin`

### 功能页面

| 页面 | 功能 |
|------|------|
| 仪表盘 | 代理状态、请求趋势、Token 消耗 |
| 请求明细 | 完整请求列表、详情查看 |
| 数据统计 | 模型维度、厂商维度、延迟分布 |
| 实时日志 | 业务日志、系统日志 |
| 管理后台 | 厂商管理、模型管理、API Key 管理 |

## 配置厂商

1. 打开管理后台（`/#/admin`）
2. 点击"添加厂商"
3. 填写厂商信息：
   - **厂商标识**：用于 model 参数前缀（如 `mimo`）
   - **API 地址**：厂商的 API 端点
   - **API Key**：厂商的 API 密钥
4. 添加模型：
   - **模型名称**：客户端使用的模型名
   - **上游模型名**：厂商实际的模型名（可选）
   - **上下文窗口**：模型的上下文长度

## 技术栈

- **后端**：Python 3.9 + Flask + SQLite
- **前端**：React 19 + TypeScript + Ant Design 6 + ECharts 6
- **部署**：Docker Compose

## 许可证

MIT
