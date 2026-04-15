from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class RouterNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        # _run_router_node is synchronous and fast (no I/O), call directly
        result = self._executor._run_router_node(node, ctx.template_context)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> RouterNodeHandler:
    handler = RouterNodeHandler(executor)
    register("router", handler)
    return handler
