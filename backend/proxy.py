import os
import sys
import logging
import time
import json
import threading
import subprocess
import tempfile
from logging.handlers import WatchedFileHandler
from datetime import datetime, timezone, timedelta

# 中国时区 (UTC+8)
CST = timezone(timedelta(hours=8))

# 常量定义
PROXY_INTERNAL_PORT = 8888  # 代理容器内部端口
DASHBOARD_PORT = 8889       # Dashboard 端口
DEFAULT_TIMEOUT = 120       # 默认请求超时（秒）
DOCKER_STOP_TIMEOUT = 15    # Docker 停止超时（秒）
DOCKER_RM_TIMEOUT = 10      # Docker 删除超时（秒）
COMPOSE_UP_TIMEOUT = 30     # Docker Compose 启动超时（秒）
RESTART_WAIT_SEC = 3        # 重启后等待秒数

# ==========================================
# 1. 优先初始化日志与接管输出
# 注意：必须在导入第三方库（如 requests）之前执行，
# 否则底层库的警告会漏网并打印到系统底层。
# ==========================================

import config

# 如果 logs 文件夹不存在，则自动创建
if not os.path.exists(config.LOG_DIR):
    os.makedirs(config.LOG_DIR)


# 通用日志配置函数，用于快速创建不同用途的日志记录器
#
# 使用 WatchedFileHandler 而非 TimedRotatingFileHandler 的原因：
# TimedRotatingFileHandler 在进程内做文件重命名轮转，当 sys.stderr 被劫持时，
# 轮转瞬间多线程并发写入会导致句柄状态损坏，进程长期运行后概率性出现 500。
# WatchedFileHandler 自身不做任何轮转，只在每次写入前检测文件是否被外部修改；
# 轮转由 _archive_missed_log_days / _start_midnight_archiver 负责（纯文件复制），
# 两者完全解耦，句柄始终有效。
class CSTFormatter(logging.Formatter):
    """使用中国时区 (UTC+8) 的日志格式器，不依赖进程时区设置"""
    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created, tz=CST)
        if datefmt:
            return dt.strftime(datefmt)
        return f"{dt.strftime('%Y-%m-%d %H:%M:%S')},{int(record.msecs):03d}"

def setup_logger(name, log_file, level=logging.INFO):
    log_path = os.path.join(config.LOG_DIR, log_file)
    # 确保文件存在（WatchedFileHandler 要求文件预先存在或可创建）
    if not os.path.exists(log_path):
        open(log_path, 'a', encoding='utf-8').close()
    handler = WatchedFileHandler(filename=log_path, encoding="utf-8")

    formatter = CSTFormatter('%(asctime)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)

    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def _archive_missed_log_days(log_file: str) -> None:
    """
    补充归档：当进程长时间未运行时，TimedRotatingFileHandler 无法自动触发跨天轮转。
    启动时调用此函数，将当前日志文件中属于过去日期的行按日期拆分写入归档文件。
    
    工作原理：
      1. 解析当前日志文件的每一行，提取日期前缀（YYYY-MM-DD）
      2. 将属于过去日期的行写入对应的归档文件（如 proxy-system.log.2026-06-12）
      3. 将今天及未来的行保留在当前文件
    
    幂等性：若归档文件已存在则跳过（不覆盖），防止重复写入。
    """
    import re as _re
    from datetime import datetime as _dt, timedelta as _td

    log_path = os.path.join(config.LOG_DIR, log_file)
    if not os.path.isfile(log_path):
        return

    today = datetime.now(CST).strftime("%Y-%m-%d")

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except Exception:
        return

    if not all_lines:
        return

    # 提取每行的日期前缀（YYYY-MM-DD）
    DATE_RE = _re.compile(r'^(\d{4}-\d{2}-\d{2})')

    # 按日期分组
    date_buckets: dict = {}  # date_str -> [lines]
    today_lines: list = []

    for line in all_lines:
        m = DATE_RE.match(line)
        if m:
            d = m.group(1)
            if d == today:
                today_lines.append(line)
            else:
                date_buckets.setdefault(d, []).append(line)
        else:
            # 无日期前缀的续行：归属到最近日期桶
            if today_lines:
                today_lines.append(line)
            elif date_buckets:
                last_date = sorted(date_buckets.keys())[-1]
                date_buckets[last_date].append(line)
            else:
                today_lines.append(line)

    # 没有需要归档的历史日期
    if not date_buckets:
        return

    # 将历史日期的行写入归档文件。归档必须先完整写入同目录临时文件，再
    # 原子替换目标文件；只有所有日期都成功后才允许截断源文件，避免进程
    # 在半写状态退出时丢失仍未归档的日志。
    archive_complete = True
    for date_str, lines in sorted(date_buckets.items()):
        archive_path = os.path.join(config.LOG_DIR, f"{log_file}.{date_str}")
        try:
            # 归档文件一旦存在就视为已完成。启动阶段可能在写入归档后、截断当前日志前崩溃；
            # 此时再次追加会复制整段历史日志。当前文件只会在停机期间保留旧日期内容，
            # 因此跳过既有归档并继续截断即可保持幂等。
            if os.path.exists(archive_path):
                continue
            fd, temp_path = tempfile.mkstemp(
                prefix=f".{os.path.basename(archive_path)}.",
                suffix=".tmp",
                dir=config.LOG_DIR,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.writelines(lines)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp_path, archive_path)
                temp_path = None
            finally:
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass
        except Exception:
            archive_complete = False
            break

    # 将当前日志文件截断为只剩今天的内容
    if archive_complete:
        try:
            with open(log_path, "w", encoding="utf-8") as f:
                f.writelines(today_lines)
        except Exception:
            pass


def _purge_archived_logs() -> None:
    """Remove archived log files older than the configured retention window."""
    keep_days = max(int(getattr(config, "LOG_BACKUP_DAYS", 30)), 1)
    cutoff = datetime.now(CST).date() - timedelta(days=keep_days - 1)
    import re as _re

    pattern = _re.compile(r"^(proxy-(?:business|system)\.log)\.(\d{4}-\d{2}-\d{2})$")
    try:
        for filename in os.listdir(config.LOG_DIR):
            match = pattern.match(filename)
            if not match:
                continue
            try:
                log_date = datetime.strptime(match.group(2), "%Y-%m-%d").date()
            except ValueError:
                continue
            if log_date < cutoff:
                os.unlink(os.path.join(config.LOG_DIR, filename))
    except OSError as exc:
        system_logger.warning("日志保留清理失败: %s", exc)

# 初始化日志记录器
proxy_logger = setup_logger("proxy", "proxy-business.log")
# proxy-system.log 同时捕获 stdout (INFO) 和 stderr (ERROR)
# 合并了原 proxy-console.log 和 proxy-error.log 两个文件
system_logger = setup_logger("system", "proxy-system.log", level=logging.DEBUG)
# 让 system_logger 同时能记录 ERROR 级别（默认 DEBUG 已覆盖，此处明确）

def _start_midnight_archiver():
    """
    后台线程：每天零点自动触发日志归档。
    计算距离下一个 00:00:00 的秒数，sleep 后执行归档，然后循环等待次日零点。
    """
    import threading
    from datetime import datetime as _dt, timedelta as _td

    def _run():
        while True:
            now = datetime.now(CST)
            # 计算到下一个 00:01:00（零点后1分钟，留出归档操作的执行时间）
            tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=1, second=0, microsecond=0)
            wait_sec = (tomorrow - now).total_seconds()
            import time as _time
            _time.sleep(max(wait_sec, 1))
            # 触发归档
            try:
                _archive_missed_log_days("proxy-business.log")
                _archive_missed_log_days("proxy-system.log")
                _purge_archived_logs()
            except Exception:
                pass

    t = threading.Thread(target=_run, daemon=True, name="midnight-archiver")
    t.start()


_proxy_background_started = False


def _start_proxy_background_tasks() -> bool:
    """Start log maintenance only from the explicit Proxy process."""
    global _proxy_background_started
    if _proxy_background_started:
        return False
    _proxy_background_started = True
    _archive_missed_log_days("proxy-business.log")
    _archive_missed_log_days("proxy-system.log")
    _purge_archived_logs()
    _start_midnight_archiver()
    return True


# 将控制台输出重定向到日志记录器
# werkzeug 通过 click.echo → sys.stderr 输出的启动噪音关键词
_WERKZEUG_NOISE = (
    b' * Serving Flask',
    b' * Debug mode',
    b'WARNING: This is a development server',
    b' * Running on',
    b' * Restarting with',
    b' * Debugger is',
    ' * Serving Flask',
    ' * Debug mode',
    'WARNING: This is a development server',
    ' * Running on',
    ' * Restarting with',
    ' * Debugger is',
)


class StreamToLogger:
    def __init__(self, logger, log_level):
        self.logger = logger
        self.log_level = log_level

    def write(self, buf):
        for line in buf.rstrip().splitlines():
            text = line.rstrip()
            # 过滤 werkzeug 启动噪音（bytes 或 str 格式均过滤）
            if any(text == noise or (isinstance(text, (str, bytes)) and str(text).find(str(noise).strip()) >= 0) for noise in _WERKZEUG_NOISE):
                continue
            if not text or text in (b'', ''):
                continue
            self.logger.log(self.log_level, text)

    def flush(self):
        pass


sys.stdout = StreamToLogger(system_logger, logging.INFO)
sys.stderr = StreamToLogger(system_logger, logging.ERROR)


def _ensure_startup_migrations() -> None:
    """Migrate and back up the database before any runtime table is opened."""
    from migrations import migrate_with_backup

    backup_report, result = migrate_with_backup(
        config.DB_PATH,
        os.path.join(config.APP_SUPPORT_DIR, "migration-backups"),
    )
    if backup_report is not None:
        system_logger.warning(
            "数据库迁移前已创建一致性备份: path=%s size=%s integrity=%s",
            backup_report.database,
            backup_report.size_bytes,
            backup_report.integrity,
        )
    system_logger.info(
        "数据库迁移检查完成: version=%s applied=%s integrity=%s",
        result.current_version,
        list(result.applied_versions),
        result.integrity,
    )


# 迁移必须先于 db/router/auth 的 CREATE/ALTER TABLE。这样任何进程在
# 接受流量前都已经完成版本校验，并且已有数据库在变更前拥有可验证备份。
_ensure_startup_migrations()

# ==========================================
# 2. 导入第三方库并屏蔽底层兼容性警告
# ==========================================
import warnings
warnings.filterwarnings("ignore", module='urllib3')

from flask import Flask, request, Response
import requests as http_requests

# ==========================================
# 3. 初始化数据库
# ==========================================
import db
db.init_db()

import router
import auth
from services.request_recorder import RequestRecorder
from services.usage_normalizer import merge_usage, normalize_usage, usage_from_stream_event
from admin_api import admin_bp

# 初始化路由表和认证表
router.init_routing_tables()
router.init_default_providers()  # 确保 SQLite 中有厂商数据
auth.init_auth_tables()

# 启动时加载持久化运行时配置（upstream_url / timeout / log_retention_days 等）
_rt_cfg_path = config.RUNTIME_CONFIG_PATH
if os.path.isfile(_rt_cfg_path):
    try:
        import json as _json
        with open(_rt_cfg_path, 'r') as _f:
            _rt = _json.load(_f)
        if "upstream_url" in _rt:
            config.TARGET_BASE_URL = _rt["upstream_url"]
        if "request_timeout" in _rt:
            config.REQUEST_TIMEOUT = int(_rt["request_timeout"])
        if "proxy_path" in _rt:
            config.PROXY_PATH = str(_rt["proxy_path"])
        if "log_retention_days" in _rt:
            config.LOG_BACKUP_DAYS = int(_rt["log_retention_days"])
    except Exception:
        pass

# ==========================================
# 4. Flask 代理服务核心逻辑
# ==========================================
app = Flask(__name__)

# 代理 app 只注册 API Blueprint，不注册静态文件路由
# Dashboard 静态文件由 8889 进程独立服务
from stats_api import stats_bp
app.register_blueprint(stats_bp)
app.register_blueprint(admin_bp)


def _create_dashboard_app():
    """Create the Dashboard WSGI application for the dedicated 8889 process."""
    from flask import Flask as _Flask
    from flask.json.provider import DefaultJSONProvider as _DefaultJSONProvider
    from stats_api import stats_bp as _stats_bp, dashboard_bp as _dashboard_bp
    from admin_api import admin_bp as _admin_bp

    class _UTF8JSONProvider(_DefaultJSONProvider):
        """让 jsonify 输出原始 UTF-8 中文，不做 unicode 转义。"""
        ensure_ascii = False

    dashboard_app = _Flask(__name__)
    dashboard_app.json_provider_class = _UTF8JSONProvider
    dashboard_app.json = _UTF8JSONProvider(dashboard_app)
    dashboard_app.register_blueprint(_stats_bp)
    dashboard_app.register_blueprint(_dashboard_bp)
    dashboard_app.register_blueprint(_admin_bp)
    return dashboard_app


def _serve_wsgi(application, port: int) -> None:
    """Serve a Flask WSGI app with Waitress instead of Flask's dev server."""
    from waitress import serve

    serve(
        application,
        host="0.0.0.0",
        port=int(port),
        threads=max(int(os.getenv("HEIMDALL_WSGI_THREADS", "8")), 2),
        channel_timeout=max(int(os.getenv("HEIMDALL_WSGI_CHANNEL_TIMEOUT", "180")), 30),
    )


def _fmt_duration(ms: int) -> str:
    """
    将毫秒格式化为人类可读耗时字符串。
    规则：< 1000ms 用 ms；>= 1000ms 用 s（保留1位小数）；>= 60000ms 用 min（保留1位小数）
    """
    if ms < 1000:
        return f"{ms:,}ms"
    elif ms < 60_000:
        return f"{ms / 1000:.1f}s"
    else:
        return f"{ms / 60_000:.1f}min"


def _speed_icon(ms: int) -> str:
    """
    根据耗时返回速度图标。
    分段规则（与前端保持一致）：
      < 2s      → ⚡ 极快
      < 10s     → 🚀 快
      < 30s     → （无图标，正常）
      < 60s     → ⏳ 慢
      >= 60s    → 🐢 龟速
    """
    if ms < 2_000:
        return " ⚡"
    elif ms < 10_000:
        return " 🚀"
    elif ms < 30_000:
        return ""
    elif ms < 60_000:
        return " ⏳"
    else:
        return " 🐢"


def log_request(record: dict):
    """
    记录请求摘要日志。
    格式示例：
      [✅ 200] 🤖 glm-5.1 — | ⏱ 1.2s ⚡ (TTFB 0.3s) | 🪙 入1,200 出500 总1,700 | ⚡ 97.8% | 🧠 1.2k/200k(1%)
      [💥 500] 🤖 glm-4.5 〜 | ⏱ 1.2min 🐢 | 🪙 入200 出0 总200 | ❌ timeout
    """
    model = record.get("model", "unknown")
    provider = record.get("provider", "")
    is_stream = bool(record.get("stream", 0))
    latency = record.get("latency_ms", 0)
    ttfb = record.get("ttfb_ms", 0)
    prompt = record.get("prompt_tokens", 0)
    completion = record.get("completion_tokens", 0)
    total = record.get("total_tokens", 0)
    cache_hit = record.get("cache_hit_tokens", 0)
    status = record.get("status_code", 0)
    error_type = record.get("error_type", "")

    # ── 状态图标 ──
    if status == 0 or status >= 500:
        status_icon = "💥"
    elif status >= 400:
        status_icon = "⚠️"
    else:
        status_icon = "✅"

    # ── 流式标识 ──
    stream_icon = "〜" if is_stream else "—"

    # ── 耗时（统一格式 + 速度图标）──
    latency_fmt = _fmt_duration(latency)
    speed_icon = _speed_icon(latency)
    latency_str = f"{latency_fmt}{speed_icon}"

    # ── TTFB（思考时间）/ 输出时间（仅流式且有数据时显示）──
    ttfb_str = ""
    if is_stream and ttfb > 0 and latency > 0:
        output_ms = latency - ttfb
        ttfb_str = f" (思考 {_fmt_duration(ttfb)} 输出 {_fmt_duration(output_ms)})"

    # ── Token（千分位格式）──
    token_str = f"🪙 入{prompt:,} 出{completion:,} 总{total:,}"

    # ── 缓存命中率（仅当有缓存命中时显示）──
    cache_str = ""
    if cache_hit > 0 and prompt > 0:
        cache_rate = cache_hit / prompt * 100
        cache_str = f" | ⚡ {cache_rate:.0f}%"

    # ── 上下文窗口占比 ──
    ctx_str = ""
    ctx_window = config.get_context_window(model)
    if ctx_window and ctx_window > 0 and prompt > 0:
        ctx_pct = prompt / ctx_window * 100
        if ctx_pct <= 100:  # 超出 100% 不显示（异常情况）
            ctx_k = prompt / 1000
            ctx_window_k = ctx_window // 1000
            ctx_str = f" | 🧠 {ctx_k:.1f}k/{ctx_window_k}k({ctx_pct:.0f}%)"

    # ── 错误类型 ──
    error_str = f" | ❌ {error_type}" if error_type else ""

    # ── 厂商标识（有 provider 时显示）──
    provider_str = f"[{provider}] " if provider else ""

    msg = (
        f"[{status_icon} {status}] {provider_str}🤖 {model} {stream_icon} | "
        f"⏱ {latency_str}{ttfb_str} | "
        f"{token_str}"
        f"{cache_str}"
        f"{ctx_str}"
        f"{error_str}"
    )

    proxy_logger.info(msg)


class UpstreamAttemptsExhausted(Exception):
    def __init__(self, status_code: int, error_type: str, attempts: list):
        super().__init__(error_type)
        self.status_code = status_code
        self.error_type = error_type
        self.attempts = attempts


def _attempt_entry(candidate: 'router.RouteKey', started_at: float, **values) -> dict:
    entry = {
        "provider_api_key_id": candidate.id,
        "duration_ms": max(int((time.time() - started_at) * 1000), 0),
    }
    entry.update(values)
    return entry


def _send_with_route_keys(
    upstream_url: str,
    data: dict,
    base_headers: dict,
    route: 'router.RouteResult',
    *,
    stream: bool,
    auth_style: str,
):
    """Try Provider Keys in stable order and return response, Key and attempts."""
    attempts = []
    candidates = route.key_candidates
    if not candidates:
        raise UpstreamAttemptsExhausted(502, "no_available_key", attempts)

    for index, candidate in enumerate(candidates):
        started_at = time.time()
        headers = dict(base_headers)
        if auth_style == "anthropic":
            headers["x-api-key"] = candidate.secret
        else:
            headers["Authorization"] = f"Bearer {candidate.secret}"
        try:
            response = http_requests.post(
                upstream_url,
                json=data,
                headers=headers,
                stream=stream,
                timeout=config.REQUEST_TIMEOUT,
            )
        except http_requests.exceptions.Timeout:
            router.mark_api_key_error(candidate.id, "timeout")
            attempts.append(_attempt_entry(candidate, started_at, error_type="timeout"))
            if index == len(candidates) - 1:
                raise UpstreamAttemptsExhausted(504, "timeout", attempts)
            continue
        except http_requests.exceptions.ConnectionError:
            router.mark_api_key_error(candidate.id, "connection_error")
            attempts.append(
                _attempt_entry(candidate, started_at, error_type="connection_error")
            )
            if index == len(candidates) - 1:
                raise UpstreamAttemptsExhausted(502, "connection_error", attempts)
            continue

        status_code = int(response.status_code)
        retryable = status_code == 429 or status_code >= 500
        if retryable:
            summary = f"upstream_status_{status_code}"
            router.mark_api_key_error(candidate.id, summary)
            attempts.append(
                _attempt_entry(
                    candidate,
                    started_at,
                    status_code=status_code,
                    error_type=summary,
                )
            )
            if index < len(candidates) - 1:
                response.close()
                continue
            return response, candidate, attempts

        attempts.append(
            _attempt_entry(
                candidate,
                started_at,
                status_code=status_code,
                outcome="success" if status_code < 400 else "client_error",
            )
        )
        if status_code < 400 and not stream:
            router.mark_api_key_used(candidate.id)
        elif status_code >= 400:
            router.mark_api_key_used(candidate.id, reset_errors=False)
        return response, candidate, attempts

    raise UpstreamAttemptsExhausted(502, "all_keys_failed", attempts)


def _protocol_error_payload(protocol: str, message: str, error_type: str) -> dict:
    if protocol == "anthropic_messages":
        public_type = {
            "auth_error": "authentication_error",
            "route_error": "invalid_request_error",
            "proxy_crash": "api_error",
            "connection_error": "api_error",
            "timeout": "api_error",
        }.get(error_type, error_type)
        return {"type": "error", "error": {"type": public_type, "message": message}}
    public_type = {
        "permission_error": "auth_error",
        "route_error": "invalid_request_error",
        "proxy_crash": "proxy_error",
        "connection_error": "proxy_error",
        "timeout": "proxy_error",
    }.get(error_type, error_type)
    return {"error": {"message": message, "type": public_type}}


def _recorded_error(
    recorder: RequestRecorder,
    status_code: int,
    message: str,
    error_type: str,
    *,
    attempts: list = None,
    provider_api_key_id: int = None,
) -> Response:
    payload = _protocol_error_payload(recorder.protocol, message, error_type)
    recorder.finalize(
        status_code,
        error_type=error_type,
        response_body=payload,
        attempts=attempts,
        provider_api_key_id=provider_api_key_id,
    )
    return Response(
        json.dumps(payload, ensure_ascii=False),
        status=status_code,
        content_type="application/json",
    )


def _parse_sse_frame(lines):
    """Parse one complete SSE frame without changing its wire representation.

    ``requests.Response.iter_lines`` removes line terminators but keeps the
    empty line that terminates an SSE event.  Parsing only individual ``data``
    lines loses Anthropic's ``event`` + ``data`` pairing, so frames are parsed
    after they have been grouped by the blank-line delimiter.
    """
    data_lines = []
    for line in lines:
        if isinstance(line, str):
            line = line.encode("utf-8")
        line = bytes(line).rstrip(b"\r")
        if line.startswith(b"data:"):
            value = line[5:]
            if value.startswith(b" "):
                value = value[1:]
            data_lines.append(value)
    if not data_lines:
        return None
    payload = b"\n".join(data_lines)
    if payload == b"[DONE]":
        return None
    try:
        return json.loads(payload.decode("utf-8", errors="replace"))
    except (TypeError, ValueError):
        return None


def _iter_sse_frames(response):
    """Yield ``(wire_frame, parsed_event)`` pairs from an upstream response."""
    frame = []
    for raw_line in response.iter_lines():
        if isinstance(raw_line, str):
            raw_line = raw_line.encode("utf-8")
        line = bytes(raw_line).rstrip(b"\r")
        if line:
            frame.append(line)
            continue
        if frame:
            yield b"\n".join(frame) + b"\n\n", _parse_sse_frame(frame)
            frame = []
    if frame:
        yield b"\n".join(frame) + b"\n\n", _parse_sse_frame(frame)


def _is_meaningful_stream_event(event: dict, protocol: str) -> bool:
    if not isinstance(event, dict):
        return False
    if protocol == "openai_chat":
        for choice in event.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("content") or delta.get("reasoning_content") or delta.get("tool_calls"):
                return True
        return False
    if protocol == "openai_responses":
        event_type = str(event.get("type") or "")
        return event_type.endswith(".delta") and any(
            event.get(field) for field in ("delta", "text", "content")
        )
    delta = event.get("delta") or {}
    return any(delta.get(field) for field in ("text", "thinking", "partial_json"))


def _forward_non_stream(
    recorder: RequestRecorder,
    route: 'router.RouteResult',
    upstream_url: str,
    data: dict,
    headers: dict,
    auth_style: str,
) -> Response:
    try:
        response, candidate, attempts = _send_with_route_keys(
            upstream_url,
            data,
            headers,
            route,
            # Read the upstream body incrementally so TTFB is measured at the
            # first received chunk rather than after requests has buffered the
            # complete response for ``stream=False``.
            stream=True,
            auth_style=auth_style,
        )
    except UpstreamAttemptsExhausted as exc:
        return _recorded_error(
            recorder,
            exc.status_code,
            "所有 Provider API Key 均不可用",
            exc.error_type,
            attempts=exc.attempts,
        )

    status_code = int(response.status_code)
    trace_id = response.headers.get("M-TraceId", "")
    content_type = response.headers.get("Content-Type", "application/json")
    content_chunks = []
    first_byte_at = None
    try:
        iter_content = getattr(response, "iter_content", None)
        if callable(iter_content):
            for chunk in iter_content(chunk_size=8192):
                if not chunk:
                    continue
                if first_byte_at is None:
                    first_byte_at = time.time()
                content_chunks.append(bytes(chunk))
            content = b"".join(content_chunks)
        else:
            content = response.content
            if content:
                first_byte_at = time.time()
    except http_requests.exceptions.Timeout:
        router.mark_api_key_error(candidate.id, "timeout")
        return _recorded_error(
            recorder,
            504,
            "Provider 响应读取超时",
            "timeout",
            attempts=attempts,
            provider_api_key_id=candidate.id,
        )
    except (
        http_requests.exceptions.ConnectionError,
        http_requests.exceptions.ChunkedEncodingError,
    ):
        router.mark_api_key_error(candidate.id, "response_read_error")
        return _recorded_error(
            recorder,
            502,
            "Provider 响应传输中断",
            "connection_error",
            attempts=attempts,
            provider_api_key_id=candidate.id,
        )
    finally:
        response.close()
    payload = None
    try:
        payload = json.loads(content.decode("utf-8", errors="replace"))
    except (TypeError, ValueError, UnicodeDecodeError):
        pass
    usage = normalize_usage((payload or {}).get("usage") if isinstance(payload, dict) else {})
    if status_code < 400:
        router.mark_api_key_used(candidate.id)
    recorder.finalize(
        status_code,
        usage=usage,
        ttfb_ms=(
            max(int((first_byte_at - recorder.started_at) * 1000), 0)
            if first_byte_at is not None
            else 0
        ),
        trace_id=trace_id,
        error_type=None if status_code < 400 else "upstream_error",
        response_body=payload if payload is not None else content,
        attempts=attempts,
        provider_api_key_id=candidate.id,
    )
    return Response(
        content,
        status=status_code,
        content_type=content_type,
    )


def _forward_stream(
    recorder: RequestRecorder,
    route: 'router.RouteResult',
    upstream_url: str,
    data: dict,
    headers: dict,
    auth_style: str,
) -> Response:
    try:
        response, candidate, attempts = _send_with_route_keys(
            upstream_url,
            data,
            headers,
            route,
            stream=True,
            auth_style=auth_style,
        )
    except UpstreamAttemptsExhausted as exc:
        return _recorded_error(
            recorder,
            exc.status_code,
            "所有 Provider API Key 均不可用",
            exc.error_type,
            attempts=exc.attempts,
        )

    status_code = int(response.status_code)
    trace_id = response.headers.get("M-TraceId", "")
    if status_code >= 400:
        content = response.content
        response.close()
        recorder.finalize(
            status_code,
            trace_id=trace_id,
            error_type="upstream_error",
            response_body=content,
            attempts=attempts,
            provider_api_key_id=candidate.id,
        )
        return Response(
            content,
            status=status_code,
            content_type=response.headers.get("Content-Type", "application/json"),
        )

    def generate():
        usage = normalize_usage({})
        ttfb_ms = 0
        final_status = status_code
        error_type = None
        captured = bytearray()
        try:
            for framed, event in _iter_sse_frames(response):
                captured.extend(framed)
                if event is not None:
                    usage = merge_usage(
                        usage,
                        usage_from_stream_event(event, recorder.protocol),
                    )
                    if not ttfb_ms and _is_meaningful_stream_event(event, recorder.protocol):
                        ttfb_ms = max(int((time.time() - recorder.started_at) * 1000), 0)
                yield framed
            router.mark_api_key_used(candidate.id)
        except GeneratorExit:
            final_status = 499
            error_type = "client_disconnect"
            router.mark_api_key_used(candidate.id, reset_errors=False)
            raise
        except http_requests.exceptions.Timeout:
            final_status = 504
            error_type = "timeout"
            router.mark_api_key_error(candidate.id, error_type)
        except (http_requests.exceptions.ConnectionError, http_requests.exceptions.ChunkedEncodingError):
            final_status = 502
            error_type = "stream_interrupted"
            router.mark_api_key_error(candidate.id, error_type)
        except Exception as exc:
            final_status = 502
            error_type = "stream_interrupted"
            router.mark_api_key_error(candidate.id, f"stream_interrupted:{type(exc).__name__}")
            system_logger.error(f"[PROXY] 流式传输失败: {exc}", exc_info=True)
        finally:
            response.close()
            recorder.finalize(
                final_status,
                usage=usage,
                ttfb_ms=ttfb_ms,
                trace_id=trace_id,
                error_type=error_type,
                response_body=bytes(captured),
                attempts=attempts,
                provider_api_key_id=candidate.id,
            )

    return Response(generate(), status=200, content_type="text/event-stream")


def _proxy_protocol(protocol: str) -> Response:
    started_at = time.time()
    client_ip = request.remote_addr or ""
    data = request.get_json(silent=True, force=True) or {}
    stream = bool(data.get("stream", False))
    recorder = RequestRecorder(
        data,
        protocol=protocol,
        endpoint=request.path,
        stream=stream,
        client_ip=client_ip,
        started_at=started_at,
        log_callback=log_request,
    )
    try:
        if not data or "model" not in data:
            return _recorded_error(recorder, 400, "缺少 model 字段", "invalid_request_error")

        if protocol == "anthropic_messages":
            client_secret = request.headers.get("x-api-key", "")
            if not client_secret:
                auth_header = request.headers.get("Authorization", "")
                client_secret = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        else:
            auth_header = request.headers.get("Authorization", "")
            client_secret = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        if not client_secret:
            return _recorded_error(recorder, 401, "缺少 API Key", "auth_error")

        key_info = auth.validate_api_key(client_secret)
        if not key_info:
            return _recorded_error(recorder, 401, "无效 API Key", "auth_error")
        recorder.authenticate(int(key_info["id"]), str(key_info.get("name") or ""))

        requested_model = str(data["model"])
        if not auth.check_model_access(key_info, requested_model):
            return _recorded_error(recorder, 403, "无权访问该模型", "permission_error")

        route_protocol = "anthropic" if protocol == "anthropic_messages" else "openai"
        route = router.resolve_route_for_proxy(requested_model, protocol=route_protocol)
        if isinstance(route, router.RouteError):
            return _recorded_error(
                recorder,
                route.status_code,
                route.message,
                "route_error",
            )
        recorder.bind_route(route)
        system_logger.info(
            f"[PROXY] 路由: {requested_model} → "
            f"{route.provider_key}/{route.model_name} ({route.base_url})"
        )

        upstream_data = dict(data)
        upstream_data["model"] = route.upstream_model
        if protocol == "openai_chat":
            upstream_data = _trim_messages_if_needed(
                upstream_data,
                context_window=route.context_window,
            )
            if stream:
                upstream_data["stream_options"] = {"include_usage": True}

        if protocol == "anthropic_messages":
            path = "/messages"
            headers = {
                "Content-Type": "application/json",
                "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
            }
            auth_style = "anthropic"
        elif protocol == "openai_responses":
            path = "/responses"
            headers = {"Content-Type": "application/json"}
            auth_style = "bearer"
        else:
            path = "/chat/completions"
            headers = {"Content-Type": "application/json"}
            auth_style = "bearer"
        upstream_url = f"{route.base_url}{path}"
        if stream:
            return _forward_stream(
                recorder, route, upstream_url, upstream_data, headers, auth_style
            )
        return _forward_non_stream(
            recorder, route, upstream_url, upstream_data, headers, auth_style
        )
    except Exception as exc:
        system_logger.error(f"[PROXY] 未捕获异常: {exc}", exc_info=True)
        return _recorded_error(recorder, 500, "内部服务器错误", "proxy_crash")


def _estimate_tokens(data: dict) -> int:
    """
    估算请求体的 token 数。
    策略：将整个请求体序列化为 JSON 字节，除以 3（保守系数）。
    base64 图片、代码、中文等内容 token 密度高，÷3 比 ÷4 更安全。
    """
    return len(json.dumps(data, ensure_ascii=False).encode('utf-8')) // 3


def _trim_messages_if_needed(data: dict, context_window: int = None) -> dict:
    """
    Token 超限保护：在转发前检测估算 token 是否超出模型上限的 90%。
    若超限，按以下策略依次缩减，直到满足限制：
      1. 截断最早的 tool result（role=tool）内容，保留前 500 字符 + 截断提示
      2. 若截断所有 tool result 仍超限，则移除最早的 tool result 条目
    保留 system / user / assistant 消息不动，尽量保留对话语义。
    """
    # 优先使用传入的 context_window（来自路由配置），否则从 config 查询
    model_name = data.get('model', '').lower()
    if context_window is None:
        context_window = config.get_context_window(model_name)
    if not context_window:
        return data  # 未知模型，不处理

    token_limit = int(context_window * 0.90)  # 90% 安全水位
    estimated = _estimate_tokens(data)
    if estimated <= token_limit:
        return data  # 未超限，直接返回

    import copy
    data = copy.deepcopy(data)
    msgs = data.get('messages', [])

    system_logger.warning(
        f"[TRIM] 请求 token 估算 {estimated:,} 超出 {model_name} 上限 {context_window:,} 的90%"
        f"({token_limit:,})，开始截断 tool result"
    )

    # 第一轮：截断 tool result 内容（保留前 500 字符）
    KEEP_CHARS = 500
    TRUNCATE_NOTICE = "\n\n[⚠️ 内容已被代理层截断以防止上下文超限]"
    for msg in msgs:
        if _estimate_tokens(data) <= token_limit:
            break
        if msg.get('role') != 'tool':
            continue
        content = msg.get('content', '')
        if isinstance(content, str) and len(content) > KEEP_CHARS:
            msg['content'] = content[:KEEP_CHARS] + TRUNCATE_NOTICE
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get('type') == 'text':
                    text = part.get('text', '')
                    if len(text) > KEEP_CHARS:
                        part['text'] = text[:KEEP_CHARS] + TRUNCATE_NOTICE

    # 第二轮：若仍超限，移除最早的 tool result（从后往前遍历避免索引偏移）
    if _estimate_tokens(data) > token_limit:
        tool_msgs = [m for m in data['messages'] if m.get('role') == 'tool']
        for tm in tool_msgs:
            if _estimate_tokens(data) <= token_limit:
                break
            try:
                data['messages'].remove(tm)
            except ValueError:
                pass

    after = _estimate_tokens(data)
    system_logger.warning(
        f"[TRIM] 截断完成，估算 token: {estimated:,} → {after:,}"
    )
    return data


@app.route('/v1/chat/completions', methods=['POST'])
@app.route('/chat/completions', methods=['POST'])
@app.route('/openai/chat/completions', methods=['POST'])
def proxy_openai_chat():
    return _proxy_protocol("openai_chat")

# ==========================================
# Anthropic 协议支持
# ==========================================

@app.route('/v1/messages', methods=['POST'])
@app.route('/v2/messages', methods=['POST'])
@app.route('/anthropic/messages', methods=['POST'])
def proxy_anthropic_messages():
    """Anthropic Messages API 代理"""
    return _proxy_protocol("anthropic_messages")

# ==========================================
# OpenAI Responses API 支持
# ==========================================

@app.route('/v1/responses', methods=['POST'])
@app.route('/openai/responses', methods=['POST'])
def proxy_openai_responses():
    """OpenAI Responses API 代理"""
    return _proxy_protocol("openai_responses")

# ==========================================
# 厂商预设 API
# ==========================================

@app.route('/api/vendor-presets', methods=['GET'])
def get_vendor_presets():
    """获取厂商预设配置"""
    import json as _json
    presets_path = os.path.join(os.path.dirname(__file__), 'vendor_presets.json')
    if os.path.isfile(presets_path):
        with open(presets_path, 'r', encoding='utf-8') as f:
            return Response(_json.dumps(_json.load(f), ensure_ascii=False), content_type='application/json')
    return Response('{"vendors":{}}', content_type='application/json')


if __name__ == '__main__':
    import logging as flask_logging

    # ── 彻底静音 werkzeug ──────────────────────────────────────
    # werkzeug 的 access log 和启动信息通过 logging + click.echo 两条路径输出，
    # 而 sys.stdout 已被重定向到 proxy-system.log，这会导致每条 HTTP 请求
    # 和每次启动都污染系统日志。
    # 方案：
    #   1. 把 werkzeug logger 设为 CRITICAL 并清空 handler
    #   2. 用 Waitress WSGI server 代替 app.run()，完全绕过
    #      werkzeug 内部的开发服务器与 click.echo 启动打印
    # ──────────────────────────────────────────────────────────
    for _log_name in ('werkzeug', 'flask.app', 'flask'):
        _lg = flask_logging.getLogger(_log_name)
        _lg.setLevel(flask_logging.CRITICAL)
        _lg.propagate = False
        for _h in list(_lg.handlers):
            _lg.removeHandler(_h)

    # ── 运行模式判断 ────────────────────────────────────────────
    # 通过命令行参数区分：
    #   python3 proxy.py           → 启动器：fork 出 dashboard + proxy 两个子进程
    #   python3 proxy.py --proxy   → 只启动代理服务（PROXY_PORT）
    #   python3 proxy.py --dashboard → 只启动 Dashboard 服务（DASHBOARD_PORT）
    # ──────────────────────────────────────────────────────────

    mode = sys.argv[1] if len(sys.argv) > 1 else None

    def _is_port_in_use(port: int) -> bool:
        """检测端口是否已被占用（socket 直接探测，不依赖 lsof）"""
        import socket as _socket
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
            s.settimeout(1)
            return s.connect_ex(('127.0.0.1', port)) == 0

    if mode == '--proxy':
        # 纯代理模式（子进程）
        # 在 Docker 中，内部端口始终是 8888（由 Dockerfile 定义）
        # 外部端口映射由 docker-compose.yml 控制
        config.PROXY_PORT = 8888  # 强制使用容器内部端口
        _start_proxy_background_tasks()
        system_logger.info(f"代理服务启动 → 宿主机端口 {getattr(config, 'PROXY_EXTERNAL_PORT', config.PROXY_PORT)}")
        _serve_wsgi(app, config.PROXY_PORT)

    elif mode == '--dashboard':
        # 纯 Dashboard 模式（子进程，永久运行）
        # 同时注册 stats_bp（API）和 dashboard_bp（静态文件）
        if _is_port_in_use(config.DASHBOARD_PORT):
            proxy_logger.info(f"Dashboard 服务已在运行（端口 {config.DASHBOARD_PORT} 已被占用），退出")
            sys.exit(0)
        dashboard_app = _create_dashboard_app()
        if getattr(config, "RETENTION_WORKER_ENABLED", False):
            from services.request_retention import start_retention_worker
            from stats_api import get_request_retention_service
            start_retention_worker(
                get_request_retention_service(),
                logger=system_logger,
            )
        system_logger.info(f"Dashboard 服务启动 → 宿主机端口 {getattr(config, 'DASHBOARD_EXTERNAL_PORT', config.DASHBOARD_PORT)}")
        _serve_wsgi(dashboard_app, config.DASHBOARD_PORT)

    else:
        # 启动器模式：确保两个服务都在运行
        system_logger.info("=" * 60)
        system_logger.info("Heimdall 启动（双进程解耦模式）")
        system_logger.info(f"  代理服务:   宿主机端口 {getattr(config, 'PROXY_EXTERNAL_PORT', config.PROXY_PORT)} (AI 请求转发)")
        proxy_logger.info(f"  Dashboard:  :{config.DASHBOARD_PORT}  (统计面板，独立进程)")
        proxy_logger.info("=" * 60)

        # 若 Dashboard 端口还没有进程，手动启动一次
        if not _is_port_in_use(config.DASHBOARD_PORT):
            subprocess.Popen(
                [sys.executable, __file__, '--dashboard'],
                cwd=config.BASE_DIR,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            proxy_logger.info("Dashboard 进程已启动")
        else:
            proxy_logger.info(f"Dashboard 进程已在运行（端口 {config.DASHBOARD_PORT}）")

        # 主进程运行代理
        _start_proxy_background_tasks()
        proxy_logger.info(f"代理进程启动 (PID {os.getpid()})")
        _serve_wsgi(app, config.PROXY_PORT)
        proxy_logger.info("代理进程退出，Dashboard 继续运行中...")
