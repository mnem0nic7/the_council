from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class HumanInputNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        context = ctx.template_context
        result = await self._executor._run_human_input_node(ctx.run_id, node, context)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> HumanInputNodeHandler:
    handler = HumanInputNodeHandler(executor)
    register("human_input", handler)
    return handler
