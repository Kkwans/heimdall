from __future__ import annotations

import proxy


def test_proxy_only_exposes_protocol_and_health_routes() -> None:
    routes = {
        rule.rule
        for rule in proxy.app.url_map.iter_rules()
        if rule.rule != "/static/<path:filename>"
    }

    assert "/healthz" in routes
    assert "/anthropic/v1/messages" in routes
    assert "/v1/chat/completions" in routes
    assert "/v1/responses" in routes
    assert "/api/keys" not in routes
    assert "/api/proxy/status" not in routes
    assert "/api/vendor-presets" not in routes


def test_proxy_management_routes_are_not_reachable() -> None:
    client = proxy.app.test_client()

    assert client.get("/healthz").status_code == 200
    assert client.get("/api/keys").status_code == 404
    assert client.get("/api/proxy/status").status_code == 404


def test_dashboard_factory_keeps_management_routes() -> None:
    dashboard = proxy._create_dashboard_app()
    routes = {
        rule.rule
        for rule in dashboard.url_map.iter_rules()
        if rule.rule != "/static/<path:filename>"
    }

    assert "/api/keys" in routes
    assert "/api/proxy/status" in routes
    assert "/api/vendor-presets" in routes
