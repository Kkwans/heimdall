"""
路由配置模块
负责管理多厂商模型路由配置，根据请求中的 model 字段查找对应的上游 API。

供 proxy.py 调用的入口：resolve_route_for_proxy(model, auth_header)
返回 RouteResult（成功）或 RouteError（失败）。
"""

import os
import sqlite3
import threading
import logging
from typing import Optional, Tuple, Union

import config

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

_logger = logging.getLogger("stderr")

# 线程本地存储
_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """获取当前线程的 SQLite 连接"""
    if not hasattr(_local, "conn") or _local.conn is None:
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return _local.conn


def init_routing_tables():
    """初始化路由配置表"""
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        # 厂商配置表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS providers (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        VARCHAR(64) NOT NULL UNIQUE,
                display_name VARCHAR(128),
                base_url    VARCHAR(512) NOT NULL,
                api_key     VARCHAR(512) NOT NULL,
                enabled     BOOLEAN DEFAULT 1,
                priority    INTEGER DEFAULT 0,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # 模型映射表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS models (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id     INTEGER NOT NULL,
                model_name      VARCHAR(128) NOT NULL,
                upstream_model  VARCHAR(128),
                enabled         BOOLEAN DEFAULT 1,
                context_window  INTEGER,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(provider_id, model_name),
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            )
        """)

        conn.commit()
        _logger.info("[ROUTER] 路由配置表初始化完成")
    except Exception as e:
        _logger.error(f"[ROUTER] 初始化路由表失败: {e}", exc_info=True)


def resolve_route(model: str) -> Optional[Tuple[str, str, str]]:
    """
    根据模型名解析路由配置。
    
    Args:
        model: 客户端请求的模型名，支持格式：
               - "mimo/mimo-v2.5-pro" (厂商前缀格式)
               - "deepseek-v4-pro" (简写格式)
    
    Returns:
        (base_url, api_key, upstream_model) 或 None（未找到路由）
    """
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        provider_name = None
        model_name = model

        # 解析厂商前缀
        if '/' in model:
            parts = model.split('/', 1)
            provider_name = parts[0]
            model_name = parts[1]

        if provider_name:
            # 有厂商前缀：精确查找
            cursor.execute("""
                SELECT p.base_url, p.api_key, COALESCE(m.upstream_model, m.model_name) as upstream_model
                FROM providers p
                JOIN models m ON m.provider_id = p.id
                WHERE p.name = ? AND m.model_name = ? AND p.enabled = 1 AND m.enabled = 1
            """, (provider_name, model_name))
        else:
            # 无厂商前缀：查找所有匹配的模型，按优先级排序
            cursor.execute("""
                SELECT p.base_url, p.api_key, COALESCE(m.upstream_model, m.model_name) as upstream_model
                FROM providers p
                JOIN models m ON m.provider_id = p.id
                WHERE m.model_name = ? AND p.enabled = 1 AND m.enabled = 1
                ORDER BY p.priority DESC
                LIMIT 1
            """, (model_name,))

        row = cursor.fetchone()
        if row:
            return (row["base_url"], row["api_key"], row["upstream_model"])

        return None
    except Exception as e:
        _logger.error(f"[ROUTER] 路由查找失败: {e}", exc_info=True)
        return None


def get_context_window(model: str) -> Optional[int]:
    """获取模型的上下文窗口大小"""
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        model_name = model.split('/')[-1] if '/' in model else model

        cursor.execute("""
            SELECT m.context_window
            FROM models m
            JOIN providers p ON m.provider_id = p.id
            WHERE m.model_name = ? AND p.enabled = 1 AND m.enabled = 1
            ORDER BY p.priority DESC
            LIMIT 1
        """, (model_name,))

        row = cursor.fetchone()
        if row and row["context_window"]:
            return row["context_window"]

        # fallback 到 config.py 中的硬编码映射
        return config.get_context_window(model_name)
    except Exception:
        return config.get_context_window(model.split('/')[-1] if '/' in model else model)


def resolve_route_for_proxy(model: str, auth_header: str = "") -> Union[RouteResult, RouteError]:
    """
    供 proxy.py 调用的路由查找。
    解析 model 字段，查询 SQLite，返回路由结果。

    参数：
        model: 客户端请求的 model 字段（如 "mimo/mimo-v2.5-pro" 或 "deepseek-v4-pro"）
        auth_header: 请求的 Authorization header 值

    返回：
        RouteResult: 路由成功
        RouteError: 路由失败（400/403/401/500）
    """
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        provider_name = None
        model_name = model

        # 1. 解析 provider 和 model_name
        if '/' in model:
            parts = model.split('/', 1)
            provider_name = parts[0]
            model_name = parts[1]

        # 2. 查找厂商
        if provider_name:
            # 有厂商前缀：精确查找
            cursor.execute(
                "SELECT * FROM providers WHERE name = ? AND enabled = 1",
                (provider_name,)
            )
        else:
            # 无厂商前缀：使用 priority 最高的厂商
            cursor.execute(
                "SELECT * FROM providers WHERE enabled = 1 ORDER BY priority DESC LIMIT 1"
            )

        provider_row = cursor.fetchone()
        if not provider_row:
            if provider_name:
                return RouteError(400, f"未知厂商: {provider_name}")
            else:
                return RouteError(400, "无可用厂商配置，请先在管理后台添加厂商")

        provider_id = provider_row["id"]
        provider_key = provider_row["name"]
        base_url = provider_row["base_url"]

        # 3. 查找模型
        cursor.execute(
            "SELECT * FROM models WHERE provider_id = ? AND model_name = ? AND enabled = 1",
            (provider_id, model_name)
        )
        model_row = cursor.fetchone()

        if not model_row:
            # 尝试别名匹配（upstream_model 字段）
            cursor.execute(
                "SELECT * FROM models WHERE provider_id = ? AND upstream_model = ? AND enabled = 1",
                (provider_id, model_name)
            )
            model_row = cursor.fetchone()

        if not model_row:
            return RouteError(400, f"不支持的模型: {model_name}（厂商: {provider_row.get('display_name', provider_key)}）")

        context_window = model_row["context_window"]
        # fallback 到 config.py 的硬编码映射
        if not context_window:
            context_window = config.get_context_window(model_name)

        # 4. 确定 API Key（优先级：请求 header > 配置文件 > 环境变量）
        api_key = ""
        if auth_header:
            api_key = auth_header.replace("Bearer ", "").strip()
        if not api_key:
            api_key = provider_row["api_key"] or ""
        if not api_key:
            # 尝试从环境变量读取
            env_var = f"HEIMDALL_API_KEY_{provider_key.upper()}"
            api_key = os.environ.get(env_var, "")

        # 5. 确定上游模型名
        upstream_model = model_row["upstream_model"] or model_name

        return RouteResult(
            base_url=base_url,
            api_key=api_key,
            model_name=upstream_model,
            provider_key=provider_key,
            context_window=context_window,
        )

    except Exception as e:
        _logger.error(f"[ROUTER] 路由查找失败: {e}", exc_info=True)
        return RouteError(500, f"路由查找异常: {str(e)}")


# CRUD 操作：厂商

def get_all_providers() -> list:
    """获取所有厂商（含模型数量）"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.*, COUNT(m.id) as model_count
        FROM providers p
        LEFT JOIN models m ON m.provider_id = p.id
        GROUP BY p.id
        ORDER BY p.priority DESC, p.name
    """)
    return [dict(row) for row in cursor.fetchall()]


def get_provider(provider_id: int) -> Optional[dict]:
    """获取单个厂商详情"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM providers WHERE id = ?", (provider_id,))
    row = cursor.fetchone()
    return dict(row) if row else None


def create_provider(data: dict) -> int:
    """创建厂商，返回 ID"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO providers (name, display_name, base_url, api_key, enabled, priority)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        data["name"],
        data.get("display_name", data["name"]),
        data["base_url"],
        data["api_key"],
        data.get("enabled", True),
        data.get("priority", 0)
    ))
    conn.commit()
    return cursor.lastrowid


def update_provider(provider_id: int, data: dict) -> bool:
    """更新厂商"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key in ["name", "display_name", "base_url", "api_key", "enabled", "priority"]:
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key])
    if not fields:
        return False
    fields.append("updated_at = CURRENT_TIMESTAMP")
    values.append(provider_id)
    cursor.execute(f"UPDATE providers SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    return cursor.rowcount > 0


def delete_provider(provider_id: int) -> bool:
    """删除厂商（级联删除关联模型）"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
    conn.commit()
    return cursor.rowcount > 0


# CRUD 操作：模型

def get_models_by_provider(provider_id: int) -> list:
    """获取厂商下的所有模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM models WHERE provider_id = ? ORDER BY model_name", (provider_id,))
    return [dict(row) for row in cursor.fetchall()]


def create_model(provider_id: int, data: dict) -> int:
    """添加模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO models (provider_id, model_name, upstream_model, enabled, context_window)
        VALUES (?, ?, ?, ?, ?)
    """, (
        provider_id,
        data["model_name"],
        data.get("upstream_model"),
        data.get("enabled", True),
        data.get("context_window")
    ))
    conn.commit()
    return cursor.lastrowid


def update_model(model_id: int, data: dict) -> bool:
    """更新模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key in ["model_name", "upstream_model", "enabled", "context_window"]:
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key])
    if not fields:
        return False
    values.append(model_id)
    cursor.execute(f"UPDATE models SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    return cursor.rowcount > 0


def delete_model(model_id: int) -> bool:
    """删除模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM models WHERE id = ?", (model_id,))
    conn.commit()
    return cursor.rowcount > 0


# ==========================================
# 启动初始化：默认厂商数据
# ==========================================

def init_default_providers():
    """
    服务启动时调用，确保 SQLite 中有厂商数据。
    1. 如果 providers 表已有数据，跳过
    2. 如果 providers.json 存在，导入到 SQLite
    3. 不创建默认厂商（用户需要自己配置）
    """
    try:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM providers")
        count = cursor.fetchone()["cnt"]

        if count > 0:
            _logger.info(f"[ROUTER] 已有 {count} 个厂商配置，跳过初始化")
            return

        # 检查 providers.json 是否存在
        providers_json_path = os.path.join(config.APP_SUPPORT_DIR, "providers.json")
        if os.path.isfile(providers_json_path):
            _import_from_json(providers_json_path)
            return

        # 无配置，提示用户添加厂商
        _logger.warning("[ROUTER] 无厂商配置，请在管理后台添加厂商")

    except Exception as e:
        _logger.error(f"[ROUTER] init_default_providers 失败: {e}", exc_info=True)


def _import_from_json(json_path: str):
    """将 providers.json 数据导入 SQLite providers/models 表"""
    import json as _json
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            cfg = _json.load(f)

        providers = cfg.get("providers", {})
        default_key = cfg.get("default_provider", "")

        conn = _get_conn()
        cursor = conn.cursor()

        for provider_key, provider_data in providers.items():
            # 确定 priority：default_provider 设为最高
            priority = 100 if provider_key == default_key else 0

            cursor.execute(
                "INSERT INTO providers (name, display_name, base_url, api_key, enabled, priority) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    provider_key,
                    provider_data.get("name", provider_key),
                    provider_data.get("base_url", ""),
                    provider_data.get("api_key", ""),
                    provider_data.get("enabled", True),
                    priority,
                )
            )
            provider_id = cursor.lastrowid

            # 导入模型
            models = provider_data.get("models", {})
            for model_name, model_cfg in models.items():
                cursor.execute(
                    "INSERT INTO models (provider_id, model_name, upstream_model, enabled, context_window) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        provider_id,
                        model_name,
                        model_cfg.get("upstream_model"),
                        model_cfg.get("enabled", True),
                        model_cfg.get("context_window"),
                    )
                )

        conn.commit()
        _logger.info(f"[ROUTER] 已从 providers.json 导入 {len(providers)} 个厂商")

    except Exception as e:
        _logger.error(f"[ROUTER] 导入 providers.json 失败: {e}", exc_info=True)
