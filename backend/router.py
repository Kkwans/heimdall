"""
路由配置模块
负责管理多厂商模型路由配置，根据请求中的 model 字段查找对应的上游 API。

供 proxy.py 调用的入口：resolve_route_for_proxy(model, auth_header)
返回 RouteResult（成功）或 RouteError（失败）。
"""

import os
import sqlite3
import logging
from dataclasses import dataclass
from typing import Optional, Union

import config
import crypto
from db import _get_conn

# ==========================================
# 路由结果数据类
# ==========================================

@dataclass(frozen=True)
class RouteKey:
    """One selectable Provider Key. Its secret stays inside the proxy process."""

    id: int
    secret: str
    priority: int


class RouteResult:
    """结构化路由结果，区分 Heimdall 模型名和上游模型名。"""

    __slots__ = (
        "base_url", "provider_id", "provider_key", "model_id", "model_name",
        "upstream_model", "requested_model", "context_window", "key_candidates",
    )

    def __init__(self, *, base_url: str, provider_id: int, provider_key: str,
                 model_id: int, model_name: str, upstream_model: str,
                 requested_model: str, context_window: int = None,
                 key_candidates: list = None):
        self.base_url = base_url.rstrip("/")
        self.provider_id = provider_id
        self.provider_key = provider_key
        self.model_id = model_id
        self.model_name = model_name
        self.upstream_model = upstream_model
        self.requested_model = requested_model
        self.context_window = context_window
        self.key_candidates = list(key_candidates or [])

    @property
    def api_key(self) -> str:
        return self.key_candidates[0].secret if self.key_candidates else ""

    @property
    def api_keys(self) -> list:
        return [candidate.secret for candidate in self.key_candidates]


class RouteError:
    """路由查找失败的结果"""
    __slots__ = ("status_code", "message")

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message

_logger = logging.getLogger("stderr")

# 使用 db 模块的统一连接管理
# _get_conn 从 db.py 导入


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
                openai_url  VARCHAR(512),
                anthropic_url VARCHAR(512),
                api_key     VARCHAR(512) NOT NULL,
                enabled     BOOLEAN DEFAULT 1,
                priority    INTEGER DEFAULT 0,
                plan_type   VARCHAR(32) DEFAULT 'api',
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # 幂等添加新列（对现有表进行升级，已有列则忽略错误）
        for col_def in [
            "ALTER TABLE providers ADD COLUMN openai_url VARCHAR(512)",
            "ALTER TABLE providers ADD COLUMN anthropic_url VARCHAR(512)",
            "ALTER TABLE providers ADD COLUMN plan_type VARCHAR(32) DEFAULT 'api'",
        ]:
            try:
                cursor.execute(col_def)
            except Exception:
                pass  # 列已存在时 SQLite 会抛错，直接忽略

        # 厂商 API Key 表（支持多 Key 优先级轮询）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS provider_api_keys (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id INTEGER NOT NULL,
                api_key     VARCHAR(512) NOT NULL,
                priority    INTEGER DEFAULT 0,
                enabled     BOOLEAN DEFAULT 1,
                last_used_at DATETIME,
                last_error_at DATETIME,
                error_count INTEGER DEFAULT 0,
                cooldown_until DATETIME,
                last_error_summary TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            )
        """)

        # 模型映射表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS models (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id     INTEGER NOT NULL,
                model_name      VARCHAR(128) NOT NULL UNIQUE,
                upstream_model  VARCHAR(128),
                enabled         BOOLEAN DEFAULT 1,
                context_window  INTEGER,
                price_input     REAL DEFAULT 0,
                price_output    REAL DEFAULT 0,
                price_cache_read REAL DEFAULT 0,
                price_cache_write REAL DEFAULT 0,
                pricing_configured BOOLEAN NOT NULL DEFAULT 0,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            )
        """)

        conn.commit()
        _logger.info("[ROUTER] 路由配置表初始化完成")

        # 幂等添加定价列
        for col_def in [
            "ALTER TABLE models ADD COLUMN price_input REAL DEFAULT 0",
            "ALTER TABLE models ADD COLUMN price_output REAL DEFAULT 0",
            "ALTER TABLE models ADD COLUMN price_cache_read REAL DEFAULT 0",
            "ALTER TABLE models ADD COLUMN price_cache_write REAL DEFAULT 0",
            "ALTER TABLE models ADD COLUMN pricing_configured BOOLEAN NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(col_def)
            except Exception:
                pass
        for col_def in [
            "ALTER TABLE provider_api_keys ADD COLUMN cooldown_until DATETIME",
            "ALTER TABLE provider_api_keys ADD COLUMN last_error_summary TEXT",
        ]:
            try:
                conn.execute(col_def)
            except Exception:
                pass
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_api_keys_route "
            "ON provider_api_keys(provider_id, enabled, priority DESC, id ASC)"
        )
        conn.commit()
    except sqlite3.Error as e:
        _logger.error(f"[ROUTER] 初始化路由表失败: {e}", exc_info=True)


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


def resolve_route_for_proxy(model: str, protocol: str = "openai") -> Union[RouteResult, RouteError]:
    """
    供 proxy.py 调用的路由查找。
    解析 model 字段，查询 SQLite，返回路由结果。
    使用厂商存储的 API Key，不接受客户端传入的 Key。

    参数：
        model: 客户端请求的 model 字段（如 "mimo/mimo-v2.5-pro" 或 "deepseek-v4-pro"）
        protocol: 协议类型 "openai" 或 "anthropic"

    返回：
        RouteResult: 路由成功
        RouteError: 路由失败（400/403/500）
    """
    try:
        conn = _get_conn()
        cursor = conn.cursor()
        requested_model = model
        provider_name = None
        model_name = model
        if "/" in model:
            provider_name, model_name = model.split("/", 1)

        if provider_name:
            provider_row = cursor.execute(
                "SELECT * FROM providers WHERE name = ? AND enabled = 1",
                (provider_name,),
            ).fetchone()
            if not provider_row:
                return RouteError(400, f"未知厂商: {provider_name}")
            provider_id = int(provider_row["id"])
            provider_key = str(provider_row["name"])
            model_row = cursor.execute(
                "SELECT * FROM models WHERE provider_id = ? AND model_name = ? AND enabled = 1",
                (provider_id, model_name),
            ).fetchone()
            if not model_row:
                model_row = cursor.execute(
                    "SELECT * FROM models WHERE provider_id = ? AND upstream_model = ? AND enabled = 1",
                    (provider_id, model_name),
                ).fetchone()
        else:
            model_row = cursor.execute(
                """
                SELECT
                    m.id AS model_id, m.model_name, m.upstream_model, m.context_window,
                    p.id AS provider_id, p.name AS provider_name, p.display_name,
                    p.openai_url, p.anthropic_url, p.base_url, p.priority
                FROM models m
                JOIN providers p ON m.provider_id = p.id
                WHERE m.model_name = ? AND m.enabled = 1 AND p.enabled = 1
                ORDER BY p.priority DESC, p.id ASC
                LIMIT 1
                """,
                (model_name,),
            ).fetchone()
            if not model_row:
                return RouteError(400, f"不支持的模型: {model_name}")
            provider_row = model_row
            provider_id = int(model_row["provider_id"])
            provider_key = str(model_row["provider_name"])

        if not model_row:
            display_name = dict(provider_row).get("display_name") or provider_key
            return RouteError(400, f"不支持的模型: {model_name}（厂商: {display_name}）")

        if protocol == "anthropic":
            base_url = provider_row["anthropic_url"] or provider_row["base_url"]
        else:
            base_url = provider_row["openai_url"] or provider_row["base_url"]
        if not base_url:
            return RouteError(500, f"厂商 {provider_key} 未配置 {protocol} 协议地址")

        context_window = model_row["context_window"] or config.get_context_window(model_name)
        key_candidates = get_provider_api_keys_for_route(provider_id)
        if not key_candidates:
            return RouteError(403, f"厂商 {provider_key} 未配置可用 API Key")

        return RouteResult(
            base_url=str(base_url),
            provider_id=provider_id,
            provider_key=provider_key,
            model_id=int(model_row["id"] if provider_name else model_row["model_id"]),
            model_name=str(model_row["model_name"]),
            upstream_model=str(model_row["upstream_model"] or model_row["model_name"]),
            requested_model=requested_model,
            context_window=context_window,
            key_candidates=key_candidates,
        )

    except sqlite3.Error as e:
        _logger.error(f"[ROUTER] 路由查找数据库错误: {e}", exc_info=True)
        return RouteError(500, f"路由查找数据库错误: {str(e)}")
    except Exception as e:
        _logger.error(f"[ROUTER] 路由查找失败: {e}", exc_info=True)
        return RouteError(500, f"路由查找异常: {str(e)}")


# CRUD 操作：厂商

def get_all_providers() -> list:
    """获取所有厂商（含模型和 Key 数量，不返回 legacy secret）。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.*, COUNT(DISTINCT m.id) as model_count, COUNT(DISTINCT k.id) as api_key_count
        FROM providers p
        LEFT JOIN models m ON m.provider_id = p.id
        LEFT JOIN provider_api_keys k ON k.provider_id = p.id
        GROUP BY p.id
        ORDER BY p.priority DESC, p.name
    """)
    rows = []
    for row in cursor.fetchall():
        d = dict(row)
        d.pop("api_key", None)
        rows.append(d)
    return rows


def get_provider(provider_id: int) -> Optional[dict]:
    """获取单个厂商详情，不返回 legacy secret。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM providers WHERE id = ?", (provider_id,))
    row = cursor.fetchone()
    if row:
        d = dict(row)
        d.pop("api_key", None)
        return d
    return None


def get_provider_by_name(name: str) -> Optional[dict]:
    """根据名称获取厂商，不返回 legacy secret。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM providers WHERE name = ?", (name,))
    row = cursor.fetchone()
    if row:
        d = dict(row)
        d.pop("api_key", None)
        return d
    return None


def create_provider(data: dict) -> int:
    """在单一事务中创建厂商和首个 Provider Key。"""
    conn = _get_conn()
    cursor = conn.cursor()
    base_url = data.get("base_url") or data.get("openai_url", "")
    encrypted_key = crypto.encrypt(data["api_key"])
    with conn:
        cursor.execute("""
            INSERT INTO providers (name, display_name, base_url, openai_url, anthropic_url, api_key, enabled, priority, plan_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data["name"],
            data.get("display_name", data["name"]),
            base_url,
            data.get("openai_url", base_url),
            data.get("anthropic_url", ""),
            encrypted_key,
            data.get("enabled", True),
            data.get("priority", 0),
            data.get("plan_type", "api"),
        ))
        provider_id = cursor.lastrowid
        cursor.execute("""
            INSERT INTO provider_api_keys (provider_id, api_key, priority, enabled)
            VALUES (?, ?, ?, ?)
        """, (
            provider_id,
            encrypted_key,
            data.get("api_key_priority", 0),
            True,
        ))
    return provider_id


# 允许更新的字段白名单
_PROVIDER_ALLOWED_FIELDS = {"name", "display_name", "base_url", "openai_url", "anthropic_url", "api_key", "enabled", "priority", "plan_type"}
_MODEL_ALLOWED_FIELDS = {"model_name", "upstream_model", "enabled", "context_window", "price_input", "price_output", "price_cache_read", "price_cache_write", "pricing_configured"}


def _validate_field_name(field: str, allowed: set) -> bool:
    """验证字段名是否在白名单中（防止 SQL 注入）"""
    return field in allowed


def update_provider(provider_id: int, data: dict) -> bool:
    """更新厂商（API Key 加密存储，字段名白名单校验）"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key, value in data.items():
        if not _validate_field_name(key, _PROVIDER_ALLOWED_FIELDS):
            continue
        if key == "api_key":
            if not value:
                continue
            fields.append(f"{key} = ?")
            values.append(crypto.encrypt(value))
        else:
            fields.append(f"{key} = ?")
            values.append(value)
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


# CRUD 操作：厂商 API Keys（多 Key 优先级轮询）

def get_provider_api_keys(provider_id: int) -> list:
    """获取厂商 Key 的预览和状态，不返回完整 secret。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM provider_api_keys WHERE provider_id = ? ORDER BY priority DESC, id",
        (provider_id,)
    )
    rows = cursor.fetchall()
    result = []
    for row in rows:
        d = dict(row)
        plaintext = crypto.decrypt(d.pop("api_key"))
        d["api_key_preview"] = crypto.mask_secret(plaintext)
        result.append(d)
    return result


def get_provider_api_keys_for_route(provider_id: int) -> list:
    """获取未冷却的启用 Key，按 priority DESC, id ASC 稳定排序。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, api_key, priority FROM provider_api_keys "
        "WHERE provider_id = ? AND enabled = 1 "
        "AND (cooldown_until IS NULL OR cooldown_until <= CURRENT_TIMESTAMP) "
        "ORDER BY priority DESC, id ASC",
        (provider_id,)
    )
    return [
        RouteKey(
            id=int(row["id"]),
            secret=crypto.decrypt(row["api_key"]),
            priority=int(row["priority"] or 0),
        )
        for row in cursor.fetchall()
    ]


def create_provider_api_key(provider_id: int, data: dict) -> int:
    """添加厂商 API Key（加密存储）"""
    conn = _get_conn()
    cursor = conn.cursor()
    encrypted_key = crypto.encrypt(data["api_key"])
    cursor.execute("""
        INSERT INTO provider_api_keys (provider_id, api_key, priority, enabled)
        VALUES (?, ?, ?, ?)
    """, (
        provider_id,
        encrypted_key,
        data.get("priority", 0),
        data.get("enabled", True),
    ))
    conn.commit()
    return cursor.lastrowid


def update_provider_api_key(key_id: int, data: dict) -> bool:
    """更新厂商 API Key"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key in ["api_key", "priority", "enabled"]:
        if key in data:
            if key == "api_key":
                fields.append(f"{key} = ?")
                values.append(crypto.encrypt(data[key]))
            else:
                fields.append(f"{key} = ?")
                values.append(data[key])
    if not fields:
        return False
    values.append(key_id)
    cursor.execute(f"UPDATE provider_api_keys SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    return cursor.rowcount > 0


def delete_provider_api_key(key_id: int) -> bool:
    """删除厂商 API Key"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM provider_api_keys WHERE id = ?", (key_id,))
    conn.commit()
    return cursor.rowcount > 0


def mark_api_key_error(key_id: int, error_summary: str = "retryable_error") -> None:
    """记录可重试故障；连续三次后让 Key 冷却五分钟。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute(
        """
        UPDATE provider_api_keys
        SET last_error_at = CURRENT_TIMESTAMP,
            last_error_summary = ?,
            error_count = COALESCE(error_count, 0) + 1,
            cooldown_until = CASE
                WHEN COALESCE(error_count, 0) + 1 >= 3
                THEN datetime('now', '+5 minutes')
                ELSE cooldown_until
            END
        WHERE id = ?
        """,
        (str(error_summary)[:500], key_id),
    )
    conn.commit()


def mark_api_key_used(key_id: int, *, reset_errors: bool = True) -> None:
    """记录 Key 使用；成功时清除连续失败和冷却状态。"""
    conn = _get_conn()
    cursor = conn.cursor()
    if reset_errors:
        cursor.execute(
            "UPDATE provider_api_keys SET last_used_at = CURRENT_TIMESTAMP, "
            "error_count = 0, cooldown_until = NULL WHERE id = ?",
            (key_id,),
        )
    else:
        cursor.execute(
            "UPDATE provider_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?",
            (key_id,),
        )
    conn.commit()


# CRUD 操作：模型

def get_models_by_provider(provider_id: int) -> list:
    """获取厂商下的所有模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM models WHERE provider_id = ? ORDER BY model_name", (provider_id,))
    models = []
    for row in cursor.fetchall():
        model = dict(row)
        model["pricing_configured"] = bool(model.get("pricing_configured", False))
        models.append(model)
    return models


def create_model(provider_id: int, data: dict) -> int:
    """添加模型"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO models (provider_id, model_name, upstream_model, enabled, context_window,
                          price_input, price_output, price_cache_read, price_cache_write,
                          pricing_configured)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        provider_id,
        data["model_name"],
        data.get("upstream_model"),
        data.get("enabled", True),
        data.get("context_window"),
        data.get("price_input", 0),
        data.get("price_output", 0),
        data.get("price_cache_read", 0),
        data.get("price_cache_write", 0),
        data.get("pricing_configured", False),
    ))
    conn.commit()
    return cursor.lastrowid


def update_model(model_id: int, data: dict) -> bool:
    """更新模型（字段名白名单校验）"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key, value in data.items():
        if not _validate_field_name(key, _MODEL_ALLOWED_FIELDS):
            continue
        fields.append(f"{key} = ?")
        values.append(value)
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

            # 获取 URL 配置
            base_url = provider_data.get("base_url", "")
            openai_url = provider_data.get("openai_url", base_url)
            anthropic_url = provider_data.get("anthropic_url", "")
            plan_type = provider_data.get("plan_type", "api")

            cursor.execute(
                "INSERT INTO providers (name, display_name, base_url, openai_url, anthropic_url, api_key, enabled, priority, plan_type) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    provider_key,
                    provider_data.get("name", provider_key),
                    base_url,
                    openai_url,
                    anthropic_url,
                    provider_data.get("api_key", ""),
                    provider_data.get("enabled", True),
                    priority,
                    plan_type,
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
