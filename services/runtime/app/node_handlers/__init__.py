from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from app.providers import ProviderService
from app.schemas import WorkflowNode
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolRunner


@dataclass
class HandlerServices:
    telemetry: TelemetryHub
    providers: ProviderService
    tools: ToolRunner
    storage: ArtifactStorage


@dataclass
class ExecutionContext:
    run_id: str
    mission_id: str
    input_payload: dict[str, Any]
    control_state: dict[str, Any]
    execution_state: dict[str, Any]
    agent_snapshot: list[dict[str, Any]]
    provider_overrides: dict[str, Any]
    results: dict[str, dict[str, Any]]
    depth: int = 0

    @property
    def template_context(self) -> dict[str, Any]:
        return {
            "mission": {"input": self.input_payload, "control": self.control_state},
            "results": self.results,
        }


@runtime_checkable
class NodeHandler(Protocol):
    async def execute(
        self,
        node: WorkflowNode,
        ctx: ExecutionContext,
    ) -> "NodeResult": ...


@dataclass
class NodeResult:
    payload: dict[str, Any]
    route: str | None = None


# Registry — populated by each handler module on import
_REGISTRY: dict[str, NodeHandler] = {}


def register(node_type: str, handler: NodeHandler) -> None:
    _REGISTRY[node_type] = handler


def get_handler(node_type: str) -> NodeHandler:
    try:
        return _REGISTRY[node_type]
    except KeyError:
        raise KeyError(f"No handler registered for node type '{node_type}'") from None


def build_registry(services: HandlerServices) -> None:
    """Import all handler modules to trigger their register() calls."""
    from app.node_handlers import (  # noqa: F401
        agent,
        delay,
        human_input,
        memory,
        parallel,
        router,
        terminal,
        tool,
    )
    # Inject services into each handler
    for handler in _REGISTRY.values():
        if hasattr(handler, "_services"):
            handler._services = services
