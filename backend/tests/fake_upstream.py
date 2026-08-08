"""Deterministic HTTP upstream used only by the isolated Compose stack."""

from __future__ import annotations

import json
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = "0.0.0.0"
PORT = 8090


class FakeUpstreamHandler(BaseHTTPRequestHandler):
    server_version = "HeimdallFakeUpstream/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[fake-upstream] {self.address_string()} {format_string % args}", flush=True)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self, events: list) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event in events:
            if event == "[DONE]":
                line = b"data: [DONE]\n\n"
            else:
                line = (
                    "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                ).encode("utf-8")
            self.wfile.write(line)
            self.wfile.flush()

    def _send_interrupted_sse(self, event: dict) -> None:
        body = ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode(
            "utf-8"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body) + 1024))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            request_data = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            request_data = {}

        scenario = self.headers.get("X-Heimdall-Test-Scenario", "success")
        provider_secret = self.headers.get("Authorization", "").removeprefix("Bearer ")
        provider_secret = provider_secret or self.headers.get("x-api-key", "")
        for candidate in ("timeout", "400", "429", "500", "disconnect"):
            if candidate in provider_secret:
                scenario = candidate
        if scenario == "timeout":
            time.sleep(5)
        if scenario in {"400", "429", "500"}:
            status = int(scenario)
            self._send_json(status, {"error": {"type": "fixture_error", "status": status}})
            return

        if request_data.get("stream"):
            if self.path.endswith("/messages"):
                events = [
                    {
                        "type": "message_start",
                        "message": {"usage": {"input_tokens": 4, "output_tokens": 0}},
                    },
                    {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "fixture response"},
                    },
                    {"type": "message_delta", "usage": {"output_tokens": 2}},
                ]
            elif self.path.endswith("/responses"):
                events = [
                    {"type": "response.output_text.delta", "delta": "fixture response"},
                    {
                        "type": "response.completed",
                        "response": {
                            "usage": {"input_tokens": 4, "output_tokens": 2}
                        },
                    },
                ]
            else:
                events = [
                    {"choices": [{"delta": {"content": "fixture response"}}]},
                    {
                        "choices": [],
                        "usage": {
                            "prompt_tokens": 4,
                            "completion_tokens": 2,
                            "total_tokens": 6,
                        },
                    },
                    "[DONE]",
                ]
            if scenario == "disconnect":
                self._send_interrupted_sse(events[0])
            else:
                self._send_sse(events)
            return

        if self.path.endswith("/messages"):
            self._send_json(
                200,
                {
                    "id": "fixture-message",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "fixture response"}],
                    "usage": {"input_tokens": 4, "output_tokens": 2},
                },
            )
            return
        if self.path.endswith("/responses"):
            self._send_json(
                200,
                {
                    "id": "fixture-response",
                    "object": "response",
                    "output": [],
                    "usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
                },
            )
            return
        self._send_json(
            200,
            {
                "id": "fixture-chat",
                "object": "chat.completion",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "fixture response"}}
                ],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
            },
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), FakeUpstreamHandler)
    print(f"[fake-upstream] listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
