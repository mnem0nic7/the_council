from __future__ import annotations

import time

import pytest

from app.schemas import ToolPolicy, WorkflowDefinition
from app.tools import ToolPolicyError, ToolRunner


def wait_for_mission_status(client, headers: dict[str, str], mission_id: str, expected: set[str], timeout: float = 6.0):
    deadline = time.time() + timeout
    last_payload = None
    while time.time() < deadline:
        response = client.get(f"/api/v1/missions/{mission_id}", headers=headers)
        response.raise_for_status()
        last_payload = response.json()
        if last_payload["status"] in expected:
            return last_payload
        time.sleep(0.1)
    raise AssertionError(f"Mission {mission_id} did not reach {expected}; last payload was {last_payload}")


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
        await runner.run("shell", {"command": "uname -a"}, policy, "mission-test")


def test_mission_executes_seeded_branching_workflow_and_persists_replay(client, auth_headers) -> None:
    launch = client.post(
        "/api/v1/missions",
        headers=auth_headers,
        json={
            "workflowId": "bridge-assessment",
            "name": "Bridge Validation",
            "input": {"prompt": "Assess the bridge and draft a readiness brief.", "route": "analysis"},
        },
    )
    launch.raise_for_status()
    mission_id = launch.json()["id"]

    mission = wait_for_mission_status(client, auth_headers, mission_id, {"completed"})
    assert mission["output"]["results"]["navigator-brief"]["agentId"] == "navigator"
    assert "engineering_report.txt" in mission["output"]["results"]["engineering-scan"]["result"]["stdout"]

    replay = client.get(f"/api/v1/missions/{mission_id}/replay", headers=auth_headers)
    replay.raise_for_status()
    payload = replay.json()
    assert len(payload["events"]) >= 4
    assert any(artifact["kind"] == "agent-output" for artifact in payload["artifacts"])
    agent_artifact = next(artifact for artifact in payload["artifacts"] if artifact["kind"] == "agent-output")
    assert agent_artifact["metadata"]["storageBackend"] == "filesystem"
    assert agent_artifact["uri"].endswith(".json")
    assert any(memory["namespace"] == "archive" for memory in payload["memories"])


def test_runtime_settings_report_storage_backend(client, auth_headers) -> None:
    response = client.get("/api/v1/settings/runtime", headers=auth_headers)
    response.raise_for_status()
    payload = response.json()
    assert payload["storage"]["artifactBackend"] == "filesystem"
    assert payload["storage"]["artifactBucket"] == "council-artifacts"


def test_public_api_health_alias(client) -> None:
    response = client.get("/api/health")
    response.raise_for_status()
    assert response.json() == {"status": "ok"}


def test_operator_can_pause_resume_and_disable_tools(client, auth_headers) -> None:
    workflow = {
        "definition": {
            "id": "pause-check",
            "name": "Pause Check",
            "description": "Exercise mission control actions",
            "version": 1,
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "type": "delay",
                    "position": {"x": 0, "y": 0},
                    "config": {"seconds": 0.8},
                },
                {
                    "id": "tool-node",
                    "name": "Tool Node",
                    "type": "tool",
                    "position": {"x": 220, "y": 0},
                    "config": {
                        "agentId": "engineer",
                        "tool": "shell",
                        "args": {"command": "echo hello"},
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
    created = client.post("/api/v1/workflows", headers=auth_headers, json=workflow)
    created.raise_for_status()

    launch = client.post(
        "/api/v1/missions",
        headers=auth_headers,
        json={"workflowId": "pause-check", "name": "Pause Mission", "input": {"prompt": "pause test", "route": "analysis"}},
    )
    launch.raise_for_status()
    mission_id = launch.json()["id"]

    client.post(f"/api/v1/missions/{mission_id}/actions", headers=auth_headers, json={"action": "pause", "payload": {}})
    client.post(
        f"/api/v1/missions/{mission_id}/actions",
        headers=auth_headers,
        json={"action": "disable_tool", "payload": {"tool": "shell"}},
    )

    paused = wait_for_mission_status(client, auth_headers, mission_id, {"paused", "failed"})
    assert "shell" in paused["controlState"]["disabled_tools"]

    client.post(
        f"/api/v1/missions/{mission_id}/actions",
        headers=auth_headers,
        json={"action": "resume", "payload": {}},
    )

    finished = wait_for_mission_status(client, auth_headers, mission_id, {"failed"})
    assert finished["status"] == "failed"
