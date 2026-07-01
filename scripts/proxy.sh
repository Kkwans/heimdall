#!/bin/bash
# =============================================================================
# proxy — 代理服务管理（:8888，AI 请求转发）
#
#   proxy start    启动代理
#   proxy stop     停止代理（面板不受影响）
#   proxy restart  重启代理
#   proxy status   查看代理状态
# =============================================================================

_self="$0"
if command -v realpath &>/dev/null; then _self="$(realpath "$0")"
elif command -v greadlink &>/dev/null; then _self="$(greadlink -f "$0")"
fi
source "$(cd "$(dirname "$_self")" && pwd)/_common.sh"

case "${1:-status}" in
    start)
        start_proxy
        ;;
    stop)
        stop_proxy
        ;;
    restart)
        print_info "重启代理服务..."
        stop_proxy; sleep 1; start_proxy
        ;;
    status)
        local_pid=$(get_proxy_pid)
        echo ""
        echo -e "${BOLD}${CYAN}  代理服务  :$PROXY_PORT${NC}"
        if [ -n "$local_pid" ]; then
            echo -e "  ${GREEN}● 运行中${NC}  PID: $local_pid"
        else
            echo -e "  ${RED}○ 已停止${NC}"
        fi
        is_proxy_launchd \
            && echo -e "  ${GREEN}🔄 开机自启：已启用${NC}" \
            || echo -e "  ${YELLOW}⭕ 开机自启：未启用${NC}   安装：heimdall install"
        echo ""
        ;;
    help|--help|-h)
        echo ""
        echo -e "${BOLD}proxy${NC} — 代理服务管理  :$PROXY_PORT  AI 请求转发"
        echo ""
        echo -e "  ${CYAN}proxy start${NC}    启动代理"
        echo -e "  ${CYAN}proxy stop${NC}     停止代理（面板不受影响）"
        echo -e "  ${CYAN}proxy restart${NC}  重启代理"
        echo -e "  ${CYAN}proxy status${NC}   查看代理状态"
        echo ""
        echo -e "  全局管理：${CYAN}heimdall --help${NC}"
        echo ""
        ;;
    *)
        print_err "未知命令：$1"
        echo "用法：proxy <start|stop|restart|status>"
        exit 1
        ;;
esac
