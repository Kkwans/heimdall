#!/bin/bash
# =============================================================================
# heimdall — 全局管理（代理 + 面板同时控制）
#
#   heimdall start      同时启动代理 + 面板
#   heimdall stop       同时停止代理 + 面板
#   heimdall restart    同时重启代理 + 面板
#   heimdall status     查看两者运行状态
#   heimdall install    首次安装：启动服务 + 开机自启 + 注册全局命令
#   heimdall enable     仅开启开机自启（服务和全局命令不受影响）
#   heimdall disable    仅关闭开机自启（服务和全局命令不受影响）
#   heimdall uninstall  完全卸载：停止服务 + 关闭自启 + 移除全局命令
#   heimdall logs       实时查看业务日志
# =============================================================================

_self="$0"
if command -v realpath &>/dev/null; then _self="$(realpath "$0")"
elif command -v greadlink &>/dev/null; then _self="$(greadlink -f "$0")"
fi
source "$(cd "$(dirname "$_self")" && pwd)/_common.sh"

cmd_start() {
    print_info "启动 Heimdall（代理 + 面板）..."
    start_proxy
    start_dashboard
}

cmd_stop() {
    print_info "停止 Heimdall（代理 + 面板）..."
    stop_proxy
    stop_dashboard
}

cmd_restart() {
    print_info "重启 Heimdall（代理 + 面板）..."
    stop_proxy; stop_dashboard; sleep 1
    start_proxy; start_dashboard
}

cmd_status() {
    local proxy_pid; proxy_pid=$(get_proxy_pid)
    local dash_pid;  dash_pid=$(get_dashboard_pid)

    echo ""
    echo -e "${BOLD}${BLUE}══════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${BLUE}   Heimdall 服务状态${NC}"
    echo -e "${BOLD}${BLUE}══════════════════════════════════════════════${NC}"

    echo -e "\n${CYAN}  ▸ 代理服务  :$PROXY_PORT${NC}"
    if [ -n "$proxy_pid" ]; then
        echo -e "    ${GREEN}● 运行中${NC}  PID: $proxy_pid"
    else
        echo -e "    ${RED}○ 已停止${NC}   运行：proxy start"
    fi
    is_proxy_launchd \
        && echo -e "    ${GREEN}🔄 开机自启：已启用${NC}" \
        || echo -e "    ${YELLOW}⭕ 开机自启：未启用${NC}   安装：heimdall install"

    echo -e "\n${CYAN}  ▸ 统计面板  :$DASHBOARD_PORT${NC}"
    if [ -n "$dash_pid" ]; then
        echo -e "    ${GREEN}● 运行中${NC}  PID: $dash_pid"
        echo -e "    🌐 http://localhost:$DASHBOARD_PORT/dashboard/"
    else
        echo -e "    ${RED}○ 已停止${NC}   运行：dashboard start"
    fi
    is_dashboard_launchd \
        && echo -e "    ${GREEN}🔄 开机自启：已启用${NC}" \
        || echo -e "    ${YELLOW}⭕ 开机自启：未启用${NC}   安装：heimdall install"

    echo -e "\n${BOLD}${BLUE}══════════════════════════════════════════════${NC}"
    echo ""
}

cmd_install() {
    print_info "安装开机自启（代理 + 面板）..."
    mkdir -p "$LOG_DIR"

    is_proxy_launchd     && launchctl unload "$PLIST_PROXY_PATH"     2>/dev/null
    is_dashboard_launchd && launchctl unload "$PLIST_DASHBOARD_PATH" 2>/dev/null
    sleep 1

    cat > "$PLIST_PROXY_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$PLIST_PROXY</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$PROXY_SCRIPT</string>
        <string>--proxy</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
</dict>
</plist>
EOF

    cat > "$PLIST_DASHBOARD_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$PLIST_DASHBOARD</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$PROXY_SCRIPT</string>
        <string>--dashboard</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
</dict>
</plist>
EOF

    launchctl load "$PLIST_PROXY_PATH"     2>/dev/null
    launchctl load "$PLIST_DASHBOARD_PATH" 2>/dev/null
    sleep 1

    local ok=1
    is_proxy_launchd     || { print_err "代理 plist 注册失败"; ok=0; }
    is_dashboard_launchd || { print_err "面板 plist 注册失败"; ok=0; }
    [ "$ok" -eq 1 ] && print_ok "开机自启安装成功（代理 + 面板均已注册）"

    # 安装三个全局命令
    echo ""
    print_info "正在安装全局命令..."
    local bin_dir
    if ln -sf "$SCRIPTS_DIR/heimdall.sh"  /usr/local/bin/heimdall  2>/dev/null && \
       ln -sf "$SCRIPTS_DIR/proxy.sh"     /usr/local/bin/proxy     2>/dev/null && \
       ln -sf "$SCRIPTS_DIR/dashboard.sh" /usr/local/bin/dashboard 2>/dev/null; then
        bin_dir="/usr/local/bin"
    else
        mkdir -p "$HOME/.local/bin"
        ln -sf "$SCRIPTS_DIR/heimdall.sh"  "$HOME/.local/bin/heimdall"
        ln -sf "$SCRIPTS_DIR/proxy.sh"     "$HOME/.local/bin/proxy"
        ln -sf "$SCRIPTS_DIR/dashboard.sh" "$HOME/.local/bin/dashboard"
        bin_dir="~/.local/bin"
        if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
            print_warn "~/.local/bin 不在 PATH，请在 ~/.zshrc 中添加："
            print_warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        fi
    fi
    print_ok "全局命令已安装到 $bin_dir  heimdall / proxy / dashboard"

    echo ""
    echo -e "${GREEN}[Heimdall]${NC} 安装完成！常用命令："
    echo -e "  ${CYAN}heimdall status${NC}    查看两个服务状态"
    echo -e "  ${CYAN}proxy stop${NC}         仅停止代理（面板不受影响）"
    echo -e "  ${CYAN}dashboard restart${NC}  仅重启面板（代理不受影响）"
    echo -e "  ${CYAN}heimdall logs${NC}      查看业务日志"
}

cmd_enable() {
    print_info "开启开机自启（服务和全局命令不受影响）..."
    mkdir -p "$(dirname "$PLIST_PROXY_PATH")"
    cat > "$PLIST_PROXY_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$PLIST_PROXY</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$PROXY_SCRIPT</string>
        <string>--proxy</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
</dict>
</plist>
EOF
    cat > "$PLIST_DASHBOARD_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$PLIST_DASHBOARD</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$PROXY_SCRIPT</string>
        <string>--dashboard</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
</dict>
</plist>
EOF
    print_ok "开机自启已开启，当前服务不受影响"
}

cmd_disable() {
    print_info "关闭开机自启（服务和全局命令不受影响）..."
    [ -f "$PLIST_PROXY_PATH" ]     && rm "$PLIST_PROXY_PATH"     && print_ok "代理 plist 已删除"
    [ -f "$PLIST_DASHBOARD_PATH" ] && rm "$PLIST_DASHBOARD_PATH" && print_ok "面板 plist 已删除"
    print_ok "开机自启已关闭，当前服务不受影响"
}

cmd_uninstall() {
    print_info "完全卸载（停止服务 + 关闭自启 + 移除全局命令）..."
    is_proxy_launchd     && { launchctl unload "$PLIST_PROXY_PATH"     2>/dev/null; print_ok "代理 launchd 已卸载"; }
    is_dashboard_launchd && { launchctl unload "$PLIST_DASHBOARD_PATH" 2>/dev/null; print_ok "面板 launchd 已卸载"; }
    [ -f "$PLIST_PROXY_PATH" ]     && rm "$PLIST_PROXY_PATH"     && print_ok "代理 plist 已删除"
    [ -f "$PLIST_DASHBOARD_PATH" ] && rm "$PLIST_DASHBOARD_PATH" && print_ok "面板 plist 已删除"

    local pid
    pid=$(get_proxy_pid);    [ -n "$pid" ] && kill "$pid" 2>/dev/null && print_ok "代理进程已停止  PID: $pid"
    pid=$(get_dashboard_pid); [ -n "$pid" ] && kill "$pid" 2>/dev/null && print_ok "面板进程已停止  PID: $pid"

    rm -f /usr/local/bin/heimdall /usr/local/bin/proxy /usr/local/bin/dashboard 2>/dev/null
    rm -f "$HOME/.local/bin/heimdall" "$HOME/.local/bin/proxy" "$HOME/.local/bin/dashboard" 2>/dev/null
    print_ok "全局命令已移除。如需重装请执行："
    echo -e "  bash $SCRIPTS_DIR/heimdall.sh install"
}

cmd_logs() {
    echo -e "${BLUE}[Heimdall]${NC} 实时业务日志（Ctrl+C 退出）"
    echo -e "${BLUE}────────────────────────────────────────${NC}"
    tail -f "$LOG_DIR/proxy-business.log" 2>/dev/null || print_err "日志文件不存在：$LOG_DIR/proxy-business.log"
}

case "${1:-status}" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    install)   cmd_install ;;
    enable)    cmd_enable ;;
    disable)   cmd_disable ;;
    uninstall) cmd_uninstall ;;
    logs)      cmd_logs ;;
    help|--help|-h)
        echo ""
        echo -e "${BOLD}heimdall${NC} — Heimdall 全局管理（代理 + 面板）"
        echo ""
        echo -e "  ${CYAN}heimdall start${NC}      同时启动代理 + 面板"
        echo -e "  ${CYAN}heimdall stop${NC}       同时停止代理 + 面板"
        echo -e "  ${CYAN}heimdall restart${NC}    同时重启代理 + 面板"
        echo -e "  ${CYAN}heimdall status${NC}     查看两者运行状态"
        echo -e "  ${CYAN}heimdall install${NC}    首次安装：启动服务 + 开机自启 + 注册全局命令"
        echo -e "  ${CYAN}heimdall enable${NC}     仅开启开机自启（服务和全局命令不受影响）"
        echo -e "  ${CYAN}heimdall disable${NC}    仅关闭开机自启（服务和全局命令不受影响）"
        echo -e "  ${CYAN}heimdall uninstall${NC}  完全卸载：停止服务 + 关闭自启 + 移除全局命令"
        echo -e "  ${CYAN}heimdall logs${NC}       实时查看业务日志"
        echo ""
        echo -e "  另见：${CYAN}proxy --help${NC}  /  ${CYAN}dashboard --help${NC}"
        echo ""
        ;;
    *)
        print_err "未知命令：$1"
        echo "用法：heimdall <start|stop|restart|status|install|enable|disable|uninstall|logs>"
        exit 1
        ;;
esac
