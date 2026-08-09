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


def _refinement_snapshot(port=19888):
    return {
        "Config": {
            "Image": "heimdall-refinement-proxy:test",
            "Cmd": ["python", "proxy.py", "--proxy"],
            "Env": [
                "HEIMDALL_DATA_DIR=/data",
                "HEIMDALL_LOG_DIR=/logs",
                f"HEIMDALL_PROXY_EXTERNAL_PORT={port}",
                "TZ=Asia/Shanghai",
                "PATH=/usr/local/bin",
            ],
            "Labels": {
                "com.docker.compose.project": "heimdall-refinement",
                "com.docker.compose.service": "proxy",
            },
            "Healthcheck": {
                "Test": ["CMD", "python", "-c", "assert True"],
                "Interval": 5000000000,
                "Timeout": 3000000000,
                "StartPeriod": 5000000000,
                "Retries": 10,
            },
        },
        "HostConfig": {
            "PortBindings": {"8888/tcp": [{"HostIp": "", "HostPort": str(port)}]},
            "RestartPolicy": {"Name": "unless-stopped"},
        },
        "NetworkSettings": {
            "Networks": {"heimdall-refinement-net": {"Aliases": ["proxy"]}},
        },
        "Mounts": [
            {"Type": "volume", "Name": "heimdall-refinement-data", "Destination": "/data"},
            {"Type": "volume", "Name": "heimdall-refinement-logs", "Destination": "/logs"},
        ],
    }


class ReconfigureRunner:
    def __init__(self, *, fail_first_replacement_start=False):
        self.commands = []
        self.names = {"heimdall-refinement-proxy"}
        self.original_port = 19888
        self.active_port = 19888
        self.fail_first_replacement_start = fail_first_replacement_start
        self.replacement_start_attempted = False

    def __call__(self, command, **_kwargs):
        self.commands.append(command)
        action = command[1]
        if action == "inspect" and "{{json .State}}" in command:
            return _completed(command, stdout=json.dumps({
                "Status": "running",
                "Running": True,
                "Health": {"Status": "healthy"},
            }))
        if action == "inspect":
            return _completed(command, stdout=json.dumps([_refinement_snapshot(self.active_port)]))
        if action == "ps":
            expected = command[command.index("--filter") + 1].removeprefix("name=^/").removesuffix("$")
            return _completed(command, stdout=f"{expected}\n" if expected in self.names else "")
        if action == "rename":
            old_name, new_name = command[2], command[3]
            self.names.remove(old_name)
            self.names.add(new_name)
            if old_name == "heimdall-refinement-proxy-port-backup":
                self.active_port = self.original_port
            return _completed(command)
        if action == "create":
            self.names.add("heimdall-refinement-proxy")
            publish = command[command.index("--publish") + 1]
            self.active_port = int(publish.split(":", 1)[0])
            return _completed(command)
        if action == "start" and command[2] == "heimdall-refinement-proxy":
            if self.fail_first_replacement_start and not self.replacement_start_attempted:
                self.replacement_start_attempted = True
                return _completed(command, returncode=1, stderr="injected start failure")
            return _completed(command)
        if action == "rm":
            name = command[-1]
            self.names.discard(name)
            return _completed(command)
        return _completed(command)


def test_external_port_reads_the_single_active_binding() -> None:
    runner = ReconfigureRunner()
    assert _service(runner).external_port() == 19888
    assert runner.commands == [["docker", "inspect", "heimdall-refinement-proxy"]]


def test_port_reconfiguration_reuses_fixed_resources_and_waits_for_readiness() -> None:
    runner = ReconfigureRunner()
    result = _service(runner).reconfigure_external_port(29999)

    assert result["port_changed"] is True
    assert result["previous_external_port"] == 19888
    assert result["external_port"] == 29999
    create = next(command for command in runner.commands if command[1] == "create")
    assert create[create.index("--publish") + 1] == "29999:8888"
    assert "heimdall-refinement-data:/data:rw" in create
    assert "heimdall-refinement-logs:/logs:rw" in create
    assert "HEIMDALL_PROXY_EXTERNAL_PORT=29999" in create
    assert create[create.index("--health-interval") + 1] == "5000000000ns"
    assert create[create.index("--health-retries") + 1] == "10"
    assert runner.names == {"heimdall-refinement-proxy"}


def test_port_reconfiguration_restores_original_container_when_start_fails() -> None:
    runner = ReconfigureRunner(fail_first_replacement_start=True)

    with pytest.raises(DockerControlError, match="已恢复原端口"):
        _service(runner).reconfigure_external_port(29999)

    assert runner.names == {"heimdall-refinement-proxy"}
    assert _service(runner).external_port() == 19888
    assert [command[1] for command in runner.commands].count("rename") == 2
    assert any(command[1:3] == ["rm", "--force"] for command in runner.commands)
