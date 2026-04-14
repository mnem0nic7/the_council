from __future__ import annotations

import asyncio
import copy
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.config import get_settings
from app.db import SessionLocal
from app.models import Agent, Artifact, MemoryRecord, Mission, OperatorAction, Workflow
from app.providers import ProviderService
from app.schemas import AgentDefinition, ProviderConfig, ToolPolicy, WorkflowDefinition
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolPolicyError, ToolRunner

TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+)\s*}}")


@dataclass
class NodeResult:
    payload: dict[str, Any]
    route: str | None = None


class MissionCancelled(RuntimeError):
    pass


class MissionExecutor:
    def __init__(self, telemetry: TelemetryHub) -> None:
        self.telemetry = telemetry
        self.providers = ProviderService()
        self.tools = ToolRunner()
        self.storage = ArtifactStorage()
        self.tasks: dict[str, asyncio.Task[None]] = {}

    def start(self, mission_id: str) -> None:
        if mission_id not in self.tasks or self.tasks[mission_id].done():
            self.tasks[mission_id] = asyncio.create_task(self.run(mission_id))

    async def run(self, mission_id: str) -> None:
        with SessionLocal() as session:
            mission = session.get(Mission, mission_id)
            if mission is None:
                return
            mission.status = "running"
            mission.started_at = datetime.now(UTC)
            session.commit()
            self.telemetry.persist_event(session, mission_id, "mission.started", "Mission launched")

        try:
            await self._execute_workflow(mission_id)
        except MissionCancelled:
            with SessionLocal() as session:
                mission = session.get(Mission, mission_id)
                if mission:
                    mission.status = "cancelled"
                    mission.completed_at = datetime.now(UTC)
                    mission.current_nodes = []
                    session.commit()
                    self.telemetry.persist_event(
                        session, mission_id, "mission.cancelled", "Mission cancelled by operator", severity="warning"
                    )
        except Exception as exc:  # noqa: BLE001
            with SessionLocal() as session:
                mission = session.get(Mission, mission_id)
                if mission:
                    mission.status = "failed"
                    mission.completed_at = datetime.now(UTC)
                    mission.current_nodes = []
                    session.commit()
                    self.telemetry.persist_event(
                        session,
                        mission_id,
                        "mission.failed",
                        f"Mission failed: {exc}",
                        severity="error",
                        data={"error": str(exc)},
                    )
        finally:
            self.tasks.pop(mission_id, None)

    async def _execute_workflow(self, mission_id: str) -> None:
        with SessionLocal() as session:
            mission = session.get(Mission, mission_id)
            workflow = session.get(Workflow, mission.workflow_id)
            definition = WorkflowDefinition.model_validate(workflow.definition)
            adjacency = {node.id: [] for node in definition.nodes}
            predecessors = {node.id: set() for node in definition.nodes}
            edge_lookup = {}
            for edge in definition.edges:
                adjacency[edge.source].append(edge)
                predecessors[edge.target].add(edge.source)
                edge_lookup[(edge.source, edge.target)] = edge
            results: dict[str, dict[str, Any]] = {}
            completed: set[str] = set()
            ready = [node.id for node in definition.nodes if not predecessors[node.id]]

        node_map = {node.id: node for node in definition.nodes}
        while ready:
            await self._wait_if_paused(mission_id)
            batch = ready
            ready = []
            with SessionLocal() as session:
                mission = session.get(Mission, mission_id)
                if mission is None:
                    return
                if mission.control_state.get("cancelled"):
                    raise MissionCancelled()
                mission.current_nodes = batch
                session.commit()
                self.telemetry.persist_event(
                    session,
                    mission_id,
                    "batch.started",
                    f"Executing nodes: {', '.join(batch)}",
                    data={"nodes": batch},
                )

            batch_results = await asyncio.gather(
                *(self._execute_node(mission_id, node_map[node_id], results) for node_id in batch)
            )
            next_candidates: set[str] = set()

            for node_id, result in zip(batch, batch_results, strict=True):
                completed.add(node_id)
                results[node_id] = result.payload
                for edge in adjacency[node_id]:
                    if self._edge_allows(edge.condition, result):
                        next_candidates.add(edge.target)

            for candidate in next_candidates:
                if candidate in completed:
                    continue
                if predecessors[candidate].issubset(completed):
                    ready.append(candidate)

        with SessionLocal() as session:
            mission = session.get(Mission, mission_id)
            if mission is None:
                return
            mission.status = "completed"
            mission.completed_at = datetime.now(UTC)
            mission.current_nodes = []
            mission.output_payload = {
                "results": results,
                "final": results.get(self._terminal_node_id(definition), {}),
            }
            session.commit()
            self.telemetry.persist_event(
                session, mission_id, "mission.completed", "Mission completed", data=mission.output_payload
            )

    async def _wait_if_paused(self, mission_id: str) -> None:
        while True:
            with SessionLocal() as session:
                mission = session.get(Mission, mission_id)
                if mission is None:
                    return
                if mission.control_state.get("cancelled"):
                    raise MissionCancelled()
                if not mission.control_state.get("paused"):
                    if mission.status == "paused":
                        mission.status = "running"
                        session.commit()
                    return
                if mission.status != "paused":
                    mission.status = "paused"
                    session.commit()
            await asyncio.sleep(0.5)

    async def _execute_node(
        self,
        mission_id: str,
        node,
        results: dict[str, dict[str, Any]],
    ) -> NodeResult:
        with SessionLocal() as session:
            mission = session.get(Mission, mission_id)
            context = {"mission": {"input": mission.input_payload, "control": mission.control_state}, "results": results}
            self.telemetry.persist_event(
                session,
                mission_id,
                "node.started",
                f"{node.name} engaged",
                node_id=node.id,
                data={"type": node.type},
            )

        try:
            if node.type == "agent":
                result = await self._run_agent_node(mission_id, node, context)
            elif node.type == "tool":
                result = await self._run_tool_node(mission_id, node, context)
            elif node.type == "router":
                result = self._run_router_node(node, context)
            elif node.type == "parallel":
                result = NodeResult(payload={"parallel": True, "node": node.id})
            elif node.type == "memory":
                result = self._run_memory_node(mission_id, node, context)
            elif node.type == "delay":
                result = await self._run_delay_node(node, context)
            elif node.type == "human_input":
                result = self._run_human_input_node(node, context)
            elif node.type == "terminal":
                result = self._run_terminal_node(node, context)
            else:
                raise RuntimeError(f"Unsupported node type: {node.type}")
        except Exception as exc:  # noqa: BLE001
            with SessionLocal() as session:
                self.telemetry.persist_event(
                    session,
                    mission_id,
                    "node.failed",
                    f"{node.name} failed: {exc}",
                    node_id=node.id,
                    severity="error",
                    data={"error": str(exc)},
                )
            raise

        with SessionLocal() as session:
            self.telemetry.persist_event(
                session,
                mission_id,
                "node.completed",
                f"{node.name} complete",
                node_id=node.id,
                data=result.payload,
            )
        return result

    async def _run_agent_node(self, mission_id: str, node, context: dict[str, Any]) -> NodeResult:
        with SessionLocal() as session:
            agent = session.get(Agent, node.config["agentId"])
            if agent is None:
                raise RuntimeError(f"Agent {node.config['agentId']} not found")
            agent_schema = AgentDefinition(
                id=agent.id,
                name=agent.name,
                role=agent.role,
                description=agent.description,
                systemPrompt=agent.system_prompt,
                provider=ProviderConfig.model_validate(agent.provider_config),
                tools=agent.tools,
                toolPolicy=ToolPolicy.model_validate(agent.tool_policy),
                memoryProfile=agent.memory_profile,
                handoffTargets=agent.handoff_targets,
                createdAt=agent.created_at,
                updatedAt=agent.updated_at,
            )
            mission = session.get(Mission, mission_id)
            overrides = mission.provider_overrides or {}
            provider_override = overrides.get(node.id) or overrides.get(agent.id)
            provider = (
                ProviderConfig.model_validate(provider_override) if provider_override else agent_schema.provider
            )
            operator_notes = "\n".join(mission.control_state.get("retask_notes", []))

        prompt_template = node.config.get(
            "promptTemplate",
            (
                "Mission input:\n{{mission.input.prompt}}\n\n"
                "Prior node outputs:\n{{results}}\n\n"
                "Operator retask notes:\n{{mission.control.retask_notes}}"
            ),
        )
        prompt = self._render_value(prompt_template, context)
        if operator_notes and "{{mission.control.retask_notes}}" not in prompt_template:
            prompt = f"{prompt}\n\nRetask notes:\n{operator_notes}"

        completion = await self.providers.complete(
            provider,
            system_prompt=agent_schema.systemPrompt,
            user_prompt=prompt,
        )
        route = None
        if "ROUTE:" in completion:
            route = completion.split("ROUTE:", 1)[1].splitlines()[0].strip()
        payload = {"agentId": agent.id, "agentName": agent.name, "output": completion}
        await self._store_artifact(mission_id, node.id, "agent-output", node.name, json.dumps(payload, indent=2))
        self._store_memory(
            mission_id,
            agent.id,
            agent_schema.memoryProfile.namespace,
            completion,
            tags=["agent", agent.role],
            metadata={"nodeId": node.id},
        )
        return NodeResult(payload=payload, route=route)

    async def _run_tool_node(self, mission_id: str, node, context: dict[str, Any]) -> NodeResult:
        with SessionLocal() as session:
            agent = session.get(Agent, node.config["agentId"])
            if agent is None:
                raise RuntimeError(f"Agent {node.config['agentId']} not found for tool execution")
            mission = session.get(Mission, mission_id)
            disabled_tools = set(mission.control_state.get("disabled_tools", []))
            tool_name = node.config["tool"]
            if tool_name in disabled_tools:
                raise ToolPolicyError(f"Tool {tool_name} has been disabled by the operator")
            policy = ToolPolicy.model_validate(agent.tool_policy)

        rendered_args = self._render_value(node.config.get("args", {}), context)
        result = await self.tools.run(tool_name, rendered_args, policy, mission_id)
        await self._store_artifact(
            mission_id, node.id, f"{tool_name}-result", node.name, self.tools.artifact_payload(result)
        )
        return NodeResult(payload={"tool": tool_name, "result": result})

    def _run_router_node(self, node, context: dict[str, Any]) -> NodeResult:
        route = self._render_value(node.config.get("route", "{{mission.input.route}}"), context)
        if isinstance(route, dict):
            route = route.get("route")
        return NodeResult(payload={"route": route}, route=str(route))

    def _run_memory_node(self, mission_id: str, node, context: dict[str, Any]) -> NodeResult:
        mode = node.config.get("mode", "write")
        namespace = node.config.get("namespace", get_settings().default_memory_namespace)
        if mode == "write":
            content = str(self._render_value(node.config.get("content", "{{results}}"), context))
            self._store_memory(mission_id, None, namespace, content, tags=["workflow"], metadata={"nodeId": node.id})
            return NodeResult(payload={"mode": mode, "namespace": namespace, "content": content})

        query = str(self._render_value(node.config.get("query", "{{mission.input.prompt}}"), context))
        top_k = int(node.config.get("topK", 3))
        with SessionLocal() as session:
            records = session.scalars(select(MemoryRecord).where(MemoryRecord.namespace == namespace)).all()
        ranked = sorted(records, key=lambda record: self._score_memory(record.content, query), reverse=True)[:top_k]
        return NodeResult(
            payload={
                "mode": mode,
                "namespace": namespace,
                "matches": [record.content for record in ranked if self._score_memory(record.content, query) > 0],
            }
        )

    async def _run_delay_node(self, node, context: dict[str, Any]) -> NodeResult:
        seconds = float(self._render_value(node.config.get("seconds", 1), context))
        await asyncio.sleep(seconds)
        return NodeResult(payload={"seconds": seconds})

    def _run_human_input_node(self, node, context: dict[str, Any]) -> NodeResult:
        if "defaultInput" not in node.config:
            raise RuntimeError("human_input nodes require defaultInput in v1 autonomous mode")
        default_input = self._render_value(node.config["defaultInput"], context)
        return NodeResult(payload={"input": default_input})

    def _run_terminal_node(self, node, context: dict[str, Any]) -> NodeResult:
        output = self._render_value(node.config.get("output", "{{results}}"), context)
        return NodeResult(payload={"terminal": True, "output": output})

    def _edge_allows(self, condition: str | None, result: NodeResult) -> bool:
        if condition is None:
            return True
        return result.route == condition

    def _terminal_node_id(self, definition: WorkflowDefinition) -> str:
        for node in definition.nodes:
            if node.type == "terminal":
                return node.id
        return definition.nodes[-1].id

    async def _store_artifact(self, mission_id: str, node_id: str, kind: str, label: str, content: str) -> None:
        stored = await self.storage.store_text(mission_id, node_id, kind, content)
        with SessionLocal() as session:
            artifact = Artifact(
                mission_id=mission_id,
                node_id=node_id,
                kind=kind,
                label=label,
                uri=stored.uri,
                content_text=stored.preview,
                metadata_json=stored.metadata,
            )
            session.add(artifact)
            session.commit()

    def _store_memory(
        self,
        mission_id: str,
        agent_id: str | None,
        namespace: str,
        content: str,
        *,
        tags: list[str],
        metadata: dict[str, Any],
    ) -> None:
        with SessionLocal() as session:
            record = MemoryRecord(
                mission_id=mission_id,
                agent_id=agent_id,
                namespace=namespace,
                content=content,
                tags=tags,
                metadata_json=metadata,
            )
            session.add(record)
            session.commit()

    def _render_value(self, value: Any, context: dict[str, Any]) -> Any:
        if isinstance(value, dict):
            return {key: self._render_value(val, context) for key, val in value.items()}
        if isinstance(value, list):
            return [self._render_value(item, context) for item in value]
        if not isinstance(value, str):
            return value

        def replace(match: re.Match[str]) -> str:
            path = match.group(1).strip()
            resolved = self._resolve_path(path, context)
            if isinstance(resolved, (dict, list)):
                return json.dumps(resolved)
            return str(resolved if resolved is not None else "")

        return TEMPLATE_PATTERN.sub(replace, value)

    def _resolve_path(self, path: str, context: dict[str, Any]) -> Any:
        current: Any = context
        for part in path.split("."):
            if isinstance(current, dict):
                current = current.get(part)
            else:
                return None
        return current

    def _score_memory(self, content: str, query: str) -> int:
        query_terms = {term for term in query.lower().split() if term}
        return sum(1 for term in query_terms if term in content.lower())


def apply_operator_action(mission: Mission, action: str, payload: dict[str, Any]) -> None:
    control_state = copy.deepcopy(mission.control_state or {})
    control_state.setdefault("retask_notes", [])
    control_state.setdefault("disabled_tools", [])

    if action == "pause":
        control_state["paused"] = True
    elif action == "resume":
        control_state["paused"] = False
    elif action == "cancel":
        control_state["cancelled"] = True
    elif action == "retask":
        note = payload.get("note")
        if note:
            control_state["retask_notes"].append(note)
    elif action == "disable_tool":
        tool_name = payload.get("tool")
        if tool_name and tool_name not in control_state["disabled_tools"]:
            control_state["disabled_tools"].append(tool_name)

    mission.control_state = control_state


def record_operator_action(mission_id: str, action: str, payload: dict[str, Any]) -> None:
    with SessionLocal() as session:
        session.add(OperatorAction(mission_id=mission_id, action=action, payload=payload))
        session.commit()
