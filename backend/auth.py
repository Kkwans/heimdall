"""
API Key 认证中间件
校验请求中的 Authorization header，保护代理接口。
"""

import sqlite3
import threading
import logging
import secrets
from typing import Optional, List
from functools import wraps
from flask import request, jsonify

import config
import crypto
from db import _get_conn

_logger = logging.getLogger("stderr")

# 使用 db 模块的统一连接管理
# _get_conn 从 db.py 导入


def init_auth_tables():
    """初始化认证相关表"""
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        # API Key 表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS api_keys (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                key_value   VARCHAR(128) NOT NULL UNIQUE,
                name        VARCHAR(128),
                enabled     BOOLEAN DEFAULT 1,
                allowed_models TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used_at DATETIME
            )
        """)

        conn.commit()
        _logger.info("[AUTH] 认证表初始化完成")
    except Exception as e:
        _logger.error(f"[AUTH] 初始化认证表失败: {e}", exc_info=True)
        raise


def generate_api_key() -> str:
    """生成随机 API Key"""
    return f"heimdall-{secrets.token_urlsafe(32)}"


def validate_api_key(key_value: str) -> Optional[dict]:
    """
    验证 API Key 是否有效。
    
    Returns:
        API Key 信息 dict 或 None（无效）
    """
    try:
        conn = _get_conn()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM api_keys 
            WHERE enabled = 1
        """)
        rows = cursor.fetchall()
        for row in rows:
            stored_key = row["key_value"]
            # 解密后比较
            decrypted = crypto.decrypt(stored_key)
            if decrypted == key_value:
                # 更新最后使用时间
                cursor.execute("""
                    UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (row["id"],))
                conn.commit()
                return dict(row)
        return None
    except Exception as e:
        _logger.error(f"[AUTH] 验证 API Key 失败: {e}", exc_info=True)
        return None


def check_model_access(key_info: dict, model: str) -> bool:
    """检查 API Key 是否有权限访问指定模型"""
    allowed = key_info.get("allowed_models")
    if not allowed:
        # 未配置限制，允许所有模型
        return True
    allowed_list = [m.strip() for m in allowed.split(",")]
    model_name = model.split('/')[-1] if '/' in model else model
    return model_name in allowed_list or model in allowed_list


def require_auth(f):
    """认证装饰器：保护需要认证的接口"""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        
        # 提取 API Key
        api_key = None
        if auth_header.startswith("Bearer "):
            api_key = auth_header[7:]
        
        if not api_key:
            return jsonify({"error": "Missing API Key", "type": "auth_error"}), 401
        
        key_info = validate_api_key(api_key)
        if not key_info:
            return jsonify({"error": "Invalid API Key", "type": "auth_error"}), 401
        
        # 将 key_info 附加到 request 上
        request.api_key_info = key_info
        return f(*args, **kwargs)
    
    return decorated


# CRUD 操作

def get_all_api_keys() -> list:
    """获取所有客户端 API Key，仅返回不可逆预览和元数据。"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute("SELECT id, key_value, name, enabled, allowed_models, created_at, last_used_at FROM api_keys ORDER BY created_at DESC")
    rows = []
    for row in cursor.fetchall():
        d = dict(row)
        plaintext = crypto.decrypt(d.pop("key_value"))
        d["key_preview"] = crypto.mask_secret(plaintext, prefix_length=8)
        rows.append(d)
    return rows


def get_api_key_value(key_id: int) -> Optional[str]:
    """按用户显式操作读取单个 Client API Key；列表接口始终保持脱敏。"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT key_value FROM api_keys WHERE id = ?", (key_id,)
    ).fetchone()
    if row is None:
        return None
    return crypto.decrypt(row["key_value"])


def create_api_key(data: dict) -> dict:
    """创建 API Key（加密存储）"""
    conn = _get_conn()
    cursor = conn.cursor()
    key_value = data.get("key_value") or generate_api_key()
    encrypted_key = crypto.encrypt(key_value)
    cursor.execute("""
        INSERT INTO api_keys (key_value, name, enabled, allowed_models)
        VALUES (?, ?, ?, ?)
    """, (
        encrypted_key,
        data.get("name", ""),
        data.get("enabled", True),
        data.get("allowed_models")
    ))
    conn.commit()
    return {"id": cursor.lastrowid, "key_value": key_value}


def update_api_key(key_id: int, data: dict) -> tuple:
    """更新 API Key；可在同一事务中重置 secret，并仅返回一次新值。"""
    conn = _get_conn()
    cursor = conn.cursor()
    fields = []
    values = []
    for key in ["name", "enabled", "allowed_models"]:
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key])
    new_key_value = None
    if data.get("reset_key") is True:
        new_key_value = generate_api_key()
        fields.append("key_value = ?")
        values.append(crypto.encrypt(new_key_value))
    if not fields:
        return False, None
    values.append(key_id)
    cursor.execute(f"UPDATE api_keys SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    updated = cursor.rowcount > 0
    return updated, new_key_value if updated else None


def delete_api_key(key_id: int) -> bool:
    """删除 API Key，并在同一事务中为历史请求固化删除时的名称。"""
    conn = _get_conn()
    cursor = conn.cursor()
    try:
        row = cursor.execute(
            "SELECT name FROM api_keys WHERE id = ?", (key_id,)
        ).fetchone()
        if row is None:
            return False
        cursor.execute(
            """
            UPDATE requests
            SET client_api_key_name = ?
            WHERE COALESCE(client_api_key_id, api_key_id) = ?
            """,
            (str(row["name"] or ""), key_id),
        )
        cursor.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
