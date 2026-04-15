from __future__ import annotations

import json as _json
import logging
from dataclasses import dataclass, field
from typing import Any

import jsonschema

from app.providers import ProviderService
from app.schemas import MissionAgentDefinition, ProviderConfig, WorkflowNode
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolRunner

logger = logging.getLogger(__name__)


@dataclass
class LoopResult:
    completion: str
    structured: dict[str, Any] | None = None
    route: str | None = None
    handoff_chain: list[str] = field(default_factory=list)
    function_call_log: list[dict[str, Any]] = field(default_factory=list)
    reflection_rounds: int = 0


class AgentLoop:
    def __init__(
        self,
        providers: ProviderService,
        telemetry: TelemetryHub,
        tools: ToolRunner,
        storage: ArtifactStorage,
    ) -> None:
        self.providers = providers
        self.telemetry = telemetry
        self.tools = tools
        self.storage = storage

    async def run(
        self,
        run_id: str,
        node: WorkflowNode,
        agent: MissionAgentDefinition,
        provider: ProviderConfig,
        prompt: str,
        prior_messages: list[dict[str, Any]] | None,
        depth: int = 0,
    ) -> LoopResult:
        """Stream a single completion turn, detect ROUTE: and HANDOFF:, return LoopResult.

        Args:
            run_id: The active mission run identifier.
            node: The workflow node being executed.
            agent: The resolved mission agent definition.
            provider: Provider config to use (may differ from agent.provider due to overrides).
            prompt: The rendered user prompt for this turn.
            prior_messages: Full message list for multi-turn mode (including system prompt and
                history). When None, single-turn mode is used (system_prompt + user_prompt only).
            depth: Current handoff recursion depth (unused in Task 4; recorded for future use).

        Returns:
            LoopResult with completion text, detected ROUTE:, and any valid HANDOFF: target ids.
        """
        chunks: list[str] = []
        seq = 0

        if prior_messages is not None:
            # Multi-turn: pass full messages list to stream_complete
            async for token in self.providers.stream_complete(
                provider,
                system_prompt=agent.systemPrompt,
                user_prompt=prompt,
                messages=prior_messages,
            ):
                chunks.append(token)
                await self.telemetry.dispatch_stream_token(run_id, node.id, token, seq)
                seq += 1
        else:
            # Single-turn
            async for token in self.providers.stream_complete(
                provider,
                system_prompt=agent.systemPrompt,
                user_prompt=prompt,
            ):
                chunks.append(token)
                await self.telemetry.dispatch_stream_token(run_id, node.id, token, seq)
                seq += 1

        completion = "".join(chunks)

        # Structured output handling
        structured: dict[str, Any] | None = None
        output_schema = node.config.get("outputSchema")
        if output_schema:
            try:
                structured = _json.loads(completion)
                jsonschema.validate(structured, output_schema)
            except (ValueError, _json.JSONDecodeError, jsonschema.ValidationError) as exc:
                logger.warning("Structured output parse failed (%s), re-prompting once", exc)
                retry_prompt = (
                    f"{prompt}\n\nIMPORTANT: Your response must be valid JSON matching this schema:\n"
                    f"{_json.dumps(output_schema, indent=2)}\nRespond with JSON only."
                )
                retry_chunks: list[str] = []
                async for token in self.providers.stream_complete(
                    provider,
                    system_prompt=agent.systemPrompt,
                    user_prompt=retry_prompt,
                ):
                    retry_chunks.append(token)
                completion = "".join(retry_chunks)
                try:
                    structured = _json.loads(completion)
                    jsonschema.validate(structured, output_schema)
                except (ValueError, _json.JSONDecodeError, jsonschema.ValidationError):
                    logger.error("Structured output failed after re-prompt for node %s", node.id)
                    structured = None

        # Detect ROUTE:
        route: str | None = None
        if "ROUTE:" in completion:
            route = completion.split("ROUTE:", 1)[1].splitlines()[0].strip()

        # Detect HANDOFF:
        handoff_chain: list[str] = []
        if "HANDOFF:" in completion:
            handoff_target_id = completion.split("HANDOFF:", 1)[1].splitlines()[0].strip()
            if handoff_target_id not in agent.handoffTargets:
                logger.warning(
                    "Agent %s emitted HANDOFF:%s but %s is not in handoffTargets; ignoring",
                    agent.id,
                    handoff_target_id,
                    handoff_target_id,
                )
            else:
                handoff_chain.append(handoff_target_id)

        return LoopResult(
            completion=completion,
            structured=structured,
            route=route,
            handoff_chain=handoff_chain,
        )
