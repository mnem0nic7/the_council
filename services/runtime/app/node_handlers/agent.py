from __future__ import annotations

import copy
import json
import logging
from typing import TYPE_CHECKING, Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.agent_loop import AgentLoop
    from app.executor import MissionExecutor

logger = logging.getLogger(__name__)


class AgentNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor
        self._loop: AgentLoop | None = None

    def _get_loop(self) -> AgentLoop:
        if self._loop is None:
            from app.agent_loop import AgentLoop
            self._loop = AgentLoop(
                providers=self._executor.providers,
                telemetry=self._executor.telemetry,
                tools=self._executor.tools,
                storage=self._executor.storage,
            )
        return self._loop

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        from app.db import SessionLocal
        from app.models import MissionRun
        from app.schemas import ProviderConfig

        # 1. Resolve agent from snapshot (no DB access)
        agent = self._executor._mission_agent_from_snapshot_from_list(
            ctx.agent_snapshot, node.config["agentId"]
        )

        # 2. Provider override
        overrides: dict[str, Any] = ctx.provider_overrides or {}
        provider_override = overrides.get(node.id) or overrides.get(agent.id)
        provider = (
            ProviderConfig.model_validate(provider_override)
            if provider_override
            else agent.provider
        )

        # 3. Build prompt
        operator_notes = "\n".join((ctx.control_state or {}).get("retask_notes", []))
        prompt_template = node.config.get(
            "promptTemplate",
            (
                "Mission input:\n{{mission.input.prompt}}\n\n"
                "Prior node outputs:\n{{results}}\n\n"
                "Operator retask notes:\n{{mission.control.retask_notes}}"
            ),
        )
        prompt = self._executor._render_value(prompt_template, ctx.template_context)
        if operator_notes and "{{mission.control.retask_notes}}" not in prompt_template:
            prompt = f"{prompt}\n\nRetask notes:\n{operator_notes}"

        # 4. Multi-turn: load history
        prior_messages = None
        multi_turn = bool(node.config.get("multiTurn", False))
        agent_id = agent.id
        prior_history: list[dict] = []
        if multi_turn:
            prior_history = (ctx.execution_state or {}).get("conversations", {}).get(agent_id, [])
            max_history_turns = int(node.config.get("maxHistoryTurns", 10))
            prior_messages = self._executor._build_conversation_messages(
                agent.systemPrompt, prior_history, prompt, max_history_turns
            )

        # 5. Run AgentLoop
        loop = self._get_loop()
        loop_result = await loop.run(
            run_id=ctx.run_id,
            node=node,
            agent=agent,
            provider=provider,
            prompt=prompt,
            prior_messages=prior_messages,
            depth=ctx.depth,
        )
        completion = loop_result.completion

        # 6. Multi-turn: persist updated conversation history
        if multi_turn:
            new_history = prior_history + [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": completion},
            ]
            with SessionLocal() as session:
                run = session.get(MissionRun, ctx.run_id)
                if run is not None:
                    next_state = copy.deepcopy(run.execution_state or {})
                    next_state.setdefault("conversations", {})[agent_id] = new_history
                    run.execution_state = next_state
                    session.commit()

        # 7. Build payload
        payload: dict[str, Any] = {
            "agentId": agent.id,
            "agentName": agent.name,
            "output": completion,
        }
        if loop_result.route:
            payload["route"] = loop_result.route

        # 8. Handle handoff execution
        if loop_result.handoff_chain:
            handoff_target_id = loop_result.handoff_chain[0]
            max_depth = int(node.config.get("maxHandoffDepth", 3))
            if ctx.depth >= max_depth:
                logger.warning(
                    "Handoff depth limit %d reached for node %s; skipping handoff to %s",
                    max_depth, node.id, handoff_target_id,
                )
            else:
                # Emit handoff telemetry
                with SessionLocal() as session:
                    run = session.get(MissionRun, ctx.run_id)
                    if run is not None:
                        self._executor.telemetry.persist_event(
                            session,
                            run.mission_id,
                            run.id,
                            "node.handoff",
                            f"Handing off from {agent.name} to {handoff_target_id}",
                            node_id=node.id,
                            data={"sourceAgent": agent.id, "targetAgent": handoff_target_id},
                        )

                # Resolve target agent from snapshot (no DB access)
                target_agent = None
                try:
                    target_agent = self._executor._mission_agent_from_snapshot_from_list(
                        ctx.agent_snapshot, handoff_target_id
                    )
                except RuntimeError as exc:
                    logger.warning("Handoff target %s not found: %s", handoff_target_id, exc)

                if target_agent is not None:
                    target_node = WorkflowNode(
                        id=f"{node.id}-handoff-{handoff_target_id}",
                        name=f"Handoff: {target_agent.name}",
                        type="agent",
                        position=node.position,
                        config={
                            "agentId": target_agent.id,
                            "promptTemplate": (
                                "You are receiving a handoff from another agent.\n"
                                "Prior agent output:\n{{results." + node.id + ".output}}\n\n"
                                "Mission input:\n{{mission.input.prompt}}"
                            ),
                        },
                    )
                    handoff_ctx = ExecutionContext(
                        run_id=ctx.run_id,
                        mission_id=ctx.mission_id,
                        input_payload=ctx.input_payload,
                        control_state=ctx.control_state,
                        execution_state=ctx.execution_state,
                        agent_snapshot=ctx.agent_snapshot,
                        provider_overrides=ctx.provider_overrides,
                        results={**ctx.results, node.id: {"output": completion}},
                        depth=ctx.depth + 1,
                    )
                    handoff_result = await self.execute(target_node, handoff_ctx)
                    payload["handoffOutput"] = {
                        "agentId": target_agent.id,
                        "agentName": target_agent.name,
                        "output": handoff_result.payload.get("output", ""),
                    }

        # 9. Store artifact
        await self._executor._store_artifact(
            ctx.run_id,
            node.id,
            "agent-output",
            node.name,
            json.dumps(payload, indent=2),
            max_artifacts=agent.toolPolicy.maxArtifacts,
        )

        # 10. Store memory
        await self._executor._store_memory(
            ctx.run_id,
            agent.id,
            agent.memoryProfile.namespace,
            completion,
            tags=["agent", agent.role],
            metadata={"nodeId": node.id},
        )

        return NodeResult(payload=payload, route=loop_result.route)


def make_handler(executor: MissionExecutor) -> AgentNodeHandler:
    handler = AgentNodeHandler(executor)
    register("agent", handler)
    return handler
