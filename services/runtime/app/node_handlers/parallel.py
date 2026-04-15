from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class ParallelNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        mode = node.config.get("mode", "fan_out")

        if mode == "fan_out":
            return NodeResult(payload={"parallel": True, "node": node.id, "input": ctx.results})

        if mode == "map":
            input_path = node.config["inputPath"]
            subgraph = node.config["subgraph"]
            output_key = node.config.get("outputKey", "mapped_results")
            join_mode = node.config.get("joinMode", "all")

            items = self._resolve_path(input_path, ctx.results)
            if not isinstance(items, list):
                raise ValueError(f"inputPath {input_path!r} must resolve to a list, got {type(items)}")

            async def run_item(item: Any) -> dict[str, Any]:
                item_ctx = ExecutionContext(
                    run_id=ctx.run_id,
                    mission_id=ctx.mission_id,
                    input_payload=ctx.input_payload,
                    control_state=ctx.control_state,
                    execution_state=ctx.execution_state,
                    agent_snapshot=ctx.agent_snapshot,
                    provider_overrides=ctx.provider_overrides,
                    results={**ctx.results, "_item": {"value": item}},
                    depth=ctx.depth,
                )
                return await self._execute_subgraph(subgraph, item_ctx)

            tasks = [asyncio.create_task(run_item(item)) for item in items]

            if join_mode == "any":
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):
                        pass
                results_list = [t.result() for t in done]
            else:
                results_list = list(await asyncio.gather(*tasks))

            return NodeResult(payload={output_key: results_list})

        raise ValueError(f"Unknown parallel mode: {mode!r}")

    def _resolve_path(self, path: str, results: dict[str, Any]) -> Any:
        parts = path.split(".")
        value: Any = {"results": results}
        for part in parts:
            try:
                value = value[part]
            except (KeyError, TypeError) as exc:
                raise KeyError(f"Path {path!r} not found at {part!r}") from exc
        return value

    async def _execute_subgraph(self, node_ids: list[str], ctx: ExecutionContext) -> dict[str, Any]:
        """Run a list of node IDs sequentially and return final result payload."""
        from app.node_handlers import get_handler
        result: dict[str, Any] = {}
        current_ctx = ctx
        for node_id in node_ids:
            node = self._get_node_from_snapshot(node_id, current_ctx)
            handler = get_handler(node.type)
            node_result = await handler.execute(node, current_ctx)
            result = node_result.payload
            current_ctx = ExecutionContext(
                run_id=current_ctx.run_id,
                mission_id=current_ctx.mission_id,
                input_payload=current_ctx.input_payload,
                control_state=current_ctx.control_state,
                execution_state=current_ctx.execution_state,
                agent_snapshot=current_ctx.agent_snapshot,
                provider_overrides=current_ctx.provider_overrides,
                results={**current_ctx.results, node_id: result},
                depth=current_ctx.depth,
            )
        return result

    def _get_node_from_snapshot(self, node_id: str, ctx: ExecutionContext):
        """Get a WorkflowNode from the execution state (workflow_snapshot)."""
        # execution_state may contain "workflow_snapshot" for subgraph execution
        workflow_snapshot = (ctx.execution_state or {}).get("workflow_snapshot", {})
        nodes = workflow_snapshot.get("nodes", [])
        from app.schemas import WorkflowNode as WFNode
        for n in nodes:
            if n.get("id") == node_id:
                return WFNode.model_validate(n)
        raise RuntimeError(f"Node {node_id!r} not found in workflow_snapshot")


def make_handler(executor: MissionExecutor) -> ParallelNodeHandler:
    handler = ParallelNodeHandler(executor)
    register("parallel", handler)
    return handler
