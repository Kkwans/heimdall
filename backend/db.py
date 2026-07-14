import sqlite3
import threading
import logging
from datetime import datetime, date

import config

# 模块内部日志器（写入到 proxy-error.log 的 stderr logger）
_logger = logging.getLogger("stderr")

# 线程本地存储，每个线程持有独立的 SQLite 连接
_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """获取当前线程的 SQLite 连接（线程安全，不跨线程共享连接）"""
    if not hasattr(_local, "conn") or _local.conn is None:
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row  # 支持字典风格访问
        # WAL 模式：提升并发读写性能（写不阻塞读）
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return _local.conn


def init_db():
    """初始化数据库：建表、创建索引"""
    try:
        conn = _get_conn()
        cursor = conn.cursor()

        # ======== requests 表（核心请求记录表）========
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS requests (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,

                -- 时间信息
                created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                date                TEXT NOT NULL,

                -- 请求信息
                model               TEXT NOT NULL,
                original_model      TEXT,
                stream              BOOLEAN DEFAULT 0,
                messages_count      INTEGER DEFAULT 0,

                -- Token 统计
                prompt_tokens       INTEGER DEFAULT 0,
                completion_tokens   INTEGER DEFAULT 0,
                total_tokens        INTEGER DEFAULT 0,
                cache_hit_tokens    INTEGER DEFAULT 0,
                cache_miss_tokens   INTEGER DEFAULT 0,
                reasoning_tokens    INTEGER DEFAULT 0,

                -- 性能指标
                latency_ms          INTEGER DEFAULT 0,
                ttfb_ms             INTEGER DEFAULT 0,

                -- 状态信息
                status_code         INTEGER DEFAULT 200,
                success             BOOLEAN DEFAULT 1,
                error_type          TEXT,

                -- 追踪信息
                trace_id            TEXT,
                client_ip           TEXT,

                -- API Key 关联
                api_key_id          INTEGER
            )
        """)

        # ======== daily_stats 表（每日聚合缓存，加速 Dashboard 查询）========
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS daily_stats (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                date                    TEXT NOT NULL UNIQUE,

                total_requests          INTEGER DEFAULT 0,
                success_requests        INTEGER DEFAULT 0,
                error_requests          INTEGER DEFAULT 0,
                stream_requests         INTEGER DEFAULT 0,

                total_prompt_tokens     INTEGER DEFAULT 0,
                total_completion_tokens INTEGER DEFAULT 0,
                total_tokens            INTEGER DEFAULT 0,
                total_cache_hit_tokens  INTEGER DEFAULT 0,

                avg_latency_ms          REAL DEFAULT 0,
                p50_latency_ms          REAL DEFAULT 0,
                p90_latency_ms          REAL DEFAULT 0,
                p99_latency_ms          REAL DEFAULT 0,

                cache_hit_rate          REAL DEFAULT 0,

                updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # 索引优化
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_requests_date ON requests(date)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_requests_api_key_id ON requests(api_key_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_requests_success ON requests(success)")

        # 幂等添加新列（对现有表进行升级，已有列则忽略错误）
        for col_def in [
            "ALTER TABLE requests ADD COLUMN request_body  TEXT DEFAULT NULL",
            "ALTER TABLE requests ADD COLUMN response_body TEXT DEFAULT NULL",
            "ALTER TABLE requests ADD COLUMN provider TEXT DEFAULT NULL",
        ]:
            try:
                cursor.execute(col_def)
            except Exception:
                pass  # 列已存在时 SQLite 会抛错，直接忽略

        conn.commit()
    except Exception as e:
        _logger.error(f"[DB] init_db 失败: {e}", exc_info=True)


def insert_request(record: dict):
    """
    异步写入请求记录（不阻塞主线程）。
    写入完成后自动更新 daily_stats。
    """
    t = threading.Thread(target=_do_insert, args=(record,), daemon=True)
    t.start()


def _do_insert(record: dict):
    """实际的数据库写入操作（在独立线程中执行）"""
    try:
        conn = _get_conn()
        conn.execute("""
            INSERT INTO requests (
                created_at, date, model, original_model, stream, messages_count,
                prompt_tokens, completion_tokens, total_tokens,
                cache_hit_tokens, cache_miss_tokens, reasoning_tokens,
                latency_ms, ttfb_ms,
                status_code, success, error_type,
                trace_id, client_ip,
                request_body, response_body,
                provider
            ) VALUES (
                :created_at, :date, :model, :original_model, :stream, :messages_count,
                :prompt_tokens, :completion_tokens, :total_tokens,
                :cache_hit_tokens, :cache_miss_tokens, :reasoning_tokens,
                :latency_ms, :ttfb_ms,
                :status_code, :success, :error_type,
                :trace_id, :client_ip,
                :request_body, :response_body,
                :provider
            )
        """, record)
        conn.commit()
        # 更新当天的聚合统计
        _update_daily_stats(record.get("date", str(date.today())))
    except Exception as e:
        _logger.error(f"[DB] insert_request 失败: {e}", exc_info=True)


def _update_daily_stats(target_date: str):
    """根据 requests 表重新计算并 UPSERT 当天的 daily_stats"""
    try:
        conn = _get_conn()

        # 聚合当天所有请求
        row = conn.execute("""
            SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_requests,
                SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) as stream_requests,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cache_hit_tokens) as total_cache_hit_tokens,
                AVG(latency_ms) as avg_latency_ms
            FROM requests
            WHERE date = ?
        """, (target_date,)).fetchone()

        if not row or row["total_requests"] == 0:
            return

        # 计算延迟百分位
        latencies = [r[0] for r in conn.execute(
            "SELECT latency_ms FROM requests WHERE date = ? AND latency_ms > 0 ORDER BY latency_ms",
            (target_date,)
        ).fetchall()]

        def percentile(data, p):
            if not data:
                return 0
            idx = int(len(data) * p / 100)
            idx = min(idx, len(data) - 1)
            return data[idx]

        p50 = percentile(latencies, 50)
        p90 = percentile(latencies, 90)
        p99 = percentile(latencies, 99)

        # 计算缓存命中率
        total_prompt = row["total_prompt_tokens"] or 0
        total_cache_hit = row["total_cache_hit_tokens"] or 0
        cache_hit_rate = (total_cache_hit / total_prompt) if total_prompt > 0 else 0

        conn.execute("""
            INSERT INTO daily_stats (
                date, total_requests, success_requests, error_requests, stream_requests,
                total_prompt_tokens, total_completion_tokens, total_tokens, total_cache_hit_tokens,
                avg_latency_ms, p50_latency_ms, p90_latency_ms, p99_latency_ms,
                cache_hit_rate, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(date) DO UPDATE SET
                total_requests = excluded.total_requests,
                success_requests = excluded.success_requests,
                error_requests = excluded.error_requests,
                stream_requests = excluded.stream_requests,
                total_prompt_tokens = excluded.total_prompt_tokens,
                total_completion_tokens = excluded.total_completion_tokens,
                total_tokens = excluded.total_tokens,
                total_cache_hit_tokens = excluded.total_cache_hit_tokens,
                avg_latency_ms = excluded.avg_latency_ms,
                p50_latency_ms = excluded.p50_latency_ms,
                p90_latency_ms = excluded.p90_latency_ms,
                p99_latency_ms = excluded.p99_latency_ms,
                cache_hit_rate = excluded.cache_hit_rate,
                updated_at = CURRENT_TIMESTAMP
        """, (
            target_date,
            row["total_requests"], row["success_requests"], row["error_requests"], row["stream_requests"],
            row["total_prompt_tokens"], row["total_completion_tokens"], row["total_tokens"], row["total_cache_hit_tokens"],
            row["avg_latency_ms"] or 0, p50, p90, p99,
            cache_hit_rate
        ))
        conn.commit()
    except Exception as e:
        _logger.error(f"[DB] _update_daily_stats 失败: {e}", exc_info=True)


# ==========================================
# 统计查询函数
# ==========================================

def query_overview(start_date: str, end_date: str) -> dict:
    """总览统计数据"""
    try:
        conn = _get_conn()

        row = conn.execute("""
            SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_requests,
                SUM(total_tokens) as total_tokens,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(cache_hit_tokens) as total_cache_hit_tokens,
                AVG(latency_ms) as avg_latency_ms
            FROM requests
            WHERE date BETWEEN ? AND ?
        """, (start_date, end_date)).fetchone()

        if not row:
            return _empty_overview()

        # 计算缓存命中率
        total_prompt = row["total_prompt_tokens"] or 0
        total_cache_hit = row["total_cache_hit_tokens"] or 0
        cache_hit_rate = (total_cache_hit / total_prompt) if total_prompt > 0 else 0

        # 计算 p99 延迟
        latencies = [r[0] for r in conn.execute(
            "SELECT latency_ms FROM requests WHERE date BETWEEN ? AND ? AND latency_ms > 0 ORDER BY latency_ms",
            (start_date, end_date)
        ).fetchall()]

        def percentile(data, p):
            if not data:
                return 0
            idx = int(len(data) * p / 100)
            idx = min(idx, len(data) - 1)
            return data[idx]

        return {
            "total_requests": row["total_requests"] or 0,
            "success_requests": row["success_requests"] or 0,
            "error_requests": row["error_requests"] or 0,
            "total_tokens": row["total_tokens"] or 0,
            "total_prompt_tokens": row["total_prompt_tokens"] or 0,
            "total_completion_tokens": row["total_completion_tokens"] or 0,
            "total_cache_hit_tokens": row["total_cache_hit_tokens"] or 0,
            "cache_hit_rate": round(cache_hit_rate, 4),
            "avg_latency_ms": round(row["avg_latency_ms"] or 0, 1),
            "p50_latency_ms": percentile(latencies, 50),
            "p90_latency_ms": percentile(latencies, 90),
            "p99_latency_ms": percentile(latencies, 99),
        }
    except Exception as e:
        _logger.error(f"[DB] query_overview 失败: {e}", exc_info=True)
        return _empty_overview()


def _empty_overview() -> dict:
    return {
        "total_requests": 0, "success_requests": 0, "error_requests": 0,
        "total_tokens": 0, "total_prompt_tokens": 0, "total_completion_tokens": 0,
        "total_cache_hit_tokens": 0, "cache_hit_rate": 0,
        "avg_latency_ms": 0, "p50_latency_ms": 0, "p90_latency_ms": 0, "p99_latency_ms": 0,
    }


def query_daily(start_date: str, end_date: str) -> list:
    """按日期分组的趋势数据"""
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                date,
                COUNT(*) as total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_requests,
                SUM(total_tokens) as total_tokens,
                SUM(prompt_tokens) as prompt_tokens,
                SUM(completion_tokens) as completion_tokens,
                SUM(cache_hit_tokens) as cache_hit_tokens,
                AVG(latency_ms) as avg_latency_ms,
                CASE
                    WHEN SUM(prompt_tokens) > 0
                    THEN ROUND(CAST(SUM(cache_hit_tokens) AS REAL) / SUM(prompt_tokens), 4)
                    ELSE 0
                END as cache_hit_rate
            FROM requests
            WHERE date BETWEEN ? AND ?
            GROUP BY date
            ORDER BY date ASC
        """, (start_date, end_date)).fetchall()

        return [dict(r) for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_daily 失败: {e}", exc_info=True)
        return []


def query_models(start_date: str, end_date: str) -> list:
    """按模型分组的统计数据"""
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                model,
                COUNT(*) as total_requests,
                SUM(total_tokens) as total_tokens,
                SUM(prompt_tokens) as prompt_tokens,
                SUM(completion_tokens) as completion_tokens,
                SUM(cache_hit_tokens) as cache_hit_tokens,
                AVG(latency_ms) as avg_latency_ms,
                CASE
                    WHEN SUM(prompt_tokens) > 0
                    THEN ROUND(CAST(SUM(cache_hit_tokens) AS REAL) / SUM(prompt_tokens), 4)
                    ELSE 0
                END as cache_hit_rate,
                ROUND(CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) as success_rate
            FROM requests
            WHERE date BETWEEN ? AND ?
            GROUP BY model
            ORDER BY total_requests DESC
        """, (start_date, end_date)).fetchall()

        return [dict(r) for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_models 失败: {e}", exc_info=True)
        return []


# 可排序字段白名单（防止 SQL 注入）
SORTABLE_FIELDS = {
    'created_at', 'latency_ms', 'ttfb_ms',
    'prompt_tokens', 'completion_tokens', 'total_tokens',
    'cache_hit_tokens',
}

# output_ms 是计算字段，特殊处理
_SORT_FIELD_MAP = {
    'output_ms': '(latency_ms - ttfb_ms)',
}


def query_requests(page: int, page_size: int, filters: dict) -> dict:
    """分页查询请求明细，支持按 model/date/status 筛选，支持全量数据排序"""
    try:
        conn = _get_conn()

        where_clauses = []
        params = []

        if filters.get("model") and filters["model"] != "all":
            where_clauses.append("model = ?")
            params.append(filters["model"])

        if filters.get("date"):
            where_clauses.append("date = ?")
            params.append(filters["date"])

        if filters.get("start_date"):
            where_clauses.append("date >= ?")
            params.append(filters["start_date"])

        if filters.get("end_date"):
            where_clauses.append("date <= ?")
            params.append(filters["end_date"])

        status = filters.get("status", "all")
        if status == "success":
            where_clauses.append("success = 1")
        elif status == "error":
            where_clauses.append("success = 0")

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        # 排序字段与方向（防注入白名单校验）
        sort_by = filters.get("sort_by", "created_at")
        sort_order = filters.get("sort_order", "desc")

        if sort_order not in ("asc", "desc"):
            sort_order = "desc"

        if sort_by in _SORT_FIELD_MAP:
            order_expr = _SORT_FIELD_MAP[sort_by]
        elif sort_by in SORTABLE_FIELDS:
            order_expr = sort_by
        else:
            order_expr = "created_at"

        order_sql = f"ORDER BY {order_expr} {sort_order.upper()}"

        # 查询总数
        total = conn.execute(
            f"SELECT COUNT(*) FROM requests {where_sql}",
            params
        ).fetchone()[0]

        # 分页查询
        offset = (page - 1) * page_size
        rows = conn.execute(
            f"""
            SELECT
                r.id, r.created_at, r.date, r.model, r.original_model, r.stream, r.messages_count,
                r.prompt_tokens, r.completion_tokens, r.total_tokens,
                r.cache_hit_tokens, r.cache_miss_tokens, r.reasoning_tokens,
                r.latency_ms, r.ttfb_ms,
                r.status_code, r.success, r.error_type,
                r.trace_id, r.client_ip,
                r.api_key_id,
                ak.name as api_key_name
            FROM requests r
            LEFT JOIN api_keys ak ON r.api_key_id = ak.id
            {where_sql}
            {order_sql}
            LIMIT ? OFFSET ?
            """,
            params + [page_size, offset]
        ).fetchall()

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [dict(r) for r in rows],
        }
    except Exception as e:
        _logger.error(f"[DB] query_requests 失败: {e}", exc_info=True)
        return {"total": 0, "page": page, "page_size": page_size, "items": []}


def query_latency_distribution(start_date: str, end_date: str, model: str = "all") -> list:
    """延迟分布数据（按固定区间分桶）"""
    try:
        conn = _get_conn()

        model_clause = ""
        params = [start_date, end_date]
        if model and model != "all":
            model_clause = "AND model = ?"
            params.append(model)

        rows = conn.execute(f"""
            SELECT latency_ms FROM requests
            WHERE date BETWEEN ? AND ? {model_clause} AND latency_ms > 0
        """, params).fetchall()

        # LLM 适配分桶：< 1s / 1-3s / 3-10s / 10-30s / > 30s
        buckets = [
            {"label": "< 1s",     "min": 0,      "max": 1000,  "count": 0},
            {"label": "1s–3s",    "min": 1000,   "max": 3000,  "count": 0},
            {"label": "3s–10s",   "min": 3000,   "max": 10000, "count": 0},
            {"label": "10s–30s",  "min": 10000,  "max": 30000, "count": 0},
            {"label": "> 30s",    "min": 30000,  "max": None,  "count": 0},
        ]

        for row in rows:
            ms = row[0]
            for bucket in buckets:
                if bucket["max"] is None:
                    if ms >= bucket["min"]:
                        bucket["count"] += 1
                        break
                elif bucket["min"] <= ms < bucket["max"]:
                    bucket["count"] += 1
                    break

        return [{"label": b["label"], "count": b["count"]} for b in buckets]
    except Exception as e:
        _logger.error(f"[DB] query_latency_distribution 失败: {e}", exc_info=True)
        return []


def query_available_models() -> list:
    """返回数据库中所有出现过的模型名列表"""
    try:
        conn = _get_conn()
        rows = conn.execute(
            "SELECT DISTINCT model FROM requests ORDER BY model"
        ).fetchall()
        return [r[0] for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_available_models 失败: {e}", exc_info=True)
        return []


# ==========================================
# v3 新增查询函数
# ==========================================

def query_model_stats(start_date: str, end_date: str) -> list:
    """按模型聚合的详细统计数据，含 Think Time / Output Time 拆分"""
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                model,
                COUNT(*)                                                         AS total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END)                    AS success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)                    AS error_requests,
                SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END)                     AS stream_requests,
                SUM(CASE WHEN stream = 0 THEN 1 ELSE 0 END)                     AS non_stream_requests,

                -- 耗时
                AVG(latency_ms)                                                  AS avg_total_latency_ms,
                AVG(CASE WHEN stream = 1 THEN ttfb_ms ELSE NULL END)             AS avg_ttfb_ms,
                AVG(CASE WHEN stream = 1 THEN latency_ms - ttfb_ms ELSE NULL END) AS avg_output_ms,

                -- Token
                AVG(prompt_tokens)                                               AS avg_prompt_tokens,
                AVG(completion_tokens)                                           AS avg_completion_tokens,
                AVG(total_tokens)                                                AS avg_total_tokens,
                SUM(total_tokens)                                                AS total_tokens,
                SUM(prompt_tokens)                                               AS total_prompt_tokens,
                SUM(completion_tokens)                                           AS total_completion_tokens,
                SUM(cache_hit_tokens)                                            AS total_cache_hit_tokens,

                -- 缓存命中率
                CASE
                    WHEN SUM(prompt_tokens) > 0
                    THEN ROUND(CAST(SUM(cache_hit_tokens) AS REAL) / SUM(prompt_tokens), 4)
                    ELSE 0
                END                                                              AS avg_cache_hit_rate,

                -- 成功率
                ROUND(CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) AS success_rate

            FROM requests
            WHERE date BETWEEN ? AND ?
            GROUP BY model
            ORDER BY total_tokens DESC
        """, (start_date, end_date)).fetchall()

        result = []
        for r in rows:
            row = dict(r)
            # 计算 P50/P90/P99（单独查询该模型的延迟分布）
            latencies = [x[0] for x in conn.execute(
                "SELECT latency_ms FROM requests WHERE date BETWEEN ? AND ? AND model = ? AND latency_ms > 0 ORDER BY latency_ms",
                (start_date, end_date, row["model"])
            ).fetchall()]

            def _pct(data, p):
                if not data:
                    return 0
                idx = min(int(len(data) * p / 100), len(data) - 1)
                return data[idx]

            row["p50_latency_ms"] = _pct(latencies, 50)
            row["p90_latency_ms"] = _pct(latencies, 90)
            row["p99_latency_ms"] = _pct(latencies, 99)
            # 四舍五入避免浮点精度问题
            for k in ["avg_total_latency_ms", "avg_ttfb_ms", "avg_output_ms",
                      "avg_prompt_tokens", "avg_completion_tokens", "avg_total_tokens"]:
                if row[k] is not None:
                    row[k] = round(row[k], 1)
            result.append(row)

        return result
    except Exception as e:
        _logger.error(f"[DB] query_model_stats 失败: {e}", exc_info=True)
        return []


def query_error_analysis(start_date: str, end_date: str) -> list:
    """错误码聚合统计（按 HTTP status_code 分组，替代原有的 error_type 分组）"""
    try:
        conn = _get_conn()
        total_errors = conn.execute(
            "SELECT COUNT(*) FROM requests WHERE date BETWEEN ? AND ? AND success = 0",
            (start_date, end_date)
        ).fetchone()[0] or 1  # 避免除零

        rows = conn.execute("""
            SELECT
                COALESCE(status_code, 0)                   AS status_code,
                COUNT(*)                                    AS count,
                GROUP_CONCAT(DISTINCT model)                AS models
            FROM requests
            WHERE date BETWEEN ? AND ? AND success = 0
            GROUP BY status_code
            ORDER BY count DESC
        """, (start_date, end_date)).fetchall()

        return [{
            "status_code": r["status_code"],
            "count": r["count"],
            "pct": round(r["count"] / total_errors, 4),
            "models": (r["models"] or "").split(",")[:5],
        } for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_error_analysis 失败: {e}", exc_info=True)
        return []


def query_hourly(target_date: str) -> list:
    """按小时分布统计（0-23 时）"""
    try:
        conn = _get_conn()
        # SQLite strftime 对 created_at 按小时分组
        rows = conn.execute("""
            SELECT
                CAST(strftime('%H', created_at) AS INTEGER)  AS hour,
                COUNT(*)                                      AS total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_requests,
                SUM(total_tokens)                             AS total_tokens,
                AVG(latency_ms)                               AS avg_latency_ms
            FROM requests
            WHERE date = ?
            GROUP BY hour
            ORDER BY hour ASC
        """, (target_date,)).fetchall()

        # 补全 0-23 所有小时（无数据的小时用 0 填充）
        hour_map = {r["hour"]: dict(r) for r in rows}
        result = []
        for h in range(24):
            if h in hour_map:
                item = hour_map[h]
                item["avg_latency_ms"] = round(item["avg_latency_ms"] or 0, 1)
                result.append(item)
            else:
                result.append({
                    "hour": h, "total_requests": 0, "success_requests": 0,
                    "error_requests": 0, "total_tokens": 0, "avg_latency_ms": 0
                })
        return result
    except Exception as e:
        _logger.error(f"[DB] query_hourly 失败: {e}", exc_info=True)
        return []


def query_provider_stats(start_date: str, end_date: str) -> list:
    """按厂商聚合的统计数据（基于 requests 表的 provider 字段）
    
    返回格式与 query_model_stats 类似，按 provider 分组：
    - provider 为空或 NULL 时归类为 "default"（未配置路由时的默认厂商）
    - 包含请求数、Token 消耗、延迟、成功率等指标
    """
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                COALESCE(NULLIF(provider, ''), 'default')  AS provider,
                COUNT(*)                                                         AS total_requests,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END)                    AS success_requests,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)                    AS error_requests,
                SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END)                     AS stream_requests,

                -- 耗时
                AVG(latency_ms)                                                  AS avg_total_latency_ms,
                AVG(CASE WHEN stream = 1 THEN ttfb_ms ELSE NULL END)             AS avg_ttfb_ms,
                AVG(CASE WHEN stream = 1 THEN latency_ms - ttfb_ms ELSE NULL END) AS avg_output_ms,

                -- Token
                SUM(total_tokens)                                                AS total_tokens,
                SUM(prompt_tokens)                                               AS total_prompt_tokens,
                SUM(completion_tokens)                                           AS total_completion_tokens,
                SUM(cache_hit_tokens)                                            AS total_cache_hit_tokens,
                AVG(total_tokens)                                                AS avg_total_tokens,

                -- 缓存命中率
                CASE
                    WHEN SUM(prompt_tokens) > 0
                    THEN ROUND(CAST(SUM(cache_hit_tokens) AS REAL) / SUM(prompt_tokens), 4)
                    ELSE 0
                END                                                              AS cache_hit_rate,

                -- 成功率
                ROUND(CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) AS success_rate,

                -- 模型列表（该厂商下的所有模型）
                GROUP_CONCAT(DISTINCT model)                                     AS models

            FROM requests
            WHERE date BETWEEN ? AND ?
            GROUP BY provider
            ORDER BY total_tokens DESC
        """, (start_date, end_date)).fetchall()

        result = []
        for r in rows:
            row = dict(r)
            # 计算 P50/P90/P99 延迟
            latencies = [x[0] for x in conn.execute(
                "SELECT latency_ms FROM requests WHERE date BETWEEN ? AND ? "
                "AND COALESCE(NULLIF(provider, ''), 'default') = ? AND latency_ms > 0 "
                "ORDER BY latency_ms",
                (start_date, end_date, row["provider"])
            ).fetchall()]

            def _pct(data, p):
                if not data:
                    return 0
                idx = min(int(len(data) * p / 100), len(data) - 1)
                return data[idx]

            row["p50_latency_ms"] = _pct(latencies, 50)
            row["p90_latency_ms"] = _pct(latencies, 90)
            row["p99_latency_ms"] = _pct(latencies, 99)
            # models 字段转为列表
            row["models"] = (row.get("models") or "").split(",") if row.get("models") else []
            # 四舍五入
            for k in ["avg_total_latency_ms", "avg_ttfb_ms", "avg_output_ms", "avg_total_tokens"]:
                if row.get(k) is not None:
                    row[k] = round(row[k], 1)
            result.append(row)

        return result
    except Exception as e:
        _logger.error(f"[DB] query_provider_stats 失败: {e}", exc_info=True)
        return []


def query_request_detail(request_id: int):
    """获取单条请求的完整信息，包含 request_body / response_body"""
    try:
        import json as _json
        conn = _get_conn()
        row = conn.execute(
            "SELECT * FROM requests WHERE id = ?", (request_id,)
        ).fetchone()
        if not row:
            return None
        r = dict(row)
        # 尝试将 request_body / response_body 字符串解析为 JSON 对象
        for key in ("request_body", "response_body"):
            val = r.get(key)
            if val:
                try:
                    r[key] = _json.loads(val)
                except Exception:
                    pass  # 无法解析则保留原始字符串
        return r
    except Exception as e:
        _logger.error(f"[DB] query_request_detail 失败: {e}", exc_info=True)
        return None


def query_api_key_stats(start_date: str, end_date: str) -> list:
    """按 APIKey 分组统计 token 用量和请求次数"""
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                COALESCE(ak.name, '未知') as api_key_name,
                r.api_key_id,
                COUNT(*) as total_requests,
                SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) as success_requests,
                SUM(CASE WHEN r.success = 0 THEN 1 ELSE 0 END) as error_requests,
                SUM(r.prompt_tokens) as total_prompt_tokens,
                SUM(r.completion_tokens) as total_completion_tokens,
                SUM(r.total_tokens) as total_tokens,
                SUM(r.cache_hit_tokens) as total_cache_hit_tokens,
                SUM(r.reasoning_tokens) as total_reasoning_tokens,
                ROUND(AVG(r.latency_ms), 0) as avg_latency_ms
            FROM requests r
            LEFT JOIN api_keys ak ON r.api_key_id = ak.id
            WHERE r.date >= ? AND r.date <= ?
            GROUP BY r.api_key_id
            ORDER BY total_tokens DESC
        """, (start_date, end_date)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_api_key_stats 失败: {e}", exc_info=True)
        return []


def query_api_key_model_stats(start_date: str, end_date: str) -> list:
    """按 APIKey + 模型分组统计"""
    try:
        conn = _get_conn()
        rows = conn.execute("""
            SELECT
                COALESCE(ak.name, '未知') as api_key_name,
                r.api_key_id,
                r.model,
                COUNT(*) as request_count,
                SUM(r.total_tokens) as total_tokens,
                ROUND(AVG(r.latency_ms), 0) as avg_latency_ms
            FROM requests r
            LEFT JOIN api_keys ak ON r.api_key_id = ak.id
            WHERE r.date >= ? AND r.date <= ?
            GROUP BY r.api_key_id, r.model
            ORDER BY total_tokens DESC
        """, (start_date, end_date)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_api_key_model_stats 失败: {e}", exc_info=True)
        return []


def query_api_key_daily(start_date: str, end_date: str, api_key_id: int = None) -> list:
    """按日期分组的 APIKey 统计趋势"""
    try:
        conn = _get_conn()
        if api_key_id:
            rows = conn.execute("""
                SELECT
                    r.date,
                    COALESCE(ak.name, '未知') as api_key_name,
                    COUNT(*) as requests,
                    SUM(r.total_tokens) as tokens,
                    SUM(r.prompt_tokens) as prompt_tokens,
                    SUM(r.completion_tokens) as completion_tokens,
                    ROUND(AVG(r.latency_ms), 0) as avg_latency_ms
                FROM requests r
                LEFT JOIN api_keys ak ON r.api_key_id = ak.id
                WHERE r.date >= ? AND r.date <= ? AND r.api_key_id = ?
                GROUP BY r.date
                ORDER BY r.date
            """, (start_date, end_date, api_key_id)).fetchall()
        else:
            rows = conn.execute("""
                SELECT
                    r.date,
                    COALESCE(ak.name, '未知') as api_key_name,
                    r.api_key_id,
                    COUNT(*) as requests,
                    SUM(r.total_tokens) as tokens,
                    SUM(r.prompt_tokens) as prompt_tokens,
                    SUM(r.completion_tokens) as completion_tokens,
                    ROUND(AVG(r.latency_ms), 0) as avg_latency_ms
                FROM requests r
                LEFT JOIN api_keys ak ON r.api_key_id = ak.id
                WHERE r.date >= ? AND r.date <= ?
                GROUP BY r.date, r.api_key_id
                ORDER BY r.date, tokens DESC
            """, (start_date, end_date)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        _logger.error(f"[DB] query_api_key_daily 失败: {e}", exc_info=True)
        return []
