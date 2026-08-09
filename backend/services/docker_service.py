"""Bounded Docker control for the fixed Heimdall proxy container.

The Dashboard receives Docker socket access at runtime, so this module is
deliberately fail-closed: callers cannot supply a container name or arbitrary
Docker arguments through an HTTP request.
"""

from __future__ import annotations

import json
import shlex
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

    def inspect_container(self) -> dict:
        """Return the fixed container's immutable Docker inspection snapshot."""
        result = self._run(["inspect", self.container_name], timeout=5)
        try:
            payload = json.loads(result.stdout.strip())
        except (TypeError, ValueError) as exc:
            raise DockerControlError("无法解析 Proxy 容器配置") from exc
        if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
            raise DockerControlError("Proxy 容器配置响应无效")
        return payload[0]

    def external_port(self) -> int:
        """Read the active host binding for the fixed internal port 8888."""
        snapshot = self.inspect_container()
        bindings = (snapshot.get("HostConfig") or {}).get("PortBindings") or {}
        entries = bindings.get("8888/tcp") or []
        if not isinstance(entries, list) or len(entries) != 1:
            raise DockerControlError("Proxy 外部端口映射不唯一")
        try:
            port = int(entries[0].get("HostPort"))
        except (AttributeError, TypeError, ValueError) as exc:
            raise DockerControlError("无法识别 Proxy 外部端口") from exc
        if not 1 <= port <= 65535:
            raise DockerControlError("Proxy 外部端口无效")
        return port

    def _container_exists(self, name: str) -> bool:
        result = self._run(
            ["ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"],
            timeout=5,
        )
        return name in {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def _replacement_create_arguments(self, snapshot: dict, external_port: int) -> list[str]:
        """Build a fail-closed replacement command from an inspected Heimdall container."""
        if not 1024 <= external_port <= 65535:
            raise DockerControlError("代理端口范围为 1024-65535")

        config_data = snapshot.get("Config") or {}
        host_config = snapshot.get("HostConfig") or {}
        labels = config_data.get("Labels") or {}
        project = labels.get("com.docker.compose.project")
        service = labels.get("com.docker.compose.service")
        expected_project = (
            "heimdall-refinement"
            if self.container_name == "heimdall-refinement-proxy"
            else "heimdall"
        )
        if project != expected_project or service != "proxy":
            raise DockerControlError("Proxy 容器不属于预期 Compose 服务")

        image = config_data.get("Image")
        if not isinstance(image, str) or not image.startswith("heimdall-"):
            raise DockerControlError("Proxy 镜像不属于 Heimdall")

        networks = (snapshot.get("NetworkSettings") or {}).get("Networks") or {}
        expected_network = (
            "heimdall-refinement-net"
            if self.container_name == "heimdall-refinement-proxy"
            else "heimdall-net"
        )
        if set(networks) != {expected_network}:
            raise DockerControlError("Proxy 网络配置不符合固定部署约束")

        allowed_volumes = {
            "/data": (
                "heimdall-refinement-data"
                if self.container_name == "heimdall-refinement-proxy"
                else "heimdall-data"
            ),
            "/logs": (
                "heimdall-refinement-logs"
                if self.container_name == "heimdall-refinement-proxy"
                else "heimdall-logs"
            ),
        }
        mounts = snapshot.get("Mounts") or []
        mounted = {}
        for mount in mounts:
            destination = mount.get("Destination")
            if mount.get("Type") != "volume" or destination not in allowed_volumes:
                raise DockerControlError("Proxy 存在不允许自动复制的挂载")
            if mount.get("Name") != allowed_volumes[destination]:
                raise DockerControlError("Proxy 数据卷不符合固定部署约束")
            mounted[destination] = mount.get("Name")
        if mounted != allowed_volumes:
            raise DockerControlError("Proxy 数据卷不完整")

        restart_policy = (host_config.get("RestartPolicy") or {}).get("Name") or "no"
        if restart_policy not in {"no", "always", "unless-stopped", "on-failure"}:
            raise DockerControlError("Proxy restart policy 不受支持")

        arguments = [
            "create",
            "--name", self.container_name,
            "--restart", restart_policy,
            "--network", expected_network,
            "--network-alias", "proxy",
            "--publish", f"{external_port}:8888",
        ]
        for destination, volume_name in allowed_volumes.items():
            arguments.extend(["--volume", f"{volume_name}:{destination}:rw"])

        runtime_env = {}
        for item in config_data.get("Env") or []:
            if not isinstance(item, str) or "=" not in item:
                continue
            key, value = item.split("=", 1)
            if key.startswith("HEIMDALL_") or key == "TZ":
                runtime_env[key] = value
        runtime_env["HEIMDALL_PROXY_EXTERNAL_PORT"] = str(external_port)
        for key in sorted(runtime_env):
            arguments.extend(["--env", f"{key}={runtime_env[key]}"])
        for key in sorted(labels):
            value = labels[key]
            if isinstance(value, str):
                arguments.extend(["--label", f"{key}={value}"])

        healthcheck = config_data.get("Healthcheck") or {}
        health_test = healthcheck.get("Test") or []
        if health_test:
            if (
                not isinstance(health_test, list)
                or not all(isinstance(item, str) for item in health_test)
                or health_test[0] not in {"CMD", "CMD-SHELL"}
            ):
                raise DockerControlError("Proxy healthcheck 配置不受支持")
            if health_test[0] == "CMD":
                health_command = shlex.join(health_test[1:])
            elif len(health_test) == 2:
                health_command = health_test[1]
            else:
                raise DockerControlError("Proxy healthcheck shell 配置无效")
            arguments.extend(["--health-cmd", health_command])
            duration_flags = {
                "Interval": "--health-interval",
                "Timeout": "--health-timeout",
                "StartPeriod": "--health-start-period",
            }
            for field, flag in duration_flags.items():
                value = healthcheck.get(field)
                if isinstance(value, int) and value > 0:
                    arguments.extend([flag, f"{value}ns"])
            retries = healthcheck.get("Retries")
            if isinstance(retries, int) and retries > 0:
                arguments.extend(["--health-retries", str(retries)])

        arguments.append(image)
        command = config_data.get("Cmd")
        if isinstance(command, list) and all(isinstance(item, str) for item in command):
            arguments.extend(command)
        return arguments

    def reconfigure_external_port(self, external_port: int) -> dict:
        """Recreate the fixed Proxy container with rollback on any readiness failure."""
        requested_port = int(external_port)
        current_port = self.external_port()
        if requested_port == current_port:
            state = self.control("restart")
            state.update({"external_port": current_port, "port_changed": False})
            return state

        snapshot = self.inspect_container()
        create_arguments = self._replacement_create_arguments(snapshot, requested_port)
        backup_name = f"{self.container_name}-port-backup"
        if self._container_exists(backup_name):
            raise DockerControlError("检测到未清理的端口切换备份容器，请先人工检查")

        started_at = self._monotonic()
        replacement_created = False
        backup_renamed = False
        try:
            self._run(["stop", "--time", "15", self.container_name])
            self._run(["rename", self.container_name, backup_name], timeout=10)
            backup_renamed = True
            self._run(create_arguments)
            replacement_created = True
            self._run(["start", self.container_name])
            state = self._wait_for_state("restart")
        except (DockerControlError, DockerControlTimeout) as exc:
            rollback_errors = []
            if replacement_created and self._container_exists(self.container_name):
                try:
                    self._run(["rm", "--force", self.container_name], timeout=15)
                except DockerControlError as rollback_exc:
                    rollback_errors.append(str(rollback_exc))
            if backup_renamed:
                try:
                    self._run(["rename", backup_name, self.container_name], timeout=10)
                    self._run(["start", self.container_name])
                    self._wait_for_state("restart")
                except (DockerControlError, DockerControlTimeout) as rollback_exc:
                    rollback_errors.append(str(rollback_exc))
            if rollback_errors:
                raise DockerControlError(
                    f"代理端口切换失败且自动恢复未完成：{'; '.join(rollback_errors)}"
                ) from exc
            raise DockerControlError(f"代理端口切换失败，已恢复原端口：{exc}") from exc

        cleanup_warning = None
        try:
            self._run(["rm", backup_name], timeout=15)
        except DockerControlError as exc:
            cleanup_warning = f"旧容器备份未自动清理：{exc}"
        state.update({
            "external_port": requested_port,
            "previous_external_port": current_port,
            "port_changed": True,
            "cleanup_warning": cleanup_warning,
            "elapsed_ms": max(0, int((self._monotonic() - started_at) * 1000)),
        })
        return state

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
