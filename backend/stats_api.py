import os
import sys
import signal
import subprocess
from datetime import date, timedelta
from typing import Optional
from flask import Blueprint, request, jsonify, send_from_directory, send_file, Response, stream_with_context

import db
import config

stats_bp = Blueprint('stats', __name__)
# dashboard_bp：仅在 Dashboard 进程（8889）上注册，代理进程（8888）不服务静态文件
dashboard_bp = Blueprint('dashboard', __name__)


# ==========================================
# 工具函数
# ==========================================

def _get_date_range():
    """从 query string 获取日期范围，默认近 7 天"""
    today = str(date.today())
    default_start = str(date.today() - timedelta(days=6))

    start_date = request.args.get("start_date", default_start)
    end_date = request.args.get("end_date", today)

    # 简单格式校验
    try:
        from datetime import datetime
        datetime.strptime(start_date, "%Y-%m-%d")
        datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        return None, None, "日期格式错误，请使用 YYYY-MM-DD 格式"

    return start_date, end_date, None


def _cors_response(data, status=200):
    """返回带 CORS headers 的 JSON 响应"""
    resp = jsonify(data)
    resp.status_code = status
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@stats_bp.after_request
def add_cors_headers(response):
    """为所有 stats Blueprint 的响应添加 CORS 头"""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


# ==========================================
# 统计 API 接口
# ==========================================

@stats_bp.route("/api/stats/overview", methods=["GET", "OPTIONS"])
def overview():
    """总览统计数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_overview(start_date, end_date)
        return _cors_response(data)
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/daily", methods=["GET", "OPTIONS"])
def daily():
    """按日期分组的趋势数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_daily(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/models", methods=["GET", "OPTIONS"])
def models():
    """按模型分组的统计数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_models(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/requests", methods=["GET", "OPTIONS"])
def requests_list():
    """分页查询请求明细"""
    if request.method == "OPTIONS":
        return _cors_response({})

    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = min(100, max(1, int(request.args.get("page_size", 20))))
    except (ValueError, TypeError):
        return _cors_response({"error": "page 和 page_size 必须为正整数"}, 400)

    filters = {
        "model": request.args.get("model", "all"),
        "date": request.args.get("date", ""),
        "start_date": request.args.get("start_date", ""),
        "end_date": request.args.get("end_date", ""),
        "status": request.args.get("status", "all"),
        # v4 新增：全量排序支持
        "sort_by": request.args.get("sort_by", "created_at"),
        "sort_order": request.args.get("sort_order", "desc"),
    }

    try:
        data = db.query_requests(page, page_size, filters)
        return _cors_response(data)
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/latency_distribution", methods=["GET", "OPTIONS"])
def latency_distribution():
    """延迟分布直方图数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    model = request.args.get("model", "all")

    try:
        data = db.query_latency_distribution(start_date, end_date, model)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/models/list", methods=["GET", "OPTIONS"])
def models_list():
    """获取所有出现过的模型名列表（供前端筛选下拉框）"""
    if request.method == "OPTIONS":
        return _cors_response({})

    try:
        data = db.query_available_models()
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


# ==========================================
# 实时日志 SSE 接口
# ==========================================

def _log_file_path(log_file_param: str, date_str: str = "") -> Optional[str]:
    """
    根据 log_file 类型和可选日期返回实际日志文件路径。
    date_str 为空时返回当日（无后缀）文件；
    date_str 为 YYYY-MM-DD 时返回归档文件（proxy-xxx.log.YYYY-MM-DD）。
    """
    prefix_map = {
        "business": "proxy-business.log",
        "system":   "proxy-system.log",
        "error":    "proxy-system.log",  # 兼容旧参数
    }
    prefix = prefix_map.get(log_file_param)
    if not prefix:
        return None
    if date_str:
        return os.path.join(config.LOG_DIR, f"{prefix}.{date_str}")
    return os.path.join(config.LOG_DIR, prefix)


def _auto_archive_if_needed():
    """
    自动归档检查：若当前日志文件中存在非今天的日志行，立即触发归档。
    在每次日志相关接口被调用时执行，完全透明，前端无感知。
    """
    import re as _re
    from datetime import datetime as _dt

    today = _dt.now().strftime("%Y-%m-%d")
    DATE_RE = _re.compile(r'^(\d{4}-\d{2}-\d{2})')

    for log_file in ("proxy-business.log", "proxy-system.log"):
        log_path = os.path.join(config.LOG_DIR, log_file)
        if not os.path.isfile(log_path) or os.path.getsize(log_path) == 0:
            continue
        try:
            # 只读前 20 行做快速检测，避免大文件全量读取
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                sample = [f.readline() for _ in range(20)]
            has_old = any(
                (m := DATE_RE.match(l)) and m.group(1) != today
                for l in sample if l.strip()
            )
            if not has_old:
                continue
            # 确认有历史日期内容，全量读取并归档
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                all_lines = f.readlines()
            date_buckets: dict = {}
            today_lines: list = []
            for line in all_lines:
                m2 = DATE_RE.match(line)
                d = m2.group(1) if m2 else None
                if d == today:
                    today_lines.append(line)
                elif d:
                    date_buckets.setdefault(d, []).append(line)
                else:
                    if today_lines:
                        today_lines.append(line)
                    elif date_buckets:
                        date_buckets[sorted(date_buckets.keys())[-1]].append(line)
                    else:
                        today_lines.append(line)
            if not date_buckets:
                continue
            archived = False
            for date_str, lines in sorted(date_buckets.items()):
                archive_path = os.path.join(config.LOG_DIR, f"{log_file}.{date_str}")
                if os.path.isfile(archive_path) and os.path.getsize(archive_path) > 0:
                    continue
                try:
                    with open(archive_path, "w", encoding="utf-8") as f:
                        f.writelines(lines)
                    archived = True
                except Exception:
                    pass
            if archived:
                try:
                    with open(log_path, "w", encoding="utf-8") as f:
                        f.writelines(today_lines)
                except Exception:
                    pass
        except Exception:
            pass


@stats_bp.route("/api/logs/dates", methods=["GET", "OPTIONS"])
def logs_dates():
    """
    返回可查询的日志日期列表（含今天）。
    每次调用时自动检查并归档过期日志，前端无感知。
    格式：{"data": ["2026-06-11", "2026-06-10", ...]}
    """
    if request.method == "OPTIONS":
        return _cors_response({})

    # 自动归档：若日志文件中有非今天的行，立即归档
    _auto_archive_if_needed()

    log_file_param = request.args.get("log_file", "business")
    prefix_map = {
        "business": "proxy-business.log",
        "system":   "proxy-system.log",
        "error":    "proxy-system.log",
    }
    prefix = prefix_map.get(log_file_param, "proxy-business.log")

    from datetime import datetime as _dt
    today = str(date.today())
    dates = [today]  # 今天始终在列表

    try:
        for fname in sorted(os.listdir(config.LOG_DIR), reverse=True):
            if fname.startswith(prefix + "."):
                suffix = fname[len(prefix) + 1:]
                # 校验是否为合法日期格式
                try:
                    _dt.strptime(suffix, "%Y-%m-%d")
                    # 跳过 0 字节的空归档文件（可能是历史清理留下的残骸）
                    fpath = os.path.join(config.LOG_DIR, fname)
                    if os.path.getsize(fpath) == 0:
                        continue
                    if suffix not in dates:
                        dates.append(suffix)
                except ValueError:
                    pass
    except Exception:
        pass

    return _cors_response({"data": dates})


@stats_bp.route("/api/logs/history", methods=["GET", "OPTIONS"])
def logs_history():
    """
    历史日志查询接口（HTTP，非 SSE）。
    参数：
      log_file=business|system（默认 business）
      date=YYYY-MM-DD（默认今天）
      lines=200（返回最后 N 行，最大 2000）
    """
    if request.method == "OPTIONS":
        return _cors_response({})

    # 自动归档：确保历史日志已正确分离
    _auto_archive_if_needed()

    log_file_param = request.args.get("log_file", "business")
    date_str = request.args.get("date", str(date.today()))
    try:
        n_lines = min(2000, max(1, int(request.args.get("lines", 200))))
    except (ValueError, TypeError):
        n_lines = 200

    today = str(date.today())
    # 今天的日志读无后缀文件，历史日期读归档文件
    if date_str == today:
        log_path = _log_file_path(log_file_param)
    else:
        log_path = _log_file_path(log_file_param, date_str)

    if not log_path:
        return _cors_response({"error": "log_file 参数无效"}, 400)

    if not os.path.exists(log_path):
        # 文件不存在（该日期无日志）
        return _cors_response({"lines": [], "date": date_str, "total": 0, "empty_file": False})

    if os.path.getsize(log_path) == 0:
        # 文件存在但为空（可能是刚轮换的空归档）
        return _cors_response({"lines": [], "date": date_str, "total": 0, "empty_file": True})

    try:
        result = subprocess.run(
            ["tail", "-n", str(n_lines), log_path],
            capture_output=True, text=True, timeout=5
        )
        raw_lines = [l for l in result.stdout.splitlines() if l.strip()]
        return _cors_response({"lines": raw_lines, "date": date_str, "total": len(raw_lines)})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/logs/stream", methods=["GET"])
def logs_stream():
    """
    SSE 实时日志流接口（仅用于今天的实时追踪）。
    连接时自动检查并归档过期日志，确保 tail 读到的是今天的内容。
    参数：
      log_file=business（默认）或 system
      lines=200（初始展示最后 N 行，最大 2000）
    """
    # 自动归档：SSE 连接前先归档，确保 tail 的日志是今天的
    _auto_archive_if_needed()
    log_file_param = request.args.get("log_file", "business")
    try:
        n_lines = min(2000, max(1, int(request.args.get("lines", 200))))
    except (ValueError, TypeError):
        n_lines = 200

    log_path = _log_file_path(log_file_param)
    if not log_path:
        return jsonify({"error": "log_file 参数无效，可选值：business, system"}), 400

    if not os.path.exists(log_path):
        return jsonify({"error": f"日志文件不存在：{log_path}"}), 404

    # 空文件：发送特殊 SSE 事件通知前端文件为空，而不是挂起 tail -f
    if os.path.getsize(log_path) == 0:
        def generate_empty():
            yield "event: empty\ndata: {}\n\n"
            # 继续挂起（tail -f 行为），等待新写入
            import time as _time
            import subprocess as _sub
            import os as _os
            proc = _sub.Popen(["tail", "-f", "-n", "0", log_path],
                              stdout=_sub.PIPE, stderr=_sub.PIPE)
            hb = 0
            while True:
                line = proc.stdout.readline()
                if line:
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        yield f"data: {text}\n\n"
                    hb = 0
                else:
                    hb += 1
                    if hb >= 100:
                        yield ": ping\n\n"
                        hb = 0
                    _time.sleep(0.1)
        return Response(
            stream_with_context(generate_empty()),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                     "Access-Control-Allow-Origin": "*"},
        )

    def generate():
        import time as _time
        process = None
        try:
            # tail -f -n N：先输出最后 N 行历史，再持续追踪新内容
            process = subprocess.Popen(
                ["tail", "-f", "-n", str(n_lines), log_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            # 心跳计数器：每 100 次空循环（约 10s）发送一次 SSE 注释心跳
            # SSE 注释格式：": ping\n\n" —— 浏览器不会触发 onmessage，只是保持连接
            heartbeat_counter = 0

            while True:
                line = process.stdout.readline()
                if line:
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        yield f"data: {text}\n\n"
                    heartbeat_counter = 0
                else:
                    heartbeat_counter += 1
                    if heartbeat_counter >= 100:
                        yield ": ping\n\n"
                        heartbeat_counter = 0
                    _time.sleep(0.1)

        except GeneratorExit:
            pass
        except Exception:
            pass
        finally:
            if process:
                try:
                    process.terminate()
                    process.wait(timeout=2)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ==========================================
# 日志配置 API（保留天数可配置）
# ==========================================

@stats_bp.route("/api/logs/config", methods=["GET", "OPTIONS"])
def logs_config_get():
    """查询日志保留天数配置"""
    if request.method == "OPTIONS":
        return _cors_response({})
    return _cors_response({"retention_days": config.LOG_BACKUP_DAYS})


@stats_bp.route("/api/logs/config", methods=["PUT", "OPTIONS"])
def logs_config_put():
    """更新日志保留天数（1-365 天），持久化到 runtime_config.json"""
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "PUT, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp
    try:
        body = request.get_json(silent=True) or {}
        retention_days = body.get("retention_days")
        if retention_days is None:
            return _cors_response({"success": False, "message": "缺少 retention_days 字段"}, 400)
        try:
            retention_days = int(retention_days)
        except (ValueError, TypeError):
            return _cors_response({"success": False, "message": "retention_days 必须为整数"}, 400)
        if not (1 <= retention_days <= 365):
            return _cors_response({"success": False, "message": "retention_days 必须在 1-365 之间"}, 400)

        # 更新内存配置
        config.LOG_BACKUP_DAYS = retention_days

        # 持久化到 runtime_config.json
        _save_runtime_config({"log_retention_days": retention_days})

        return _cors_response({"success": True, "retention_days": retention_days})
    except Exception as e:
        return _cors_response({"success": False, "message": str(e)}, 500)


# ==========================================
# Dashboard 静态文件路由
# ==========================================

# ==========================================
# v3 新增统计 API 端点
# ==========================================

@stats_bp.route("/api/stats/by-model", methods=["GET", "OPTIONS"])
def stats_by_model():
    """按模型聚合的详细统计数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_model_stats(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/by-provider", methods=["GET", "OPTIONS"])
def stats_by_provider():
    """按厂商聚合的统计数据（基于请求中的 provider 字段）"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_provider_stats(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/error-analysis", methods=["GET", "OPTIONS"])
def stats_error_analysis():
    """错误类型聚合统计"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_error_analysis(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/hourly", methods=["GET", "OPTIONS"])
def stats_hourly():
    """按小时分布统计（默认今天）"""
    if request.method == "OPTIONS":
        return _cors_response({})

    from datetime import datetime as _dt
    target_date = request.args.get("date", str(date.today()))
    try:
        _dt.strptime(target_date, "%Y-%m-%d")
    except ValueError:
        return _cors_response({"error": "date 格式错误，请使用 YYYY-MM-DD 格式"}, 400)

    try:
        data = db.query_hourly(target_date)
        return _cors_response({"data": data, "date": target_date})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/request/<int:request_id>/detail", methods=["GET", "OPTIONS"])
def stats_request_detail(request_id):
    """获取单条请求的完整详情（含 request_body / response_body）"""
    if request.method == "OPTIONS":
        return _cors_response({})

    try:
        data = db.query_request_detail(request_id)
        if data is None:
            return _cors_response({"error": f"请求 ID {request_id} 不存在"}, 404)
        return _cors_response(data)
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


# ==========================================
# v4 新增：代理状态控制接口
# ==========================================

def _get_port_pid(port: int):
    """检测指定端口是否被监听，返回 PID 或 None。
    macOS 使用 lsof（可获取 PID），Linux 使用 socket 探测（无法获取 PID 但可判断端口状态）。"""
    if config.IS_MACOS:
        try:
            result = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=3
            )
            pid_str = result.stdout.strip()
            if pid_str:
                return int(pid_str.split('\n')[0])
        except Exception:
            pass
        return None
    else:
        # Linux/Docker：使用 socket 探测（返回 1 表示端口被占用，None 表示空闲）
        import socket as _socket
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
                s.settimeout(1)
                if s.connect_ex(('127.0.0.1', port)) == 0:
                    return 1  # 端口被占用（无法获取真实 PID）
        except Exception:
            pass
        return None


def _get_proxy_pid():
    """检测代理端口（PROXY_PORT）是否被监听"""
    return _get_port_pid(config.PROXY_PORT)


@stats_bp.route("/api/proxy/status", methods=["GET", "OPTIONS"])
def proxy_status():
    """检测代理服务运行状态（仅检测代理端口，不含 Dashboard 端口）"""
    if request.method == "OPTIONS":
        return _cors_response({})
    pid = _get_proxy_pid()
    return _cors_response({
        "running": pid is not None,
        "port": config.PROXY_PORT,
        "pid": pid,
    })


def _kill_port_process(port: int) -> dict:
    """杀死监听指定端口的进程，同步等待进程退出。返回 {success, message}"""
    import time as _time
    pid = _get_port_pid(port)
    if pid is None:
        return {"success": True, "message": f"端口 {port} 上没有运行中的进程"}
    try:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return {"success": True, "message": f"进程 {pid} 已退出"}
        except Exception as e:
            return {"success": False, "message": str(e)}

        # 等待最多 3 秒
        for _ in range(30):
            _time.sleep(0.1)
            if _get_port_pid(port) is None:
                return {"success": True, "message": f"已停止 (PID {pid}, 端口 {port})"}

        # 强制杀死
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
        for _ in range(20):
            _time.sleep(0.1)
            if _get_port_pid(port) is None:
                return {"success": True, "message": f"已强制停止 (PID {pid}, 端口 {port})"}

        return {"success": False, "message": f"停止失败，端口 {port} 的进程 {pid} 仍在运行"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@stats_bp.route("/api/proxy/stop", methods=["POST", "OPTIONS"])
def proxy_stop():
    """停止代理服务（只杀监听 PROXY_PORT 的进程，Dashboard 不受影响）

    支持可选 JSON body：{"old_port": <port>}
    - 不传或与 PROXY_PORT 相同：停止当前配置端口的进程
    - 传入 old_port 且与 PROXY_PORT 不同：停止旧端口进程（用于修改端口后切换）
    """
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    # 解析可选的 old_port 参数
    body = request.get_json(silent=True) or {}
    old_port = body.get("old_port")

    # ── macOS：先 launchctl unload，防止 KeepAlive 在进程被杀后自动重拉 ──
    # unload 只注销 launchd 托管条目，不影响 plist 文件本身（开机自启状态不变）。
    # 若 plist 不存在或未托管，launchctl unload 会静默失败，不影响后续 kill。
    # Linux/Docker：无 launchd，跳过此步骤。
    if config.IS_MACOS:
        proxy_plist = _get_plist_path()
        if os.path.isfile(proxy_plist):
            subprocess.run(["launchctl", "unload", proxy_plist], capture_output=True, timeout=5)

    if old_port and int(old_port) != config.PROXY_PORT:
        # 端口变更场景：停止旧端口进程
        result = _kill_port_process(int(old_port))
    else:
        # 普通停止：停止当前配置端口进程
        result = _kill_port_process(config.PROXY_PORT)

    status_code = 200 if result["success"] else 500
    return _cors_response(result, status_code)


@stats_bp.route("/api/proxy/start", methods=["POST", "OPTIONS"])
def proxy_start():
    """启动代理服务（独立进程，不影响 Dashboard）

    正确流程：
    1. 若端口被占（进程仍在或刚被杀掉 TIME_WAIT），等待端口彻底释放（最多 5 秒）
    2. 端口释放后再启动新进程
    3. 等待新进程真正绑定端口（最多 10 秒），才返回成功
    """
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    import time as _time

    # 步骤1：等待端口完全释放（无论是正在运行还是刚停止的 TIME_WAIT 状态）
    # 最多等 5 秒，每 0.1 秒检测一次
    if _get_port_pid(config.PROXY_PORT) is not None:
        for _ in range(50):
            _time.sleep(0.1)
            if _get_port_pid(config.PROXY_PORT) is None:
                break
        else:
            return _cors_response({"success": False, "message": f"端口 {config.PROXY_PORT} 仍被占用，无法启动"}, 409)

    # 步骤2：始终直接 Popen 启动（响应快，不依赖 launchd ThrottleInterval）；
    # 若 plist 存在，启动成功后再 launchctl load 让 launchd 接管（崩溃自动重启）。
    proxy_plist = _get_plist_path()
    try:
        proxy_script = os.path.join(config.BACKEND_DIR, "proxy.py")
        subprocess.Popen(
            [sys.executable, proxy_script, '--proxy'],
            cwd=config.BACKEND_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        return _cors_response({"success": False, "message": str(e)}, 500)

    # 步骤3：等待新进程真正绑定端口（最多 10 秒）
    for _ in range(100):
        _time.sleep(0.1)
        if _get_port_pid(config.PROXY_PORT) is not None:
            pid = _get_proxy_pid()
            # macOS：plist 存在时让 launchd 接管（静默失败不影响已运行进程）
            # Linux/Docker：无 launchd，跳过。
            if config.IS_MACOS and os.path.isfile(proxy_plist):
                subprocess.run(["launchctl", "load", proxy_plist], capture_output=True, timeout=5)
            return _cors_response({"success": True, "message": f"代理启动成功（PID {pid}，端口 {config.PROXY_PORT}）"})

    return _cors_response({"success": False, "message": "代理启动超时，请查看日志"}, 500)


# ==========================================
# v5 新增：代理配置查询 + 编辑 + 开机自启管理
# ==========================================

def _get_plist_path():
    """获取代理服务 launchd plist 文件路径（仅 macOS）"""
    if not config.IS_MACOS:
        return ""
    return os.path.expanduser("~/Library/LaunchAgents/com.heimdall.proxy.plist")


def _get_dashboard_plist_path():
    """获取 Dashboard 服务 launchd plist 文件路径（仅 macOS）"""
    if not config.IS_MACOS:
        return ""
    return os.path.expanduser("~/Library/LaunchAgents/com.heimdall.dashboard.plist")


def _make_plist_content(proxy_script: str, work_dir: str) -> str:
    """生成代理服务 launchd plist 内容（--proxy 模式）"""
    python_bin = sys.executable
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.heimdall.proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python_bin}</string>
        <string>{proxy_script}</string>
        <string>--proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{work_dir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
</dict>
</plist>
"""


def _make_dashboard_plist_content(proxy_script: str, work_dir: str) -> str:
    """生成 Dashboard 服务 launchd plist 内容（--dashboard 模式）"""
    python_bin = sys.executable
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.heimdall.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python_bin}</string>
        <string>{proxy_script}</string>
        <string>--dashboard</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{work_dir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
"""


def _get_config_path():
    """获取持久化配置文件路径（存储可编辑字段）"""
    return config.RUNTIME_CONFIG_PATH


def _load_runtime_config() -> dict:
    """读取运行时可编辑配置"""
    cfg_path = _get_config_path()
    defaults = {
        "upstream_url": getattr(config, 'TARGET_BASE_URL', ''),
        "proxy_port": config.PROXY_PORT,
        "dashboard_port": getattr(config, 'DASHBOARD_PORT', 8889),
        "proxy_path": getattr(config, 'PROXY_PATH', '/v1/openai/native'),
        "request_timeout": config.REQUEST_TIMEOUT,
    }
    if os.path.isfile(cfg_path):
        try:
            import json
            with open(cfg_path, 'r') as f:
                saved = json.load(f)
            defaults.update(saved)
        except Exception:
            pass
    return defaults


def _save_runtime_config(data: dict):
    """保存运行时可编辑配置"""
    import json
    cfg_path = _get_config_path()
    existing = _load_runtime_config()
    existing.update(data)
    with open(cfg_path, 'w') as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)


@stats_bp.route("/api/proxy/config", methods=["GET", "OPTIONS"])
def proxy_config_get():
    """查询代理完整配置：代理端口、路径、上游地址、超时、自启状态"""
    if request.method == "OPTIONS":
        return _cors_response({})
    cfg = _load_runtime_config()
    # macOS：两个 plist 都存在才算完整开启自启
    # Linux/Docker：自启由 Docker restart policy 管理，此处固定返回 False
    if config.IS_MACOS:
        autostart_enabled = (
            os.path.isfile(_get_plist_path()) and
            os.path.isfile(_get_dashboard_plist_path())
        )
    else:
        autostart_enabled = False
    return _cors_response({
        "proxy_port": cfg.get("proxy_port", config.PROXY_PORT),
        "dashboard_port": cfg.get("dashboard_port", getattr(config, 'DASHBOARD_PORT', 8889)),
        "proxy_path": cfg.get("proxy_path", getattr(config, 'PROXY_PATH', '/v1/openai/native')),
        "upstream_url": cfg.get("upstream_url", getattr(config, 'TARGET_BASE_URL', '')),
        "request_timeout": cfg.get("request_timeout", config.REQUEST_TIMEOUT),
        "autostart_enabled": autostart_enabled,
    })


@stats_bp.route("/api/proxy/config", methods=["PUT", "OPTIONS"])
def proxy_config_put():
    """更新代理配置（upstream_url / proxy_path / request_timeout）"""
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "PUT, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp
    try:
        body = request.get_json(silent=True) or {}
        allowed = {"upstream_url", "proxy_path", "proxy_port", "request_timeout"}
        to_save = {k: v for k, v in body.items() if k in allowed}
        if not to_save:
            return _cors_response({"success": False, "message": "无有效字段"}, 400)
        _save_runtime_config(to_save)
        # 同步到 config 模块内存（重启后以持久化文件为准）
        if "upstream_url" in to_save:
            config.TARGET_BASE_URL = to_save["upstream_url"]
        if "proxy_path" in to_save:
            config.PROXY_PATH = to_save["proxy_path"]
        if "proxy_port" in to_save:
            config.PROXY_PORT = int(to_save["proxy_port"])
        if "request_timeout" in to_save:
            config.REQUEST_TIMEOUT = int(to_save["request_timeout"])
        return _cors_response({"success": True, "message": "配置已更新，重启代理后完全生效"})
    except Exception as e:
        return _cors_response({"success": False, "message": str(e)}, 500)


@stats_bp.route("/api/proxy/autostart/install", methods=["POST", "OPTIONS"])
def proxy_autostart_install():
    """
    开启开机自启：只写入 plist 文件，不调用任何 launchctl 命令。
    launchd 会在下次登录时读取 plist 自动生效；
    不执行 load/unload/bootout/bootstrap，避免任何 launchctl
    操作意外终止当前正在运行的进程（Dashboard 自身）。
    Linux/Docker 环境不支持此功能（使用 Docker restart policy 替代）。
    """
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp
    if not config.IS_MACOS:
        return _cors_response({"success": False, "message": "开机自启仅支持 macOS（Docker 环境请使用 restart: unless-stopped）"}, 400)
    try:
        proxy_script = os.path.join(config.BACKEND_DIR, "proxy.py")
        work_dir = config.BASE_DIR

        # ── 代理服务 plist ──
        plist_path = _get_plist_path()
        os.makedirs(os.path.dirname(plist_path), exist_ok=True)
        with open(plist_path, 'w') as f:
            f.write(_make_plist_content(proxy_script, work_dir))

        # ── Dashboard 服务 plist ──
        dash_plist_path = _get_dashboard_plist_path()
        with open(dash_plist_path, 'w') as f:
            f.write(_make_dashboard_plist_content(proxy_script, work_dir))

        return _cors_response({"success": True, "message": "开机自启已开启（下次登录自动启动，当前服务不受影响）"})
    except Exception as e:
        return _cors_response({"success": False, "message": str(e)}, 500)


@stats_bp.route("/api/proxy/autostart/uninstall", methods=["POST", "OPTIONS"])
def proxy_autostart_uninstall():
    """
    关闭开机自启：只删除 plist 文件，不调用任何 launchctl 命令。
    plist 文件不存在后，下次登录 launchd 不再自启；
    不执行 unload/bootout，避免任何 launchctl 操作终止当前进程。
    Linux/Docker 环境不支持此功能。
    """
    if request.method == "OPTIONS":
        resp = jsonify({})
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp
    if not config.IS_MACOS:
        return _cors_response({"success": False, "message": "开机自启仅支持 macOS（Docker 环境请使用 restart: unless-stopped）"}, 400)
    try:
        for plist_path in (_get_plist_path(), _get_dashboard_plist_path()):
            if os.path.isfile(plist_path):
                os.remove(plist_path)
        return _cors_response({"success": True, "message": "开机自启已关闭（当前服务不受影响）"})
    except Exception as e:
        return _cors_response({"success": False, "message": str(e)}, 500)


# ==========================================
# Dashboard 静态文件路由（仅注册到 dashboard_bp，由 8889 进程服务）
# 代理进程（8888）只处理 AI 请求，不服务 Dashboard 页面
# ==========================================

@dashboard_bp.route("/", defaults={"_redirect": True})
def root_redirect(_redirect):
    """根路径重定向到 Dashboard"""
    from flask import redirect
    return redirect("/dashboard/", code=302)


@dashboard_bp.route("/<path:filename>")
def root_static(filename):
    """
    Serve 根路径静态资源（favicon.svg, avatar.gif, icons.svg 等）。
    Vite 构建后 public/ 目录下的文件会被复制到 dist/ 根目录，
    浏览器会直接请求 /favicon.svg、/avatar.gif 等根路径，
    必须单独路由处理，否则 /dashboard/<path> 无法匹配根路径文件。
    """
    import mimetypes as _mimetypes

    dist_dir = config.DASHBOARD_DIST_DIR
    file_path = os.path.join(dist_dir, filename)

    # 只服务真实存在的文件，避免拦截 API 路由（/api/...）
    if not os.path.isfile(file_path):
        from flask import abort
        abort(404)

    mime_type, _ = _mimetypes.guess_type(file_path)
    if mime_type is None:
        mime_type = "application/octet-stream"

    def _read_root(path):
        try:
            with open(path, "rb") as f:
                return f.read()
        except OSError:
            pass
        import subprocess as _sp
        try:
            r = _sp.run(["cat", path], capture_output=True, timeout=15)
            if r.returncode == 0:
                return r.stdout
        except Exception:
            pass
        import tempfile as _tmp, shutil as _shutil
        try:
            tmp = _tmp.NamedTemporaryFile(delete=False)
            tmp.close()
            _shutil.copy2(path, tmp.name)
            with open(tmp.name, "rb") as f:
                data = f.read()
            os.unlink(tmp.name)
            return data
        except Exception:
            pass
        raise OSError(f"[Errno 1] Operation not permitted: {path!r}")

    try:
        data = _read_root(file_path)
    except Exception:
        from flask import abort
        abort(404)

    resp = Response(data, status=200, mimetype=mime_type)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@dashboard_bp.route("/dashboard/", defaults={"filename": "index.html"})
@dashboard_bp.route("/dashboard/<path:filename>")
def dashboard(filename):
    """
    Serve 前端 Dashboard 静态文件。
    
    使用直接文件读取而非 send_from_directory，规避 macOS com.apple.provenance
    扩展属性在长时间运行的 launchd 进程中导致权限降级（authorization denied）的问题。
    该属性由 macOS TCC 机制管理，用户无法手动删除，但 Python open() 在大多数
    进程上下文中可以正常读取。
    """
    import mimetypes as _mimetypes
    import logging as _logging
    _slogger = _logging.getLogger("system")

    dist_dir = config.DASHBOARD_DIST_DIR

    if not os.path.exists(dist_dir):
        return (
            "<h2>Dashboard 尚未构建</h2>"
            "<p>请执行以下命令构建前端：</p>"
            "<pre>cd dashboard && npm install && npm run build</pre>",
            404
        )

    # SPA fallback：所有非静态资源路径都返回 index.html
    file_path = os.path.join(dist_dir, filename)
    if not os.path.exists(file_path) or os.path.isdir(file_path):
        filename = "index.html"
        file_path = os.path.join(dist_dir, filename)

    def _read_file(path):
        """
        读取文件内容。
        策略：
          1. 先用 Python open() 直接读（最快）
          2. 若因 com.apple.provenance xattr 导致 [Errno 1] Operation not permitted，
             改用子进程 cat 读取（cat 继承的 TCC 沙箱上下文较宽松，通常可以绕过该限制）
          3. cat 也失败时，把文件 cp 到系统临时目录后再读（新文件不带原 xattr）
        com.apple.provenance 无法被 xattr -d/-rc 删除（macOS TCC 系统保护），
        因此不再尝试 xattr 清除，直接走绕过路径。
        """
        try:
            with open(path, "rb") as f:
                return f.read()
        except OSError:
            pass
        # 方案2：用子进程 cat 读取
        import subprocess as _sp
        try:
            r = _sp.run(["cat", path], capture_output=True, timeout=15)
            if r.returncode == 0:
                _slogger.info(f"[DASHBOARD] cat fallback OK: {path!r}")
                return r.stdout
        except Exception:
            pass
        # 方案3：cp 到临时文件后读取（新文件不继承原 xattr）
        import tempfile as _tmp, shutil as _shutil
        try:
            tmp = _tmp.NamedTemporaryFile(delete=False)
            tmp.close()
            _shutil.copy2(path, tmp.name)
            with open(tmp.name, "rb") as f:
                data = f.read()
            os.unlink(tmp.name)
            _slogger.info(f"[DASHBOARD] cp-tmp fallback OK: {path!r}")
            return data
        except Exception:
            pass
        raise OSError(f"[Errno 1] Operation not permitted: {path!r}")

    mime_type, _ = _mimetypes.guess_type(file_path)
    if mime_type is None:
        mime_type = "application/octet-stream"

    try:
        data = _read_file(file_path)
    except Exception as e2:
        import traceback as _tb
        _slogger.error(f"[DASHBOARD] 读取静态文件失败 filename={filename!r}: {e2}")
        _slogger.error(_tb.format_exc())
        return (
            f"<h2>Dashboard 加载失败</h2>"
            f"<p>文件: {filename}</p>"
            f"<pre>{e2}</pre>",
            500,
        )

    resp = Response(data, status=200, mimetype=mime_type)
    # 静态资源（JS/CSS 等）缓存 1 小时，index.html 不缓存（SPA 入口）
    if filename == "index.html":
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    else:
        resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp
