"""
AI Credit 代理路由
将前端请求代理到 friday.sankuai.com 的 AI Credit 接口。

真实 API 流程（已通过抓包验证）：
  Step 1: GET /sso/web/auth?clientId=12d702aa62&accessEnv=product
          ↳ 返回 access-token（Bearer Token）
          ↳ 认证条件：需携带浏览器中 friday.sankuai.com 的 SSO Cookie

  Step 2: GET /cockpit/personalTenant/personalInfo
          Headers: access-token: <token>, M-APPKEY: fe_com.sankuai.friday.ai.credit
          ↳ 返回 { code: 0, data: { tenantId: "xxx", ... } }

  Step 3: GET /cockpit/usage/user/info?tenantId=xxx
          ↳ 返回 Credit 摘要（余额、有效期等）

  Step 3b: GET /cockpit/usage/user/records?pageNum=1&pageSize=50&tenantId=xxx
           ↳ 返回消耗记录列表

缓存策略（本地 SQLite）：
  - 历史数据（date < today）：每天首次请求 Friday 成功后落库，之后直接查本地
  - 今日数据（date == today）：每次实时请求 Friday（T+1更新，今日实时变化）
  - Friday 接口失败时：本地有历史缓存则返回缓存（附 from_cache=true）+ 今日数据为空
  - 判断"是否已经今天落库"：查 last_fetch_date 表
"""

import json
import sqlite3
import threading
import requests
from datetime import date as _date
from flask import Blueprint, request, jsonify
import config

credit_bp = Blueprint('credit', __name__)

# ── 服务端持久化 Friday Cookie（解决 Tailscale 远程设备无法携带 Cookie 的问题）──
# 用户可在本机通过 /api/credit/cookie 接口将 Cookie 存入服务端 SQLite，
# 远程设备访问时后端自动读取使用，无需浏览器 Cookie。
_cookie_lock = threading.Lock()

# ── SQLite 缓存（复用 heimdall.db）──────────────────────────────────────────

_cache_lock = threading.Lock()


def _get_cache_conn() -> sqlite3.Connection:
    """返回缓存数据库连接（每次新建，调用方负责关闭）"""
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _init_cache_table():
    """建立消耗记录缓存表、fetch 记录表、Cookie 存储表、用户信息缓存表（首次调用时）"""
    conn = _get_cache_conn()
    try:
        # 消耗记录缓存（按 tenant_id + 日期唯一）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS credit_records_cache (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id    TEXT    NOT NULL,
                rec_date     TEXT    NOT NULL,
                records_json TEXT    NOT NULL,
                cached_at    TEXT    NOT NULL,
                UNIQUE(tenant_id, rec_date)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_crc_tenant_date "
            "ON credit_records_cache(tenant_id, rec_date)"
        )
        # 每天首次请求记录（tenant_id + 日期唯一）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS credit_fetch_log (
                tenant_id   TEXT NOT NULL,
                fetch_date  TEXT NOT NULL,
                fetched_at  TEXT NOT NULL,
                PRIMARY KEY (tenant_id, fetch_date)
            )
        """)
        # Friday Cookie 持久化存储（单行，key='friday_cookie'）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS credit_config (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # 用户个人信息缓存（单行，按 mis_id 存储）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS credit_user_info (
                mis_id     TEXT PRIMARY KEY,
                info_json  TEXT NOT NULL,
                cached_at  TEXT NOT NULL
            )
        """)
        conn.commit()
    finally:
        conn.close()


def _get_stored_cookie() -> str:
    """从 SQLite 读取持久化存储的 Friday Cookie（为空时返回空字符串）"""
    try:
        conn = _get_cache_conn()
        try:
            row = conn.execute(
                "SELECT value FROM credit_config WHERE key='friday_cookie'"
            ).fetchone()
            val = row['value'] if row else ''
            # 防御：值存在但全是空格也视为空
            return val.strip() if val else ''
        finally:
            conn.close()
    except Exception:
        return ''


def _set_stored_cookie(cookie: str):
    """将 Friday Cookie 持久化到 SQLite"""
    today = str(_date.today())
    conn = _get_cache_conn()
    try:
        with _cookie_lock:
            conn.execute(
                """INSERT OR REPLACE INTO credit_config(key, value, updated_at)
                   VALUES('friday_cookie', ?, ?)""",
                (cookie, today)
            )
            conn.commit()
    finally:
        conn.close()


def _effective_cookie() -> str:
    """
    获取有效 Cookie：
    1. 优先使用服务端持久化存储的 Friday Cookie（用户通过自动同步/手动粘贴存入的）
       — 这才是真正用于访问 friday.sankuai.com 的 Cookie
    2. 降级到当前请求携带的 Cookie（注意：浏览器向 Heimdall 发请求时携带的是
       Heimdall 自身域的 Cookie，而非 Friday 的 Cookie；仅在极少数场景有效）

    说明：不再优先使用请求头 Cookie 的原因：
    - 浏览器访问 Heimdall（例如 localhost:8080）时，携带的是 Heimdall 域的 Cookie
    - 这与 friday.sankuai.com 的认证 Cookie 是完全独立的
    - 直接用 Heimdall 的 Cookie 去请求 Friday 会导致鉴权失败
    """
    stored = _get_stored_cookie()
    if stored:
        return stored
    # 降级：尝试请求头中的 Cookie（极少数情况，如 Heimdall 部署在 sankuai.com 子域下时可能有效）
    return request.headers.get('Cookie', '').strip()


# 应用启动时初始化缓存表
_init_cache_table()


def _has_fetched_today(tenant_id: str) -> bool:
    """判断今天是否已成功从 Friday 拉取过历史数据"""
    today = str(_date.today())
    conn = _get_cache_conn()
    try:
        row = conn.execute(
            "SELECT 1 FROM credit_fetch_log WHERE tenant_id=? AND fetch_date=?",
            (tenant_id, today)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def _mark_fetched_today(tenant_id: str):
    """标记今天已从 Friday 成功拉取历史数据"""
    today = str(_date.today())
    conn = _get_cache_conn()
    try:
        with _cache_lock:
            conn.execute(
                """INSERT OR REPLACE INTO credit_fetch_log(tenant_id, fetch_date, fetched_at)
                   VALUES(?, ?, ?)""",
                (tenant_id, today, today)
            )
            conn.commit()
    finally:
        conn.close()


def _load_cached_records(tenant_id: str, exclude_today: bool = True) -> list:
    """
    从本地 SQLite 读取已缓存的消耗记录。
    exclude_today=True 时只返回非今日数据（今日需实时请求）。
    """
    today = str(_date.today())
    conn = _get_cache_conn()
    try:
        if exclude_today:
            rows = conn.execute(
                "SELECT records_json FROM credit_records_cache "
                "WHERE tenant_id = ? AND rec_date < ? ORDER BY rec_date DESC",
                (tenant_id, today)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT records_json FROM credit_records_cache "
                "WHERE tenant_id = ? ORDER BY rec_date DESC",
                (tenant_id,)
            ).fetchall()
        result = []
        for row in rows:
            try:
                result.extend(json.loads(row['records_json']))
            except Exception:
                pass
        return result
    finally:
        conn.close()


def _save_records_to_cache(tenant_id: str, records: list):
    """
    将消耗记录按日期分组写入本地 SQLite。
    只缓存非今日的记录（今日数据仍在变化）。
    """
    today = str(_date.today())
    # 按日期分组
    by_date: dict[str, list] = {}
    for r in records:
        d = r.get('date', '')[:10] if isinstance(r, dict) else ''
        if d and d != 'None' and d < today:
            by_date.setdefault(d, []).append(r)

    if not by_date:
        return

    conn = _get_cache_conn()
    try:
        with _cache_lock:
            now = str(_date.today())
            for rec_date, recs in by_date.items():
                conn.execute(
                    """INSERT INTO credit_records_cache
                           (tenant_id, rec_date, records_json, cached_at)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(tenant_id, rec_date) DO UPDATE SET
                           records_json = excluded.records_json,
                           cached_at    = excluded.cached_at""",
                    (tenant_id, rec_date, json.dumps(recs, ensure_ascii=False), now)
                )
            conn.commit()
    finally:
        conn.close()


FRIDAY_BASE = 'https://friday.sankuai.com'
FRIDAY_APPKEY = 'fe_com.sankuai.friday.ai.credit'
FRIDAY_REFERER = 'https://friday.sankuai.com/aiCredit/'
FRIDAY_SSO_CLIENT = '12d702aa62'
TIMEOUT = 15


# ── CORS ─────────────────────────────────────────────────────────────────────

@credit_bp.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = (
        'Content-Type, Cookie, access-token'
    )
    return response


def _options_resp():
    resp = jsonify({})
    resp.status_code = 204
    return resp


def _err(code: int, msg: str, login_url: bool = False):
    body = {'code': code, 'message': msg}
    if login_url:
        body['loginUrl'] = 'https://friday.sankuai.com/aiCredit'
    resp = jsonify(body)
    resp.status_code = code if code in (401, 502, 504) else 502
    return resp


# ── 内部工具 ─────────────────────────────────────────────────────────────────

def _build_headers(cookie: str, access_token: str = '') -> dict:
    """构建请求 Friday 的通用 Header"""
    h = {
        'Cookie': cookie,
        'Referer': FRIDAY_REFERER,
        'M-APPKEY': FRIDAY_APPKEY,
        'x-requested-with': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': (
            request.headers.get('User-Agent') or
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        ),
    }
    if access_token:
        h['access-token'] = access_token
    return h


def _is_redirect(status: int) -> bool:
    return status in (301, 302, 303, 307, 308)


def _friday_get(path: str, headers: dict, params: dict = None):
    """发起请求并返回 (ok, data_or_error_resp)"""
    try:
        r = requests.get(
            FRIDAY_BASE + path,
            headers=headers,
            params=params or {},
            timeout=TIMEOUT,
            allow_redirects=False,
        )
        if _is_redirect(r.status_code):
            return False, _err(401, '未登录或 SSO 会话已过期，请先访问 friday.sankuai.com 完成登录', True)

        try:
            data = r.json()
        except Exception:
            return False, _err(502, f'上游接口返回非 JSON 响应（HTTP {r.status_code}）')

        # Friday 标准错误：{"status":401,"data":{"message":"auth failed"}}
        # 或 {"code":401,"message":"..."}
        upstream_code = data.get('status') or data.get('code')
        if upstream_code == 401:
            return False, _err(401, 'Friday 鉴权失败，请先在浏览器访问 friday.sankuai.com 完成登录', True)

        # 业务层错误码：code != 0 且 code != 200
        if isinstance(upstream_code, int) and upstream_code not in (0, 200, None):
            msg = data.get('message') or data.get('msg') or f'上游错误 code={upstream_code}'
            return False, _err(502, msg)

        return True, data

    except requests.Timeout:
        return False, _err(504, '请求上游接口超时（>15s）')
    except requests.RequestException as e:
        return False, _err(502, f'代理请求失败: {str(e)}')


# ── Step 1：获取 access-token ─────────────────────────────────────────────────

def _get_access_token(cookie: str):
    """
    通过 /sso/web/auth 换取 access-token。
    返回 (token_str | None, error_resp | None)
    """
    # 优先使用前端透传的 access-token（来自请求头）
    client_token = request.headers.get('access-token', '').strip()
    if client_token:
        return client_token, None

    # 若没有透传，则自动调用 SSO 接口换取
    if not cookie:
        return None, _err(401, '未携带认证 Cookie，请先在浏览器访问 friday.sankuai.com 完成 SSO 登录', True)

    headers = _build_headers(cookie)
    ok, result = _friday_get(
        f'/sso/web/auth?clientId={FRIDAY_SSO_CLIENT}&accessEnv=product',
        headers,
    )
    if not ok:
        # SSO 接口任何错误（包括 "ssoid不存在" 等）均视为未登录
        return None, _err(401, 'SSO 认证失败，请先在浏览器访问 friday.sankuai.com 完成登录', True)

    # 响应格式：{"code":0,"data":{"accessToken":"xxx",...}}
    data_block = result.get('data') or result
    token = (
        data_block.get('accessToken') or
        data_block.get('access_token') or
        data_block.get('token') or
        (result.get('data') if isinstance(result.get('data'), str) else None)
    )
    if not token:
        return None, _err(401, '无法从 SSO 接口获取 access-token，请确认已登录 friday.sankuai.com', True)

    return token, None


# ── 用户信息本地缓存工具 ────────────────────────────────────────────────────

def _save_user_info_cache(info: dict):
    """将用户信息缓存到 SQLite（按 misId 存储）"""
    mis_id = info.get('misId', '').strip()
    if not mis_id:
        return
    today = str(_date.today())
    conn = _get_cache_conn()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO credit_user_info(mis_id, info_json, cached_at)
               VALUES(?, ?, ?)""",
            (mis_id, json.dumps(info, ensure_ascii=False), today)
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def _load_user_info_cache():
    """从 SQLite 读取最近缓存的用户信息（返回最新一条）"""
    conn = _get_cache_conn()
    try:
        row = conn.execute(
            "SELECT info_json FROM credit_user_info ORDER BY cached_at DESC LIMIT 1"
        ).fetchone()
        if row:
            return json.loads(row['info_json'])
        return None
    except Exception:
        return None
    finally:
        conn.close()


def _extract_real_name(data_block: dict) -> str:
    """
    从 Friday personalInfo 接口数据中提取真实中文姓名。

    Friday /cockpit/personalTenant/personalInfo 实际返回字段：
      tenantId, tenantName, misId, appId, org
    其中 tenantName 格式为 "黄康的个人租户"，从中截取姓名部分。
    """
    # 优先：接口直接返回 userName / name
    direct = (
        data_block.get('userName') or data_block.get('user_name') or
        data_block.get('name') or ''
    )
    if direct and direct != data_block.get('misId', ''):
        return direct

    # 从 tenantName 推导："黄康的个人租户" → "黄康"
    tenant_name = data_block.get('tenantName') or data_block.get('tenant_name') or ''
    if tenant_name:
        # 匹配 "XXX的个人租户" 格式
        for suffix in ('的个人租户', 's Personal Tenant', "'s Personal"):
            if suffix in tenant_name:
                name = tenant_name[:tenant_name.index(suffix)].strip()
                if name:
                    return name
        # 如果不是标准格式，直接返回 tenantName（可能本身就是名字）
        if len(tenant_name) <= 10 and '租户' not in tenant_name:
            return tenant_name

    return ''


# ── 个人信息接口：/api/credit/me ─────────────────────────────────────────────

@credit_bp.route('/api/credit/me', methods=['GET', 'OPTIONS'])
def credit_me():
    """
    返回当前登录用户的个人信息。
    数据来源：/cockpit/personalTenant/personalInfo
    返回格式：{
        code: 0,
        data: {
            realName,   # 真实姓名（从 tenantName 提取）
            userName,   # misId（兼容字段）
            misId, tenantId, appId,
            org,        # 组织路径（原始 org 字段）
            department, # org 的别名
            avatar      # 空字符串，前端使用本地 GIF
        }
    }
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    # 缓存优先：有本地缓存时直接返回，不请求 Friday
    # 个人信息基本不变，无需每次实时拉取
    # 传 ?force=1 可强制刷新（例如点击刷新按钮时）
    force = request.args.get('force', '0').strip() == '1'
    if not force:
        cached = _load_user_info_cache()
        if cached and (cached.get('misId') or cached.get('realName')):
            return jsonify({'code': 0, 'data': cached, 'from_cache': True})

    cookie = _effective_cookie()
    token, err = _get_access_token(cookie)
    if err:
        return err

    headers = _build_headers(cookie, token)
    ok, result = _friday_get('/cockpit/personalTenant/personalInfo', headers)
    if not ok:
        return result

    data_block = result.get('data') or result
    real_name = _extract_real_name(data_block)
    mis_id = (
        data_block.get('misId') or data_block.get('mis_id') or
        data_block.get('userId') or data_block.get('user_id') or ''
    )
    org = (
        data_block.get('org') or data_block.get('orgFullPath') or
        data_block.get('org_full_path') or data_block.get('department') or
        data_block.get('dept') or ''
    )
    info = {
        'realName': real_name,
        'userName': mis_id,          # 兼容字段，前端 displayName 逻辑会用
        'misId': mis_id,
        'tenantId': (
            data_block.get('tenantId') or data_block.get('tenant_id') or ''
        ),
        'appId': (
            data_block.get('appId') or data_block.get('app_id') or
            data_block.get('clientId') or ''
        ),
        'org': org,
        'department': org,           # 兼容字段
        'avatar': (
            data_block.get('avatar') or data_block.get('avatarUrl') or
            data_block.get('headImgUrl') or ''
        ),
        # 保留原始 data，方便前端取其他字段
        '_raw': data_block,
    }
    # 缓存到本地，供访客模式使用
    _save_user_info_cache(info)
    return jsonify({'code': 0, 'data': info})


@credit_bp.route('/api/credit/me/local', methods=['GET', 'OPTIONS'])
def credit_me_local():
    """访客模式：直接从本地 SQLite 读取缓存的用户信息，不调 Friday。"""
    if request.method == 'OPTIONS':
        return _options_resp()
    info = _load_user_info_cache()
    if info:
        return jsonify({'code': 0, 'data': info})
    return jsonify({'code': 0, 'data': None})


# ── Step 2：获取 tenantId ────────────────────────────────────────────────────

def _get_tenant_id(cookie: str, token: str):
    """
    通过 /cockpit/personalTenant/personalInfo 获取 tenantId。
    返回 (tenantId_str | None, error_resp | None)
    """
    headers = _build_headers(cookie, token)
    ok, result = _friday_get('/cockpit/personalTenant/personalInfo', headers)
    if not ok:
        return None, result

    data_block = result.get('data') or result
    tenant_id = (
        data_block.get('tenantId') or
        data_block.get('tenant_id') or
        data_block.get('id') or
        (str(result.get('data')) if isinstance(result.get('data'), (int, str)) else None)
    )
    if not tenant_id:
        return None, _err(502, '无法获取 tenantId，接口返回数据格式异常')

    return str(tenant_id), None


# ── 聚合接口：/api/credit/summary ────────────────────────────────────────────

@credit_bp.route('/api/credit/auto-sync', methods=['POST', 'OPTIONS'])
def credit_auto_sync():
    """
    从本机浏览器（Chrome / Safari）自动读取 friday.sankuai.com 的 Cookie，
    保存到服务端 SQLite，无需用户手动复制粘贴。
    仅限 macOS 本机运行时有效（需要读取浏览器 Cookie 存储）。
    Linux/Docker 环境不支持，请通过 POST /api/credit/cookie 手动粘贴 Cookie。
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    # Linux/Docker 环境：browser_cookie3 无法读取浏览器 Cookie
    import platform as _platform
    if _platform.system() != 'Darwin':
        return jsonify({'code': 400, 'message': '自动同步仅支持 macOS（Docker 环境请通过 POST /api/credit/cookie 手动粘贴 Cookie）'}), 400

    try:
        import browser_cookie3  # type: ignore
    except ImportError:
        return jsonify({'code': 500, 'message': 'browser_cookie3 未安装，请在服务器运行 pip3 install browser-cookie3'}), 500

    # 精确读 friday.sankuai.com 的 cookie（不读 .sankuai.com 全域，避免混入无关子域的 cookie）
    friday_domain = 'friday.sankuai.com'
    cookie_str = ''
    errors = []

    # 判断 cookie 是否属于 friday.sankuai.com（name 包含关键标识）
    FRIDAY_KEY_COOKIES = {'moa_deviceId', '_lxsdk_cuid', '_lxsdk', 'logan_session_token',
                          'utm_source_rg', 'com.sankuai.friday'}

    def is_friday_cookie(c) -> bool:
        """判断是否是 friday 域的关键 cookie"""
        if not c.value:
            return False
        # domain 精确匹配
        d = (c.domain or '').lstrip('.')
        if 'friday.sankuai.com' in d:
            return True
        # 关键 cookie name 匹配（这些 cookie 只有 friday.sankuai.com 才有）
        for key in FRIDAY_KEY_COOKIES:
            if c.name.startswith(key):
                return True
        # ssoid（格式为 <clientId>_ssoid）
        if c.name.endswith('_ssoid'):
            return True
        return False

    # 按优先级尝试各浏览器
    browsers = [
        ('Chrome',  lambda: browser_cookie3.chrome(domain_name=friday_domain)),
        ('Safari',  lambda: browser_cookie3.safari(domain_name=friday_domain)),
        ('Firefox', lambda: browser_cookie3.firefox(domain_name=friday_domain)),
        ('Edge',    lambda: browser_cookie3.edge(domain_name=friday_domain)),
    ]

    for name, getter in browsers:
        try:
            all_cookies = getter()
            # 过滤：只保留 friday 相关 cookie，按 name 去重（取最后一个）
            seen: dict[str, str] = {}
            for c in all_cookies:
                if is_friday_cookie(c):
                    seen[c.name] = c.value
            if seen:
                pairs = [f'{k}={v}' for k, v in seen.items()]
                cookie_str = '; '.join(pairs)
                break
        except Exception as e:
            errors.append(f'{name}: {e}')

    if not cookie_str:
        return jsonify({
            'code': 404,
            'message': f'未能从本机浏览器找到 .sankuai.com 的 Cookie。请确认已在 Chrome/Safari 中登录 friday.sankuai.com。详细错误：{"; ".join(errors)}',
        }), 404

    # 直接保存，不做强制 SSO 验证（验证在实际调用时进行）
    # 原因：SSO 验证可能因网络抖动/超时误判，导致有效 Cookie 被拒绝
    _set_stored_cookie(cookie_str)
    return jsonify({'code': 0, 'message': f'已从本机浏览器同步 Cookie（{len(cookie_str)} 字节）。如页面仍提示需要认证，说明 Cookie 已过期，请在浏览器重新登录 friday.sankuai.com 后再同步。', 'length': len(cookie_str)})


@credit_bp.route('/api/credit/cookie', methods=['GET', 'POST', 'OPTIONS'])
def credit_cookie():
    """
    Friday Cookie 管理接口（解决 Tailscale 远程访问 401 问题）

    GET  /api/credit/cookie
         返回当前存储的 Cookie 状态（脱敏，只返回前 20 位 + 长度）

    POST /api/credit/cookie
         Body: { "cookie": "<完整 Friday Cookie 字符串>" }
         将 Cookie 存入服务端 SQLite，后续远程访问时后端自动携带

    DELETE /api/credit/cookie（通过 POST body action=delete）
         清除存储的 Cookie
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    if request.method == 'GET':
        stored = _get_stored_cookie()
        if stored:
            preview = stored[:30] + '...' if len(stored) > 30 else stored
            return jsonify({
                'code': 0,
                'has_cookie': True,
                'preview': preview,
                'length': len(stored),
            })
        return jsonify({'code': 0, 'has_cookie': False})

    # POST
    body = request.get_json(silent=True) or {}
    action = body.get('action', '')
    if action == 'delete':
        conn = _get_cache_conn()
        try:
            conn.execute("DELETE FROM credit_config WHERE key='friday_cookie'")
            conn.commit()
        finally:
            conn.close()
        return jsonify({'code': 0, 'message': 'Cookie 已清除'})

    cookie_val = body.get('cookie', '').strip()
    if not cookie_val:
        return jsonify({'code': 400, 'message': '缺少 cookie 字段'}), 400

    # 直接保存，不做强制 SSO 验证（验证在实际调用时进行）
    # 原因：SSO 验证可能因网络抖动/超时/临时错误误判，导致有效 Cookie 被拒绝
    _set_stored_cookie(cookie_val)
    return jsonify({'code': 0, 'message': f'Cookie 已保存（{len(cookie_val)} 字节）。如页面仍提示需要认证，说明 Cookie 已过期，请在浏览器重新登录 friday.sankuai.com 后再复制。', 'length': len(cookie_val)})


@credit_bp.route('/api/credit/summary', methods=['GET', 'OPTIONS'])
def credit_summary():
    """
    一次性返回 Credit 摘要（含 tenantId）。
    流程：SSO → tenantId → /cockpit/usage/user/info
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    cookie = _effective_cookie()

    # Step 1: 获取 access-token
    token, err = _get_access_token(cookie)
    if err:
        return err

    # Step 2: 获取 tenantId
    tenant_id, err = _get_tenant_id(cookie, token)
    if err:
        return err

    # Step 3: 获取 Credit 信息
    headers = _build_headers(cookie, token)
    ok, result = _friday_get(
        '/cockpit/usage/user/info',
        headers,
        params={'tenantId': tenant_id},
    )
    if not ok:
        return result

    # 真实接口返回 data 是数组 (每个产品一条)
    # 将其包装为 { tenantId, products: [...] }，方便前端使用
    raw_data = result.get('data', [])
    if isinstance(raw_data, list):
        return jsonify({'code': 0, 'data': {'tenantId': tenant_id, 'products': raw_data}})
    elif isinstance(raw_data, dict):
        raw_data['tenantId'] = tenant_id
        return jsonify({'code': 0, 'data': raw_data})
    else:
        return jsonify({'code': 0, 'data': {'tenantId': tenant_id, 'products': []}})


# ── 消耗记录接口：/api/credit/records ────────────────────────────────────────

@credit_bp.route('/api/credit/records', methods=['GET', 'OPTIONS'])
def credit_records():
    """
    消耗记录接口（智能缓存策略）。

    缓存策略：
      历史数据（date < today）：
        - 每天首次请求：从 Friday 拉取全量，将 T-1（昨天）数据落库，标记今日已拉取
        - 今天已拉取过：直接从本地数据库读取历史记录，不再调 Friday

      今日数据（date == today）：
        - 每次都实时请求 Friday（今日数据随时变化）
        - 若 Friday 失败：返回错误，同时附带 today_error=true，让前端告知用户今日数据不可用

      完全无法请求 Friday 且没有任何本地缓存：返回 401 / 502 错误

    Query 参数：
      tenantId  - 前端传入（避免重复获取）
      pageNum   - 默认 1
      pageSize  - 默认 100
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    cookie = _effective_cookie()
    page_num = request.args.get('pageNum', '1')
    page_size = request.args.get('pageSize', '100')

    tenant_id = request.args.get('tenantId', '').strip()
    token = request.headers.get('access-token', '').strip()

    # ── 确保拿到 token 和 tenantId ────────────────────────────────────────────
    if not tenant_id or not token:
        token, err = _get_access_token(cookie)
        if err:
            # 认证失败：若有本地缓存，返回历史数据 + 告知今日数据不可用
            if tenant_id:
                cached = _load_cached_records(tenant_id, exclude_today=True)
                if cached:
                    return jsonify({
                        'code': 0,
                        'from_cache': True,
                        'today_error': True,
                        'cache_tip': '历史数据来自本地缓存（Friday 未登录，今日数据不可用）',
                        'data': {'list': cached, 'total': len(cached)},
                    })
            return err
        if not tenant_id:
            tenant_id, err = _get_tenant_id(cookie, token)
            if err:
                return err

    today = str(_date.today())
    headers = _build_headers(cookie, token)

    # ── 今日数据（实时获取）────────────────────────────────────────────────────
    today_list = []
    today_ok = False
    today_err_msg = None

    ok_today, result_today = _friday_get(
        '/cockpit/usage/user/records',
        headers,
        params={
            'pageNum': '1',
            'pageSize': page_size,
            'tenantId': tenant_id,
            # 若接口支持日期筛选，优先只拉今天；否则拉全量再过滤
        },
    )
    if ok_today:
        raw = result_today.get('data', result_today)
        if isinstance(raw, dict):
            all_list = raw.get('list') or raw.get('records') or []
        elif isinstance(raw, list):
            all_list = raw
        else:
            all_list = []

        # 分离今日 / 历史
        for item in all_list:
            d = str(item.get('date', ''))[:10]
            if d == today:
                today_list.append(item)

        # 将非今日数据写入缓存
        try:
            _save_records_to_cache(tenant_id, all_list)
        except Exception:
            pass

        today_ok = True

        # 标记今天已成功拉取（今日数据拉到了，说明 T-1 也在其中了）
        if not _has_fetched_today(tenant_id):
            _mark_fetched_today(tenant_id)

    else:
        # 今日数据拉取失败，记录错误消息（从 result_today 中取）
        if hasattr(result_today, 'get_json'):
            j = result_today.get_json(silent=True) or {}
            today_err_msg = j.get('message', 'Friday 接口异常')
        else:
            today_err_msg = 'Friday 接口异常，今日数据不可用'

    # ── 历史数据（本地缓存 or 网络）─────────────────────────────────────────────
    # 如果今天已经拉取过 Friday，或者本次实时拉取成功，直接读本地缓存
    # 否则（今日首次 + 实时请求成功已处理；今日首次 + 失败走下面逻辑）
    history_list = _load_cached_records(tenant_id, exclude_today=True)

    if not today_ok and not history_list:
        # 既无今日数据，也无历史缓存，返回原始错误
        return result_today

    # ── 合并今日 + 历史 ────────────────────────────────────────────────────────
    merged = today_list + history_list

    resp_data = {
        'code': 0,
        'data': {'list': merged, 'total': len(merged)},
    }
    if not today_ok:
        resp_data['today_error'] = True
        resp_data['today_error_msg'] = today_err_msg or 'Friday 接口异常，今日数据不可用'
    if history_list and not _has_fetched_today(tenant_id):
        # 历史来自缓存但今日拉取成功，不算 from_cache
        pass
    if not today_ok and history_list:
        resp_data['from_cache'] = True
        resp_data['cache_tip'] = f'历史数据来自本地缓存；今日数据获取失败：{today_err_msg}'

    return jsonify(resp_data)


# ── 本地历史记录接口（无需 Friday，直接查 SQLite）：/api/credit/local ──────────

@credit_bp.route('/api/credit/local', methods=['GET', 'OPTIONS'])
def credit_local():
    """
    直接从本地 SQLite 返回历史消耗记录（不调 Friday）。
    用于前端按天汇总视图等不需要实时数据的场景。

    Query 参数：
      tenantId  - 可选；为空时查询所有租户的记录
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    tenant_id = request.args.get('tenantId', '').strip()

    if tenant_id:
        records = _load_cached_records(tenant_id, exclude_today=True)
    else:
        # tenantId 为空：查询全部租户的缓存记录
        conn = _get_cache_conn()
        try:
            today = str(_date.today())
            rows = conn.execute(
                "SELECT records_json FROM credit_records_cache "
                "WHERE rec_date < ? ORDER BY rec_date DESC",
                (today,)
            ).fetchall()
            records = []
            for row in rows:
                try:
                    records.extend(json.loads(row['records_json']))
                except Exception:
                    pass
        except Exception:
            records = []
        finally:
            conn.close()

    return jsonify({'code': 0, 'data': {'list': records, 'total': len(records)}})


# ── 每日消耗趋势（derived from records）：/api/credit/daily ──────────────────

@credit_bp.route('/api/credit/debug', methods=['GET', 'OPTIONS'])
def credit_debug():
    """调试端点：显示当前 cookie 存储状态和 SSO 连通性（不需要认证）"""
    if request.method == 'OPTIONS':
        return _options_resp()

    stored = _get_stored_cookie()
    result = {
        'has_stored_cookie': bool(stored),
        'stored_cookie_len': len(stored) if stored else 0,
        'stored_cookie_preview': (stored[:40] + '...') if stored and len(stored) > 40 else stored,
        'effective_cookie_source': 'stored' if stored else 'request_header',
    }

    # 尝试用存储的 cookie 做 SSO 验证
    if stored:
        try:
            headers = _build_headers(stored)
            r = requests.get(
                f'{FRIDAY_BASE}/sso/web/auth?clientId={FRIDAY_SSO_CLIENT}&accessEnv=product',
                headers=headers, timeout=10, allow_redirects=False,
            )
            result['sso_test_status'] = r.status_code
            if not _is_redirect(r.status_code):
                try:
                    data = r.json()
                    result['sso_test_code'] = data.get('status') or data.get('code')
                    if result['sso_test_code'] == 0:
                        result['sso_test_result'] = 'OK - cookie valid'
                    else:
                        result['sso_test_result'] = f'FAIL - upstream code {result["sso_test_code"]}'
                except Exception:
                    result['sso_test_result'] = f'HTTP {r.status_code}'
            else:
                result['sso_test_result'] = f'REDIRECT to login ({r.status_code}) - cookie expired'
        except Exception as e:
            result['sso_test_result'] = f'error: {e}'
    else:
        result['sso_test_result'] = 'skipped - no cookie stored'

    return jsonify({'code': 0, 'data': result})


@credit_bp.route('/api/credit/daily', methods=['GET', 'OPTIONS'])
def credit_daily():
    """
    每日消耗趋势。
    Friday 没有专门的 daily 接口，由消耗记录聚合而来。
    返回格式：{"code": 0, "data": [{"date": "2026-06-01", "used": 12.5}, ...]}
    """
    if request.method == 'OPTIONS':
        return _options_resp()

    cookie = _effective_cookie()
    tenant_id = request.args.get('tenantId', '').strip()
    token = request.headers.get('access-token', '').strip()

    if not tenant_id or not token:
        token, err = _get_access_token(cookie)
        if err:
            return err
        if not tenant_id:
            tenant_id, err = _get_tenant_id(cookie, token)
            if err:
                return err

    # 拉取最近 100 条记录做聚合
    headers = _build_headers(cookie, token)
    ok, result = _friday_get(
        '/cockpit/usage/user/records',
        headers,
        params={'pageNum': '1', 'pageSize': '100', 'tenantId': tenant_id},
    )
    if not ok:
        return result

    raw_data = result.get('data', {})
    if isinstance(raw_data, dict):
        records = raw_data.get('list') or raw_data.get('records') or raw_data.get('data') or []
    elif isinstance(raw_data, list):
        records = raw_data
    else:
        records = []

    # 按日期聚合消耗量
    daily: dict[str, float] = {}
    for item in records:
        if not isinstance(item, dict):
            continue
        date_val = (
            item.get('statDate') or item.get('stat_date') or
            item.get('date') or item.get('createTime') or ''
        )
        # 只取日期部分（前 10 位）
        date_str = str(date_val)[:10]
        if not date_str or date_str == 'None':
            continue
        amount = float(
            item.get('creditUsed') or item.get('credit_used') or
            item.get('used') or item.get('amount') or item.get('creditAmount') or 0
        )
        daily[date_str] = daily.get(date_str, 0.0) + amount

    # 按日期升序排列
    daily_list = sorted(
        [{'date': d, 'used': round(v, 4)} for d, v in daily.items()],
        key=lambda x: x['date'],
    )

    return jsonify({'code': 0, 'data': daily_list})
