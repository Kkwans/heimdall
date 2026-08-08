"""Fail closed when the isolated Compose stack can reach production resources."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


EXPECTED_PROJECT = "heimdall-refinement"
EXPECTED_SERVICES = {"tests", "fake-upstream", "migrate", "proxy", "dashboard"}
EXPECTED_VOLUMES = {"heimdall-refinement-data", "heimdall-refinement-logs"}
EXPECTED_NETWORK = "heimdall-refinement-net"
EXPECTED_PORTS = {"proxy": "19888", "dashboard": "18889"}
FORBIDDEN_PRODUCTION_PORTS = {"9888", "8889"}


class IsolationError(RuntimeError):
    """Raised when the rendered Compose configuration is not isolated."""


def _render_compose(compose_file: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(compose_file),
            "--profile",
            "test",
            "config",
            "--format",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(result.stdout)


def validate(config: dict[str, Any]) -> None:
    if config.get("name") != EXPECTED_PROJECT:
        raise IsolationError(f"Compose project 必须为 {EXPECTED_PROJECT!r}")

    services = config.get("services", {})
    if set(services) != EXPECTED_SERVICES:
        raise IsolationError(f"隔离服务集合异常: {sorted(services)}")

    volume_names = {item.get("name") for item in config.get("volumes", {}).values()}
    if volume_names != EXPECTED_VOLUMES:
        raise IsolationError(f"隔离卷名称异常: {sorted(str(item) for item in volume_names)}")

    network_names = {item.get("name") for item in config.get("networks", {}).values()}
    if network_names != {EXPECTED_NETWORK}:
        raise IsolationError(f"隔离网络名称异常: {sorted(str(item) for item in network_names)}")

    for service_name, service in services.items():
        container_name = str(service.get("container_name", ""))
        image_name = str(service.get("image", ""))
        if not container_name.startswith("heimdall-refinement-"):
            raise IsolationError(f"{service_name} 使用了非隔离容器名: {container_name!r}")
        if not image_name.startswith("heimdall-refinement-"):
            raise IsolationError(f"{service_name} 使用了非隔离镜像: {image_name!r}")
        if service.get("privileged"):
            raise IsolationError(f"{service_name} 不允许 privileged")
        if service.get("network_mode") == "host":
            raise IsolationError(f"{service_name} 不允许运行在 host network")

        attached_networks = set(service.get("networks", {}))
        if attached_networks != {"refinement-net"}:
            raise IsolationError(f"{service_name} 网络连接异常: {sorted(attached_networks)}")

        for mount in service.get("volumes", []):
            if mount.get("type") == "bind":
                allowed_socket = (
                    service_name == "dashboard"
                    and mount.get("source") == "/var/run/docker.sock"
                    and mount.get("target") == "/var/run/docker.sock"
                    and mount.get("read_only") is True
                )
                if allowed_socket:
                    continue
                raise IsolationError(f"{service_name} 不允许该 bind mount: {mount}")
            if mount.get("type") != "volume":
                raise IsolationError(f"{service_name} 挂载类型异常: {mount}")
            source = mount.get("source")
            resolved = config.get("volumes", {}).get(source, {}).get("name")
            if resolved not in EXPECTED_VOLUMES:
                raise IsolationError(f"{service_name} 使用了非隔离卷: {resolved!r}")

        if service_name == "dashboard":
            environment = service.get("environment", {})
            if environment.get("HEIMDALL_PROXY_CONTAINER_NAME") != "heimdall-refinement-proxy":
                raise IsolationError("隔离 Dashboard 必须只控制 heimdall-refinement-proxy")

        published_ports = {str(item.get("published")) for item in service.get("ports", [])}
        if published_ports & FORBIDDEN_PRODUCTION_PORTS:
            raise IsolationError(f"{service_name} 占用了正式端口: {sorted(published_ports)}")
        expected_port = EXPECTED_PORTS.get(service_name)
        if expected_port and published_ports != {expected_port}:
            raise IsolationError(
                f"{service_name} 端口应为 {expected_port}，实际为 {sorted(published_ports)}"
            )
        if expected_port is None and published_ports:
            raise IsolationError(f"{service_name} 不应发布宿主机端口: {sorted(published_ports)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Heimdall 隔离 Compose 边界")
    parser.add_argument(
        "compose_file",
        nargs="?",
        default="docker-compose.isolated.yml",
        type=Path,
    )
    args = parser.parse_args()
    compose_file = args.compose_file.expanduser().resolve()
    validate(_render_compose(compose_file))
    print("isolated_compose=ok services=5 ports=19888,18889 production_data_mounts=0 docker_socket=dashboard-only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
