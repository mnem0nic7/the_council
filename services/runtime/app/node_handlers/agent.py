from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class AgentNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        context = ctx.template_context
        result = await self._executor._run_agent_node(ctx.run_id, node, context, ctx.depth)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> AgentNodeHandler:
    handler = AgentNodeHandler(executor)
    register("agent", handler)
    return handler
