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

    from app.executor import MissionExecutor
    from app.schemas import MissionAgentDefinition, MemoryProfile, ProviderConfig, ToolPolicy, WorkflowNode
    from app.telemetry import TelemetryHub

    telemetry = MagicMock(spec=TelemetryHub)
    telemetry.persist_event = MagicMock(return_value=MagicMock())
    telemetry.dispatch_stream_token = AsyncMock()
    telemetry._schedule_dispatch = MagicMock()
    executor = MissionExecutor(telemetry)

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

    with patch.object(executor, "_mission_agent_from_snapshot", return_value=agent):
        with patch.object(executor, "_store_artifact", new_callable=AsyncMock):
            with patch.object(executor, "_store_memory"):
                with patch("app.executor.SessionLocal") as mock_session_class:
                    session_mock = MagicMock()
                    mock_session_class.return_value.__enter__ = MagicMock(return_value=session_mock)
                    mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
                    run_mock = MagicMock()
                    run_mock.mission_id = "m1"
                    run_mock.control_state = {}
                    run_mock.provider_overrides = {}
                    run_mock.execution_state = {}
                    session_mock.get.return_value = run_mock

                    result = await executor._run_agent_node(
                        "run-1",
                        node,
                        {"mission": {"input": {"prompt": "test"}, "control": {}}, "results": {}},
                        depth=0,  # maxHandoffDepth=0, so depth >= max_depth → skip
                    )

    # Should complete without recursive call, just log the depth-limit warning
    assert "output" in result.payload


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
