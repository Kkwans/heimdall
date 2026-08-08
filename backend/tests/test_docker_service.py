import json
import subprocess

import pytest

from services.docker_service import (
    DockerControlError,
    DockerControlTimeout,
    DockerService,
)


def _completed(command, *, stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess(command, returncode, stdout=stdout, stderr=stderr)


class FakeRunner:
    def __init__(self, states=None):
        self.commands = []
        self.states = list(states or [])

    def __call__(self, command, **_kwargs):
        self.commands.append(command)
        if command[1] == "inspect" and "{{json .State}}" in command:
            state = self.states.pop(0) if self.states else {
                "Status": "running",
                "Running": True,
                "Health": {"Status": "healthy"},
            }
            return _completed(command, stdout=json.dumps(state))
        if command[1] == "inspect":
            return _completed(command, stdout="unless-stopped\n")
        return _completed(command)


def _service(runner, **kwargs):
    return DockerService(
        container_name="heimdall-refinement-proxy",
        proxy_host="proxy",
        runner=runner,
        http_probe=lambda url, timeout: url == "http://proxy:8888/api/proxy/status",
        sleep=lambda _seconds: None,
        **kwargs,
    )


def test_container_name_must_be_in_fixed_allowlist() -> None:
    with pytest.raises(DockerControlError, match="allowlist"):
        DockerService(container_name="user-supplied", proxy_host="proxy")


def test_start_uses_fixed_container_and_waits_for_http_readiness() -> None:
    runner = FakeRunner()

    result = _service(runner).control("start")

    assert result["running"] is True
    assert result["health"] == "healthy"
    assert result["ready"] is True
    assert runner.commands[0] == ["docker", "start", "heimdall-refinement-proxy"]
    assert runner.commands[1] == [
        "docker", "inspect", "--format", "{{json .State}}",
        "heimdall-refinement-proxy",
    ]


def test_stop_waits_until_container_is_exited_without_http_probe() -> None:
    runner = FakeRunner(states=[{
        "Status": "exited",
        "Running": False,
    }])
    probes = []
    service = DockerService(
        container_name="heimdall-refinement-proxy",
        proxy_host="proxy",
        runner=runner,
        http_probe=lambda url, timeout: probes.append((url, timeout)) or True,
        sleep=lambda _seconds: None,
    )

    result = service.control("stop")

    assert result["status"] == "exited"
    assert result["ready"] is False
    assert probes == []
    assert runner.commands[0] == [
        "docker", "stop", "--time", "15", "heimdall-refinement-proxy",
    ]


def test_restart_timeout_reports_last_container_state() -> None:
    runner = FakeRunner(states=[{
        "Status": "running",
        "Running": True,
        "Health": {"Status": "starting"},
    }])
    ticks = iter([0.0, 0.0, 0.0, 1.0])
    service = _service(
        runner,
        readiness_timeout=0.5,
        monotonic=lambda: next(ticks),
    )

    with pytest.raises(DockerControlTimeout, match="health=starting"):
        service.control("restart")

    assert runner.commands[0] == [
        "docker", "restart", "--time", "15", "heimdall-refinement-proxy",
    ]


def test_command_failure_is_bounded_and_does_not_retry_other_targets() -> None:
    commands = []

    def fail(command, **_kwargs):
        commands.append(command)
        return _completed(command, returncode=1, stderr="injected failure" * 100)

    with pytest.raises(DockerControlError) as error:
        _service(fail).control("start")

    assert len(str(error.value)) <= 500
    assert commands == [["docker", "start", "heimdall-refinement-proxy"]]


def test_restart_policy_uses_same_allowlisted_container() -> None:
    runner = FakeRunner()
    service = _service(runner)

    assert service.set_restart_policy(True) == "unless-stopped"

    assert runner.commands == [
        ["docker", "update", "--restart=unless-stopped", "heimdall-refinement-proxy"],
        [
            "docker", "inspect", "--format",
            "{{.HostConfig.RestartPolicy.Name}}",
            "heimdall-refinement-proxy",
        ],
    ]
