# Heimdall OpenAI 兼容 API 文档

> Heimdall 代理服务完全兼容 OpenAI API 协议，支持 Chat Completions API 和 Responses API。

## 快速入门

### Base URL

| 格式 | URL |
|------|-----|
| 标准（推荐） | `http://<IP>:<端口>/openai` |
| 简化 | `http://<IP>:<端口>` 或 `http://<IP>:<端口>/v1` |

### 认证

在请求头中添加 Heimdall API Key：

```
Authorization: Bearer <你的 Heimdall API Key>
```

### 第一个请求

```bash
curl -X POST http://<IP>:<端口>/openai/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API Key>" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'
```

---

## Chat Completions API

### 请求

```
POST /v1/chat/completions
POST /chat/completions
POST /openai/chat/completions
```

### 请求头

| Header | 必填 | 说明 |
|--------|------|------|
| `Content-Type` | 是 | `application/json` |
| `Authorization` | 是 | `Bearer <API Key>` |

### 请求体

```json
{
  "model": "mimo/mimo-v2.5",
  "messages": [
    {"role": "system", "content": "你是一个有帮助的助手"},
    {"role": "user", "content": "你好"}
  ],
  "max_tokens": 1024,
  "temperature": 1.0,
  "top_p": 0.95,
  "stream": false,
  "stop": null,
  "frequency_penalty": 0,
  "presence_penalty": 0
}
```

### 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `model` | string | 是 | - | 模型名称，格式：`厂商/模型名` 或 `模型名` |
| `messages` | array | 是 | - | 消息列表 |
| `max_tokens` | integer | 否 | 模型默认 | 最大输出 token 数 |
| `temperature` | float | 否 | 1.0 | 采样温度（0-2） |
| `top_p` | float | 否 | 1.0 | 核采样概率（0-1） |
| `stream` | boolean | 否 | false | 是否使用流式输出 |
| `stop` | string/array | 否 | null | 停止序列 |
| `frequency_penalty` | float | 否 | 0 | 频率惩罚（-2 到 2） |
| `presence_penalty` | float | 否 | 0 | 存在惩罚（-2 到 2） |
| `stream_options` | object | 否 | null | 流式选项，如 `{"include_usage": true}` |

### 响应

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "mimo-v2.5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！有什么可以帮助你的吗？",
        "reasoning_content": "用户的问候..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30,
    "completion_tokens_details": {
      "reasoning_tokens": 5
    }
  }
}
```

### 流式响应

设置 `"stream": true`，响应为 SSE 格式：

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"你好"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"！"},"index":0}]}

data: [DONE]
```

如需在流式响应中获取 usage 信息，添加 `stream_options`：

```json
{
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

---

## Responses API

### 请求

```
POST /v1/responses
POST /openai/responses
```

### 请求体

```json
{
  "model": "mimo/mimo-v2.5",
  "input": "你好",
  "max_output_tokens": 1024
}
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `input` | string/array | 是 | 输入内容 |
| `max_output_tokens` | integer | 否 | 最大输出 token 数 |
| `instructions` | string | 否 | 系统指令 |
| `tools` | array | 否 | 工具定义 |
| `stream` | boolean | 否 | 是否流式输出 |

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
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 常见错误码

| HTTP 状态码 | 错误类型 | 说明 |
|------------|----------|------|
| 400 | invalid_request_error | 请求参数错误 |
| 401 | auth_error | API Key 无效或缺失 |
| 403 | auth_error | 模型访问被拒绝 |
| 408 | timeout | 请求超时 |
| 429 | rate_limit_error | 请求频率超限 |
| 500 | server_error | 服务器内部错误 |
| 502 | proxy_error | 上游服务不可达 |

---

## Python SDK 示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<IP>:<端口>/openai",
    api_key="<你的 Heimdall API Key>"
)

# 非流式
response = client.chat.completions.create(
    model="mimo/mimo-v2.5",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=100
)
print(response.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="mimo/mimo-v2.5",
    messages=[{"role": "user", "content": "讲个故事"}],
    max_tokens=500,
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Node.js SDK 示例

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://<IP>:<端口>/openai',
  apiKey: '<你的 Heimdall API Key>'
});

const response = await client.chat.completions.create({
  model: 'mimo/mimo-v2.5',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 100
});

console.log(response.choices[0].message.content);
```
