from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class DelayNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        # _run_delay_node signature: (node, context) — no run_id
        result = await self._executor._run_delay_node(node, ctx.template_context)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> DelayNodeHandler:
    handler = DelayNodeHandler(executor)
    register("delay", handler)
    return handler
