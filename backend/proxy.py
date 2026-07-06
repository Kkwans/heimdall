import os
import sys
import logging
import time
import json
import threading
import subprocess
from logging.handlers import WatchedFileHandler
from datetime import datetime, date as date_type, timezone, timedelta

# 中国时区 (UTC+8)
CST = timezone(timedelta(hours=8))

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
def setup_logger(name, log_file, level=logging.INFO):
    log_path = os.path.join(config.LOG_DIR, log_file)
    # 确保文件存在（WatchedFileHandler 要求文件预先存在或可创建）
    if not os.path.exists(log_path):
        open(log_path, 'a', encoding='utf-8').close()
    handler = WatchedFileHandler(filename=log_path, encoding="utf-8")

    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
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

    today = _dt.now().strftime("%Y-%m-%d")

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

    # 将历史日期的行写入归档文件
    archived_any = False
    for date_str, lines in sorted(date_buckets.items()):
        archive_path = os.path.join(config.LOG_DIR, f"{log_file}.{date_str}")
        if os.path.isfile(archive_path):
            # 已归档：将缺失的行追加（追加模式，避免重复）
            # 简单策略：若归档文件已存在且大小 > 0，则跳过（认为已归档过）
            existing_size = os.path.getsize(archive_path)
            if existing_size > 0:
                continue
        try:
            with open(archive_path, "w", encoding="utf-8") as f:
                f.writelines(lines)
            archived_any = True
        except Exception:
            pass

    # 将当前日志文件截断为只剩今天的内容
    if archived_any:
        try:
            with open(log_path, "w", encoding="utf-8") as f:
                f.writelines(today_lines)
        except Exception:
            pass


# 初始化日志记录器
proxy_logger = setup_logger("proxy", "proxy-business.log")
# proxy-system.log 同时捕获 stdout (INFO) 和 stderr (ERROR)
# 合并了原 proxy-console.log 和 proxy-error.log 两个文件
system_logger = setup_logger("system", "proxy-system.log", level=logging.DEBUG)
# 让 system_logger 同时能记录 ERROR 级别（默认 DEBUG 已覆盖，此处明确）

# 启动时补充归档：修复跨天未归档的历史日志
_archive_missed_log_days("proxy-business.log")
_archive_missed_log_days("proxy-system.log")


def _start_midnight_archiver():
    """
    后台线程：每天零点自动触发日志归档。
    计算距离下一个 00:00:00 的秒数，sleep 后执行归档，然后循环等待次日零点。
    """
    import threading
    from datetime import datetime as _dt, timedelta as _td

    def _run():
        while True:
            now = _dt.now()
            # 计算到下一个 00:01:00（零点后1分钟，留出归档操作的执行时间）
            tomorrow = (now + _td(days=1)).replace(hour=0, minute=1, second=0, microsecond=0)
            wait_sec = (tomorrow - now).total_seconds()
            import time as _time
            _time.sleep(max(wait_sec, 1))
            # 触发归档
            try:
                _archive_missed_log_days("proxy-business.log")
                _archive_missed_log_days("proxy-system.log")
            except Exception:
                pass

    t = threading.Thread(target=_run, daemon=True, name="midnight-archiver")
    t.start()


_start_midnight_archiver()


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


def build_record(
    request_data: dict,
    status_code: int,
    usage: dict,
    latency_ms: int,
    is_stream: bool,
    ttfb_ms: int = 0,
    trace_id: str = "",
    error_type: str = None,
    client_ip: str = "",
    request_body: str = None,
    response_body: str = None,
    provider: str = None,
) -> dict:
    """构建请求记录 dict，用于写入数据库和日志"""
    original_model = request_data.get("model", "unknown")

    # 处理模型名（与代理逻辑一致：取 '/' 后的部分）
    model = original_model.split('/')[-1] if '/' in original_model else original_model

    messages = request_data.get("messages", [])
    messages_count = len(messages) if isinstance(messages, list) else 0

    # 从 usage 中提取 token 数据（兼容不同模型的字段名差异）
    prompt_tokens = usage.get("prompt_tokens", 0) or 0
    completion_tokens = usage.get("completion_tokens", 0) or 0
    total_tokens = usage.get("total_tokens", 0) or (prompt_tokens + completion_tokens)

    # 缓存相关（OpenAI / FRIDAY 格式）
    cache_hit_tokens = (
        usage.get("prompt_cache_hit_tokens", 0) or
        usage.get("prompt_tokens_details", {}).get("cached_tokens", 0) or
        0
    )
    cache_miss_tokens = usage.get("prompt_cache_miss_tokens", 0) or 0

    # 推理 token（DeepSeek-R1 等推理模型）
    reasoning_tokens = (
        usage.get("completion_tokens_details", {}).get("reasoning_tokens", 0) or 0
    )

    success = status_code < 400
    today = str(date_type.today())

    return {
        "created_at": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "date": datetime.now(CST).strftime("%Y-%m-%d"),
        "model": model,
        "original_model": original_model,
        "stream": 1 if is_stream else 0,
        "messages_count": messages_count,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cache_hit_tokens": cache_hit_tokens,
        "cache_miss_tokens": cache_miss_tokens,
        "reasoning_tokens": reasoning_tokens,
        "latency_ms": latency_ms,
        "ttfb_ms": ttfb_ms,
        "status_code": status_code,
        "success": 1 if success else 0,
        "error_type": error_type,
        "trace_id": trace_id,
        "client_ip": client_ip,
        "request_body": request_body,
        "response_body": response_body,
        "provider": provider,
    }


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


def handle_non_stream(data: dict, headers: dict, start_time: float, client_ip: str, route: 'router.RouteResult' = None) -> Response:
    """处理非流式请求"""
    usage = {}
    status_code = 500
    trace_id = ""
    error_type = None
    provider_key = route.provider_key if route else None

    # 确定上游 URL 和 headers
    base_url = route.base_url
    upstream_url = f"{base_url}/chat/completions"

    # 如果路由有 API Key 且请求没有自带 Authorization，使用路由的 Key
    upstream_headers = dict(headers)
    if route and route.api_key and not upstream_headers.get('Authorization'):
        upstream_headers['Authorization'] = f"Bearer {route.api_key}"

    try:
        resp = http_requests.post(
            upstream_url,
            json=data,
            headers=upstream_headers,
            timeout=config.REQUEST_TIMEOUT
        )
        status_code = resp.status_code
        trace_id = resp.headers.get("M-TraceId", "")

        # 解析 usage 和响应内容
        resp_body_str = None
        if status_code == 200:
            try:
                resp_json = resp.json()
                usage = resp_json.get("usage", {}) or {}
                resp_body_str = json.dumps(resp_json, ensure_ascii=False)
            except Exception:
                pass
        else:
            # 非 200：记录完整错误响应体，供请求详情展示
            try:
                resp_body_str = resp.text
            except Exception:
                pass

        # 请求内容
        req_body_str = json.dumps(data, ensure_ascii=False)

        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, status_code, usage, latency_ms, is_stream=False,
                              trace_id=trace_id, client_ip=client_ip,
                              request_body=req_body_str, response_body=resp_body_str,
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)

        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('Content-Type'))

    except http_requests.exceptions.Timeout:
        error_type = "timeout"
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 504, {}, latency_ms, is_stream=False,
                              error_type=error_type, client_ip=client_ip,
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 请求超时: model={data.get('model', 'unknown')}")
        return Response('{"error": "Gateway Timeout"}', status=504, content_type='application/json')

    except http_requests.exceptions.ConnectionError:
        error_type = "connection_error"
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 502, {}, latency_ms, is_stream=False,
                              error_type=error_type, client_ip=client_ip,
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 连接失败: model={data.get('model', 'unknown')}")
        return Response('{"error": "Bad Gateway"}', status=502, content_type='application/json')

    except Exception as e:
        error_type = "unknown"
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 500, {}, latency_ms, is_stream=False,
                              error_type=error_type, client_ip=client_ip,
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 未知错误: {e}", exc_info=True)
        return Response('{"error": "Internal Server Error"}', status=500, content_type='application/json')


def handle_stream(data: dict, headers: dict, start_time: float, client_ip: str, route: 'router.RouteResult' = None) -> Response:
    """处理流式请求（SSE）"""

    # 确定上游 URL 和 headers
    base_url = route.base_url
    upstream_url = f"{base_url}/chat/completions"

    # 如果路由有 API Key 且请求没有自带 Authorization，使用路由的 Key
    upstream_headers = dict(headers)
    if route and route.api_key and not upstream_headers.get('Authorization'):
        upstream_headers['Authorization'] = f"Bearer {route.api_key}"

    provider_key = route.provider_key if route else None

    # 请求流式响应时，添加 stream_options 以获取 usage 统计
    stream_data = dict(data)
    stream_data["stream_options"] = {"include_usage": True}

    # 先建立连接，检查上游状态码
    # 上游非 200 时直接返回带正确 HTTP 状态码的 JSON 错误响应，
    # 让客户端（如 Codex）能感知到具体错误原因，而不是静默失败
    try:
        upstream_resp = http_requests.post(
            upstream_url,
            json=stream_data,
            headers=upstream_headers,
            stream=True,
            timeout=config.REQUEST_TIMEOUT
        )
    except http_requests.exceptions.Timeout:
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 504, {}, latency_ms, is_stream=True,
                              error_type="timeout", client_ip=client_ip,
                              request_body=json.dumps(data, ensure_ascii=False),
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 流式请求超时: model={data.get('model', 'unknown')}")
        return Response('{"error":{"message":"Gateway Timeout","type":"proxy_error"}}',
                        status=504, content_type='application/json')
    except http_requests.exceptions.ConnectionError:
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 502, {}, latency_ms, is_stream=True,
                              error_type="connection_error", client_ip=client_ip,
                              request_body=json.dumps(data, ensure_ascii=False),
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 流式请求连接失败: model={data.get('model', 'unknown')}")
        return Response('{"error":{"message":"Bad Gateway","type":"proxy_error"}}',
                        status=502, content_type='application/json')
    except Exception as e:
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, 500, {}, latency_ms, is_stream=True,
                              error_type="unknown", client_ip=client_ip,
                              request_body=json.dumps(data, ensure_ascii=False),
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        system_logger.error(f"[PROXY] 流式请求未知错误: {e}", exc_info=True)
        return Response('{"error":{"message":"Internal Server Error","type":"proxy_error"}}',
                        status=500, content_type='application/json')

    status_code = upstream_resp.status_code
    trace_id = upstream_resp.headers.get("M-TraceId", "")

    # 上游非 200：读取错误体，记录日志，以正确 HTTP 状态码返回给客户端
    if status_code != 200:
        try:
            err_content = upstream_resp.content
            err_text = err_content.decode('utf-8', errors='ignore')
        except Exception:
            err_content = b'{"error":{"message":"Unknown upstream error","type":"upstream_error"}}'
            err_text = err_content.decode()

        system_logger.error(
            f"[PROXY] 上游返回 {status_code}: model={data.get('model', 'unknown')} "
            f"trace={trace_id} body={err_text[:500]}"
        )
        latency_ms = int((time.time() - start_time) * 1000)
        record = build_record(data, status_code, {}, latency_ms, is_stream=True,
                              trace_id=trace_id, client_ip=client_ip,
                              request_body=json.dumps(data, ensure_ascii=False),
                              response_body=err_text,
                              provider=provider_key)
        db.insert_request(record)
        log_request(record)
        content_type = upstream_resp.headers.get('Content-Type', 'application/json')
        return Response(err_content, status=status_code, content_type=content_type)

    # 上游 200：正常流式转发
    def generate():
        usage = {}
        ttfb_ms = 0
        first_token = True
        error_type = None
        reasoning_chunks = []
        content_chunks = []

        try:
            for line in upstream_resp.iter_lines():
                if line:
                    yield line + b'\n\n'

                    if first_token:
                        ttfb_ms = int((time.time() - start_time) * 1000)
                        first_token = False

                    if line.startswith(b'data: ') and line != b'data: [DONE]':
                        try:
                            chunk_str = line[6:].decode('utf-8', errors='ignore')
                            chunk_json = json.loads(chunk_str)
                            if chunk_json.get("usage"):
                                usage = chunk_json["usage"]
                            choices = chunk_json.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                rc = delta.get("reasoning_content")
                                ct = delta.get("content")
                                if rc and len(reasoning_chunks) < 200:
                                    reasoning_chunks.append(rc)
                                if ct and len(content_chunks) < 200:
                                    content_chunks.append(ct)
                        except Exception:
                            pass

        except http_requests.exceptions.Timeout:
            error_type = "timeout"
            system_logger.error(f"[PROXY] 流式传输超时: model={data.get('model', 'unknown')}")
        except Exception as e:
            error_type = "unknown"
            system_logger.error(f"[PROXY] 流式传输错误: {e}", exc_info=True)
        finally:
            latency_ms = int((time.time() - start_time) * 1000)
            req_body_str = json.dumps(data, ensure_ascii=False)
            reasoning_text = "".join(reasoning_chunks)
            content_text = "".join(content_chunks)
            if reasoning_text or content_text:
                resp_body_str = json.dumps({
                    "reasoning_content": reasoning_text,
                    "content": content_text,
                    "_stream": True,
                }, ensure_ascii=False)
            else:
                resp_body_str = None
            record = build_record(
                data, status_code, usage, latency_ms,
                is_stream=True, ttfb_ms=ttfb_ms,
                trace_id=trace_id, error_type=error_type, client_ip=client_ip,
                request_body=req_body_str, response_body=resp_body_str,
                provider=provider_key
            )
            db.insert_request(record)
            log_request(record)

    return Response(generate(), content_type='text/event-stream')


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

    # 第二轮：若仍超限，移除最早的 tool result
    if _estimate_tokens(data) > token_limit:
        tool_indices = [i for i, m in enumerate(msgs) if m.get('role') == 'tool']
        for idx in tool_indices:
            if _estimate_tokens(data) <= token_limit:
                break
            # 找到并移除（索引已偏移，需重新查找）
            for j, m in enumerate(data['messages']):
                if m.get('role') == 'tool' and m is msgs[idx]:
                    data['messages'].pop(j)
                    break

    after = _estimate_tokens(data)
    system_logger.warning(
        f"[TRIM] 截断完成，估算 token: {estimated:,} → {after:,}"
    )
    return data


@app.route('/v1/chat/completions', methods=['POST'])
def proxy():
    start_time = time.time()
    client_ip = request.remote_addr or ""

    try:
        # 获取客户端发来的 JSON 请求数据
        # force=True：即使 Content-Type 不是 application/json 也尝试解析
        # 这样可以兼容部分客户端漏传 Content-Type 的情况
        data = request.get_json(silent=True, force=True) or {}

        if not data or 'model' not in data:
            return Response('{"error":{"message":"Missing model field","type":"invalid_request_error"}}',
                            status=400, content_type='application/json')

        original_model = data['model']

        # ── API Key 认证检查 ──
        auth_header = request.headers.get('Authorization', '')
        api_key = None
        if auth_header.startswith('Bearer '):
            api_key = auth_header[7:]
        
        # 检查是否是 Heimdall API Key
        key_info = None
        if api_key and api_key.startswith('heimdall-'):
            key_info = auth.validate_api_key(api_key)
            if not key_info:
                return Response('{"error":{"message":"Invalid API Key","type":"auth_error"}}',
                               status=401, content_type='application/json')
            # 检查模型权限
            if not auth.check_model_access(key_info, original_model):
                return Response('{"error":{"message":"Model access denied","type":"auth_error"}}',
                               status=403, content_type='application/json')

        # ── 路由查找：根据 model 字段确定上游 API ──
        route = router.resolve_route_for_proxy(original_model, auth_header)

        if isinstance(route, router.RouteError):
            system_logger.warning(f"[PROXY] 路由失败: model={original_model} error={route.message}")
            return Response(
                json.dumps({"error": {"message": route.message, "type": "invalid_request_error"}}),
                status=route.status_code, content_type='application/json'
            )

        # 记录路由信息到日志
        system_logger.info(
            f"[PROXY] 路由: {original_model} → {route.provider_key}/{route.model_name}"
            f" ({route.base_url})"
        )

        # 将 model 替换为上游实际模型名（去掉 provider 前缀）
        data['model'] = route.model_name

        # ── Token 超限保护 ──────────────────────────────────────────
        data = _trim_messages_if_needed(data, context_window=route.context_window)
        # ────────────────────────────────────────────────────────────

        # 提取鉴权头部
        headers = {
            'Content-Type': 'application/json',
            'Authorization': auth_header,
        }

        # 判断是否流式请求
        is_stream = data.get('stream', False)

        if is_stream:
            return handle_stream(data, headers, start_time, client_ip, route=route)
        else:
            return handle_non_stream(data, headers, start_time, client_ip, route=route)

    except Exception as e:
        # 兜底异常捕获：确保任何未预期的错误都返回 JSON 格式，而非 Flask 默认的 HTML 500 页面
        try:
            system_logger.error(f"[PROXY] 路由层未捕获异常: {e}", exc_info=True)
        except Exception:
            pass  # logger 本身异常时静默处理，防止二次崩溃
        latency_ms = int((time.time() - start_time) * 1000)
        try:
            record = build_record({}, 500, {}, latency_ms, is_stream=False,
                                  error_type="proxy_crash", client_ip=client_ip)
            db.insert_request(record)
        except Exception:
            pass
        return Response('{"error":{"message":"Internal Server Error","type":"proxy_error"}}',
                        status=500, content_type='application/json')


if __name__ == '__main__':
    import logging as flask_logging

    # ── 彻底静音 werkzeug ──────────────────────────────────────
    # werkzeug 的 access log 和启动信息通过 logging + click.echo 两条路径输出，
    # 而 sys.stdout 已被重定向到 proxy-system.log，这会导致每条 HTTP 请求
    # 和每次启动都污染系统日志。
    # 方案：
    #   1. 把 werkzeug logger 设为 CRITICAL 并清空 handler
    #   2. 用 make_server().serve_forever() 代替 app.run()，完全绕过
    #      werkzeug 内部的 click.echo 启动打印
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
        # 从运行时配置文件读取最新端口（用户可能通过 API 修改了端口，config.py 只有默认值）
        try:
            import json as _json
            _rt_cfg_path = config.RUNTIME_CONFIG_PATH
            if os.path.isfile(_rt_cfg_path):
                with open(_rt_cfg_path, 'r') as _f:
                    _rt = _json.load(_f)
                if 'proxy_port' in _rt:
                    config.PROXY_PORT = int(_rt['proxy_port'])
        except Exception:
            pass
        proxy_logger.info(f"代理服务启动 → :{config.PROXY_PORT}")
        app.run(host='0.0.0.0', port=config.PROXY_PORT, threaded=True, use_reloader=False)

    elif mode == '--dashboard':
        # 纯 Dashboard 模式（子进程，永久运行）
        # 同时注册 stats_bp（API）和 dashboard_bp（静态文件）
        if _is_port_in_use(config.DASHBOARD_PORT):
            proxy_logger.info(f"Dashboard 服务已在运行（端口 {config.DASHBOARD_PORT} 已被占用），退出")
            sys.exit(0)
        from flask import Flask as _Flask
        from flask.json.provider import DefaultJSONProvider as _DefaultJSONProvider
        from stats_api import stats_bp as _stats_bp, dashboard_bp as _dashboard_bp
        from admin_api import admin_bp as _admin_bp

        class _UTF8JSONProvider(_DefaultJSONProvider):
            """让 jsonify 输出原始 UTF-8 中文，不做 unicode 转义（兼容 Flask 3.x）"""
            ensure_ascii = False

        dashboard_app = _Flask(__name__)
        dashboard_app.json_provider_class = _UTF8JSONProvider
        dashboard_app.json = _UTF8JSONProvider(dashboard_app)
        dashboard_app.register_blueprint(_stats_bp)
        dashboard_app.register_blueprint(_dashboard_bp)
        dashboard_app.register_blueprint(_admin_bp)
        proxy_logger.info(f"Dashboard 服务启动 → :{config.DASHBOARD_PORT}")
        dashboard_app.run(host='0.0.0.0', port=config.DASHBOARD_PORT, threaded=True, use_reloader=False)

    else:
        # 启动器模式：确保两个服务都在运行
        proxy_logger.info("=" * 60)
        proxy_logger.info("Heimdall 启动（双进程解耦模式）")
        proxy_logger.info(f"  代理服务:   :{config.PROXY_PORT}   (AI 请求转发)")
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
        proxy_logger.info(f"代理进程启动 (PID {os.getpid()})")
        app.run(host='0.0.0.0', port=config.PROXY_PORT, threaded=True, use_reloader=False)
        proxy_logger.info("代理进程退出，Dashboard 继续运行中...")
