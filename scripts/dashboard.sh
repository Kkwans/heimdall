#!/bin/bash
# =============================================================================
# dashboard — 统计面板管理（:8889，Web 看板）
#
#   dashboard start    启动面板
#   dashboard stop     停止面板（代理不受影响）
#   dashboard restart  重启面板
#   dashboard status   查看面板状态
# =============================================================================

_self="$0"
if command -v realpath &>/dev/null; then _self="$(realpath "$0")"
elif command -v greadlink &>/dev/null; then _self="$(greadlink -f "$0")"
fi
source "$(cd "$(dirname "$_self")" && pwd)/_common.sh"

case "${1:-status}" in
    start)
        start_dashboard
        ;;
    stop)
        stop_dashboard
        ;;
    restart)
        print_info "重启统计面板..."
        stop_dashboard; sleep 1; start_dashboard
        ;;
    status)
        local_pid=$(get_dashboard_pid)
        echo ""
        echo -e "${BOLD}${CYAN}  统计面板  :$DASHBOARD_PORT${NC}"
        if [ -n "$local_pid" ]; then
            echo -e "  ${GREEN}● 运行中${NC}  PID: $local_pid"
            echo -e "  🌐 http://localhost:$DASHBOARD_PORT/dashboard/"
        else
            echo -e "  ${RED}○ 已停止${NC}"
        fi
        is_dashboard_launchd \
            && echo -e "  ${GREEN}🔄 开机自启：已启用${NC}" \
            || echo -e "  ${YELLOW}⭕ 开机自启：未启用${NC}   安装：heimdall install"
        echo ""
        ;;
    help|--help|-h)
        echo ""
        echo -e "${BOLD}dashboard${NC} — 统计面板管理  :$DASHBOARD_PORT  Web 看板"
        echo ""
        echo -e "  ${CYAN}dashboard start${NC}    启动面板"
        echo -e "  ${CYAN}dashboard stop${NC}     停止面板（代理不受影响）"
        echo -e "  ${CYAN}dashboard restart${NC}  重启面板"
        echo -e "  ${CYAN}dashboard status${NC}   查看面板状态"
        echo ""
        echo -e "  全局管理：${CYAN}heimdall --help${NC}"
        echo ""
        ;;
    *)
        print_err "未知命令：$1"
        echo "用法：dashboard <start|stop|restart|status>"
        exit 1
        ;;
esac
