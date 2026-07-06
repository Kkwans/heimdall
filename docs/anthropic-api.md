# Heimdall Anthropic 兼容 API 文档

> Heimdall 代理服务兼容 Anthropic Messages API 协议，支持流式和非流式请求。

## 快速入门

### Base URL

| 格式 | URL |
|------|-----|
| 标准（推荐） | `http://<IP>:<端口>/anthropic` |
| 简化 | `http://<IP>:<端口>` 或 `http://<IP>:<端口>/v2` |

### 认证

在请求头中添加 Heimdall API Key：

```
x-api-key: <你的 Heimdall API Key>
```

### 第一个请求

```bash
curl -X POST http://<IP>:<端口>/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API Key>" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'
```

---

## Messages API

### 请求

```
POST /v1/messages
POST /v2/messages
POST /anthropic/v1/messages
```

### 请求头

| Header | 必填 | 说明 |
|--------|------|------|
| `Content-Type` | 是 | `application/json` |
| `x-api-key` | 是 | `<Heimdall API Key>` |
| `anthropic-version` | 是 | API 版本，当前为 `2023-06-01` |

> **注意**：`anthropic-version` 是 Anthropic API 的必填头，用于指定 API 版本。当前 Anthropic 官方版本为 `2023-06-01`。Anthropic SDK（Python/Node.js）会自动添加此头。

### 请求体

```json
{
  "model": "mimo/mimo-v2.5",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "system": "你是一个有帮助的助手",
  "temperature": 1.0,
  "top_p": 0.95,
  "stream": false
}
```

### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `model` | string | 是 | - | 模型名称，格式：`厂商/模型名` 或 `模型名` |
| `max_tokens` | integer | 是 | - | 最大输出 token 数 |
| `messages` | array | 是 | - | 消息列表 |
| `system` | string | 否 | null | 系统提示词 |
| `temperature` | float | 否 | 1.0 | 采样温度（0-1） |
| `top_p` | float | 否 | 0.95 | 核采样概率（0-1） |
| `stream` | boolean | 否 | false | 是否使用流式输出 |
| `stop_sequences` | array | 否 | null | 停止序列 |
| `top_k` | integer | 否 | null | Top-K 采样 |
| `metadata` | object | 否 | null | 请求元数据 |

### Messages 格式

```json
{
  "role": "user",
  "content": "消息内容"
}
```

支持的内容类型：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "文本内容"},
    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}}
  ]
}
```

### 响应

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "你好！有什么可以帮助你的吗？"
    },
    {
      "type": "thinking",
      "thinking": "用户的问候..."
    }
  ],
  "model": "mimo-v2.5",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

### 流式响应

设置 `"stream": true`，响应为 SSE 格式：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"mimo-v2.5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"！"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 认证方式

### 方式一：x-api-key 头（推荐）

```
x-api-key: <API Key>
```

### 方式二：Authorization Bearer

```
Authorization: Bearer <API Key>
```

两种方式均可，Heimdall 会自动识别。

---

## 模型格式

| 格式 | 示例 | 说明 |
|------|------|------|
| `厂商/模型名` | `mimo/mimo-v2.5` | 指定厂商 |
| `模型名` | `mimo-v2.5` | 使用默认厂商（优先级最高） |

---

## 错误处理

### 错误响应格式

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "错误描述"
  }
}
```

### 常见错误码

| HTTP 状态码 | 错误类型 | 说明 |
|------------|----------|------|
| 400 | invalid_request_error | 请求参数错误 |
| 401 | authentication_error | API Key 无效或缺失 |
| 403 | permission_error | 模型访问被拒绝 |
| 408 | timeout | 请求超时 |
| 429 | rate_limit_error | 请求频率超限 |
| 500 | api_error | 服务器内部错误 |
| 502 | api_error | 上游服务不可达 |

---

## Python SDK 示例

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://<IP>:<端口>/anthropic",
    api_key="<你的 Heimdall API Key>"
)

# 非流式
message = client.messages.create(
    model="mimo/mimo-v2.5",
    max_tokens=100,
    messages=[{"role": "user", "content": "你好"}]
)
print(message.content[0].text)

# 流式
with client.messages.stream(
    model="mimo/mimo-v2.5",
    max_tokens=500,
    messages=[{"role": "user", "content": "讲个故事"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## Node.js SDK 示例

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://<IP>:<端口>/anthropic',
  apiKey: '<你的 Heimdall API Key>'
});

const message = await client.messages.create({
  model: 'mimo/mimo-v2.5',
  max_tokens: 100,
  messages: [{ role: 'user', content: '你好' }]
});

console.log(message.content[0].text);
```

## cURL 示例

```bash
curl -X POST http://<IP>:<端口>/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API Key>" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```
