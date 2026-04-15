from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class TerminalNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        # _run_terminal_node is synchronous and has signature: (node, context) — no run_id
        result = self._executor._run_terminal_node(node, ctx.template_context)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> TerminalNodeHandler:
    handler = TerminalNodeHandler(executor)
    register("terminal", handler)
    return handler
