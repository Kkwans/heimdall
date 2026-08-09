"""
路由管理 API
提供厂商、模型和 API Key 的 CRUD 接口。
"""

import json
import os
import sqlite3
from flask import Blueprint, request, jsonify
import router
import auth

admin_bp = Blueprint('admin', __name__)

_MODEL_PRICE_FIELDS = (
    "price_input",
    "price_output",
    "price_cache_read",
    "price_cache_write",
)


def _validate_model_data(data: dict):
    """校验模型数值字段，返回中文错误或 None。"""
    context_window = data.get("context_window")
    if context_window is not None:
        if isinstance(context_window, bool) or not isinstance(context_window, (int, float)):
            return "上下文窗口必须是正整数"
        if context_window <= 0 or int(context_window) != context_window:
            return "上下文窗口必须是正整数"

    for field in _MODEL_PRICE_FIELDS:
        value = data.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            return "模型价格必须是大于或等于 0 的数字"

    pricing_configured = data.get("pricing_configured")
    if pricing_configured is not None and pricing_configured not in (True, False, 0, 1):
        return "价格配置状态无效"
    return None


def load_vendor_presets():
    """加载厂商预设配置"""
    presets_path = os.path.join(os.path.dirname(__file__), 'vendor_presets.json')
    try:
        with open(presets_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {"version": 1, "vendors": {}}


@admin_bp.route('/api/vendor-presets', methods=['GET'])
def get_vendor_presets():
    """获取厂商预设配置"""
    return jsonify(load_vendor_presets())


# ==========================================
# 厂商管理 API
# ==========================================

@admin_bp.route('/api/providers', methods=['GET'])
def list_providers():
    """获取所有厂商列表"""
    providers = router.get_all_providers()
    return jsonify({"providers": providers})


@admin_bp.route('/api/providers/<int:provider_id>', methods=['GET'])
def get_provider(provider_id):
    """获取单个厂商详情（含模型列表）"""
    provider = router.get_provider(provider_id)
    if not provider:
        return jsonify({"error": "Provider not found"}), 404
    models = router.get_models_by_provider(provider_id)
    provider["models"] = models
    return jsonify(provider)


@admin_bp.route('/api/providers', methods=['POST'])
def create_provider():
    """创建厂商"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    for field, message in (("name", "请输入厂商标识"), ("api_key", "请输入首个 Provider API Key")):
        if not isinstance(data.get(field), str) or not data[field].strip():
            return jsonify({"error": message}), 400
    
    # openai_url 和 anthropic_url 至少要有一个
    if not data.get("openai_url") and not data.get("anthropic_url"):
        return jsonify({"error": "OpenAI 和 Anthropic 协议地址至少填写一个"}), 400
    
    # 检查厂商名是否已存在
    existing = router.get_provider_by_name(data["name"])
    if existing:
        return jsonify({"error": f"厂商 '{data['name']}' 已存在"}), 409
    
    try:
        provider_id = router.create_provider(data)
        return jsonify({"id": provider_id, "message": "厂商创建成功"}), 201
    except sqlite3.IntegrityError as exc:
        if "UNIQUE constraint failed: providers.name" in str(exc):
            return jsonify({"error": f"厂商 '{data['name']}' 已存在"}), 409
        return jsonify({"error": "创建厂商失败，请稍后重试"}), 500
    except Exception:
        return jsonify({"error": "创建厂商失败，请稍后重试"}), 500


@admin_bp.route('/api/providers/<int:provider_id>', methods=['PUT'])
def update_provider(provider_id):
    """更新厂商"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    success = router.update_provider(provider_id, data)
    if not success:
        return jsonify({"error": "Provider not found or no changes"}), 404
    return jsonify({"message": "Provider updated"})


@admin_bp.route('/api/providers/<int:provider_id>', methods=['DELETE'])
def delete_provider(provider_id):
    """删除厂商（级联删除关联模型）"""
    success = router.delete_provider(provider_id)
    if not success:
        return jsonify({"error": "Provider not found"}), 404
    return jsonify({"message": "Provider deleted"})


# ==========================================
# 模型管理 API
# ==========================================

@admin_bp.route('/api/providers/<int:provider_id>/models', methods=['GET'])
def list_models(provider_id):
    """获取厂商下的模型列表"""
    provider = router.get_provider(provider_id)
    if not provider:
        return jsonify({"error": "Provider not found"}), 404
    models = router.get_models_by_provider(provider_id)
    return jsonify({"models": models})


@admin_bp.route('/api/providers/<int:provider_id>/models', methods=['POST'])
def create_model(provider_id):
    """添加模型"""
    provider = router.get_provider(provider_id)
    if not provider:
        return jsonify({"error": "Provider not found"}), 404
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    if not isinstance(data.get("model_name"), str) or not data["model_name"].strip():
        return jsonify({"error": "请输入模型名称"}), 400
    
    if "upstream_model" not in data or not data["upstream_model"]:
        return jsonify({"error": "请输入上游模型名"}), 400

    validation_error = _validate_model_data(data)
    if validation_error:
        return jsonify({"error": validation_error}), 400
    
    try:
        model_id = router.create_model(provider_id, data)
        return jsonify({"id": model_id, "message": "Model created"}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": f"模型 '{data['model_name']}' 已存在"}), 409
    except Exception:
        return jsonify({"error": "添加模型失败，请稍后重试"}), 500


@admin_bp.route('/api/models/<int:model_id>', methods=['PUT'])
def update_model(model_id):
    """更新模型"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    validation_error = _validate_model_data(data)
    if validation_error:
        return jsonify({"error": validation_error}), 400
    success = router.update_model(model_id, data)
    if not success:
        return jsonify({"error": "Model not found or no changes"}), 404
    return jsonify({"message": "Model updated"})


@admin_bp.route('/api/models/<int:model_id>', methods=['DELETE'])
def delete_model(model_id):
    """删除模型"""
    success = router.delete_model(model_id)
    if not success:
        return jsonify({"error": "Model not found"}), 404
    return jsonify({"message": "Model deleted"})


# ==========================================
# 厂商 API Key 管理 API（多 Key 优先级轮询）
# ==========================================

@admin_bp.route('/api/providers/<int:provider_id>/api-keys', methods=['GET'])
def list_provider_api_keys(provider_id):
    """获取厂商的所有 API Key"""
    provider = router.get_provider(provider_id)
    if not provider:
        return jsonify({"error": "Provider not found"}), 404
    keys = router.get_provider_api_keys(provider_id)
    return jsonify({"keys": keys})


@admin_bp.route('/api/providers/<int:provider_id>/api-keys', methods=['POST'])
def create_provider_api_key(provider_id):
    """添加厂商 API Key"""
    provider = router.get_provider(provider_id)
    if not provider:
        return jsonify({"error": "Provider not found"}), 404
    data = request.get_json()
    if not data or not data.get("api_key"):
        return jsonify({"error": "api_key is required"}), 400
    try:
        key_id = router.create_provider_api_key(provider_id, data)
        return jsonify({"id": key_id, "message": "API Key created"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/provider-api-keys/<int:key_id>', methods=['PUT'])
def update_provider_api_key(key_id):
    """更新厂商 API Key"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    success = router.update_provider_api_key(key_id, data)
    if not success:
        return jsonify({"error": "Key not found or no changes"}), 404
    return jsonify({"message": "API Key updated"})


@admin_bp.route('/api/provider-api-keys/<int:key_id>', methods=['DELETE'])
def delete_provider_api_key(key_id):
    """删除厂商 API Key"""
    success = router.delete_provider_api_key(key_id)
    if not success:
        return jsonify({"error": "Key not found"}), 404
    return jsonify({"message": "API Key deleted"})


# ==========================================
# API Key 管理 API
# ==========================================

@admin_bp.route('/api/keys', methods=['GET'])
def list_api_keys():
    """获取所有 API Key"""
    keys = auth.get_all_api_keys()
    return jsonify({"keys": keys})


@admin_bp.route('/api/keys', methods=['POST'])
def create_api_key():
    """创建 API Key"""
    data = request.get_json() or {}
    try:
        result = auth.create_api_key(data)
        response = jsonify(result)
        response.headers["Cache-Control"] = "no-store"
        return response, 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/keys/<int:key_id>', methods=['PUT'])
def update_api_key(key_id):
    """更新 API Key"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    success, new_key_value = auth.update_api_key(key_id, data)
    if not success:
        return jsonify({"error": "API Key not found or no changes"}), 404
    payload = {"message": "API Key updated"}
    if new_key_value is not None:
        payload["key_value"] = new_key_value
    response = jsonify(payload)
    if new_key_value is not None:
        response.headers["Cache-Control"] = "no-store"
    return response


@admin_bp.route('/api/keys/<int:key_id>/copy', methods=['POST'])
def copy_api_key(key_id):
    """仅在用户主动点击复制时返回单个完整 Key，不随列表批量下发。"""
    key_value = auth.get_api_key_value(key_id)
    if key_value is None:
        return jsonify({"error": "API Key not found"}), 404
    response = jsonify({"key_value": key_value})
    response.headers["Cache-Control"] = "no-store"
    return response


@admin_bp.route('/api/keys/<int:key_id>', methods=['DELETE'])
def delete_api_key(key_id):
    """删除 API Key"""
    success = auth.delete_api_key(key_id)
    if not success:
        return jsonify({"error": "API Key not found"}), 404
    return jsonify({"message": "API Key deleted"})
