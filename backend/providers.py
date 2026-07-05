"""
providers.py - [已废弃] 多厂商路由配置管理

⚠️ 此文件已废弃，路由功能已统一到 router.py。
proxy.py 不再使用此文件，所有路由查找通过 router.resolve_route_for_proxy() 进行。
保留此文件仅供参考。

废弃时间：2026-07-06
替代方案：router.py
"""

import os
import json
import threading
import logging

import config

_logger = logging.getLogger("system")

# ==========================================
# 配置文件路径
# ==========================================
PROVIDERS_CONFIG_PATH = os.path.join(config.APP_SUPPORT_DIR, "providers.json")

# ==========================================
# 内存中的配置（线程安全读写）
# ==========================================
_config_lock = threading.Lock()
_providers_config = None  # 延迟加载


# ==========================================
# 路由结果数据类
# ==========================================
class RouteResult:
    """路由查找成功的结果"""
    __slots__ = ("base_url", "api_key", "model_name", "provider_key", "context_window")

    def __init__(self, base_url: str, api_key: str, model_name: str,
                 provider_key: str, context_window: int = None):
        self.base_url = base_url
        self.api_key = api_key
        self.model_name = model_name
        self.provider_key = provider_key
        self.context_window = context_window


class RouteError:
    """路由查找失败的结果"""
    __slots__ = ("status_code", "message")

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message


# ==========================================
# 默认配置（向后兼容）
# ==========================================
def _build_default_config() -> dict:
    """
    构建默认配置：当 providers.json 不存在时使用。
    从 config.py 的现有配置推导，保证向后兼容。
    """
    # 从 MODEL_CONTEXT_WINDOWS 构建 Friday 的 models 配置
    friday_models = {}
    for model_name, ctx_window in config.MODEL_CONTEXT_WINDOWS.items():
        friday_models[model_name] = {
            "context_window": ctx_window,
            "enabled": True,
        }

    return {
        "version": 1,
        "default_provider": "friday",
        "providers": {
            "friday": {
                "name": "公司 Friday",
                "base_url": config.TARGET_BASE_URL,
                "api_key": "",
                "api_key_env": "",
                "enabled": True,
                "models": friday_models,
            }
        }
    }


# ==========================================
# 配置加载/保存
# ==========================================
def load_config() -> dict:
    """
    加载 providers.json 配置文件。
    不存在时返回默认配置（Friday only）。
    """
    global _providers_config

    if os.path.isfile(PROVIDERS_CONFIG_PATH):
        try:
            with open(PROVIDERS_CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            _logger.info(f"[Providers] 已加载配置: {len(cfg.get('providers', {}))} 个厂商")
            _providers_config = cfg
            return cfg
        except Exception as e:
            _logger.error(f"[Providers] 加载配置失败，使用默认配置: {e}")

    # 无配置文件或加载失败 → 使用默认配置
    cfg = _build_default_config()
    _providers_config = cfg
    _logger.info("[Providers] 使用默认配置（Friday only）")
    return cfg


def save_config(cfg: dict) -> None:
    """
    保存配置到 providers.json（原子写入）。
    同时更新内存中的配置。
    """
    global _providers_config

    with _config_lock:
        # 写入临时文件后重命名（原子操作）
        tmp_path = PROVIDERS_CONFIG_PATH + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, PROVIDERS_CONFIG_PATH)
            _providers_config = cfg
            _logger.info("[Providers] 配置已保存")
        except Exception as e:
            _logger.error(f"[Providers] 保存配置失败: {e}")
            # 清理临时文件
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def get_config() -> dict:
    """获取当前配置（延迟加载）"""
    if _providers_config is None:
        return load_config()
    return _providers_config


# ==========================================
# 路由查找核心逻辑
# ==========================================
def resolve_route(model: str, auth_header: str = "") -> "RouteResult | RouteError":
    """
    解析 model 字段，返回路由信息。

    参数：
        model: 客户端请求的 model 字段（如 "mimo/mimo-v2.5-pro" 或 "deepseek-v4-pro"）
        auth_header: 请求的 Authorization header 值

    返回：
        RouteResult: 路由成功
        RouteError: 路由失败（400/403/500）
    """
    cfg = get_config()
    providers = cfg.get("providers", {})
    default_key = cfg.get("default_provider", "friday")

    # 1. 解析 provider 和 model_name
    if "/" in model:
        provider_key, model_name = model.split("/", 1)
    else:
        provider_key = None
        model_name = model

    # 2. 查找 provider
    if provider_key:
        provider = providers.get(provider_key)
        if not provider:
            return RouteError(400, f"未知厂商: {provider_key}")
        if not provider.get("enabled", True):
            return RouteError(403, f"厂商已禁用: {provider_key}")
    else:
        provider = providers.get(default_key)
        if not provider:
            return RouteError(500, f"默认厂商配置错误: {default_key}")

    # 3. 验证模型
    models = provider.get("models", {})
    if models:
        # 严格模式：检查模型是否在配置中
        model_config = models.get(model_name)
        if not model_config:
            # 尝试别名匹配
            for m_name, m_cfg in models.items():
                if m_cfg.get("alias") == model_name:
                    model_config = m_cfg
                    model_name = m_name
                    break
        if not model_config:
            return RouteError(400, f"不支持的模型: {model_name}（厂商: {provider.get('name', provider_key)}）")
        if not model_config.get("enabled", True):
            return RouteError(403, f"模型已禁用: {model_name}")
        context_window = model_config.get("context_window")
    else:
        # 兼容模式（Friday 空 models）：允许任意模型
        context_window = config.get_context_window(model_name)

    # 4. 确定 API Key（优先级：请求 header > 配置文件 > 环境变量）
    api_key = ""
    if auth_header:
        api_key = auth_header.replace("Bearer ", "").strip()
    if not api_key:
        api_key = provider.get("api_key", "")
    if not api_key:
        env_var = provider.get("api_key_env", "")
        if env_var:
            api_key = os.environ.get(env_var, "")

    # 5. 确定 base_url（支持 runtime_config.json 覆盖 Friday 的 base_url）
    base_url = provider.get("base_url", "")
    if provider_key == "friday" or provider_key is None:
        # Friday 的 base_url 允许被 runtime_config.json 的 upstream_url 覆盖
        if hasattr(config, '_runtime_upstream_url') and config._runtime_upstream_url:
            base_url = config._runtime_upstream_url

    return RouteResult(
        base_url=base_url,
        api_key=api_key,
        model_name=model_name,
        provider_key=provider_key or default_key,
        context_window=context_window,
    )


# ==========================================
# 配置查询辅助函数
# ==========================================
def get_all_providers() -> dict:
    """获取所有厂商配置（API Key 脱敏）"""
    cfg = get_config()
    result = {}
    for key, provider in cfg.get("providers", {}).items():
        masked = dict(provider)
        if masked.get("api_key"):
            masked["api_key"] = _mask_api_key(masked["api_key"])
        result[key] = masked
    return {
        "default_provider": cfg.get("default_provider", "friday"),
        "providers": result,
    }


def get_all_models() -> list:
    """获取所有可用模型列表（扁平化）"""
    cfg = get_config()
    models = []
    for provider_key, provider in cfg.get("providers", {}).items():
        if not provider.get("enabled", True):
            continue
        for model_name, model_config in provider.get("models", {}).items():
            if not model_config.get("enabled", True):
                continue
            models.append({
                "provider": provider_key,
                "provider_name": provider.get("name", provider_key),
                "model": model_name,
                "full_name": f"{provider_key}/{model_name}",
                "context_window": model_config.get("context_window"),
            })
    return models


def _mask_api_key(key: str) -> str:
    """API Key 脱敏：sk-xxxx...xxxx"""
    if len(key) <= 8:
        return "****"
    return key[:4] + "****" + key[-4:]


# ==========================================
# 初始化
# ==========================================
def init():
    """模块初始化：加载配置"""
    load_config()


# 自动初始化
init()
