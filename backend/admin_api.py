"""
路由管理 API
提供厂商、模型和 API Key 的 CRUD 接口。
"""

import json
import os
from flask import Blueprint, request, jsonify
import router
import auth

admin_bp = Blueprint('admin', __name__)


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
    
    required = ["name", "api_key"]
    for field in required:
        if field not in data:
            return jsonify({"error": f"Missing required field: {field}"}), 400
    
    # openai_url 和 anthropic_url 至少要有一个
    if not data.get("openai_url") and not data.get("anthropic_url"):
        return jsonify({"error": "OpenAI 和 Anthropic 协议地址至少填写一个"}), 400
    
    # 检查厂商名是否已存在
    existing = router.get_provider_by_name(data["name"])
    if existing:
        return jsonify({"error": f"厂商 '{data['name']}' 已存在"}), 409
    
    try:
        provider_id = router.create_provider(data)
        return jsonify({"id": provider_id, "message": "Provider created"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
    
    if "model_name" not in data:
        return jsonify({"error": "Missing required field: model_name"}), 400
    
    if "upstream_model" not in data or not data["upstream_model"]:
        return jsonify({"error": "Missing required field: upstream_model"}), 400
    
    try:
        model_id = router.create_model(provider_id, data)
        return jsonify({"id": model_id, "message": "Model created"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/models/<int:model_id>', methods=['PUT'])
def update_model(model_id):
    """更新模型"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
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
    # 脱敏处理
    for key in keys:
        if key.get("api_key"):
            v = key["api_key"]
            key["api_key_preview"] = v[:6] + "..." + v[-4:] if len(v) > 10 else v
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
    # 脱敏处理：heimdall-xxxx...后四位
    for key in keys:
        if key.get("key_value"):
            v = key["key_value"]
            key["key_preview"] = v[:8] + "..." + v[-4:] if len(v) > 12 else v
    return jsonify({"keys": keys})


@admin_bp.route('/api/keys', methods=['POST'])
def create_api_key():
    """创建 API Key"""
    data = request.get_json() or {}
    try:
        result = auth.create_api_key(data)
        return jsonify(result), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@admin_bp.route('/api/keys/<int:key_id>', methods=['PUT'])
def update_api_key(key_id):
    """更新 API Key"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400
    
    success = auth.update_api_key(key_id, data)
    if not success:
        return jsonify({"error": "API Key not found or no changes"}), 404
    return jsonify({"message": "API Key updated"})


@admin_bp.route('/api/keys/<int:key_id>', methods=['DELETE'])
def delete_api_key(key_id):
    """删除 API Key"""
    success = auth.delete_api_key(key_id)
    if not success:
        return jsonify({"error": "API Key not found"}), 404
    return jsonify({"message": "API Key deleted"})
