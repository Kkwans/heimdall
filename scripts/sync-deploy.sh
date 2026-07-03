#!/bin/bash
# Heimdall - 部署修复脚本（T6 前置）
# 修复问题：
# 1. backend/ 目录嵌套错误（backend/backend/ → backend/）
# 2. 源码未同步（T5 macOS 条件化代码未推送）
# 3. 缺少 .env 文件

set -e

PROJECT_NAME="heimdall"
DEPLOY_DIR="/volume1/DockerProject/${PROJECT_NAME}"
SOURCE_DIR="/volume2/Project/Heimdall"

echo "🔧 Heimdall 部署修复脚本（T6 前置）"
echo "====================================="
echo ""

# ── 步骤 1：清理嵌套目录 ──────────────────────────────────────
echo "📁 步骤 1: 修复 backend/ 目录结构"
if [ -d "${DEPLOY_DIR}/backend/backend" ]; then
    echo "   ⚠️  发现嵌套 backend/backend/，正在修复..."
    # 移动嵌套的文件到正确位置
    cp -f "${DEPLOY_DIR}/backend/backend/"*.py "${DEPLOY_DIR}/backend/" 2>/dev/null || true
    cp -f "${DEPLOY_DIR}/backend/backend/requirements.txt" "${DEPLOY_DIR}/backend/" 2>/dev/null || true
    rm -rf "${DEPLOY_DIR}/backend/backend"
    echo "   ✅ backend/backend/ 已修复"
else
    echo "   ✅ 目录结构正常"
fi

# ── 步骤 2：同步最新源码 ──────────────────────────────────────
echo "📋 步骤 2: 同步最新源码（包含 T5 macOS 条件化代码）"

# 后端代码
echo "   📦 同步 backend/..."
for file in config.py proxy.py stats_api.py credit_api.py db.py requirements.txt; do
    if [ -f "${SOURCE_DIR}/backend/${file}" ]; then
        cp -f "${SOURCE_DIR}/backend/${file}" "${DEPLOY_DIR}/backend/${file}"
        echo "   ✅ backend/${file}"
    fi
done

# 前端代码（完整同步）
echo "   📦 同步 frontend/..."
rm -rf "${DEPLOY_DIR}/frontend"
cp -rf "${SOURCE_DIR}/frontend" "${DEPLOY_DIR}/frontend"
echo "   ✅ frontend/ 已更新"

# Docker/Compose 文件
echo "   📦 同步 Docker 配置文件..."
for file in docker-compose.yml Dockerfile-proxy Dockerfile-dashboard .env.example .dockerignore; do
    if [ -f "${SOURCE_DIR}/${file}" ]; then
        cp -f "${SOURCE_DIR}/${file}" "${DEPLOY_DIR}/${file}"
        echo "   ✅ ${file}"
    fi
done

# ── 步骤 3：创建 .env 文件 ──────────────────────────────────
echo "📝 步骤 3: 创建 .env 文件"
if [ -f "${DEPLOY_DIR}/.env" ]; then
    echo "   ⚠️  .env 已存在，跳过（保留用户配置）"
else
    cp "${DEPLOY_DIR}/.env.example" "${DEPLOY_DIR}/.env"
    echo "   ✅ .env 已从 .env.example 创建"
fi

# ── 步骤 4：修复文件权限 ──────────────────────────────────
echo "🔐 步骤 4: 修复文件权限"
chmod 644 "${DEPLOY_DIR}/docker-compose.yml" 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/Dockerfile-proxy" 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/Dockerfile-dashboard" 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/.env" 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/.env.example" 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/backend/"*.py 2>/dev/null || true
chmod 644 "${DEPLOY_DIR}/backend/requirements.txt" 2>/dev/null || true
chmod -R u+rwX "${DEPLOY_DIR}/frontend/" 2>/dev/null || true
echo "   ✅ 权限已修复"

# ── 验证 ──────────────────────────────────────────────────
echo ""
echo "📋 验证结果"
echo "====================================="

# 检查后端文件
echo -n "后端文件: "
if [ -f "${DEPLOY_DIR}/backend/proxy.py" ] && [ -f "${DEPLOY_DIR}/backend/config.py" ]; then
    echo "✅ 完整（$(ls ${DEPLOY_DIR}/backend/*.py 2>/dev/null | wc -l) 个 Python 文件）"
else
    echo "❌ 缺少文件"
fi

# 检查前端文件
echo -n "前端文件: "
if [ -f "${DEPLOY_DIR}/frontend/package.json" ]; then
    echo "✅ 完整"
else
    echo "❌ 缺少 package.json"
fi

# 检查 Docker 文件
echo -n "Docker 文件: "
if [ -f "${DEPLOY_DIR}/docker-compose.yml" ] && [ -f "${DEPLOY_DIR}/Dockerfile-proxy" ] && [ -f "${DEPLOY_DIR}/Dockerfile-dashboard" ]; then
    echo "✅ 完整"
else
    echo "❌ 缺少文件"
fi

# 检查 .env
echo -n "环境配置: "
if [ -f "${DEPLOY_DIR}/.env" ]; then
    echo "✅ .env 存在"
else
    echo "❌ 缺少 .env"
fi

# 检查嵌套问题
echo -n "目录结构: "
if [ -d "${DEPLOY_DIR}/backend/backend" ]; then
    echo "❌ 仍有嵌套 backend/backend/"
else
    echo "✅ 正常"
fi

echo ""
echo "🚀 修复完成！下一步："
echo "   cd ${DEPLOY_DIR} && docker compose build && docker compose up -d"
