from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import traceback
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from app.core.config import get_settings
from app.db import SessionLocal
from app.embeddings import embed_text
from app.migrations import default_control_state
from app.models import Artifact, MemoryRecord, Mission, MissionAgent, MissionRun, NodeErrorRecord, OperatorAction, _HAS_PGVECTOR
from app.providers import ProviderService
from app.schemas import MissionAgentDefinition, ProviderConfig, ToolPolicy, WorkflowDefinition, WorkflowNode
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolPolicyError, ToolRunner
from app.node_handlers import ExecutionContext, NodeResult, get_handler

logger = logging.getLogger(__name__)

TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+)\s*}}")
ACTIVE_RUN_STATUSES = {"queued", "running", "paused", "awaiting_input"}


class MissionCancelled(RuntimeError):
    pass


class MissionExecutor:
    def __init__(self, telemetry: TelemetryHub) -> None:
        self.telemetry = telemetry
        self.providers = ProviderService()
        self.tools = ToolRunner()
        self.storage = ArtifactStorage()
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self._register_handlers()

    def _register_handlers(self) -> None:
        from app.node_handlers import agent, tool, router, parallel, memory, delay, human_input, terminal, subworkflow
        agent.make_handler(self)
        tool.make_handler(self)
        router.make_handler(self)
        parallel.make_handler(self)
        memory.make_handler(self)
        delay.make_handler(self)
        human_input.make_handler(self)
        terminal.make_handler(self)
        subworkflow.make_handler(self)

    def start(self, run_id: str) -> None:
        if run_id not in self.tasks or self.tasks[run_id].done():
            self.tasks[run_id] = asyncio.create_task(self.run(run_id))

    async def run(self, run_id: str) -> None:
        first_start = False
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                return
            mission = session.get(Mission, run.mission_id)
            if mission is None:
                return
            if run.status in {"completed", "failed", "cancelled"} and not (run.control_state or {}).get("paused"):
                return
            if run.started_at is None:
                run.started_at = datetime.now(UTC)
                first_start = True
            if not (run.control_state or {}).get("paused"):
                run.status = "running"
            sync_mission_from_run(mission, run)
            session.commit()
            if first_start:
                self.telemetry.persist_event(session, mission.id, run.id, "mission.started", "Mission launched")

        try:
            await self._execute_workflow(run_id)
        except MissionCancelled:
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    return
                mission = session.get(Mission, run.mission_id)
                if mission is None:
                    return
                run.status = "cancelled"
                run.completed_at = datetime.now(UTC)
                run.current_nodes = []
                sync_mission_from_run(mission, run)
                session.commit()
                self.telemetry.persist_event(
                    session,
                    mission.id,
                    run.id,
                    "mission.cancelled",
                    "Mission cancelled by operator",
                    severity="warning",
                )
        except Exception as exc:  # noqa: BLE001
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    return
                mission = session.get(Mission, run.mission_id)
                if mission is None:
                    return
                run.status = "failed"
                run.completed_at = datetime.now(UTC)
                run.current_nodes = []
                sync_mission_from_run(mission, run)
                session.commit()
                self.telemetry.persist_event(
                    session,
                    mission.id,
                    run.id,
                    "mission.failed",
                    f"Mission failed: {exc}",
                    severity="error",
                    data={"error": str(exc)},
                )
        finally:
            self.tasks.pop(run_id, None)

    async def _execute_workflow(self, run_id: str) -> None:
        while True:
            await self._wait_if_paused(run_id)
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    return
                mission = session.get(Mission, run.mission_id)
                if mission is None:
                    return
                if (run.control_state or {}).get("cancelled"):
                    raise MissionCancelled()

                definition = WorkflowDefinition.model_validate(run.workflow_snapshot)
                state = copy.deepcopy(run.execution_state or {})
                results = copy.deepcopy(state.get("results", {}))
                completed = set(state.get("completedNodes", []))
                batch = self._ready_nodes(definition, completed, results)

                if not batch:
                    if len(completed) == len(definition.nodes):
                        final_payload = {
                            "results": results,
                            "final": results.get(self._terminal_node_id(definition), {}),
                        }
                        run.status = "completed"
                        run.completed_at = datetime.now(UTC)
                        run.current_nodes = []
                        run.output_payload = final_payload
                        sync_mission_from_run(mission, run)
                        session.commit()
                        self.telemetry.persist_event(
                            session,
                            mission.id,
                            run.id,
                            "mission.completed",
                            "Mission completed",
                            data=final_payload,
                        )
                        return
                    raise RuntimeError("Workflow reached a non-executable state")

                node_map = {node.id: node for node in definition.nodes}
                run.current_nodes = batch
                run.status = "running"
                sync_mission_from_run(mission, run)
                session.commit()
                self.telemetry.persist_event(
                    session,
                    mission.id,
                    run.id,
                    "batch.started",
                    f"Executing nodes: {', '.join(batch)}",
                    data={"nodes": batch},
                )

            batch_results = await asyncio.gather(
                *(self._execute_node(run_id, node_map[node_id], results) for node_id in batch)
            )

            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    return
                mission = session.get(Mission, run.mission_id)
                if mission is None:
                    return
                next_state = copy.deepcopy(run.execution_state or {})
                next_results = copy.deepcopy(next_state.get("results", {}))
                next_completed = set(next_state.get("completedNodes", []))
                for node_id, result in zip(batch, batch_results, strict=True):
                    next_results[node_id] = result.payload
                    next_completed.add(node_id)
                next_state["results"] = next_results
                next_state["completedNodes"] = sorted(next_completed)
                run.execution_state = next_state
                run.current_nodes = []
                sync_mission_from_run(mission, run)
                session.commit()

    async def _execute_workflow_inline(
        self,
        run_id: str,
        workflow,  # WorkflowDefinition
        ctx: ExecutionContext,
    ) -> dict[str, Any]:
        """Execute a workflow definition against a pre-built context. Returns results dict."""
        definition = workflow
        completed: set[str] = set()
        results: dict[str, Any] = dict(ctx.results)

        while True:
            batch = self._ready_nodes(definition, completed, results)
            if not batch:
                break
            node_map = {node.id: node for node in definition.nodes}
            batch_nodes = [node_map[nid] for nid in batch if nid in node_map]
            batch_results = await asyncio.gather(
                *(self._execute_node(run_id, node, results) for node in batch_nodes)
            )
            for nid, result in zip(batch, batch_results, strict=True):
                results[nid] = result.payload
                completed.add(nid)

        return results

    async def _wait_if_paused(self, run_id: str) -> None:
        while True:
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    return
                mission = session.get(Mission, run.mission_id)
                if mission is None:
                    return
                control_state = run.control_state or {}
                if control_state.get("cancelled"):
                    raise MissionCancelled()
                if not control_state.get("paused"):
                    if run.status == "paused":
                        run.status = "running"
                        sync_mission_from_run(mission, run)
                        session.commit()
                    return
                if run.status != "paused":
                    run.status = "paused"
                    sync_mission_from_run(mission, run)
                    session.commit()
            await asyncio.sleep(0.25)

    async def _execute_node(
        self,
        run_id: str,
        node: WorkflowNode,
        results: dict[str, dict[str, Any]],
    ) -> NodeResult:
        retry_cfg = node.config.get("retry", {})
        max_attempts = int(retry_cfg.get("maxAttempts", 1))
        backoff_seconds = float(retry_cfg.get("backoffSeconds", 1))
        backoff_multiplier = float(retry_cfg.get("backoffMultiplier", 2))
        on_exhausted = retry_cfg.get("onExhausted", "fail")
        fallback_node_id = node.config.get("fallbackNodeId")

        last_exc: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                return await self._execute_node_once(run_id, node, results)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                # Record error in quarantine table
                await self._record_node_error(run_id, node.id, attempt, exc)

                if attempt < max_attempts:
                    # Emit retry event
                    with SessionLocal() as session:
                        run = session.get(MissionRun, run_id)
                        if run is not None:
                            self.telemetry.persist_event(
                                session,
                                run.mission_id,
                                run_id,
                                "node.retry",
                                f"{node.name} retry {attempt}/{max_attempts}: {exc}",
                                node_id=node.id,
                                severity="warning",
                                data={"attempt": attempt, "maxAttempts": max_attempts, "error": str(exc)},
                            )
                    delay = backoff_seconds * (backoff_multiplier ** (attempt - 1))
                    await asyncio.sleep(delay)
                else:
                    # Exhausted
                    if on_exhausted == "skip":
                        with SessionLocal() as session:
                            run = session.get(MissionRun, run_id)
                            if run is not None:
                                self.telemetry.persist_event(
                                    session,
                                    run.mission_id,
                                    run_id,
                                    "node.skipped",
                                    f"{node.name} skipped after {max_attempts} attempts: {exc}",
                                    node_id=node.id,
                                    severity="warning",
                                    data={"skipped": True, "error": str(exc)},
                                )
                        return NodeResult(payload={"skipped": True, "error": str(last_exc)})
                    elif on_exhausted == "fallback" and fallback_node_id:
                        # Find the fallback node in the workflow and run it
                        with SessionLocal() as session:
                            run = session.get(MissionRun, run_id)
                            if run is None:
                                raise RuntimeError("Run not found")
                            definition = WorkflowDefinition.model_validate(run.workflow_snapshot)
                            fallback_node = next(
                                (n for n in definition.nodes if n.id == fallback_node_id), None
                            )
                            if fallback_node is None:
                                raise RuntimeError(f"Fallback node {fallback_node_id} not found")
                        self.telemetry._schedule_dispatch(
                            run_id,
                            {"type": "node.fallback", "nodeId": node.id, "fallbackNodeId": fallback_node_id},
                        )
                        return await self._execute_node_once(run_id, fallback_node, results)
                    else:
                        if on_exhausted == "fallback":
                            logger.warning(
                                "Node %s configured onExhausted=fallback but fallbackNodeId is missing; failing instead",
                                node.id,
                            )
                        # "fail" mode: re-raise original exception
                        raise last_exc  # type: ignore[misc]

        # Should never reach here
        raise RuntimeError("Retry loop exited without returning or raising")

    async def _execute_node_once(
        self,
        run_id: str,
        node: WorkflowNode,
        results: dict[str, dict[str, Any]],
    ) -> NodeResult:
        ctx: ExecutionContext
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                raise RuntimeError("Run not found")
            mission = session.get(Mission, run.mission_id)
            if mission is None:
                raise RuntimeError("Mission not found")
            ctx = ExecutionContext(
                run_id=run_id,
                mission_id=run.mission_id,
                input_payload=run.input_payload or {},
                control_state=run.control_state or {},
                execution_state=run.execution_state or {},
                agent_snapshot=run.agent_snapshot or [],
                provider_overrides=run.provider_overrides or {},
                results=results,
            )
            self.telemetry.persist_event(
                session,
                mission.id,
                run.id,
                "node.started",
                f"{node.name} engaged",
                node_id=node.id,
                data={"type": node.type},
            )

        try:
            handler = get_handler(node.type)
            result = await handler.execute(node, ctx)
        except Exception as exc:  # noqa: BLE001
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is not None:
                    self.telemetry.persist_event(
                        session,
                        run.mission_id,
                        run.id,
                        "node.failed",
                        f"{node.name} failed: {exc}",
                        node_id=node.id,
                        severity="error",
                        data={"error": str(exc)},
                    )
            raise

        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is not None:
                self.telemetry.persist_event(
                    session,
                    run.mission_id,
                    run.id,
                    "node.completed",
                    f"{node.name} complete",
                    node_id=node.id,
                    data=result.payload,
                )
        return result

    @staticmethod
    def _build_conversation_messages(
        system_prompt: str,
        history: list[dict],
        new_user_prompt: str,
        max_history_turns: int,
    ) -> list[dict]:
        """Build message list with system prompt and history, truncated to max_history_turns."""
        messages = [{"role": "system", "content": system_prompt}]
        # Add history, keeping last max_history_turns pairs (user+assistant)
        max_messages = max_history_turns * 2
        trimmed = history[-max_messages:] if len(history) > max_messages else history
        messages.extend(trimmed)
        messages.append({"role": "user", "content": new_user_prompt})
        return messages

    async def _run_tool_node(self, run_id: str, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                raise RuntimeError("Run not found")
            agent = self._mission_agent_from_snapshot(run, node.config["agentId"])
            disabled_tools = set((run.control_state or {}).get("disabled_tools", []))
            tool_name = node.config["tool"]
            if tool_name in disabled_tools:
                raise ToolPolicyError(f"Tool {tool_name} has been disabled by the operator")
            policy = ToolPolicy.model_validate(agent.toolPolicy)
            mission_id = run.mission_id

        rendered_args = self._render_value(node.config.get("args", {}), context)
        result = await self.tools.run(tool_name, rendered_args, policy, run_id)
        await self._store_artifact(
            run_id,
            node.id,
            f"{tool_name}-result",
            node.name,
            self.tools.artifact_payload(result),
            max_artifacts=policy.maxArtifacts,
        )
        return NodeResult(payload={"agentId": agent.id, "tool": tool_name, "result": result, "missionId": mission_id})

    def _run_router_node(self, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        route = self._render_value(node.config.get("route", "{{mission.input.route}}"), context)
        if isinstance(route, dict):
            route = route.get("route")
        route_value = str(route)
        return NodeResult(payload={"route": route_value}, route=route_value)

    async def _run_memory_node(self, run_id: str, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        mode = node.config.get("mode", "write")
        namespace = node.config.get("namespace", get_settings().default_memory_namespace)
        if mode == "write":
            content = str(self._render_value(node.config.get("content", "{{results}}"), context))
            await self._store_memory(run_id, None, namespace, content, tags=["workflow"], metadata={"nodeId": node.id})
            return NodeResult(payload={"mode": mode, "namespace": namespace, "content": content})

        query = str(self._render_value(node.config.get("query", "{{mission.input.prompt}}"), context))
        top_k = int(node.config.get("topK", 3))

        # Try vector search first when embedding is enabled
        settings = get_settings()
        if settings.embedding_enabled:
            query_embedding = await embed_text(query)
            if query_embedding is not None:
                try:
                    with SessionLocal() as session:
                        stmt = (
                            select(MemoryRecord)
                            .where(MemoryRecord.namespace == namespace)
                            .where(MemoryRecord.embedding.isnot(None))
                            .order_by(MemoryRecord.embedding.cosine_distance(query_embedding))
                            .limit(top_k)
                        )
                        records = session.scalars(stmt).all()
                    if records:
                        return NodeResult(
                            payload={
                                "mode": mode,
                                "namespace": namespace,
                                "matches": [record.content for record in records],
                            }
                        )
                except Exception:  # noqa: BLE001
                    pass  # fall through to term-overlap

        # Fallback: term-overlap scoring
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

    async def _run_delay_node(self, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        seconds = float(self._render_value(node.config.get("seconds", 1), context))
        await asyncio.sleep(seconds)
        return NodeResult(payload={"seconds": seconds})

    async def _run_human_input_node(self, run_id: str, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        """Block until operator provides input or timeout expires."""
        if "defaultInput" in node.config:
            default_input = self._render_value(node.config["defaultInput"], context)
            return NodeResult(payload={"input": default_input})

        timeout_seconds = float(node.config.get("timeoutSeconds", 3600))
        prompt_text = str(self._render_value(node.config.get("prompt", "Operator input required"), context))

        # Set run to awaiting_input status
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                raise RuntimeError("Run not found")
            mission = session.get(Mission, run.mission_id)
            if mission is None:
                raise RuntimeError("Mission not found")
            control_state = copy.deepcopy(run.control_state or {})
            control_state["awaiting_input_node"] = node.id
            control_state["awaiting_input_prompt"] = prompt_text
            run.control_state = control_state
            run.status = "awaiting_input"
            sync_mission_from_run(mission, run)
            session.commit()
            self.telemetry.persist_event(
                session,
                mission.id,
                run_id,
                "node.awaiting_input",
                f"{node.name} awaiting operator input: {prompt_text}",
                node_id=node.id,
                data={"prompt": prompt_text},
            )

        # Poll for response
        deadline = asyncio.get_event_loop().time() + timeout_seconds
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.5)
            with SessionLocal() as session:
                run = session.get(MissionRun, run_id)
                if run is None:
                    raise RuntimeError("Run not found")
                control_state = run.control_state or {}
                if "human_input_response" in control_state:
                    response = control_state["human_input_response"]
                    # Clear the response and restore running status
                    next_control = copy.deepcopy(control_state)
                    del next_control["human_input_response"]
                    next_control.pop("awaiting_input_node", None)
                    next_control.pop("awaiting_input_prompt", None)
                    mission = session.get(Mission, run.mission_id)
                    if mission is None:
                        raise RuntimeError("Mission not found")
                    run.control_state = next_control
                    run.status = "running"
                    sync_mission_from_run(mission, run)
                    session.commit()
                    return NodeResult(payload={"input": response})
                if control_state.get("cancelled"):
                    raise MissionCancelled()

        raise RuntimeError(f"human_input node timed out after {timeout_seconds}s waiting for operator input")

    def _run_terminal_node(self, node: WorkflowNode, context: dict[str, Any]) -> NodeResult:
        output = self._render_value(node.config.get("output", "{{results}}"), context)
        return NodeResult(payload={"terminal": True, "output": output})

    def _mission_agent_from_snapshot(self, run: MissionRun, mission_agent_id: str) -> MissionAgentDefinition:
        for payload in run.agent_snapshot or []:
            if payload.get("id") == mission_agent_id:
                return MissionAgentDefinition.model_validate(payload)
        raise RuntimeError(f"Mission agent {mission_agent_id} not found")

    def _mission_agent_from_snapshot_from_list(
        self, agent_snapshot: list[dict], mission_agent_id: str
    ) -> MissionAgentDefinition:
        """Resolve a MissionAgentDefinition from an in-memory snapshot list (no DB access)."""
        for payload in agent_snapshot or []:
            if payload.get("id") == mission_agent_id or payload.get("local_id") == mission_agent_id:
                return MissionAgentDefinition.model_validate(payload)
        raise RuntimeError(f"Agent '{mission_agent_id}' not found in snapshot")

    def _ready_nodes(
        self,
        definition: WorkflowDefinition,
        completed: set[str],
        results: dict[str, dict[str, Any]],
    ) -> list[str]:
        incoming: dict[str, list[Any]] = {node.id: [] for node in definition.nodes}
        for edge in definition.edges:
            incoming.setdefault(edge.target, []).append(edge)

        ready: list[str] = []
        for node in definition.nodes:
            if node.id in completed:
                continue
            edges = incoming.get(node.id, [])
            if not edges:
                ready.append(node.id)
                continue
            sources = {edge.source for edge in edges}
            if not sources.issubset(completed):
                continue
            if any(self._edge_allows(edge.condition, results.get(edge.source)) for edge in edges):
                ready.append(node.id)
        return ready

    def _edge_allows(self, condition: str | None, result_payload: dict[str, Any] | None) -> bool:
        if condition is None:
            return True
        if not isinstance(result_payload, dict):
            return False
        return str(result_payload.get("route")) == condition

    def _terminal_node_id(self, definition: WorkflowDefinition) -> str:
        for node in definition.nodes:
            if node.type == "terminal":
                return node.id
        return definition.nodes[-1].id

    async def _store_artifact(
        self, run_id: str, node_id: str, kind: str, label: str, content: str, *, max_artifacts: int = 20
    ) -> None:
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                return
            mission_id = run.mission_id
            count = session.execute(
                select(func.count()).select_from(Artifact).where(Artifact.run_id == run_id)
            ).scalar()
            if count >= max_artifacts:
                self.telemetry.persist_event(
                    session,
                    mission_id,
                    run_id,
                    "node.artifact_limit_reached",
                    f"Artifact limit of {max_artifacts} reached for run {run_id}; skipping store",
                    severity="warning",
                    node_id=node_id,
                )
                return
        stored = await self.storage.store_text(mission_id, run_id, node_id, kind, content)
        with SessionLocal() as session:
            artifact = Artifact(
                mission_id=mission_id,
                run_id=run_id,
                node_id=node_id,
                kind=kind,
                label=label,
                uri=stored.uri,
                content_text=stored.preview,
                metadata_json=stored.metadata,
            )
            session.add(artifact)
            session.commit()

    async def _store_memory(
        self,
        run_id: str,
        mission_agent_id: str | None,
        namespace: str,
        content: str,
        *,
        tags: list[str],
        metadata: dict[str, Any],
    ) -> None:
        # Only generate and store embeddings when pgvector column is available.
        # LargeBinary (SQLite fallback) cannot store a list[float] natively.
        embedding = await embed_text(content) if _HAS_PGVECTOR else None
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                return
            record = MemoryRecord(
                mission_id=run.mission_id,
                run_id=run_id,
                agent_id=mission_agent_id,
                mission_agent_id=mission_agent_id,
                namespace=namespace,
                content=content,
                tags=tags,
                metadata_json=metadata,
                embedding=embedding,
            )
            session.add(record)
            session.commit()

    async def _record_node_error(self, run_id: str, node_id: str, attempt: int, exc: Exception) -> None:
        with SessionLocal() as session:
            run = session.get(MissionRun, run_id)
            if run is None:
                return
            record = NodeErrorRecord(
                mission_id=run.mission_id,
                run_id=run_id,
                node_id=node_id,
                attempt=attempt,
                error_type=type(exc).__name__,
                error_message=str(exc),
                traceback=traceback.format_exc(),
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


def sync_mission_from_run(mission: Mission, run: MissionRun) -> None:
    mission.status = run.status
    mission.input_payload = copy.deepcopy(run.input_payload or {})
    mission.output_payload = copy.deepcopy(run.output_payload or {})
    mission.current_nodes = copy.deepcopy(run.current_nodes or [])
    mission.provider_overrides = copy.deepcopy(run.provider_overrides or {})
    mission.control_state = copy.deepcopy(run.control_state or default_control_state())
    mission.started_at = run.started_at
    mission.completed_at = run.completed_at
    mission.latest_run_id = run.id
    mission.active_run_id = run.id if run.status in ACTIVE_RUN_STATUSES else None


def apply_operator_action(run: MissionRun, action: str, payload: dict[str, Any]) -> None:
    control_state = copy.deepcopy(run.control_state or default_control_state())
    control_state.setdefault("retask_notes", [])
    control_state.setdefault("disabled_tools", [])

    if action == "pause":
        control_state["paused"] = True
        if run.status not in {"completed", "failed", "cancelled"}:
            run.status = "paused"
    elif action == "resume":
        control_state["paused"] = False
        if run.status == "paused":
            run.status = "running"
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
    elif action == "provide_input":
        input_text = payload.get("input", "")
        control_state["human_input_response"] = input_text

    run.control_state = control_state


def record_operator_action(mission_id: str, run_id: str, action: str, payload: dict[str, Any]) -> None:
    with SessionLocal() as session:
        session.add(OperatorAction(mission_id=mission_id, run_id=run_id, action=action, payload=payload))
        session.commit()
