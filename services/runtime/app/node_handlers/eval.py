from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.agent_loop import AgentLoop

logger = logging.getLogger(__name__)


class EvalNodeHandler:
    def __init__(self, agent_loop: AgentLoop) -> None:
        self._agent_loop = agent_loop

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        config = node.config
        target_node_id = config["targetNodeId"]
        judge_agent_id = config["judgeAgentId"]
        rubric = config.get(
            "rubric",
            "Evaluate the following output. Return JSON: {score, critique, pass}",
        )
        on_fail = config.get("onFail", "continue")

        # Get target output
        target_output = ctx.results.get(target_node_id, {}).get("output", "")

        # Resolve judge agent from snapshot
        judge_agent = self._resolve_agent(judge_agent_id, ctx)
        if judge_agent is None:
            raise RuntimeError(f"Judge agent {judge_agent_id!r} not found in snapshot")

        # Build eval prompt
        eval_prompt = (
            f"Evaluate the following output according to this rubric:\n{rubric}\n\n"
            f"Output to evaluate:\n{target_output}\n\n"
            f'Respond with JSON only: {{"score": <0-1>, "critique": "<text>", "pass": <true/false>}}'
        )

        # Force JSON output schema
        output_schema = {
            "type": "object",
            "properties": {
                "score": {"type": "number", "minimum": 0, "maximum": 1},
                "critique": {"type": "string"},
                "pass": {"type": "boolean"},
            },
            "required": ["score", "critique", "pass"],
        }

        # Synthetic node with outputSchema to force structured response
        eval_node = WorkflowNode(
            id=f"{node.id}-judge",
            name=f"Eval: {judge_agent.name}",
            type="agent",
            position=node.position,
            config={"agentId": judge_agent_id, "outputSchema": output_schema},
        )

        loop_result = await self._agent_loop.run(
            run_id=ctx.run_id,
            node=eval_node,
            agent=judge_agent,
            provider=judge_agent.provider,
            prompt=eval_prompt,
            prior_messages=None,
        )

        eval_result = loop_result.structured or {}
        passed = bool(eval_result.get("pass", True))

        # TODO: persist eval_result to execution_state.evals[node.id] when DB access is available

        if not passed and on_fail == "fail":
            raise RuntimeError(
                f"Eval node {node.id} failed: score={eval_result.get('score')} "
                f"critique={eval_result.get('critique')}"
            )

        return NodeResult(payload={"eval": eval_result, "targetNodeId": target_node_id})

    def _resolve_agent(self, agent_id: str, ctx: ExecutionContext):
        from app.schemas import MissionAgentDefinition

        for agent_dict in ctx.agent_snapshot:
            if agent_dict.get("id") == agent_id or agent_dict.get("local_id") == agent_id:
                return MissionAgentDefinition.model_validate(agent_dict)
        return None


def make_handler(agent_loop: AgentLoop) -> EvalNodeHandler:
    handler = EvalNodeHandler(agent_loop)
    register("eval", handler)
    return handler
