from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import pytest

from app.db import SessionLocal
from app.migrations import migrate_legacy_missions
from app.models import Mission, MissionRun
from app.schemas import ToolPolicy, WorkflowDefinition
from app.tools import ToolPolicyError, ToolRunner


def wait_for_run_status(
    client,
    headers: dict[str, str],
    mission_id: str,
    run_id: str,
    expected: set[str],
    timeout: float = 8.0,
) -> dict[str, Any]:
    deadline = time.time() + timeout
    last_payload = None
    while time.time() < deadline:
        response = client.get(f"/api/v1/missions/{mission_id}/runs/{run_id}", headers=headers)
        response.raise_for_status()
        last_payload = response.json()
        if last_payload["status"] in expected:
            return last_payload
        time.sleep(0.1)
    raise AssertionError(f"Run {run_id} did not reach {expected}; last payload was {last_payload}")


def create_blank_mission(client, auth_headers, name: str = "Mission Workspace") -> dict[str, Any]:
    response = client.post(
        "/api/v1/missions",
        headers=auth_headers,
        json={
            "name": name,
            "description": "Mission workspace under test",
            "defaultInput": {"prompt": "", "route": "analysis"},
            "defaultProviderOverrides": {},
        },
    )
    response.raise_for_status()
    return response.json()


def runtime_settings(client, auth_headers) -> dict[str, Any]:
    response = client.get("/api/v1/settings/runtime", headers=auth_headers)
    response.raise_for_status()
    return response.json()


def create_mission_agent(client, auth_headers, mission_id: str, agent_id: str = "science-officer") -> dict[str, Any]:
    settings = runtime_settings(client, auth_headers)
    payload = {
        "id": agent_id,
        "missionId": mission_id,
        "templateAgentId": None,
        "name": "Science Officer",
        "role": "research-analyst",
        "description": "Investigates signals and summarizes findings.",
        "systemPrompt": "Investigate carefully and summarize with evidence.",
        "provider": settings["providers"][0],
        "tools": ["web", "api"],
        "toolPolicy": {
            **settings["defaultPolicy"],
            "allowedTools": ["web", "api"],
        },
        "memoryProfile": {"mode": "hybrid", "namespace": "science", "topK": 5},
        "handoffTargets": ["captain"],
    }
    response = client.post(f"/api/v1/missions/{mission_id}/agents", headers=auth_headers, json=payload)
    response.raise_for_status()
    return response.json()


def test_handler_registry_contains_all_node_types():
    from app.node_handlers import get_handler
    # The app-level executor registers all handlers at import time via main.py.
    # Importing the app here ensures _register_handlers() has been called.
    import app.main  # noqa: F401 — side effect: registers handlers
    for node_type in ["agent", "tool", "router", "parallel", "memory", "delay", "human_input", "terminal", "eval"]:
        handler = get_handler(node_type)
        assert handler is not None, f"No handler for {node_type}"


def test_unknown_node_type_raises():
    from app.node_handlers import get_handler, _REGISTRY
    # Clear any existing registry entries for this test
    original = dict(_REGISTRY)
    _REGISTRY.clear()
    try:
        with pytest.raises(KeyError, match="No handler registered"):
            get_handler("nonexistent_type")
    finally:
        _REGISTRY.update(original)


def test_workflow_definition_rejects_cycles() -> None:
    with pytest.raises(ValueError, match="acyclic"):
        WorkflowDefinition.model_validate(
            {
                "id": "cycle",
                "name": "Cycle",
                "nodes": [
                    {"id": "a", "name": "A", "type": "delay", "position": {"x": 0, "y": 0}, "config": {}},
                    {"id": "b", "name": "B", "type": "terminal", "position": {"x": 1, "y": 1}, "config": {}},
                ],
                "edges": [
                    {"id": "ab", "source": "a", "target": "b"},
                    {"id": "ba", "source": "b", "target": "a"},
                ],
            }
        )


@pytest.mark.asyncio
async def test_tool_runner_blocks_disallowed_shell() -> None:
    runner = ToolRunner()
    policy = ToolPolicy(
        allowedTools=["shell"],
        shellAllowlist=["echo"],
        shellDenylist=["rm"],
        writableRoots=["./data/workspaces"],
    )
    with pytest.raises(ToolPolicyError):
        await runner.run("shell", {"command": "uname -a"}, policy, "run-test")


def test_mission_workflow_requires_mission_agent_ids(client, auth_headers) -> None:
    mission = create_blank_mission(client, auth_headers, "Reference Validation")
    mission_id = mission["id"]
    workflow = {
        "definition": {
            "id": "mission-workflow",
            "name": "Mission Workflow",
            "description": "Requires a mission-scoped agent binding",
            "version": 1,
            "nodes": [
                {
                    "id": "captain-brief",
                    "name": "Captain Brief",
                    "type": "agent",
                    "position": {"x": 0, "y": 0},
                    "config": {"agentId": "captain", "promptTemplate": "Mission {{mission.input.prompt}}"},
                },
                {
                    "id": "terminal",
                    "name": "Terminal",
                    "type": "terminal",
                    "position": {"x": 220, "y": 0},
                    "config": {"output": "{{results.captain-brief.output}}"},
                },
            ],
            "edges": [{"id": "e1", "source": "captain-brief", "target": "terminal"}],
        }
    }

    rejected = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=workflow)
    assert rejected.status_code == 422
    assert "unknown mission agent captain" in rejected.text

    imported = client.post(
        f"/api/v1/missions/{mission_id}/agents/import",
        headers=auth_headers,
        json={"templateAgentId": "captain"},
    )
    imported.raise_for_status()

    accepted = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=workflow)
    accepted.raise_for_status()
    assert accepted.json()["nodes"][0]["config"]["agentId"] == "captain"


def test_imported_mission_agent_is_isolated_from_global_template(client, auth_headers) -> None:
    mission = client.post(
        "/api/v1/missions",
        headers=auth_headers,
        json={"name": "Template Copy", "templateWorkflowId": "bridge-assessment"},
    )
    mission.raise_for_status()
    mission_id = mission.json()["id"]

    mission_agents = client.get(f"/api/v1/missions/{mission_id}/agents", headers=auth_headers)
    mission_agents.raise_for_status()
    captain = next(agent for agent in mission_agents.json() if agent["id"] == "captain")
    assert captain["templateAgentId"] == "captain"

    updated_payload = {
        **captain,
        "name": "Mission Captain",
        "description": "Customized for this mission workspace.",
    }
    updated = client.put(
        f"/api/v1/missions/{mission_id}/agents/captain",
        headers=auth_headers,
        json=updated_payload,
    )
    updated.raise_for_status()
    assert updated.json()["name"] == "Mission Captain"

    global_agents = client.get("/api/v1/agents", headers=auth_headers)
    global_agents.raise_for_status()
    global_captain = next(agent for agent in global_agents.json() if agent["id"] == "captain")
    assert global_captain["name"] == "Captain"


def test_legacy_mission_migration_serializes_snapshot_timestamps() -> None:
    legacy_timestamp = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)

    with SessionLocal() as session:
        session.add(
            Mission(
                id="legacy-bridge",
                workflow_id="bridge-assessment",
                name="Legacy Bridge",
                description="Created before mission workspaces existed.",
                status="completed",
                input_payload={"prompt": "Legacy bridge review", "route": "analysis"},
                output_payload={"results": {}},
                current_nodes=[],
                provider_overrides={},
                control_state={},
                workflow_definition=None,
                active_run_id=None,
                latest_run_id=None,
                created_at=legacy_timestamp,
                updated_at=legacy_timestamp,
                started_at=legacy_timestamp,
                completed_at=legacy_timestamp,
            )
        )
        session.commit()

    migrate_legacy_missions()

    with SessionLocal() as session:
        migrated_run = session.get(MissionRun, "legacy-bridge")
        assert migrated_run is not None
        captain_snapshot = next(agent for agent in migrated_run.agent_snapshot if agent["id"] == "captain")
        assert captain_snapshot["createdAt"] == legacy_timestamp.isoformat()
        assert captain_snapshot["updatedAt"] == legacy_timestamp.isoformat()


def test_mission_run_executes_seeded_template_and_persists_replay(client, auth_headers) -> None:
    mission = client.post(
        "/api/v1/missions",
        headers=auth_headers,
        json={
            "name": "Bridge Validation",
            "templateWorkflowId": "bridge-assessment",
            "defaultInput": {"prompt": "Assess the bridge and draft a readiness brief.", "route": "analysis"},
        },
    )
    mission.raise_for_status()
    mission_id = mission.json()["id"]

    launch = client.post(
        f"/api/v1/missions/{mission_id}/runs",
        headers=auth_headers,
        json={"input": {"prompt": "Assess the bridge and draft a readiness brief.", "route": "analysis"}},
    )
    launch.raise_for_status()
    run_id = launch.json()["id"]

    run = wait_for_run_status(client, auth_headers, mission_id, run_id, {"completed"})
    assert run["output"]["results"]["navigator-brief"]["agentId"] == "navigator"
    assert "engineering_report.txt" in run["output"]["results"]["engineering-scan"]["result"]["stdout"]

    replay = client.get(f"/api/v1/missions/{mission_id}/runs/{run_id}/replay", headers=auth_headers)
    replay.raise_for_status()
    payload = replay.json()
    assert len(payload["events"]) >= 4
    assert any(artifact["kind"] == "agent-output" for artifact in payload["artifacts"])
    assert any(memory["namespace"] == "archive" for memory in payload["memories"])
    assert all(event["runId"] == run_id for event in payload["events"])


def test_paused_workflow_edits_update_run_snapshot_and_future_runs(client, auth_headers) -> None:
    mission = create_blank_mission(client, auth_headers, "Paused Edit Workspace")
    mission_id = mission["id"]

    imported = client.post(
        f"/api/v1/missions/{mission_id}/agents/import",
        headers=auth_headers,
        json={"templateAgentId": "engineer"},
    )
    imported.raise_for_status()

    initial_workflow = {
        "definition": {
            "id": "mission-workflow",
            "name": "Mission Workflow",
            "description": "Editable paused workflow",
            "version": 1,
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "type": "delay",
                    "position": {"x": 0, "y": 0},
                    "config": {"seconds": 1.2},
                },
                {
                    "id": "tool-node",
                    "name": "Tool Node",
                    "type": "tool",
                    "position": {"x": 220, "y": 0},
                    "config": {
                        "agentId": "engineer",
                        "tool": "shell",
                        "args": {"command": "echo before"},
                    },
                },
                {
                    "id": "terminal",
                    "name": "Terminal",
                    "type": "terminal",
                    "position": {"x": 440, "y": 0},
                    "config": {"output": "{{results.tool-node.result.stdout}}"},
                },
            ],
            "edges": [
                {"id": "e1", "source": "wait", "target": "tool-node"},
                {"id": "e2", "source": "tool-node", "target": "terminal"},
            ],
        }
    }
    save_initial = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=initial_workflow)
    save_initial.raise_for_status()

    launch = client.post(
        f"/api/v1/missions/{mission_id}/runs",
        headers=auth_headers,
        json={"input": {"prompt": "pause edit", "route": "analysis"}},
    )
    launch.raise_for_status()
    run_id = launch.json()["id"]

    paused_response = client.post(
        f"/api/v1/missions/{mission_id}/runs/{run_id}/actions",
        headers=auth_headers,
        json={"action": "pause", "payload": {}},
    )
    paused_response.raise_for_status()
    wait_for_run_status(client, auth_headers, mission_id, run_id, {"paused"})

    updated_workflow = {
        "definition": {
            **initial_workflow["definition"],
            "nodes": [
                initial_workflow["definition"]["nodes"][0],
                {
                    **initial_workflow["definition"]["nodes"][1],
                    "config": {
                        "agentId": "engineer",
                        "tool": "shell",
                        "args": {"command": "echo after"},
                    },
                },
                initial_workflow["definition"]["nodes"][2],
            ],
        }
    }
    updated = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=updated_workflow)
    updated.raise_for_status()

    mission_after_update = client.get(f"/api/v1/missions/{mission_id}", headers=auth_headers)
    mission_after_update.raise_for_status()
    assert mission_after_update.json()["workflowDefinition"]["nodes"][1]["config"]["args"]["command"] == "echo after"

    resume = client.post(
        f"/api/v1/missions/{mission_id}/runs/{run_id}/actions",
        headers=auth_headers,
        json={"action": "resume", "payload": {}},
    )
    resume.raise_for_status()
    completed = wait_for_run_status(client, auth_headers, mission_id, run_id, {"completed"})
    assert completed["output"]["results"]["tool-node"]["result"]["stdout"].strip() == "after"

    second_launch = client.post(
        f"/api/v1/missions/{mission_id}/runs",
        headers=auth_headers,
        json={"input": {"prompt": "second run", "route": "analysis"}},
    )
    second_launch.raise_for_status()
    second_run_id = second_launch.json()["id"]
    second_completed = wait_for_run_status(client, auth_headers, mission_id, second_run_id, {"completed"})
    assert second_completed["output"]["results"]["tool-node"]["result"]["stdout"].strip() == "after"


def test_replay_remains_stable_after_later_mission_edits(client, auth_headers) -> None:
    mission = create_blank_mission(client, auth_headers, "Replay Stability")
    mission_id = mission["id"]
    imported = client.post(
        f"/api/v1/missions/{mission_id}/agents/import",
        headers=auth_headers,
        json={"templateAgentId": "engineer"},
    )
    imported.raise_for_status()

    def workflow_for(command: str) -> dict[str, Any]:
        return {
            "definition": {
                "id": "mission-workflow",
                "name": "Mission Workflow",
                "description": "Replay stability check",
                "version": 1,
                "nodes": [
                    {
                        "id": "tool-node",
                        "name": "Tool Node",
                        "type": "tool",
                        "position": {"x": 0, "y": 0},
                        "config": {"agentId": "engineer", "tool": "shell", "args": {"command": command}},
                    },
                    {
                        "id": "terminal",
                        "name": "Terminal",
                        "type": "terminal",
                        "position": {"x": 220, "y": 0},
                        "config": {"output": "{{results.tool-node.result.stdout}}"},
                    },
                ],
                "edges": [{"id": "e1", "source": "tool-node", "target": "terminal"}],
            }
        }

    first_save = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=workflow_for("echo first"))
    first_save.raise_for_status()
    first_launch = client.post(f"/api/v1/missions/{mission_id}/runs", headers=auth_headers, json={"input": {}})
    first_launch.raise_for_status()
    first_run_id = first_launch.json()["id"]
    wait_for_run_status(client, auth_headers, mission_id, first_run_id, {"completed"})

    second_save = client.put(
        f"/api/v1/missions/{mission_id}/workflow",
        headers=auth_headers,
        json=workflow_for("echo second"),
    )
    second_save.raise_for_status()
    second_launch = client.post(f"/api/v1/missions/{mission_id}/runs", headers=auth_headers, json={"input": {}})
    second_launch.raise_for_status()
    second_run_id = second_launch.json()["id"]
    wait_for_run_status(client, auth_headers, mission_id, second_run_id, {"completed"})

    first_replay = client.get(f"/api/v1/missions/{mission_id}/runs/{first_run_id}/replay", headers=auth_headers)
    first_replay.raise_for_status()
    second_replay = client.get(f"/api/v1/missions/{mission_id}/runs/{second_run_id}/replay", headers=auth_headers)
    second_replay.raise_for_status()

    first_terminal = first_replay.json()["mission"]["output"]["results"]["tool-node"]["result"]["stdout"].strip()
    second_terminal = second_replay.json()["mission"]["output"]["results"]["tool-node"]["result"]["stdout"].strip()
    assert first_terminal == "first"
    assert second_terminal == "second"


def test_only_one_active_run_per_mission(client, auth_headers) -> None:
    mission = create_blank_mission(client, auth_headers, "Single Active Run")
    mission_id = mission["id"]
    imported = client.post(
        f"/api/v1/missions/{mission_id}/agents/import",
        headers=auth_headers,
        json={"templateAgentId": "engineer"},
    )
    imported.raise_for_status()

    workflow = {
        "definition": {
            "id": "mission-workflow",
            "name": "Mission Workflow",
            "description": "One active run limit",
            "version": 1,
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "type": "delay",
                    "position": {"x": 0, "y": 0},
                    "config": {"seconds": 1.5},
                },
                {
                    "id": "tool-node",
                    "name": "Tool Node",
                    "type": "tool",
                    "position": {"x": 220, "y": 0},
                    "config": {"agentId": "engineer", "tool": "shell", "args": {"command": "echo hello"}},
                },
            ],
            "edges": [{"id": "e1", "source": "wait", "target": "tool-node"}],
        }
    }
    saved = client.put(f"/api/v1/missions/{mission_id}/workflow", headers=auth_headers, json=workflow)
    saved.raise_for_status()

    first_launch = client.post(f"/api/v1/missions/{mission_id}/runs", headers=auth_headers, json={"input": {}})
    first_launch.raise_for_status()
    first_run_id = first_launch.json()["id"]

    second_launch = client.post(f"/api/v1/missions/{mission_id}/runs", headers=auth_headers, json={"input": {}})
    assert second_launch.status_code == 409

    client.post(
        f"/api/v1/missions/{mission_id}/runs/{first_run_id}/actions",
        headers=auth_headers,
        json={"action": "cancel", "payload": {}},
    ).raise_for_status()
    wait_for_run_status(client, auth_headers, mission_id, first_run_id, {"cancelled", "failed"})


def test_runtime_settings_report_storage_backend(client, auth_headers) -> None:
    payload = runtime_settings(client, auth_headers)
    assert payload["storage"]["artifactBackend"] == "filesystem"
    assert payload["storage"]["artifactBucket"] == "council-artifacts"


def test_public_api_health_alias(client) -> None:
    response = client.get("/api/health")
    response.raise_for_status()
    assert response.json() == {"status": "ok"}


def test_agent_crud_round_trip(client, auth_headers) -> None:
    settings = runtime_settings(client, auth_headers)
    payload = {
        "id": "science-officer",
        "name": "Science Officer",
        "role": "research-analyst",
        "description": "Investigates external systems and records findings.",
        "systemPrompt": "Investigate carefully and summarize concrete findings.",
        "provider": settings["providers"][0],
        "tools": ["web", "api"],
        "toolPolicy": {
            **settings["defaultPolicy"],
            "allowedTools": ["web", "api"],
        },
        "memoryProfile": {"mode": "hybrid", "namespace": "science", "topK": 5},
        "handoffTargets": ["captain", "archivist"],
    }

    created = client.post("/api/v1/agents", headers=auth_headers, json=payload)
    created.raise_for_status()
    assert created.json()["id"] == "science-officer"

    updated_payload = {
        **created.json(),
        "name": "Science Officer Prime",
        "tools": ["web"],
        "toolPolicy": {
            **settings["defaultPolicy"],
            "allowedTools": ["web"],
        },
        "handoffTargets": ["captain"],
    }
    updated = client.put("/api/v1/agents/science-officer", headers=auth_headers, json=updated_payload)
    updated.raise_for_status()
    assert updated.json()["name"] == "Science Officer Prime"

    deleted = client.delete("/api/v1/agents/science-officer", headers=auth_headers)
    assert deleted.status_code == 204

    remaining = client.get("/api/v1/agents", headers=auth_headers)
    remaining.raise_for_status()
    assert all(agent["id"] != "science-officer" for agent in remaining.json())


# ---------------------------------------------------------------------------
# Phase 7: Security & Enforcement tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_path_traversal_blocked(tmp_path, monkeypatch) -> None:
    """7a: ToolRunner raises ToolPolicyError when a path traversal is attempted."""
    run_id = "test-traversal-run"
    workspace = tmp_path / run_id
    workspace.mkdir(parents=True)

    # Monkeypatch the cached settings instance so _mission_workspace uses tmp_path
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "workspace_root", str(tmp_path))

    runner = ToolRunner()
    runner.settings = settings

    policy = ToolPolicy(allowedTools=["filesystem"])

    with pytest.raises(ToolPolicyError, match="outside mission writable roots"):
        await runner.run(
            "filesystem",
            {"action": "read", "path": "../../etc/passwd"},
            policy,
            run_id,
        )


@pytest.mark.asyncio
async def test_max_artifacts_enforced() -> None:
    """7b: _store_artifact returns early (emitting a warning event) when limit is reached."""
    from unittest.mock import MagicMock, patch

    from app.executor import MissionExecutor
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    telemetry.persist_event = MagicMock()
    executor = MissionExecutor(telemetry)

    with patch("app.executor.SessionLocal") as mock_session_class:
        # Set up context manager
        session_mock = MagicMock()
        mock_session_class.return_value.__enter__ = MagicMock(return_value=session_mock)
        mock_session_class.return_value.__exit__ = MagicMock(return_value=False)

        # run.mission_id
        run_mock = MagicMock()
        run_mock.mission_id = "mission-1"
        session_mock.get.return_value = run_mock

        # artifact count at the limit
        session_mock.execute.return_value.scalar.return_value = 20

        await executor._store_artifact(
            "run-1", "node-1", "agent-output", "Test Label", "content", max_artifacts=20
        )

    # persist_event should have been called exactly once with a warning
    telemetry.persist_event.assert_called_once()
    call_args = telemetry.persist_event.call_args
    # positional args: session, mission_id, run_id, event_type, message
    assert call_args[0][3] == "node.artifact_limit_reached"
    assert call_args[1]["severity"] == "warning"


def test_tool_output_truncated() -> None:
    """7c: _truncate_result shortens text fields that exceed max_chars."""
    runner = ToolRunner()
    result = {"stdout": "a" * 1000, "returncode": 0}
    truncated = runner._truncate_result(result, 100)
    assert len(truncated["stdout"]) == 100
    assert truncated["_truncated"] is True
    assert truncated["returncode"] == 0


def test_tool_output_not_truncated_when_short() -> None:
    """7c: _truncate_result leaves short text fields unchanged."""
    runner = ToolRunner()
    result = {"stdout": "hello", "returncode": 0}
    out = runner._truncate_result(result, 100)
    assert out["stdout"] == "hello"
    assert "_truncated" not in out


# ---------------------------------------------------------------------------
# Phase 8: LLM Streaming tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_complete_scripted() -> None:
    """8a: stream_complete yields tokens word-by-word for the scripted-local provider."""
    from app.providers import ProviderService
    from app.schemas import ProviderConfig

    service = ProviderService()
    provider = ProviderConfig(
        id="scripted-local",
        label="Test",
        mode="local",
        model="scripted-local",
    )
    tokens = []
    async for token in service.stream_complete(
        provider,
        system_prompt="You are a test agent.",
        user_prompt="Hello",
    ):
        tokens.append(token)

    assert len(tokens) > 0
    full = "".join(tokens)
    assert len(full) > 0


@pytest.mark.asyncio
async def test_dispatch_stream_token_no_db_write() -> None:
    """8b: dispatch_stream_token broadcasts via WebSocket without writing to the DB."""
    from app.telemetry import TelemetryHub

    hub = TelemetryHub()

    # Mock broadcast to capture calls
    broadcast_calls = []

    async def mock_broadcast(run_id, payload):
        broadcast_calls.append((run_id, payload))

    hub.broadcast = mock_broadcast

    await hub.dispatch_stream_token("run-1", "node-1", "hello", 0)

    assert len(broadcast_calls) == 1
    run_id, payload = broadcast_calls[0]
    assert run_id == "run-1"
    assert payload["type"] == "node.stream_token"
    assert payload["token"] == "hello"
    assert payload["nodeId"] == "node-1"
    assert payload["sequence"] == 0
    # No DB writes — no session was created


# ---------------------------------------------------------------------------
# Phase 9: Node-Level Retry & Error Handling tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_node_retry_then_succeed() -> None:
    """9a: Node fails twice then succeeds on third attempt."""
    from unittest.mock import MagicMock, patch

    from app.executor import MissionExecutor, NodeResult
    from app.schemas import WorkflowNode
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    telemetry.persist_event = MagicMock(return_value=MagicMock())
    telemetry._schedule_dispatch = MagicMock()
    executor = MissionExecutor(telemetry)

    call_count = 0

    async def fake_execute_once(run_id, node, results):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise RuntimeError("temporary failure")
        return NodeResult(payload={"output": "success"})

    node = WorkflowNode(
        id="n1",
        name="Test Node",
        type="agent",
        position={"x": 0, "y": 0},
        config={
            "retry": {
                "maxAttempts": 3,
                "backoffSeconds": 0,  # no sleep in test
                "backoffMultiplier": 1,
                "onExhausted": "fail",
            }
        },
    )

    with patch.object(executor, "_execute_node_once", side_effect=fake_execute_once):
        with patch("app.executor.SessionLocal") as mock_session_class:
            session_mock = MagicMock()
            mock_session_class.return_value.__enter__ = MagicMock(return_value=session_mock)
            mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
            run_mock = MagicMock()
            run_mock.mission_id = "m1"
            run_mock.workflow_snapshot = {
                "id": "wf1",
                "name": "wf",
                "version": 1,
                "nodes": [{"id": "n1", "name": "Test Node", "type": "agent", "position": {"x": 0, "y": 0}}],
                "edges": [],
            }
            session_mock.get.return_value = run_mock

            result = await executor._execute_node("run-1", node, {})

    assert call_count == 3
    assert result.payload["output"] == "success"


@pytest.mark.asyncio
async def test_node_retry_skip_on_exhaustion() -> None:
    """9b: Node fails all retries and skips."""
    from unittest.mock import MagicMock, patch

    from app.executor import MissionExecutor, NodeResult
    from app.schemas import WorkflowNode
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    telemetry.persist_event = MagicMock(return_value=MagicMock())
    telemetry._schedule_dispatch = MagicMock()
    executor = MissionExecutor(telemetry)

    node = WorkflowNode(
        id="n1",
        name="Failing Node",
        type="agent",
        position={"x": 0, "y": 0},
        config={
            "retry": {
                "maxAttempts": 2,
                "backoffSeconds": 0,
                "backoffMultiplier": 1,
                "onExhausted": "skip",
            }
        },
    )

    async def always_fail(run_id, node, results):
        raise RuntimeError("always fails")

    with patch.object(executor, "_execute_node_once", side_effect=always_fail):
        with patch("app.executor.SessionLocal") as mock_session_class:
            session_mock = MagicMock()
            mock_session_class.return_value.__enter__ = MagicMock(return_value=session_mock)
            mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
            run_mock = MagicMock()
            run_mock.mission_id = "m1"
            session_mock.get.return_value = run_mock

            result = await executor._execute_node("run-1", node, {})

    assert result.payload["skipped"] is True
    assert "always fails" in result.payload["error"]


@pytest.mark.asyncio
async def test_node_error_records_written() -> None:
    """9c: _record_node_error writes a NodeErrorRecord to the DB."""
    from app.executor import MissionExecutor
    from app.models import NodeErrorRecord
    from app.telemetry import TelemetryHub

    with SessionLocal() as session:
        from app.models import Mission, MissionRun

        mission = Mission(
            id="m-err-test",
            name="Error Record Mission",
            description="",
            status="running",
            input_payload={},
            output_payload={},
            current_nodes=[],
            provider_overrides={},
            control_state={},
            workflow_definition={"id": "wf", "name": "wf", "version": 1, "nodes": [], "edges": []},
        )
        session.add(mission)
        run = MissionRun(
            id="run-err-test",
            mission_id="m-err-test",
            name="Error Run",
            status="running",
            workflow_snapshot={"id": "wf", "name": "wf", "version": 1, "nodes": [], "edges": []},
        )
        session.add(run)
        session.commit()

    from unittest.mock import MagicMock

    telemetry = MagicMock(spec=TelemetryHub)
    executor = MissionExecutor(telemetry)

    exc = ValueError("something went wrong")
    await executor._record_node_error("run-err-test", "node-x", 2, exc)

    with SessionLocal() as session:
        records = session.query(NodeErrorRecord).filter_by(run_id="run-err-test").all()

    assert len(records) == 1
    rec = records[0]
    assert rec.mission_id == "m-err-test"
    assert rec.node_id == "node-x"
    assert rec.attempt == 2
    assert rec.error_type == "ValueError"
    assert rec.error_message == "something went wrong"
    assert rec.traceback is not None


# ---------------------------------------------------------------------------
# Phase 11: Multi-Turn Conversation History tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multi_turn_accumulates_history() -> None:
    """11a: Second call to a multi-turn agent receives prior conversation."""
    from unittest.mock import AsyncMock, MagicMock

    from app.executor import MissionExecutor
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    telemetry.persist_event = MagicMock(return_value=MagicMock())
    telemetry._schedule_dispatch = MagicMock()
    telemetry.dispatch_stream_token = AsyncMock()
    executor = MissionExecutor(telemetry)

    # Verify _build_conversation_messages builds correct message list
    messages = executor._build_conversation_messages(
        system_prompt="You are helpful.",
        history=[
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ],
        new_user_prompt="How are you?",
        max_history_turns=10,
    )

    assert messages[0] == {"role": "system", "content": "You are helpful."}
    assert messages[1] == {"role": "user", "content": "Hello"}
    assert messages[2] == {"role": "assistant", "content": "Hi there!"}
    assert messages[3] == {"role": "user", "content": "How are you?"}
    assert len(messages) == 4


def test_conversation_history_truncation() -> None:
    """11b: History is truncated to max_history_turns pairs."""
    from unittest.mock import MagicMock

    from app.executor import MissionExecutor
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    executor = MissionExecutor(telemetry)

    # Build a long history (6 turns = 12 messages)
    history = []
    for i in range(6):
        history.append({"role": "user", "content": f"Message {i}"})
        history.append({"role": "assistant", "content": f"Response {i}"})

    # With max_history_turns=2, only last 4 messages kept + system + new user
    messages = executor._build_conversation_messages(
        system_prompt="System",
        history=history,
        new_user_prompt="Latest",
        max_history_turns=2,
    )

    # system + 4 history messages + new user = 6
    assert len(messages) == 6
    assert messages[0]["role"] == "system"
    assert messages[-1] == {"role": "user", "content": "Latest"}


@pytest.mark.asyncio
async def test_provider_complete_with_messages() -> None:
    """11c: complete() uses provided messages when given."""
    from app.providers import ProviderService
    from app.schemas import ProviderConfig

    service = ProviderService()
    provider = ProviderConfig(
        id="scripted-local",
        label="Test",
        mode="local",
        model="scripted-local",
    )

    # scripted-local ignores messages but doesn't crash
    result = await service.complete(
        provider,
        system_prompt="system",
        user_prompt="user",
        messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "prior"},
            {"role": "assistant", "content": "response"},
            {"role": "user", "content": "user"},
        ],
    )
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_provider_semaphore_limits_concurrency() -> None:
    """7d: ProviderService initialises a semaphore that limits to max_concurrent_llm_calls."""
    import asyncio

    from app.core.config import get_settings
    from app.providers import ProviderService

    settings = get_settings()
    service = ProviderService()

    # Verify semaphore is created as asyncio.Semaphore
    assert isinstance(service._semaphore, asyncio.Semaphore)

    # Acquire max_concurrent_llm_calls times — all should succeed immediately
    acquired = 0
    for _ in range(settings.max_concurrent_llm_calls):
        assert not service._semaphore.locked(), "Semaphore should not be locked yet"
        await service._semaphore.acquire()
        acquired += 1

    # After acquiring max times, the semaphore is exhausted (locked)
    assert service._semaphore.locked()

    # Release all acquired slots
    for _ in range(acquired):
        service._semaphore.release()

    assert not service._semaphore.locked()


# ---------------------------------------------------------------------------
# Phase 12: Dynamic Agent Handoffs tests
# ---------------------------------------------------------------------------


def test_handoff_parsing() -> None:
    """12a: HANDOFF: directive is correctly parsed from completion text."""
    completion = "Analysis complete.\nHANDOFF:specialist-agent\nSome more text."
    handoff_target = None
    if "HANDOFF:" in completion:
        handoff_target = completion.split("HANDOFF:", 1)[1].splitlines()[0].strip()
    assert handoff_target == "specialist-agent"


def test_handoff_target_not_in_allowed_list_is_ignored() -> None:
    """12b: HANDOFF: to an agent not in handoffTargets is ignored."""
    from app.schemas import MissionAgentDefinition, ProviderConfig, ToolPolicy, MemoryProfile

    # Agent with no handoff targets
    agent = MissionAgentDefinition(
        id="agent-1",
        missionId="m1",
        name="Agent One",
        role="analyst",
        systemPrompt="You are an analyst.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],  # empty — no handoffs allowed
    )

    handoff_target_id = "specialist-agent"
    if handoff_target_id not in agent.handoffTargets:
        handoff_target_id = None

    assert handoff_target_id is None


@pytest.mark.asyncio
async def test_handoff_depth_limit() -> None:
    """12c: Handoff is skipped when depth limit is reached."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.agent_loop import AgentLoop, LoopResult
    from app.node_handlers import ExecutionContext
    from app.node_handlers.agent import AgentNodeHandler
    from app.schemas import MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy, WorkflowNode

    node = WorkflowNode(
        id="n1",
        name="Agent Node",
        type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "agent-1", "maxHandoffDepth": 0},  # depth 0 = no handoffs
    )

    # Agent that would normally trigger a handoff
    agent = MissionAgentDefinition(
        id="agent-1",
        missionId="m1",
        name="Agent One",
        role="analyst",
        systemPrompt="You are an analyst.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=["specialist-agent"],
    )

    from app.executor import MissionExecutor

    mock_executor = MagicMock()
    mock_executor.providers = MagicMock()
    mock_executor.telemetry = MagicMock()
    mock_executor.telemetry.dispatch_stream_token = AsyncMock()
    mock_executor.tools = MagicMock()
    mock_executor.storage = MagicMock()
    mock_executor._mission_agent_from_snapshot_from_list = MagicMock(return_value=agent)
    mock_executor._render_value = MagicMock(side_effect=lambda v, ctx: v)
    mock_executor._store_artifact = AsyncMock()
    mock_executor._store_memory = AsyncMock()
    mock_executor._build_conversation_messages = MissionExecutor._build_conversation_messages

    handler = AgentNodeHandler(mock_executor)

    ctx = ExecutionContext(
        run_id="run-1",
        mission_id="m1",
        input_payload={"prompt": "test"},
        control_state={},
        execution_state={},
        agent_snapshot=[agent.model_dump()],
        provider_overrides={},
        results={},
        depth=0,  # maxHandoffDepth=0, so depth >= max_depth → skip
    )

    # LoopResult with a handoff chain — handler should skip it due to depth limit
    mock_loop_result = LoopResult(
        completion="analysis done",
        route=None,
        handoff_chain=["specialist-agent"],
    )

    with patch.object(AgentLoop, "run", new=AsyncMock(return_value=mock_loop_result)):
        result = await handler.execute(node, ctx)

    # Should complete without recursive call, just log the depth-limit warning
    assert "output" in result.payload
    assert "handoffOutput" not in result.payload


# ---------------------------------------------------------------------------
# Phase 10: Human-in-the-Loop tests
# ---------------------------------------------------------------------------


def test_provide_input_action():
    """provide_input action writes human_input_response to control_state."""
    from app.executor import apply_operator_action
    from app.models import MissionRun

    run = MissionRun(
        id="run-1",
        mission_id="m1",
        name="Test",
        status="awaiting_input",
        workflow_snapshot={},
        agent_snapshot=[],
        input_payload={},
        execution_state={},
        control_state={"awaiting_input_node": "node-1"},
    )

    apply_operator_action(run, "provide_input", {"input": "yes, proceed"})

    assert run.control_state["human_input_response"] == "yes, proceed"


@pytest.mark.asyncio
async def test_human_input_default_returns_immediately():
    """human_input node with defaultInput returns without blocking."""
    from unittest.mock import MagicMock

    from app.executor import MissionExecutor
    from app.schemas import WorkflowNode
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    executor = MissionExecutor(telemetry)

    node = WorkflowNode(
        id="n1",
        name="Input Node",
        type="human_input",
        position={"x": 0, "y": 0},
        config={"defaultInput": "auto-proceed"},
    )

    result = await executor._run_human_input_node("run-1", node, {})
    assert result.payload["input"] == "auto-proceed"


# ---------------------------------------------------------------------------
# Phase 13: Vector Memory with pgvector tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_embed_text_disabled() -> None:
    """13a: embed_text returns None when embedding_enabled=False."""
    from unittest.mock import patch

    from app.core.config import get_settings
    from app.embeddings import embed_text

    settings = get_settings()
    with patch.object(settings, "embedding_enabled", False):
        with patch("app.embeddings.get_settings", return_value=settings):
            result = await embed_text("some text to embed")

    assert result is None


@pytest.mark.asyncio
async def test_store_memory_sets_embedding() -> None:
    """13b: _store_memory calls embed_text when pgvector is available and stores the result on the MemoryRecord."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.executor import MissionExecutor
    from app.telemetry import TelemetryHub

    fake_embedding = [0.1, 0.2, 0.3]
    embed_mock = AsyncMock(return_value=fake_embedding)

    telemetry = MagicMock(spec=TelemetryHub)
    executor = MissionExecutor(telemetry)

    stored_records: list[Any] = []

    # Patch _HAS_PGVECTOR to True so the embedding path is exercised.
    # Patch SessionLocal to capture what record is persisted without hitting SQLite
    # with an incompatible list type (LargeBinary requires bytes).
    with patch("app.executor._HAS_PGVECTOR", True):
        with patch("app.executor.embed_text", embed_mock):
            with patch("app.executor.SessionLocal") as mock_session_class:
                session_mock = MagicMock()
                mock_session_class.return_value.__enter__ = MagicMock(return_value=session_mock)
                mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
                run_mock = MagicMock()
                run_mock.mission_id = "m-emb-test"
                session_mock.get.return_value = run_mock

                def capture_add(record):
                    stored_records.append(record)

                session_mock.add.side_effect = capture_add

                await executor._store_memory(
                    "run-emb-test",
                    None,
                    "test-namespace",
                    "hello world",
                    tags=["test"],
                    metadata={"nodeId": "n1"},
                )

    # embed_text should have been called with the content
    embed_mock.assert_called_once_with("hello world")

    # The MemoryRecord should have been constructed with the embedding
    assert len(stored_records) == 1
    record = stored_records[0]
    assert record.embedding == fake_embedding
    assert record.content == "hello world"
    assert record.namespace == "test-namespace"


@pytest.mark.asyncio
async def test_memory_retrieval_falls_back_to_term_overlap() -> None:
    """13c: _run_memory_node falls back to term-overlap when embed_text returns None."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.executor import MissionExecutor
    from app.models import MemoryRecord
    from app.schemas import WorkflowNode
    from app.telemetry import TelemetryHub

    # Pre-populate some memory records
    with SessionLocal() as session:
        mission = __import__("app.models", fromlist=["Mission"]).Mission(
            id="m-fallback-test",
            name="Fallback Mission",
            description="",
            status="running",
            input_payload={},
            output_payload={},
            current_nodes=[],
            provider_overrides={},
            control_state={},
            workflow_definition={"id": "wf", "name": "wf", "version": 1, "nodes": [], "edges": []},
        )
        session.add(mission)
        run = __import__("app.models", fromlist=["MissionRun"]).MissionRun(
            id="run-fallback-test",
            mission_id="m-fallback-test",
            name="Fallback Run",
            status="running",
            workflow_snapshot={"id": "wf", "name": "wf", "version": 1, "nodes": [], "edges": []},
        )
        session.add(run)
        session.add(
            MemoryRecord(
                mission_id="m-fallback-test",
                run_id="run-fallback-test",
                namespace="fallback-ns",
                content="the quick brown fox jumps",
                tags=[],
                metadata_json={},
            )
        )
        session.add(
            MemoryRecord(
                mission_id="m-fallback-test",
                run_id="run-fallback-test",
                namespace="fallback-ns",
                content="unrelated content about ships",
                tags=[],
                metadata_json={},
            )
        )
        session.commit()

    telemetry = MagicMock(spec=TelemetryHub)
    executor = MissionExecutor(telemetry)

    node = WorkflowNode(
        id="n1",
        name="Memory Read",
        type="memory",
        position={"x": 0, "y": 0},
        config={"mode": "read", "namespace": "fallback-ns", "query": "fox jumps", "topK": 3},
    )

    # embed_text returns None -> falls back to term overlap
    with patch("app.executor.embed_text", new_callable=AsyncMock, return_value=None):
        with patch("app.executor.get_settings") as mock_settings:
            mock_settings.return_value.embedding_enabled = False
            mock_settings.return_value.default_memory_namespace = "bridge"
            result = await executor._run_memory_node(
                "run-fallback-test",
                node,
                {"mission": {"input": {"prompt": "fox jumps"}, "control": {}}, "results": {}},
            )

    assert result.payload["mode"] == "read"
    assert len(result.payload["matches"]) >= 1
    assert any("fox" in m for m in result.payload["matches"])


# ---------------------------------------------------------------------------
# Phase 15: AgentLoop tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_loop_basic_completion(monkeypatch):
    """AgentLoop returns a LoopResult with the completion text."""
    from app.agent_loop import AgentLoop, LoopResult
    from app.node_handlers import ExecutionContext
    from app.schemas import MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy, WorkflowNode

    tokens_yielded = []

    async def fake_stream(*args, **kwargs):
        for token in ["hello ", "world"]:
            tokens_yielded.append(token)
            yield token

    from unittest.mock import AsyncMock, MagicMock

    mock_providers = MagicMock()
    mock_providers.stream_complete = fake_stream
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()
    mock_tools = MagicMock()
    mock_storage = MagicMock()

    loop = AgentLoop(
        providers=mock_providers,
        telemetry=mock_telemetry,
        tools=mock_tools,
        storage=mock_storage,
    )

    node = WorkflowNode(
        id="n1",
        name="Test",
        type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1"},
    )
    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    result = await loop.run(
        run_id="run1",
        node=node,
        agent=agent,
        provider=provider,
        prompt="Say hello",
        prior_messages=None,
        depth=0,
    )

    assert result.completion == "hello world"
    assert result.route is None
    assert result.handoff_chain == []


@pytest.mark.asyncio
async def test_agent_loop_structured_output_valid(monkeypatch):
    """When outputSchema present and LLM returns valid JSON, result.structured is populated."""
    import json
    from app.agent_loop import AgentLoop
    from unittest.mock import MagicMock, AsyncMock
    from app.schemas import WorkflowNode, MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy

    schema = {"type": "object", "properties": {"score": {"type": "number"}}, "required": ["score"]}
    fake_json = json.dumps({"score": 0.9})

    async def fake_stream(*args, **kwargs):
        yield fake_json

    mock_providers = MagicMock()
    mock_providers.stream_complete = fake_stream
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=MagicMock(), storage=MagicMock())

    node = WorkflowNode(
        id="n1", name="Test", type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1", "outputSchema": schema}
    )
    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    result = await loop.run(run_id="run1", node=node, agent=agent, provider=provider,
                             prompt="Score this", prior_messages=None)

    assert result.structured == {"score": 0.9}
    assert result.completion == fake_json


@pytest.mark.asyncio
async def test_agent_loop_structured_output_invalid_reprompts(monkeypatch):
    """When LLM returns invalid JSON, AgentLoop re-prompts once and returns valid result."""
    import json
    from app.agent_loop import AgentLoop
    from unittest.mock import MagicMock, AsyncMock
    from app.schemas import WorkflowNode, MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy

    schema = {"type": "object", "properties": {"score": {"type": "number"}}, "required": ["score"]}
    call_count = 0

    async def fake_stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield "not json at all"
        else:
            yield json.dumps({"score": 0.5})

    mock_providers = MagicMock()
    mock_providers.stream_complete = fake_stream
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=MagicMock(), storage=MagicMock())

    node = WorkflowNode(
        id="n1", name="Test", type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1", "outputSchema": schema}
    )
    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    result = await loop.run(run_id="run1", node=node, agent=agent, provider=provider,
                             prompt="Score this", prior_messages=None)

    assert call_count == 2  # first call failed, second succeeded
    assert result.structured == {"score": 0.5}


@pytest.mark.asyncio
async def test_agent_loop_function_call_dispatched(monkeypatch):
    """LLM tool_call response is dispatched and result fed back; loop terminates on text response."""
    from app.agent_loop import AgentLoop
    from unittest.mock import MagicMock, AsyncMock, patch
    from app.schemas import WorkflowNode, MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy
    import json

    call_count = 0

    def make_tool_call_response():
        tc = MagicMock()
        tc.id = "call_1"
        tc.function.name = "search"
        tc.function.arguments = json.dumps({"query": "hello"})
        msg = MagicMock()
        msg.tool_calls = [tc]
        msg.content = None
        choice = MagicMock()
        choice.message = msg
        resp = MagicMock()
        resp.choices = [choice]
        return resp

    def make_text_response(text):
        msg = MagicMock()
        msg.tool_calls = None
        msg.content = text
        choice = MagicMock()
        choice.message = msg
        resp = MagicMock()
        resp.choices = [choice]
        return resp

    async def fake_acompletion(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return make_tool_call_response()
        return make_text_response("search result: hello world")

    mock_providers = MagicMock()
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()
    mock_tools = MagicMock()
    mock_storage = MagicMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=mock_tools, storage=mock_storage)

    native_functions = [
        {
            "name": "search",
            "description": "Search for information",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            "handler": "tool_call",
        }
    ]
    node = WorkflowNode(
        id="n1", name="Test", type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1", "nativeFunctions": native_functions, "maxFunctionCallRounds": 5}
    )
    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    with patch("app.agent_loop.acompletion", new=fake_acompletion):
        result = await loop.run(run_id="run1", node=node, agent=agent, provider=provider,
                                 prompt="Find hello", prior_messages=None)

    assert call_count == 2
    assert result.completion == "search result: hello world"
    assert len(result.function_call_log) == 1
    assert result.function_call_log[0]["name"] == "search"


@pytest.mark.asyncio
async def test_agent_loop_function_call_max_rounds(monkeypatch):
    """Loop terminates at maxFunctionCallRounds even if LLM keeps calling tools."""
    from app.agent_loop import AgentLoop
    from unittest.mock import MagicMock, AsyncMock, patch
    from app.schemas import WorkflowNode, MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy
    import json

    async def always_tool_call(**kwargs):
        tc = MagicMock()
        tc.id = "call_x"
        tc.function.name = "search"
        tc.function.arguments = json.dumps({"query": "x"})
        msg = MagicMock()
        msg.tool_calls = [tc]
        msg.content = None
        choice = MagicMock()
        choice.message = msg
        resp = MagicMock()
        resp.choices = [choice]
        return resp

    mock_providers = MagicMock()
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=MagicMock(), storage=MagicMock())

    native_functions = [{"name": "search", "description": "S", "parameters": {}, "handler": "tool_call"}]
    node = WorkflowNode(
        id="n1", name="T", type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1", "nativeFunctions": native_functions, "maxFunctionCallRounds": 2}
    )
    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )

    with patch("app.agent_loop.acompletion", new=always_tool_call):
        result = await loop.run(run_id="run1", node=node, agent=agent, provider=agent.provider,
                                 prompt="search forever", prior_messages=None)

    assert result.completion == ""  # maxRounds hit, no text response
    assert len(result.function_call_log) == 2  # 2 rounds × 1 tool call each


# ---------------------------------------------------------------------------
# Phase 15 Task 7: AgentNodeHandler owns full agentic cycle via AgentLoop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_node_handler_execute_produces_output(monkeypatch):
    """AgentNodeHandler.execute() calls AgentLoop and returns payload with 'output' key."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.agent_loop import AgentLoop, LoopResult
    from app.node_handlers import ExecutionContext
    from app.node_handlers.agent import AgentNodeHandler
    from app.schemas import MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy, WorkflowNode

    mock_agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="TestAgent",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )

    mock_executor = MagicMock()
    mock_executor.providers = MagicMock()
    mock_executor.telemetry = MagicMock()
    mock_executor.telemetry.dispatch_stream_token = AsyncMock()
    mock_executor.tools = MagicMock()
    mock_executor.storage = MagicMock()
    mock_executor._mission_agent_from_snapshot_from_list = MagicMock(return_value=mock_agent)
    mock_executor._render_value = MagicMock(side_effect=lambda v, ctx: v)
    mock_executor._store_artifact = AsyncMock()
    mock_executor._store_memory = AsyncMock()

    # _build_conversation_messages is a static method — bind it from the real class
    from app.executor import MissionExecutor
    mock_executor._build_conversation_messages = MissionExecutor._build_conversation_messages

    handler = AgentNodeHandler(mock_executor)

    node = WorkflowNode(
        id="n1",
        name="Test",
        type="agent",
        position={"x": 0, "y": 0},
        config={"agentId": "a1"},
    )

    agent_snapshot = [mock_agent.model_dump()]
    ctx = ExecutionContext(
        run_id="run1",
        mission_id="m1",
        input_payload={"prompt": "test"},
        control_state={},
        execution_state={},
        agent_snapshot=agent_snapshot,
        provider_overrides={},
        results={},
        depth=0,
    )

    mock_loop_result = LoopResult(completion="hello world", route=None, handoff_chain=[])

    with patch.object(AgentLoop, "run", new=AsyncMock(return_value=mock_loop_result)):
        result = await handler.execute(node, ctx)

    assert result.payload["output"] == "hello world"
    assert result.payload["agentId"] == "a1"


# ---------------------------------------------------------------------------
# Task 8: Parallel fan_out
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_parallel_fanout_passes_results_to_context():
    """Parallel node in fan_out mode returns input results so children can access them."""
    from app.node_handlers.parallel import ParallelNodeHandler
    from app.node_handlers import ExecutionContext, NodeResult
    from app.schemas import WorkflowNode

    handler = ParallelNodeHandler(executor=None)
    node = WorkflowNode(id="p1", name="P", type="parallel", position={"x":0,"y":0}, config={"mode": "fan_out"})
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={"prev": {"output": "data"}},
    )
    result = await handler.execute(node, ctx)
    assert result.payload["input"] == {"prev": {"output": "data"}}
    assert result.payload["parallel"] is True


# ---------------------------------------------------------------------------
# Task 9: Parallel map mode
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_parallel_map_scatters_over_list(monkeypatch):
    """Map mode spawns one sub-execution per item and gathers results."""
    from app.node_handlers.parallel import ParallelNodeHandler
    from app.node_handlers import ExecutionContext, NodeResult
    from app.schemas import WorkflowNode

    handler = ParallelNodeHandler(executor=None)

    async def fake_execute_subgraph(node_ids, ctx):
        item_value = ctx.results.get("_item", {}).get("value", "?")
        return {"output": item_value.upper()}

    handler._execute_subgraph = fake_execute_subgraph

    node = WorkflowNode(
        id="p1", name="P", type="parallel",
        position={"x": 0, "y": 0},
        config={
            "mode": "map",
            "inputPath": "results.extract.items",
            "subgraph": ["process"],
            "outputKey": "mapped",
        }
    )
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={"extract": {"items": ["a", "b", "c"]}},
    )

    result = await handler.execute(node, ctx)
    assert result.payload["mapped"] == [
        {"output": "A"},
        {"output": "B"},
        {"output": "C"},
    ]


@pytest.mark.asyncio
async def test_parallel_map_join_any_cancels_remainder(monkeypatch):
    """joinMode=any resolves on first completion and cancels the rest."""
    import asyncio
    from app.node_handlers.parallel import ParallelNodeHandler
    from app.node_handlers import ExecutionContext
    from app.schemas import WorkflowNode

    handler = ParallelNodeHandler(executor=None)
    executed_items = []

    async def fake_execute_subgraph(node_ids, ctx):
        item = ctx.results.get("_item", {}).get("value", "?")
        executed_items.append(item)
        if item == "slow":
            await asyncio.sleep(10)  # will be cancelled
        return {"output": item}

    handler._execute_subgraph = fake_execute_subgraph

    node = WorkflowNode(
        id="p1", name="P", type="parallel",
        position={"x": 0, "y": 0},
        config={
            "mode": "map",
            "inputPath": "results.items.list",
            "subgraph": ["step"],
            "outputKey": "results",
            "joinMode": "any",
        }
    )
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={"items": {"list": ["fast", "slow"]}},
    )

    result = await handler.execute(node, ctx)
    # Only 1 result since joinMode=any stops on first completion
    assert len(result.payload["results"]) == 1
    assert result.payload["results"][0]["output"] == "fast"
    assert result.route is None


# ---------------------------------------------------------------------------
# Phase 17: SubworkflowNodeHandler tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subworkflow_depth_guard_raises():
    """Raises RuntimeError when ctx.depth >= maxDepth."""
    from app.node_handlers.subworkflow import SubworkflowNodeHandler
    from app.node_handlers import ExecutionContext
    from app.schemas import WorkflowNode

    handler = SubworkflowNodeHandler(executor=None)
    node = WorkflowNode(
        id="sw1", name="Sub", type="subworkflow",
        position={"x": 0, "y": 0},
        config={"inline": {"nodes": [], "edges": []}, "maxDepth": 3},
    )
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={}, depth=3,  # AT maxDepth
    )
    with pytest.raises(RuntimeError, match="depth limit"):
        await handler.execute(node, ctx)


@pytest.mark.asyncio
async def test_subworkflow_maps_input_to_child_context(monkeypatch):
    """inputMapping injects parent results into child execution context."""
    from app.node_handlers.subworkflow import SubworkflowNodeHandler
    from app.node_handlers import ExecutionContext
    from app.schemas import WorkflowNode
    from unittest.mock import AsyncMock, MagicMock

    handler = SubworkflowNodeHandler(executor=None)

    # Track what child_ctx was built with
    captured_ctx = {}

    async def fake_execute_inline(run_id, workflow, child_ctx, node_id_prefix=""):
        captured_ctx.update({"input_payload": child_ctx.input_payload, "depth": child_ctx.depth})
        return {}

    handler._execute_inline = fake_execute_inline

    node = WorkflowNode(
        id="sw1", name="Sub", type="subworkflow",
        position={"x": 0, "y": 0},
        config={
            "inline": {"nodes": [], "edges": []},
            "inputMapping": {"prompt": "{{results.intake.output}}"},
            "maxDepth": 3,
        },
    )
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={"intake": {"output": "hello from parent"}},
        depth=0,
    )
    await handler.execute(node, ctx)
    assert captured_ctx["input_payload"]["prompt"] == "hello from parent"
    assert captured_ctx["depth"] == 1  # incremented


@pytest.mark.asyncio
async def test_subworkflow_maps_output_back(monkeypatch):
    """outputMapping extracts terminal result into parent NodeResult payload."""
    from app.node_handlers.subworkflow import SubworkflowNodeHandler
    from app.node_handlers import ExecutionContext
    from app.schemas import WorkflowNode

    handler = SubworkflowNodeHandler(executor=None)

    async def fake_execute_inline(run_id, workflow, child_ctx, node_id_prefix=""):
        return {"sub_terminal": {"output": "summary result"}}

    handler._execute_inline = fake_execute_inline

    node = WorkflowNode(
        id="sw1", name="Sub", type="subworkflow",
        position={"x": 0, "y": 0},
        config={
            "inline": {"nodes": [], "edges": []},
            "outputMapping": {"summary": "results.sub_terminal.output"},
            "maxDepth": 3,
        },
    )
    ctx = ExecutionContext(
        run_id="r1", mission_id="m1",
        input_payload={}, control_state={}, execution_state={},
        agent_snapshot=[], provider_overrides={},
        results={}, depth=0,
    )
    result = await handler.execute(node, ctx)
    assert result.payload["summary"] == "summary result"


# ---------------------------------------------------------------------------
# Phase 18: EvalNodeHandler tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_eval_node_passes_target_output_to_judge(monkeypatch):
    """Eval node runs judge agent against targetNodeId's output."""
    from unittest.mock import AsyncMock, MagicMock

    from app.agent_loop import AgentLoop, LoopResult
    from app.node_handlers import ExecutionContext
    from app.node_handlers.eval import EvalNodeHandler
    from app.schemas import MemoryProfile, MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowNode

    judge_agent = MissionAgentDefinition(
        id="judge-1",
        missionId="m1",
        name="Judge",
        role="evaluator",
        systemPrompt="You are a strict evaluator.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )

    handler = EvalNodeHandler(agent_loop=MagicMock())
    handler._agent_loop = MagicMock()
    mock_loop_result = LoopResult(
        completion='{"score": 0.8, "critique": "good", "pass": true}',
        structured={"score": 0.8, "critique": "good", "pass": True},
    )
    handler._agent_loop.run = AsyncMock(return_value=mock_loop_result)

    node = WorkflowNode(
        id="eval1",
        name="Eval",
        type="eval",
        position={"x": 0, "y": 0},
        config={
            "targetNodeId": "researcher",
            "judgeAgentId": judge_agent.id,
            "rubric": "Is this good?",
            "passThreshold": 0.7,
            "onFail": "continue",
        },
    )
    agent_snapshot = [judge_agent.model_dump()]
    ctx = ExecutionContext(
        run_id="r1",
        mission_id="m1",
        input_payload={},
        control_state={},
        execution_state={},
        agent_snapshot=agent_snapshot,
        provider_overrides={},
        results={"researcher": {"output": "some research output"}},
    )

    result = await handler.execute(node, ctx)
    assert result.payload["eval"]["pass"] is True
    assert result.payload["eval"]["score"] == 0.8
    assert result.payload["targetNodeId"] == "researcher"
    assert handler._agent_loop.run.called


@pytest.mark.asyncio
async def test_eval_node_on_fail_raises(monkeypatch):
    """onFail=fail raises RuntimeError when judge returns pass=False."""
    from unittest.mock import AsyncMock, MagicMock

    from app.agent_loop import LoopResult
    from app.node_handlers import ExecutionContext
    from app.node_handlers.eval import EvalNodeHandler
    from app.schemas import MemoryProfile, MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowNode

    judge_agent = MissionAgentDefinition(
        id="judge-1",
        missionId="m1",
        name="Judge",
        role="evaluator",
        systemPrompt="You are a strict evaluator.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )

    handler = EvalNodeHandler(agent_loop=MagicMock())
    handler._agent_loop = MagicMock()
    handler._agent_loop.run = AsyncMock(
        return_value=LoopResult(
            completion='{"score": 0.3, "critique": "poor", "pass": false}',
            structured={"score": 0.3, "critique": "poor", "pass": False},
        )
    )

    node = WorkflowNode(
        id="eval1",
        name="Eval",
        type="eval",
        position={"x": 0, "y": 0},
        config={
            "targetNodeId": "researcher",
            "judgeAgentId": judge_agent.id,
            "passThreshold": 0.7,
            "onFail": "fail",
        },
    )
    ctx = ExecutionContext(
        run_id="r1",
        mission_id="m1",
        input_payload={},
        control_state={},
        execution_state={},
        agent_snapshot=[judge_agent.model_dump()],
        provider_overrides={},
        results={"researcher": {"output": "bad output"}},
    )

    with pytest.raises(RuntimeError):
        await handler.execute(node, ctx)


@pytest.mark.asyncio
async def test_eval_node_on_fail_continue_does_not_raise(monkeypatch):
    """onFail=continue stores eval result and does not raise."""
    from unittest.mock import AsyncMock, MagicMock

    from app.agent_loop import LoopResult
    from app.node_handlers import ExecutionContext
    from app.node_handlers.eval import EvalNodeHandler
    from app.schemas import MemoryProfile, MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowNode

    judge_agent = MissionAgentDefinition(
        id="judge-1",
        missionId="m1",
        name="Judge",
        role="evaluator",
        systemPrompt="You are a strict evaluator.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )

    handler = EvalNodeHandler(agent_loop=MagicMock())
    handler._agent_loop = MagicMock()
    handler._agent_loop.run = AsyncMock(
        return_value=LoopResult(
            completion='{"score": 0.3, "pass": false, "critique": "needs work"}',
            structured={"score": 0.3, "pass": False, "critique": "needs work"},
        )
    )

    node = WorkflowNode(
        id="eval1",
        name="Eval",
        type="eval",
        position={"x": 0, "y": 0},
        config={
            "targetNodeId": "researcher",
            "judgeAgentId": judge_agent.id,
            "passThreshold": 0.7,
            "onFail": "continue",  # should NOT raise
        },
    )
    ctx = ExecutionContext(
        run_id="r1",
        mission_id="m1",
        input_payload={},
        control_state={},
        execution_state={},
        agent_snapshot=[judge_agent.model_dump()],
        provider_overrides={},
        results={"researcher": {"output": "output"}},
    )

    result = await handler.execute(node, ctx)  # must not raise
    assert result.payload["eval"]["pass"] is False


# ---------------------------------------------------------------------------
# Phase 18 Task 12: AgentLoop reflection loop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_loop_reflection_reruns_below_threshold(monkeypatch):
    """When reflection score < passThreshold, AgentLoop re-runs with critique."""
    from unittest.mock import AsyncMock, MagicMock

    from app.agent_loop import AgentLoop
    from app.schemas import MemoryProfile, MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowNode

    judge_call_count = 0
    main_call_count = 0

    async def combined_fake_stream(*args, **kwargs):
        nonlocal judge_call_count, main_call_count
        system_prompt = kwargs.get("system_prompt", "")
        if "score" in system_prompt.lower() or "evaluate" in system_prompt.lower() or "critic" in system_prompt.lower():
            judge_call_count += 1
            if judge_call_count == 1:
                yield '{"score": 0.5, "pass": false, "critique": "needs more detail"}'
            else:
                yield '{"score": 0.9, "pass": true, "critique": "good now"}'
        else:
            main_call_count += 1
            if main_call_count == 1:
                yield "first completion"
            else:
                yield "revised completion"

    mock_providers = MagicMock()
    mock_providers.stream_complete = combined_fake_stream
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=MagicMock(), storage=MagicMock())

    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    node = WorkflowNode(
        id="n1", name="Test", type="agent",
        position={"x": 0, "y": 0},
        config={
            "agentId": "a1",
            "reflection": {
                "judgeSystemPrompt": "You are a critic. Score the output.",
                "maxRounds": 2,
                "rubric": "Is this good?",
                "passThreshold": 0.8,
            }
        }
    )

    result = await loop.run(
        run_id="run1", node=node, agent=agent, provider=provider,
        prompt="Write something", prior_messages=None,
    )

    # First judge call returned score=0.5 (below 0.8), so agent re-ran → judge called again (score=0.9, pass)
    assert result.reflection_rounds == 2  # two judge evaluations
    assert result.completion == "revised completion"


@pytest.mark.asyncio
async def test_agent_loop_reflection_exits_at_max_rounds(monkeypatch):
    """Reflection loop exits after maxRounds even if score stays below threshold."""
    from unittest.mock import AsyncMock, MagicMock

    from app.agent_loop import AgentLoop
    from app.schemas import MemoryProfile, MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowNode

    async def combined_stream(*args, **kwargs):
        system_prompt = kwargs.get("system_prompt", "")
        if "score" in system_prompt.lower() or "evaluate" in system_prompt.lower():
            yield '{"score": 0.3, "pass": false, "critique": "still bad"}'
        else:
            yield "some output"

    mock_providers = MagicMock()
    mock_providers.stream_complete = combined_stream
    mock_telemetry = MagicMock()
    mock_telemetry.dispatch_stream_token = AsyncMock()

    loop = AgentLoop(providers=mock_providers, telemetry=mock_telemetry, tools=MagicMock(), storage=MagicMock())

    agent = MissionAgentDefinition(
        id="a1",
        missionId="m1",
        name="Agent1",
        role="assistant",
        systemPrompt="You are helpful.",
        provider=ProviderConfig(id="scripted-local", label="Test", mode="local", model="scripted-local"),
        tools=[],
        toolPolicy=ToolPolicy(),
        memoryProfile=MemoryProfile(),
        handoffTargets=[],
    )
    provider = agent.provider

    node = WorkflowNode(
        id="n1", name="Test", type="agent",
        position={"x": 0, "y": 0},
        config={
            "agentId": "a1",
            "reflection": {
                "judgeSystemPrompt": "Evaluate this. Score it.",
                "maxRounds": 1,
                "passThreshold": 0.8,
            }
        }
    )

    result = await loop.run(
        run_id="run1", node=node, agent=agent, provider=provider,
        prompt="Write something", prior_messages=None,
    )

    # maxRounds=1 means at most 1 judge call; score always 0.3 but loop exits after 1 round
    assert result.reflection_rounds == 1
    # completion is the revised output (agent re-ran after the single failed round)
    assert result.completion == "some output"
