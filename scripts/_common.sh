#!/bin/bash
# =============================================================================
# _common.sh — Heimdall 公共变量与工具函数
# 被 heimdall.sh / proxy.sh / dashboard.sh 共同 source
# =============================================================================

# ── 确保 UTF-8 编码环境（修复中文乱码）──
export LANG="${LANG:-zh_CN.UTF-8}"
export LC_ALL="${LC_ALL:-zh_CN.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-zh_CN.UTF-8}"

# ── 解析调用脚本的真实路径，从而定位项目根目录 ──
_resolve_real() {
    local f="$1"
    if command -v realpath &>/dev/null; then
        realpath "$f"
    elif command -v greadlink &>/dev/null; then
        greadlink -f "$f"
    else
        python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$f" 2>/dev/null || echo "$f"
    fi
}

SCRIPTS_DIR="$(cd "$(dirname "$(_resolve_real "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
PYTHON_BIN="/usr/bin/python3"
LOG_DIR="$PROJECT_DIR/logs"
PROXY_SCRIPT="$BACKEND_DIR/proxy.py"

# ── plist 名称 ──
PLIST_PROXY="com.heimdall.proxy"
PLIST_DASHBOARD="com.heimdall.dashboard"
PLIST_PROXY_PATH="$HOME/Library/LaunchAgents/$PLIST_PROXY.plist"
PLIST_DASHBOARD_PATH="$HOME/Library/LaunchAgents/$PLIST_DASHBOARD.plist"

# ── 动态读取端口配置 ──
PROXY_PORT="${HEIMDALL_PORT:-$("$PYTHON_BIN" -c "import sys; sys.path.insert(0,'$BACKEND_DIR'); import config; print(config.PROXY_PORT)" 2>/dev/null || echo 8888)}"
DASHBOARD_PORT="${HEIMDALL_DASHBOARD_PORT:-$("$PYTHON_BIN" -c "import sys; sys.path.insert(0,'$BACKEND_DIR'); import config; print(config.DASHBOARD_PORT)" 2>/dev/null || echo 8889)}"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_info()  { echo -e "${BLUE}[Heimdall]${NC} $1"; }
print_ok()    { echo -e "${GREEN}[Heimdall]${NC} ✅ $1"; }
print_warn()  { echo -e "${YELLOW}[Heimdall]${NC} ⚠️  $1"; }
print_err()   { echo -e "${RED}[Heimdall]${NC} ❌ $1"; }

# ── 代理进程 ──
# 以 plist 文件是否存在为准（而非 launchctl list）：
# disable 只删除 plist 文件不执行 launchctl，状态应立即反映。
is_proxy_launchd() { [ -f "$PLIST_PROXY_PATH" ]; }
get_proxy_pid()    { pgrep -f "$PROXY_SCRIPT.*--proxy" 2>/dev/null | head -1; }

# ── 面板进程 ──
is_dashboard_launchd() { [ -f "$PLIST_DASHBOARD_PATH" ]; }
get_dashboard_pid()    { pgrep -f "$PROXY_SCRIPT.*--dashboard" 2>/dev/null | head -1; }

# =============================================================================
# 代理：启动
# =============================================================================
start_proxy() {
    local pid; pid=$(get_proxy_pid)
    [ -n "$pid" ] && { print_warn "代理已在运行  PID: $pid"; return 0; }
    local occupied; occupied=$(lsof -ti :"$PROXY_PORT" 2>/dev/null | head -1)
    if [ -n "$occupied" ]; then
        print_err "端口 $PROXY_PORT 已被 PID $occupied 占用"; return 1
    fi
    mkdir -p "$LOG_DIR"
    # 始终直接 nohup 启动（响应快），若 plist 存在则再 launchctl load 让 launchd 接管
    nohup "$PYTHON_BIN" "$PROXY_SCRIPT" --proxy > /dev/null 2>&1 &
    sleep 1
    pid=$(get_proxy_pid)
    if [ -n "$pid" ]; then
        print_ok "代理服务已启动  PID: $pid  端口: $PROXY_PORT"
        # plist 存在时让 launchd 接管（崩溃自动重启），load 失败不影响已运行进程
        [ -f "$PLIST_PROXY_PATH" ] && launchctl load "$PLIST_PROXY_PATH" 2>/dev/null
    else
        print_err "代理启动失败，请查看日志：$LOG_DIR/proxy-system.log"; return 1
    fi
}

# =============================================================================
# 代理：停止
# =============================================================================
stop_proxy() {
    # 先通过 launchctl unload 注销 launchd 托管，防止 kill 后被 KeepAlive 自动重拉。
    # unload 不删除 plist 文件，开机自启状态不受影响。
    if [ -f "$PLIST_PROXY_PATH" ]; then
        launchctl unload "$PLIST_PROXY_PATH" 2>/dev/null
    fi
    local pid; pid=$(get_proxy_pid)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null; sleep 1
        pid=$(get_proxy_pid)
        [ -n "$pid" ] && { kill -9 "$pid" 2>/dev/null; sleep 1; }
    fi
    pid=$(get_proxy_pid)
    if [ -z "$pid" ]; then
        print_ok "代理服务已停止"
    else
        print_err "代理停止失败，进程 $pid 仍在运行"; return 1
    fi
}

# =============================================================================
# 面板：启动
# =============================================================================
start_dashboard() {
    local pid; pid=$(get_dashboard_pid)
    [ -n "$pid" ] && { print_warn "面板已在运行  PID: $pid"; return 0; }
    local occupied; occupied=$(lsof -ti :"$DASHBOARD_PORT" 2>/dev/null | head -1)
    if [ -n "$occupied" ]; then
        print_err "端口 $DASHBOARD_PORT 已被 PID $occupied 占用"; return 1
    fi
    mkdir -p "$LOG_DIR"
    # 始终直接 nohup 启动（响应快），若 plist 存在则再 launchctl load 让 launchd 接管
    nohup "$PYTHON_BIN" "$PROXY_SCRIPT" --dashboard > /dev/null 2>&1 &
    sleep 1
    pid=$(get_dashboard_pid)
    if [ -n "$pid" ]; then
        print_ok "统计面板已启动  PID: $pid  端口: $DASHBOARD_PORT"
        print_info "访问地址：http://localhost:$DASHBOARD_PORT/dashboard/"
        # plist 存在时让 launchd 接管（崩溃自动重启），load 失败不影响已运行进程
        [ -f "$PLIST_DASHBOARD_PATH" ] && launchctl load "$PLIST_DASHBOARD_PATH" 2>/dev/null
    else
        print_err "面板启动失败，请查看日志：$LOG_DIR/proxy-system.log"; return 1
    fi
}

# =============================================================================
# 面板：停止
# =============================================================================
stop_dashboard() {
    # 先通过 launchctl unload 注销 launchd 托管，防止 kill 后被 KeepAlive 自动重拉。
    # unload 不删除 plist 文件，开机自启状态不受影响。
    if [ -f "$PLIST_DASHBOARD_PATH" ]; then
        launchctl unload "$PLIST_DASHBOARD_PATH" 2>/dev/null
    fi
    local pid; pid=$(get_dashboard_pid)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null; sleep 1
        pid=$(get_dashboard_pid)
        [ -n "$pid" ] && { kill -9 "$pid" 2>/dev/null; sleep 1; }
    fi
    pid=$(get_dashboard_pid)
    if [ -z "$pid" ]; then
        print_ok "统计面板已停止"
    else
        print_err "面板停止失败，进程 $pid 仍在运行"; return 1
    fi
}
