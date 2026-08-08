"""One-shot request recording shared by every proxy protocol path."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, Optional

import db
from services.usage_normalizer import normalize_usage


CST = timezone(timedelta(hours=8))


def _json_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


class RequestRecorder:
    """Build and persist exactly one final record for one client request."""

    def __init__(
        self,
        request_data: Dict[str, Any],
        *,
        protocol: str,
        endpoint: str,
        stream: bool,
        client_ip: str,
        started_at: Optional[float] = None,
        log_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.request_data = dict(request_data or {})
        self.requested_model = str(self.request_data.get("model") or "unknown")
        self.protocol = protocol
        self.endpoint = endpoint
        self.stream = bool(stream)
        self.client_ip = client_ip
        self.started_at = started_at if started_at is not None else time.time()
        self.client_api_key_id: Optional[int] = None
        self.stat_eligible = False
        self.route = None
        self.log_callback = log_callback
        self._lock = threading.Lock()
        self._finalized = False

    @property
    def finalized(self) -> bool:
        with self._lock:
            return self._finalized

    def authenticate(self, client_api_key_id: int) -> None:
        self.client_api_key_id = client_api_key_id
        self.stat_eligible = True

    def bind_route(self, route: Any) -> None:
        self.route = route

    def finalize(
        self,
        status_code: int,
        *,
        usage: Optional[Dict[str, Any]] = None,
        ttfb_ms: int = 0,
        trace_id: str = "",
        error_type: Optional[str] = None,
        response_body: Any = None,
        attempts: Optional[Iterable[Dict[str, Any]]] = None,
        provider_api_key_id: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._finalized:
                return None
            self._finalized = True

        now = datetime.now(CST)
        normalized = normalize_usage(usage or {})
        route = self.route
        model = (
            getattr(route, "model_name", None)
            or (
                self.requested_model.split("/", 1)[-1]
                if "/" in self.requested_model
                else self.requested_model
            )
            or "unknown"
        )
        attempts_list = list(attempts or [])
        latency_ms = max(int((time.time() - self.started_at) * 1000), 0)
        messages = self.request_data.get("messages", [])
        messages_count = len(messages) if isinstance(messages, list) else 0
        provider_id = getattr(route, "provider_id", None)
        provider = getattr(route, "provider_key", None)

        record = {
            "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
            "date": now.strftime("%Y-%m-%d"),
            "model": model,
            "original_model": self.requested_model,
            "stream": 1 if self.stream else 0,
            "messages_count": messages_count,
            **normalized,
            "latency_ms": latency_ms,
            "ttfb_ms": max(int(ttfb_ms or 0), 0),
            "status_code": int(status_code),
            "success": 1 if int(status_code) < 400 and not error_type else 0,
            "error_type": error_type,
            "trace_id": trace_id,
            "client_ip": self.client_ip,
            "request_body": _json_text(self.request_data),
            "response_body": _json_text(response_body),
            "provider": provider,
            "api_key_id": self.client_api_key_id,
            "provider_id": provider_id,
            "provider_api_key_id": provider_api_key_id,
            "client_api_key_id": self.client_api_key_id,
            "protocol": self.protocol,
            "endpoint": self.endpoint,
            "route_attempts": json.dumps(attempts_list, ensure_ascii=False),
            "stat_eligible": 1 if self.stat_eligible else 0,
        }
        db.insert_request(record)
        if self.log_callback is not None:
            self.log_callback(record)
        return record
