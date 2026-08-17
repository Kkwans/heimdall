"""
加密工具模块
提供 API Key 的加密存储和解密读取功能。
使用 Fernet 对称加密（AES-128-CBC + HMAC-SHA256）。
"""

import os
import base64
import logging
from cryptography.fernet import Fernet

_logger = logging.getLogger("stderr")

# 密钥文件路径
_KEY_FILE = os.path.join(os.environ.get("HEIMDALL_DATA_DIR", "/data"), ".encryption_key")


def _load_or_create_key() -> bytes:
    """加载或生成加密密钥"""
    if os.path.isfile(_KEY_FILE):
        with open(_KEY_FILE, "rb") as f:
            return f.read()
    
    # 生成新密钥
    key = Fernet.generate_key()
    os.makedirs(os.path.dirname(_KEY_FILE), exist_ok=True)
    with open(_KEY_FILE, "wb") as f:
        f.write(key)
    # 限制权限（仅 owner 可读写）
    try:
        os.chmod(_KEY_FILE, 0o600)
    except Exception:
        pass
    return key


# 全局 Fernet 实例（延迟初始化）
_fernet: Fernet = None


class SecretEncryptionError(RuntimeError):
    """Raised when a secret cannot be encrypted safely."""


class SecretDecryptionError(RuntimeError):
    """Raised when an encrypted secret cannot be decrypted safely."""


def _get_fernet() -> Fernet:
    """获取 Fernet 实例（延迟初始化）"""
    global _fernet
    if _fernet is None:
        key = _load_or_create_key()
        _fernet = Fernet(key)
    return _fernet


def encrypt(plaintext: str) -> str:
    """加密字符串，返回 base64 编码的密文"""
    if not plaintext:
        return plaintext
    try:
        f = _get_fernet()
        encrypted = f.encrypt(plaintext.encode("utf-8"))
        return encrypted.decode("utf-8")
    except Exception as e:
        _logger.error("[CRYPTO] 加密失败，已拒绝写入密钥")
        raise SecretEncryptionError("secret encryption failed") from e


def decrypt(ciphertext: str) -> str:
    """解密字符串，返回明文"""
    if not ciphertext:
        return ciphertext
    # 只有明确不是 Fernet token 的历史值才按 legacy plaintext 兼容读取。
    # 看起来像密文但无法验证的值必须失败关闭，不能当作明文继续路由。
    if not is_encrypted(ciphertext):
        return ciphertext
    try:
        f = _get_fernet()
        decrypted = f.decrypt(ciphertext.encode("utf-8"))
        return decrypted.decode("utf-8")
    except Exception as exc:
        _logger.error("[CRYPTO] 密钥解密失败，已拒绝使用该值")
        raise SecretDecryptionError("secret decryption failed") from exc


def is_encrypted(value: str) -> bool:
    """判断字符串是否已加密（Fernet token 以 gAAAAA 开头）"""
    if not value:
        return False
    return value.startswith("gAAAAA")


def mask_secret(value: str, prefix_length: int = 6, suffix_length: int = 4) -> str:
    """返回不可还原完整 secret 的预览文本。"""
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    if len(value) <= prefix_length + suffix_length:
        return f"{value[:2]}••••{value[-2:]}"
    return f"{value[:prefix_length]}...{value[-suffix_length:]}"
