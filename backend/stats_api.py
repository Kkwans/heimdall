import os
import sys
import signal
import subprocess
import tempfile
import threading
from datetime import date, timedelta
from typing import Optional
from flask import Blueprint, request, jsonify, send_from_directory, send_file, Response, stream_with_context

import db
import config
from services.docker_service import (
    DockerControlError,
    DockerControlTimeout,
    DockerService,
)
from services.request_retention import (
    RequestRetentionService,
    RetentionConfirmationError,
    RetentionError,
    RetentionValidationError,
)

stats_bp = Blueprint('stats', __name__)
# dashboard_bp：仅在 Dashboard 进程（8889）上注册，代理进程（8888）不服务静态文件
dashboard_bp = Blueprint('dashboard', __name__)

_retention_service_lock = threading.Lock()
_retention_service: Optional[RequestRetentionService] = None
_retention_service_path = ""


def get_request_retention_service() -> RequestRetentionService:
    """Return one token-preserving service instance for the active DB path."""
    global _retention_service, _retention_service_path
    database_path = os.path.abspath(config.DB_PATH)
    with _retention_service_lock:
        if _retention_service is None or _retention_service_path != database_path:
            _retention_service = RequestRetentionService(
                database_path,
                batch_size=getattr(config, "RETENTION_BATCH_SIZE", 500),
            )
            _retention_service_path = database_path
        return _retention_service


def get_docker_service() -> DockerService:
    return DockerService(
        container_name=getattr(config, "PROXY_CONTAINER_NAME", "heimdall-proxy"),
        proxy_host=getattr(config, "PROXY_HOST", "heimdall-proxy"),
        proxy_port=8888,
    )


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


@stats_bp.route("/api/dashboard/summary", methods=["GET", "OPTIONS"])
def dashboard_summary():
    """Return the existing Dashboard datasets in one consistent response."""
    if request.method == "OPTIONS":
        return _cors_response({})
    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)
    try:
        return _cors_response({
            "overview": db.query_overview(start_date, end_date),
            "daily": db.query_daily(start_date, end_date),
            "models": db.query_models(start_date, end_date),
        })
    except Exception as exc:
        return _cors_response({"error": str(exc)}, 500)


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


@stats_bp.route("/api/stats/costs", methods=["GET", "OPTIONS"])
def costs():
    """人民币成本汇总、Client Access Key 与模型分布。"""
    if request.method == "OPTIONS":
        return _cors_response({})
    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)
    try:
        return _cors_response(db.query_cost_stats(start_date, end_date))
    except Exception as exc:
        return _cors_response({"error": str(exc)}, 500)


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


@stats_bp.route("/api/requests/retention", methods=["GET", "OPTIONS"])
def request_retention_get():
    """Return disabled-by-default request retention settings and last run state."""
    if request.method == "OPTIONS":
        return _cors_response({})
    try:
        data = get_request_retention_service().get_config()
        data.update({
            "min_days": 1,
            "max_days": 3650,
            "schedule": "每日 00:15（Asia/Shanghai）",
            "vacuum_enabled": False,
        })
        return _cors_response(data)
    except RetentionError as exc:
        return _cors_response({"error": str(exc)}, 503)


@stats_bp.route("/api/requests/retention/preview", methods=["POST", "OPTIONS"])
def request_retention_preview():
    """Preview expired rows/body bytes and issue a short-lived confirmation."""
    if request.method == "OPTIONS":
        return _cors_response({})
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return _cors_response({"error": "请求体必须为 JSON 对象"}, 400)
    try:
        result = get_request_retention_service().preview(body.get("retention_days"))
        return _cors_response(result)
    except RetentionValidationError as exc:
        return _cors_response({"error": str(exc)}, 400)
    except RetentionError as exc:
        return _cors_response({"error": str(exc)}, 503)


@stats_bp.route("/api/requests/retention", methods=["PUT", "OPTIONS"])
def request_retention_put():
    """Save retention settings without deleting rows immediately."""
    if request.method == "OPTIONS":
        return _cors_response({})
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return _cors_response({"success": False, "error": "请求体必须为 JSON 对象"}, 400)
    try:
        result = get_request_retention_service().update_config(
            enabled=body.get("enabled"),
            retention_days=body.get("retention_days"),
            confirmation_token=body.get("confirmation_token"),
        )
        result.update({
            "success": True,
            "cleanup_started": False,
            "message": (
                "请求记录自动清理已启用，将从下一次每日任务开始执行"
                if result["enabled"]
                else "请求记录自动清理已关闭"
            ),
        })
        return _cors_response(result)
    except (RetentionValidationError, RetentionConfirmationError) as exc:
        return _cors_response({"success": False, "error": str(exc)}, 400)
    except RetentionError as exc:
        return _cors_response({"success": False, "error": str(exc)}, 503)


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
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

    CST = _tz(_td(hours=8))
    today = _dt.now(CST).strftime("%Y-%m-%d")
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
                try:
                    # 追加模式：将旧行追加到归档文件末尾
                    with open(archive_path, "a", encoding="utf-8") as f:
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
# APIKey 统计接口
# ==========================================

@stats_bp.route("/api/stats/api-keys", methods=["GET", "OPTIONS"])
def api_key_stats():
    """按 APIKey 分组的统计数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_api_key_stats(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/api-keys/models", methods=["GET", "OPTIONS"])
def api_key_model_stats():
    """按 APIKey + 模型分组的统计数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    try:
        data = db.query_api_key_model_stats(start_date, end_date)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


@stats_bp.route("/api/stats/api-keys/daily", methods=["GET", "OPTIONS"])
def api_key_daily():
    """按日期分组的 APIKey 趋势数据"""
    if request.method == "OPTIONS":
        return _cors_response({})

    start_date, end_date, err = _get_date_range()
    if err:
        return _cors_response({"error": err}, 400)

    api_key_id = request.args.get("api_key_id", None, type=int)

    try:
        data = db.query_api_key_daily(start_date, end_date, api_key_id)
        return _cors_response({"data": data})
    except Exception as e:
        return _cors_response({"error": str(e)}, 500)


# ==========================================
# 代理状态与固定容器控制接口
# ==========================================

def _proxy_socket_ready() -> bool:
    """Protocol-process fallback when Docker CLI is intentionally unavailable."""
    import socket as _socket
    proxy_host = getattr(config, "PROXY_HOST", "heimdall-proxy")
    try:
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            return sock.connect_ex((proxy_host, 8888)) == 0
    except Exception:
        return False


@stats_bp.route("/api/proxy/status", methods=["GET", "OPTIONS"])
def proxy_status():
    """Return Docker state plus HTTP readiness when Dashboard can inspect it."""
    if request.method == "OPTIONS":
        return _cors_response({})

    try:
        status = get_docker_service().get_status()
        status["control_available"] = True
    except DockerControlError:
        running = _proxy_socket_ready()
        status = {
            "running": running,
            "ready": running,
            "status": "running" if running else "unknown",
            "health": None,
            "control_available": False,
        }
    status.update({
        "port": getattr(config, "PROXY_EXTERNAL_PORT", 9888),
        "pid": None,
    })
    return _cors_response(status)


def _control_proxy(action: str):
    messages = {
        "start": "代理服务已启动并通过健康检查",
        "stop": "代理服务已停止",
        "restart": "代理服务已重启并通过健康检查",
    }
    try:
        result = get_docker_service().control(action)
        return _cors_response({
            "success": True,
            "message": messages[action],
            "state": result,
        })
    except DockerControlTimeout as exc:
        return _cors_response({"success": False, "message": str(exc)}, 504)
    except DockerControlError as exc:
        return _cors_response({"success": False, "message": str(exc)}, 500)


@stats_bp.route("/api/proxy/stop", methods=["POST", "OPTIONS"])
def proxy_stop():
    """Stop only the fixed allowlisted Heimdall Proxy container."""
    if request.method == "OPTIONS":
        return _cors_response({})
    return _control_proxy("stop")


@stats_bp.route("/api/proxy/start", methods=["POST", "OPTIONS"])
def proxy_start():
    """Start only the fixed allowlisted Heimdall Proxy container."""
    if request.method == "OPTIONS":
        return _cors_response({})
    return _control_proxy("start")


@stats_bp.route("/api/proxy/restart", methods=["POST", "OPTIONS"])
def proxy_restart():
    """Restart only the fixed allowlisted Heimdall Proxy container."""
    if request.method == "OPTIONS":
        return _cors_response({})
    return _control_proxy("restart")


# ==========================================
# v5 新增：代理配置查询 + 编辑 + 开机自启管理
# ==========================================

def _get_plist_path():
    """获取代理服务 launchd plist 文件路径（仅 macOS）"""
    return ""


def _get_dashboard_plist_path():
    """获取 Dashboard 服务 launchd plist 文件路径（仅 macOS）"""
    return ""


def _make_plist_content(proxy_script: str, work_dir: str) -> str:
    """生成代理服务 launchd plist 内容（仅 macOS）"""
    return ""


def _make_dashboard_plist_content(proxy_script: str, work_dir: str) -> str:
    """生成 Dashboard 服务 launchd plist 内容（仅 macOS）"""
    return ""


def _get_config_path():
    """获取持久化配置文件路径（存储可编辑字段）"""
    return config.RUNTIME_CONFIG_PATH


def _load_runtime_config() -> dict:
    """读取运行时可编辑配置"""
    cfg_path = _get_config_path()
    defaults = {
        "upstream_url": getattr(config, 'TARGET_BASE_URL', ''),
        "proxy_path": getattr(config, 'PROXY_PATH', '/v1/openai/native'),
        "request_timeout": config.REQUEST_TIMEOUT,
    }
    if os.path.isfile(cfg_path):
        try:
            import json
            with open(cfg_path, 'r') as f:
                saved = json.load(f)
            for field in ("upstream_url", "proxy_path", "request_timeout", "log_retention_days"):
                if field in saved:
                    defaults[field] = saved[field]
        except Exception:
            pass
    return defaults


def _save_runtime_config(data: dict):
    """Atomically save runtime config without exposing a partial JSON file."""
    import json
    cfg_path = _get_config_path()
    existing = _load_runtime_config()
    existing.update(data)
    directory = os.path.dirname(cfg_path)
    os.makedirs(directory, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=directory,
            prefix=".runtime-config-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = temporary.name
            json.dump(existing, temporary, indent=2, ensure_ascii=False)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, cfg_path)
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.unlink(temporary_path)


@stats_bp.route("/api/proxy/config", methods=["GET", "OPTIONS"])
def proxy_config_get():
    """Return runtime settings and deployment-only port/public URL metadata."""
    if request.method == "OPTIONS":
        return _cors_response({})
    cfg = _load_runtime_config()

    autostart_enabled = False
    try:
        policy = get_docker_service().restart_policy()
        autostart_enabled = policy in ("unless-stopped", "always", "on-failure")
    except DockerControlError:
        pass

    return _cors_response({
        "proxy_port": getattr(config, 'PROXY_EXTERNAL_PORT', 9888),
        "dashboard_port": getattr(config, 'DASHBOARD_EXTERNAL_PORT', 8889),
        "proxy_path": cfg.get("proxy_path", getattr(config, 'PROXY_PATH', '/v1/chat/completions')),
        "upstream_url": cfg.get("upstream_url", ""),
        "request_timeout": int(cfg.get("request_timeout", config.REQUEST_TIMEOUT)),
        "autostart_enabled": autostart_enabled,
        "public_base_url": getattr(config, "PUBLIC_BASE_URL", ""),
        "deployment_readonly": ["proxy_port", "dashboard_port", "public_base_url"],
        "editable_fields": ["request_timeout"],
    })


@stats_bp.route("/api/proxy/config", methods=["PUT", "OPTIONS"])
def proxy_config_put():
    """Save runtime-safe fields and state restart semantics explicitly."""
    if request.method == "OPTIONS":
        return _cors_response({})
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return _cors_response({"success": False, "message": "请求体必须为 JSON 对象"}, 400)
        deployment_only = {
            "proxy_port", "dashboard_port", "public_base_url",
        }
        attempted = sorted(deployment_only.intersection(body))
        if attempted:
            return _cors_response({
                "success": False,
                "message": "部署端口和公共地址为只读，请通过 Compose 或部署配置修改",
                "readonly_fields": attempted,
            }, 400)

        allowed = {"request_timeout", "upstream_url", "proxy_path"}
        unknown = sorted(set(body) - allowed)
        if unknown:
            return _cors_response({
                "success": False,
                "message": "包含不支持的配置字段",
                "unsupported_fields": unknown,
            }, 400)

        current = _load_runtime_config()
        to_save = {}
        if "request_timeout" in body:
            try:
                timeout = int(body["request_timeout"])
            except (TypeError, ValueError):
                return _cors_response({"success": False, "message": "超时时间必须为整数"}, 400)
            if not 10 <= timeout <= 600:
                return _cors_response({"success": False, "message": "超时时间范围 10-600 秒"}, 400)
            to_save["request_timeout"] = timeout
        for field in ("upstream_url", "proxy_path"):
            if field in body:
                value = body[field]
                if not isinstance(value, str):
                    return _cors_response({"success": False, "message": f"{field} 必须为字符串"}, 400)
                to_save[field] = value.strip()

        if not to_save:
            return _cors_response({"success": False, "message": "无有效字段"}, 400)

        changed_fields = sorted(
            field for field, value in to_save.items() if current.get(field) != value
        )
        if changed_fields:
            _save_runtime_config(to_save)
        restart_required = bool(changed_fields)
        return _cors_response({
            "success": True,
            "changed_fields": changed_fields,
            "restart_required": restart_required,
            "message": (
                "配置已保存，重启代理后生效"
                if restart_required
                else "配置未变化"
            ),
        })
    except (OSError, ValueError) as exc:
        return _cors_response({"success": False, "message": str(exc)}, 500)


@stats_bp.route("/api/proxy/autostart/install", methods=["POST", "OPTIONS"])
def proxy_autostart_install():
    """开启开机自启（设置 Docker restart policy 为 unless-stopped）"""
    if request.method == "OPTIONS":
        return _cors_response({})
    try:
        get_docker_service().set_restart_policy(True)
        return _cors_response({"success": True, "message": "开机自启已开启（restart: unless-stopped）"})
    except DockerControlError as exc:
        return _cors_response({"success": False, "message": f"设置失败: {exc}"}, 500)


@stats_bp.route("/api/proxy/autostart/uninstall", methods=["POST", "OPTIONS"])
def proxy_autostart_uninstall():
    """关闭开机自启（设置 Docker restart policy 为 no）"""
    if request.method == "OPTIONS":
        return _cors_response({})
    try:
        get_docker_service().set_restart_policy(False)
        return _cors_response({"success": True, "message": "开机自启已关闭"})
    except DockerControlError as exc:
        return _cors_response({"success": False, "message": f"设置失败: {exc}"}, 500)


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
        with open(path, "rb") as f:
            return f.read()

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
        """读取文件内容。"""
        with open(path, "rb") as f:
            return f.read()

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
