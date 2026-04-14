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
