from __future__ import annotations

import json as _json
import logging
from dataclasses import dataclass, field
from typing import Any

import jsonschema
from litellm import acompletion

from app.providers import ProviderService
from app.schemas import MissionAgentDefinition, ProviderConfig, WorkflowNode
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolRunner

logger = logging.getLogger(__name__)


class FunctionDispatcher:
    def __init__(self, tools: ToolRunner) -> None:
        self.tools = tools

    async def dispatch(
        self,
        function_name: str,
        arguments: dict[str, Any],
        handler_type: str,
        run_id: str,
        node_id: str,
    ) -> str:
        if handler_type == "tool_call":
            tool_name = arguments.get("tool", function_name)
            tool_args = arguments.get("args", arguments)
            try:
                result = await self.tools.run(tool_name, tool_args, policy=None, run_id=run_id)
                return str(result)
            except Exception as exc:
                return f"Error: {exc}"
        elif handler_type == "memory_search":
            return f"[memory_search not yet implemented for query: {arguments.get('query', '')}]"
        else:
            return f"[unknown handler: {handler_type}]"


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
        # --- Native function-calling path ---
        native_functions = node.config.get("nativeFunctions", [])
        function_call_log: list[dict[str, Any]] = []

        if native_functions:
            lm_tools = [
                {
                    "type": "function",
                    "function": {
                        "name": fn["name"],
                        "description": fn["description"],
                        "parameters": fn.get("parameters", {}),
                    },
                }
                for fn in native_functions
            ]
            fn_handler_map = {fn["name"]: fn.get("handler", "tool_call") for fn in native_functions}
            dispatcher = FunctionDispatcher(self.tools)

            loop_messages: list[dict] = [
                {"role": "system", "content": agent.systemPrompt},
                {"role": "user", "content": prompt},
            ]

            max_rounds = int(node.config.get("maxFunctionCallRounds", 5))
            completion = ""

            for _round in range(max_rounds):
                response = await acompletion(
                    model=provider.model,
                    messages=loop_messages,
                    tools=lm_tools,
                )
                msg = response.choices[0].message

                if msg.tool_calls:
                    loop_messages.append(
                        {"role": "assistant", "tool_calls": [tc.model_dump() for tc in msg.tool_calls]}
                    )
                    for tc in msg.tool_calls:
                        fn_name = tc.function.name
                        fn_args = _json.loads(tc.function.arguments or "{}")
                        handler_type = fn_handler_map.get(fn_name, "tool_call")
                        fn_result = await dispatcher.dispatch(
                            fn_name, fn_args, handler_type, run_id, node.id
                        )
                        loop_messages.append(
                            {"role": "tool", "tool_call_id": tc.id, "content": fn_result}
                        )
                        function_call_log.append({"name": fn_name, "args": fn_args, "result": fn_result})
                else:
                    completion = msg.content or ""
                    break
            else:
                logger.warning(
                    "maxFunctionCallRounds=%d reached for node %s", max_rounds, node.id
                )
                completion = ""

            # Detect ROUTE: and return early — skip the streaming section
            route: str | None = None
            if "ROUTE:" in completion:
                route = completion.split("ROUTE:", 1)[1].splitlines()[0].strip()
            return LoopResult(completion=completion, route=route, function_call_log=function_call_log)

        # --- Streaming path (no nativeFunctions) ---
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
