from __future__ import annotations

from typing import TYPE_CHECKING

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class ParallelNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        # Phase 14: pass-through (fan-out handled by batch mechanism in executor)
        # Phase 16 will add map mode here
        return NodeResult(payload={"parallel": True, "node": node.id, "input": ctx.results})


def make_handler(executor: MissionExecutor) -> ParallelNodeHandler:
    handler = ParallelNodeHandler(executor)
    register("parallel", handler)
    return handler
