from __future__ import annotations

import copy
import re
from typing import TYPE_CHECKING, Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor

TEMPLATE_PATTERN = re.compile(r"\{\{\s*([^}]+)\s*\}\}")


class SubworkflowNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        config = node.config
        max_depth = int(config.get("maxDepth", 3))

        if ctx.depth >= max_depth:
            raise RuntimeError(
                f"Subworkflow depth limit {max_depth} reached at node {node.id}"
            )

        # Resolve workflow definition
        workflow = await self._resolve_workflow(config, ctx)

        # Apply inputMapping — render template strings against parent context
        input_mapping = config.get("inputMapping", {})
        sub_input = {
            key: self._render(template, ctx.template_context)
            for key, template in input_mapping.items()
        }

        # Build child execution context
        child_ctx = ExecutionContext(
            run_id=ctx.run_id,
            mission_id=ctx.mission_id,
            input_payload={**ctx.input_payload, **sub_input},
            control_state=ctx.control_state,
            execution_state=copy.deepcopy(ctx.execution_state),
            agent_snapshot=ctx.agent_snapshot,
            provider_overrides=ctx.provider_overrides,
            results={},
            depth=ctx.depth + 1,
        )

        # Execute sub-workflow
        sub_results = await self._execute_inline(
            ctx.run_id,
            workflow,
            child_ctx,
            node_id_prefix=f"sub:{node.id}:",
        )

        # Apply outputMapping
        output_mapping = config.get("outputMapping", {})
        payload: dict[str, Any] = {}
        for key, path in output_mapping.items():
            parts = path.split(".")
            value: Any = {"results": sub_results}
            try:
                for part in parts:
                    value = value[part]
                payload[key] = value
            except (KeyError, TypeError):
                payload[key] = None

        if not payload:
            payload = sub_results

        return NodeResult(payload=payload)

    async def _resolve_workflow(self, config: dict[str, Any], ctx: ExecutionContext):
        from app.schemas import WorkflowDefinition
        if "inline" in config:
            raw = dict(config["inline"])
            # Provide default id/name when the inline spec omits them
            raw.setdefault("id", f"inline-{ctx.run_id}")
            raw.setdefault("name", "inline-subworkflow")
            return WorkflowDefinition.model_validate(raw)
        workflow_id = config.get("workflowId")
        if not workflow_id:
            raise ValueError("subworkflow node requires 'workflowId' or 'inline' config")
        from app.db import SessionLocal
        from app.models import Workflow
        with SessionLocal() as session:
            wf = session.get(Workflow, workflow_id)
            if wf is None:
                raise RuntimeError(f"Workflow {workflow_id!r} not found")
            return WorkflowDefinition.model_validate(wf.definition)

    async def _execute_inline(
        self,
        run_id: str,
        workflow,
        child_ctx: ExecutionContext,
        node_id_prefix: str = "",
    ) -> dict[str, Any]:
        """Execute a workflow definition against a pre-built child context."""
        if self._executor is None:
            return {}
        return await self._executor._execute_workflow_inline(run_id, workflow, child_ctx)

    def _render(self, template: str, context: dict[str, Any]) -> str:
        if not isinstance(template, str):
            return str(template)

        def replace(match: re.Match) -> str:
            path = match.group(1).strip()
            parts = path.split(".")
            value: Any = context
            try:
                for part in parts:
                    value = value[part]
                return str(value)
            except (KeyError, TypeError):
                return match.group(0)

        return TEMPLATE_PATTERN.sub(replace, template)


def make_handler(executor: MissionExecutor) -> SubworkflowNodeHandler:
    handler = SubworkflowNodeHandler(executor)
    register("subworkflow", handler)
    return handler
