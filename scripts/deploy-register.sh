#!/bin/bash
# Heimdall - 绿联 Docker UI 注册脚本
# 用途：创建部署目录、符号链接、注册到 NAS Docker UI 数据库
# 使用：在 NAS 上以 Kkwans 用户运行
# 前置条件：T1-T3 的文件已准备好（Dockerfile-proxy, Dockerfile-dashboard, docker-compose.yml）

set -e

# ── 配置 ──────────────────────────────────────────────────────
PROJECT_NAME="heimdall"
DEPLOY_DIR="/volume1/DockerProject/${PROJECT_NAME}"
SOURCE_DIR="/volume2/Project/Heimdall"
DOCKER_APPS="/volume1/docker-apps"
DB_PATH="/volume1/@appstore/com.ugreen.docker/db/docker_info_log.db"
COMPOSE_FILE="docker-compose.yml"

echo "🔧 Heimdall 绿联 Docker UI 注册脚本"
echo "=================================="
echo ""

# ── 步骤 1：创建部署目录 ──────────────────────────────────────
echo "📁 步骤 1: 创建部署目录 ${DEPLOY_DIR}"
if [ -d "${DEPLOY_DIR}" ]; then
    echo "   ⚠️  目录已存在，跳过创建"
else
    mkdir -p "${DEPLOY_DIR}"
    echo "   ✅ 目录已创建"
fi

# ── 步骤 2：复制部署文件 ──────────────────────────────────────
echo "📋 步骤 2: 复制部署文件"
for file in docker-compose.yml Dockerfile-proxy Dockerfile-dashboard .env.example backend/requirements.txt; do
    src="${SOURCE_DIR}/${file}"
    dst="${DEPLOY_DIR}/${file}"
    if [ -f "${src}" ]; then
        # 创建目标子目录（如果需要）
        mkdir -p "$(dirname "${dst}")"
        cp -f "${src}" "${dst}"
        echo "   ✅ ${file}"
    elif [ -d "${src}" ]; then
        mkdir -p "${dst}"
        cp -rf "${src}/"* "${dst}/"
        echo "   ✅ ${file}/"
    else
        echo "   ❌ ${file} 不存在"
    fi
done

# 复制后端代码（Dockerfile 构建需要）
echo "   📦 复制 backend/ 目录..."
cp -rf "${SOURCE_DIR}/backend/" "${DEPLOY_DIR}/backend/"

# 复制前端代码（Dashboard Dockerfile 构建需要）
echo "   📦 复制 frontend/ 目录..."
cp -rf "${SOURCE_DIR}/frontend/" "${DEPLOY_DIR}/frontend/"

echo "   ✅ 所有文件已复制"

# ── 步骤 3：创建符号链接 ──────────────────────────────────────
echo "🔗 步骤 3: 创建符号链接"
LINK_PATH="${DOCKER_APPS}/${PROJECT_NAME}"
if [ -L "${LINK_PATH}" ]; then
    echo "   ⚠️  符号链接已存在，跳过创建"
elif [ -e "${LINK_PATH}" ]; then
    echo "   ❌ ${LINK_PATH} 已存在（非符号链接），请手动处理"
    exit 1
else
    ln -s "${DEPLOY_DIR}" "${LINK_PATH}"
    echo "   ✅ ${LINK_PATH} → ${DEPLOY_DIR}"
fi

# ── 步骤 4：注册到绿联 Docker UI 数据库 ──────────────────────
echo "💾 步骤 4: 注册到绿联 Docker UI 数据库"

# 检查数据库是否存在
if [ ! -f "${DB_PATH}" ]; then
    echo "   ❌ 数据库不存在: ${DB_PATH}"
    exit 1
fi

# 检查是否已注册
EXISTING=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM compose WHERE name='${PROJECT_NAME}';")
if [ "${EXISTING}" -gt 0 ]; then
    echo "   ⚠️  项目 '${PROJECT_NAME}' 已注册，更新路径"
    sqlite3 "${DB_PATH}" \
        "UPDATE compose SET path='${DEPLOY_DIR}/${COMPOSE_FILE}', updated_at=datetime('now') WHERE name='${PROJECT_NAME}';"
    echo "   ✅ 路径已更新"
else
    sqlite3 "${DB_PATH}" \
        "INSERT INTO compose (created_at, updated_at, name, state, path, content, app_id, container_num) \
         VALUES (datetime('now'), datetime('now'), '${PROJECT_NAME}', 0, '${DEPLOY_DIR}/${COMPOSE_FILE}', '', '', 2);"
    echo "   ✅ 已注册到数据库（state=0，容器启动后更新为 1）"
fi

# ── 验证 ──────────────────────────────────────────────────────
echo ""
echo "📋 验证结果"
echo "=================================="

# 检查部署目录
echo -n "部署目录: "
if [ -d "${DEPLOY_DIR}" ] && [ -f "${DEPLOY_DIR}/${COMPOSE_FILE}" ]; then
    echo "✅ ${DEPLOY_DIR}"
else
    echo "❌ 缺少文件"
fi

# 检查符号链接
echo -n "符号链接: "
if [ -L "${LINK_PATH}" ] && [ -d "${LINK_PATH}" ]; then
    echo "✅ ${LINK_PATH} → $(readlink ${LINK_PATH})"
else
    echo "❌ 不存在或无效"
fi

# 检查数据库注册
echo -n "数据库注册: "
DB_ENTRY=$(sqlite3 "${DB_PATH}" "SELECT name, state, path FROM compose WHERE name='${PROJECT_NAME}';")
if [ -n "${DB_ENTRY}" ]; then
    echo "✅ ${DB_ENTRY}"
else
    echo "❌ 未注册"
fi

echo ""
echo "🚀 下一步操作："
echo "   1. 构建镜像: cd ${DEPLOY_DIR} && docker compose build"
echo "   2. 启动容器: cd ${DEPLOY_DIR} && docker compose up -d"
echo "   3. 更新数据库状态: sqlite3 ${DB_PATH} \"UPDATE compose SET state=1, container_num=2 WHERE name='${PROJECT_NAME}';\""
echo "   4. 验证: docker compose ps && curl -s http://localhost:8888/health"
