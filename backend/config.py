import os

# ==========================================
# Heimdall 配置文件
# 所有可配置项集中管理，支持通过环境变量覆盖
# ==========================================

# backend/ 目录
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
# 项目根目录（backend/ 的上一级）
BASE_DIR = os.path.dirname(BACKEND_DIR)

# ==========================================
# 数据存储目录
# ==========================================
# 优先使用环境变量 HEIMDALL_DATA_DIR（Docker 部署时通过 docker-compose 注入）。
# Linux/Docker 默认 /data（Dockerfile 中 mkdir -p /data 并挂载 volume）。
APP_SUPPORT_DIR = os.getenv("HEIMDALL_DATA_DIR", "/data")
# 确保目录存在（config 模块被导入时立即创建）
os.makedirs(APP_SUPPORT_DIR, exist_ok=True)

# ==========================================
# 数据库配置
# ==========================================
DB_PATH = os.path.join(APP_SUPPORT_DIR, "heimdall.db")

# ==========================================
# 日志配置
# ==========================================
# 优先使用环境变量 HEIMDALL_LOG_DIR。
# Linux/Docker 默认 /logs（Dockerfile 中 mkdir -p /logs 并挂载 volume）。
LOG_DIR = os.getenv("HEIMDALL_LOG_DIR", "/logs")
os.makedirs(LOG_DIR, exist_ok=True)

# 是否启用详细请求/响应日志（记录完整 prompt 和 response 内容）
# 注意：开启后磁盘占用会显著增大
# 通过环境变量启用：export HEIMDALL_DETAIL_LOG=true
ENABLE_DETAIL_LOG = os.getenv("HEIMDALL_DETAIL_LOG", "false").lower() == "true"

# 日志文件保留天数
LOG_BACKUP_DAYS = int(os.getenv("HEIMDALL_LOG_BACKUP_DAYS", "30"))

# ==========================================
# 代理配置
# ==========================================
# 上游 API 基础地址（从 runtime_config.json 加载，用户在 Dashboard 配置）
TARGET_BASE_URL = ""

# 代理服务端口（处理 AI 请求转发）
# Docker 内部端口固定为 8888，外部端口通过 docker-compose 映射
PROXY_PORT = int(os.getenv("HEIMDALL_PORT", "8888"))

# Dashboard 服务端口（统计面板 + API，独立于代理）
DASHBOARD_PORT = int(os.getenv("HEIMDALL_DASHBOARD_PORT", "8889"))

# 代理路径（客户端请求路径）
# OpenAI 标准协议：/v1/chat/completions
PROXY_PATH = os.getenv("HEIMDALL_PROXY_PATH", "/v1/chat/completions")

# 请求超时时间（秒）
REQUEST_TIMEOUT = int(os.getenv("HEIMDALL_TIMEOUT", "120"))

# 代理服务主机名（Docker 容器名）
# 在 Docker 网络中，代理容器可通过此主机名访问
PROXY_HOST = os.getenv("HEIMDALL_PROXY_HOST", "heimdall-proxy")

# ==========================================
# Dashboard 配置
# ==========================================
# 前端构建产物目录（相对于 BASE_DIR）
DASHBOARD_DIST_DIR = os.path.join(BASE_DIR, "frontend", "dist")

# ==========================================
# 运行时配置文件路径
# ==========================================
RUNTIME_CONFIG_PATH = os.path.join(APP_SUPPORT_DIR, "runtime_config.json")

# ==========================================
# 模型上下文窗口大小映射表
# 数据来源：Friday 模型广场（https://friday.sankuai.com/ml/modelPlaza/modelInfo）
# 键：模型名小写（支持前缀匹配）；值：context window token 数
# ==========================================
MODEL_CONTEXT_WINDOWS: dict = {
    # 智谱 GLM 系列
    "glm-5.1": 200_000,
    "glm-5v-turbo": 200_000,
    "glm-5-turbo": 200_000,
    "glm-5": 200_000,
    "glm-4.5": 128_000,
    # DeepSeek 系列
    "deepseek-v4-pro": 1_024_000,
    "deepseek-v4-flash-meituan": 256_000,
    "deepseek-v4-flash": 1_024_000,
    "deepseek-v3.2": 128_000,
    "deepseek-v3.1": 128_000,
    "deepseek-v3": 64_000,
    # Anthropic Claude 系列
    "claude-opus-4.8": 1_024_000,
    "claude-opus-4.7": 200_000,
    "claude-opus-4.6": 200_000,
    "claude-sonnet-4.6": 200_000,
    "claude-sonnet-4.5": 200_000,
    "claude-haiku": 200_000,
    "claude-3-5-sonnet": 200_000,
    # OpenAI GPT 系列
    "gpt-5.5": 1_050_000,
    "gpt-5.4-mini": 400_000,
    "gpt-5.4": 1_050_000,
    "gpt-5.3": 128_000,
    "gpt-5-mini": 128_000,
    "gpt-5": 128_000,
    "gpt-4o": 128_000,
    # Google Gemini 系列
    "gemini-3.5-flash": 1_024_000,
    "gemini-3.1-flash-lite": 1_024_000,
    "gemini-3.1-flash": 1_024_000,
    "gemini-2.5-pro": 1_000_000,
    "gemini-2.0-flash": 1_000_000,
    # 美团自研
    "longcat-2.0-preview": 1_024_000,
    "longcat-flash-omni-2603": 128_000,
    "longcat": 128_000,
    # 阿里 Qwen 系列
    "qwen3.5": 256_000,
    "qwen3": 128_000,
    "qwen2.5": 128_000,
    # Moonshot Kimi 系列
    "kimi-k2.6": 256_000,
    "kimi-k2.5": 256_000,
    "kimi-k2": 256_000,
    # MiniMax 系列
    "minimax-m3": 1_024_000,
    "minimax-m2.7": 200_000,
    "minimax-m2": 200_000,
    # 腾讯混元
    "hy3-preview": 256_000,
    "hy3": 256_000,
    # DeepSeek Reasoner
    "deepseek-r1": 128_000,
    "deepseek-r2": 128_000,
}


def get_context_window(model_name: str):
    """
    查询模型的 context window 大小（token 数）。
    先精确匹配，再做包含匹配（如 glm-5.1-2026-04 能匹配 glm-5.1）。
    未找到则返回 None。
    """
    if not model_name:
        return None
    name = model_name.lower()
    # 精确匹配
    if name in MODEL_CONTEXT_WINDOWS:
        return MODEL_CONTEXT_WINDOWS[name]
    # 前缀/包含匹配（按键长度降序，优先匹配更具体的键）
    for key in sorted(MODEL_CONTEXT_WINDOWS.keys(), key=len, reverse=True):
        if name.startswith(key) or key in name:
            return MODEL_CONTEXT_WINDOWS[key]
    return None
