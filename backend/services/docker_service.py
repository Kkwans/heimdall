"""Bounded Docker control for the fixed Heimdall proxy container.

The Dashboard receives Docker socket access at runtime, so this module is
deliberately fail-closed: callers cannot supply a container name or arbitrary
Docker arguments through an HTTP request.
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.request
from dataclasses import asdict, dataclass
from typing import Callable, Optional


ALLOWED_PROXY_CONTAINERS = frozenset({
    "heimdall-proxy",
    "heimdall-refinement-proxy",
})


class DockerControlError(RuntimeError):
    """Raised when a Docker command or container inspection fails."""


class DockerControlTimeout(DockerControlError):
    """Raised when the requested final state is not reached in time."""


@dataclass(frozen=True)
class ContainerState:
    status: str
    running: bool
    health: Optional[str]


Runner = Callable[..., subprocess.CompletedProcess]
HttpProbe = Callable[[str, float], bool]


def _default_http_probe(url: str, timeout: float) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def _safe_command_error(result: subprocess.CompletedProcess) -> str:
    message = (result.stderr or result.stdout or "Docker 命令执行失败").strip()
    return message[:500]


class DockerService:
    """Control exactly one allowlisted Heimdall proxy container."""

    def __init__(
        self,
        *,
        container_name: str,
        proxy_host: str,
        proxy_port: int = 8888,
        command_timeout: float = 30,
        readiness_timeout: float = 30,
        poll_interval: float = 0.5,
        runner: Runner = subprocess.run,
        http_probe: HttpProbe = _default_http_probe,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if container_name not in ALLOWED_PROXY_CONTAINERS:
            raise DockerControlError("Proxy 容器不在固定 allowlist 中")
        self.container_name = container_name
        self.proxy_host = proxy_host
        self.proxy_port = int(proxy_port)
        self.command_timeout = float(command_timeout)
        self.readiness_timeout = float(readiness_timeout)
        self.poll_interval = float(poll_interval)
        self._runner = runner
        self._http_probe = http_probe
        self._sleep = sleep
        self._monotonic = monotonic

    @property
    def readiness_url(self) -> str:
        return f"http://{self.proxy_host}:{self.proxy_port}/api/proxy/status"

    def _run(self, arguments: list[str], *, timeout: Optional[float] = None):
        command = ["docker", *arguments]
        try:
            result = self._runner(
                command,
                capture_output=True,
                text=True,
                timeout=timeout or self.command_timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise DockerControlTimeout("Docker 命令执行超时") from exc
        except OSError as exc:
            raise DockerControlError("Docker CLI 不可用") from exc
        if result.returncode != 0:
            raise DockerControlError(_safe_command_error(result))
        return result

    def inspect_state(self) -> ContainerState:
        result = self._run(
            ["inspect", "--format", "{{json .State}}", self.container_name],
            timeout=5,
        )
        try:
            state = json.loads(result.stdout.strip())
        except (TypeError, ValueError) as exc:
            raise DockerControlError("无法解析 Proxy 容器状态") from exc
        health = state.get("Health") or {}
        return ContainerState(
            status=str(state.get("Status") or "unknown"),
            running=bool(state.get("Running")),
            health=str(health.get("Status")) if health.get("Status") else None,
        )

    def restart_policy(self) -> str:
        result = self._run(
            [
                "inspect",
                "--format",
                "{{.HostConfig.RestartPolicy.Name}}",
                self.container_name,
            ],
            timeout=5,
        )
        return result.stdout.strip()

    def set_restart_policy(self, enabled: bool) -> str:
        policy = "unless-stopped" if enabled else "no"
        self._run(["update", f"--restart={policy}", self.container_name], timeout=10)
        actual = self.restart_policy()
        if actual != policy:
            raise DockerControlError("Docker restart policy 未达到预期状态")
        return actual

    def get_status(self) -> dict:
        state = self.inspect_state()
        ready = bool(
            state.running
            and state.health in (None, "healthy")
            and self._http_probe(self.readiness_url, 2)
        )
        return {
            **asdict(state),
            "ready": ready,
            "container_name": self.container_name,
        }

    def _wait_for_state(self, action: str) -> dict:
        deadline = self._monotonic() + self.readiness_timeout
        last_state = ContainerState(status="unknown", running=False, health=None)
        last_ready = False

        while self._monotonic() <= deadline:
            last_state = self.inspect_state()
            if action == "stop":
                if not last_state.running and last_state.status in {
                    "created", "exited", "dead",
                }:
                    return {
                        **asdict(last_state),
                        "ready": False,
                        "container_name": self.container_name,
                    }
            else:
                health_ready = last_state.health in (None, "healthy")
                last_ready = bool(
                    last_state.running
                    and health_ready
                    and self._http_probe(self.readiness_url, 2)
                )
                if last_ready:
                    return {
                        **asdict(last_state),
                        "ready": True,
                        "container_name": self.container_name,
                    }
            self._sleep(self.poll_interval)

        state_text = f"status={last_state.status}, health={last_state.health or 'none'}"
        raise DockerControlTimeout(f"Proxy 未在规定时间内达到预期状态（{state_text}）")

    def control(self, action: str) -> dict:
        commands = {
            "start": ["start", self.container_name],
            "stop": ["stop", "--time", "15", self.container_name],
            "restart": ["restart", "--time", "15", self.container_name],
        }
        if action not in commands:
            raise DockerControlError("不支持的 Proxy 控制动作")
        started_at = self._monotonic()
        self._run(commands[action])
        state = self._wait_for_state(action)
        state.update({
            "action": action,
            "elapsed_ms": max(0, int((self._monotonic() - started_at) * 1000)),
        })
        return state
