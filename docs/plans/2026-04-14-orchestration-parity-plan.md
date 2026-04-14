# Orchestration Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the executor into a NodeHandler registry with a unified AgentLoop, then add parallel fan-out/map, structured outputs, native LLM tool-calling, sub-workflow composition, and evaluation/reflection.

**Architecture:** NodeHandler protocol + registry replaces the monolithic `_execute_node_once` dispatch chain. `AgentLoop` owns the full inner agentic cycle (streaming, function-calling, structured output, reflection, handoffs, multi-turn). New node types `subworkflow` and `eval` plug in as handlers.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy async, litellm, asyncio, pytest, Next.js/TypeScript (contracts + canvas)

**Design doc:** `docs/plans/2026-04-14-orchestration-parity-design.md`

---

## Phase 14: NodeHandler Registry (behaviour-preserving refactor)

**Goal:** Extract the dispatch chain into a registry. All 33 existing tests must pass unchanged after this phase.

---

### Task 1: Create `HandlerServices`, `ExecutionContext`, and `NodeHandler` protocol

**Files:**
- Create: `services/runtime/app/node_handlers/__init__.py`

**Step 1: Write the file**

```python
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
```

**Step 2: Verify syntax**

```bash
cd /workspace/the_council && python -c "from app.node_handlers import HandlerServices, ExecutionContext, NodeResult"
```
Expected: no output (no errors).

**Step 3: Commit**

```bash
git add services/runtime/app/node_handlers/__init__.py
git commit -m "feat: add NodeHandler protocol, HandlerServices, ExecutionContext"
```

---

### Task 2: Create thin handler stubs for all existing node types

**Files:**
- Create: `services/runtime/app/node_handlers/agent.py`
- Create: `services/runtime/app/node_handlers/tool.py`
- Create: `services/runtime/app/node_handlers/router.py`
- Create: `services/runtime/app/node_handlers/parallel.py`
- Create: `services/runtime/app/node_handlers/memory.py`
- Create: `services/runtime/app/node_handlers/delay.py`
- Create: `services/runtime/app/node_handlers/human_input.py`
- Create: `services/runtime/app/node_handlers/terminal.py`

Each handler is a thin wrapper that calls the corresponding executor method. They hold a reference to the executor (passed at build time) until Phase 15 fully decouples them.

**Step 1: Create `agent.py`**

```python
from __future__ import annotations
from typing import TYPE_CHECKING
from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode

if TYPE_CHECKING:
    from app.executor import MissionExecutor


class AgentNodeHandler:
    def __init__(self, executor: MissionExecutor) -> None:
        self._executor = executor

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        context = ctx.template_context
        result = await self._executor._run_agent_node(ctx.run_id, node, context, ctx.depth)
        return NodeResult(payload=result.payload, route=result.route)


def make_handler(executor: MissionExecutor) -> AgentNodeHandler:
    handler = AgentNodeHandler(executor)
    register("agent", handler)
    return handler
```

**Step 2: Create the remaining stubs** (`tool.py`, `router.py`, `memory.py`, `delay.py`, `human_input.py`, `terminal.py`) using the exact same pattern — each wraps the corresponding `_run_*` method:

- `tool.py` → wraps `_run_tool_node`, registers `"tool"`
- `router.py` → wraps `_run_router_node`, registers `"router"`
- `memory.py` → wraps `_run_memory_node`, registers `"memory"`
- `delay.py` → wraps `_run_delay_node`, registers `"delay"`
- `human_input.py` → wraps `_run_human_input_node`, registers `"human_input"`
- `terminal.py` → wraps `_run_terminal_node`, registers `"terminal"`

**Step 3: Create `parallel.py`** (fixes the stub):

```python
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
```

**Step 4: Commit**

```bash
git add services/runtime/app/node_handlers/
git commit -m "feat: add thin NodeHandler stubs for all existing node types"
```

---

### Task 3: Wire the registry into `MissionExecutor`

**Files:**
- Modify: `services/runtime/app/executor.py`

**Step 1: Write a failing test** (in `services/runtime/tests/test_runtime.py`):

```python
def test_handler_registry_contains_all_node_types():
    from app.node_handlers import get_handler
    for node_type in ["agent", "tool", "router", "parallel", "memory", "delay", "human_input", "terminal"]:
        handler = get_handler(node_type)
        assert handler is not None, f"No handler for {node_type}"

def test_unknown_node_type_raises():
    from app.node_handlers import get_handler
    with pytest.raises(KeyError, match="No handler registered"):
        get_handler("nonexistent_type")
```

**Step 2: Run to verify failure**

```bash
cd /workspace/the_council && .venv/bin/pytest services/runtime/tests/test_runtime.py::test_handler_registry_contains_all_node_types -v
```
Expected: FAIL (registry empty).

**Step 3: Update `MissionExecutor.__init__`** to register handlers:

```python
def __init__(self, telemetry: TelemetryHub) -> None:
    self.telemetry = telemetry
    self.providers = ProviderService()
    self.tools = ToolRunner()
    self.storage = ArtifactStorage()
    self.tasks: dict[str, asyncio.Task[None]] = {}
    self._register_handlers()

def _register_handlers(self) -> None:
    from app.node_handlers import agent, tool, router, parallel, memory, delay, human_input, terminal
    agent.make_handler(self)
    tool.make_handler(self)
    router.make_handler(self)
    parallel.make_handler(self)
    memory.make_handler(self)
    delay.make_handler(self)
    human_input.make_handler(self)
    terminal.make_handler(self)
```

**Step 4: Update `_execute_node_once` dispatch chain** — replace the `if/elif` block with:

```python
from app.node_handlers import get_handler, ExecutionContext

# Build context from run data
ctx = ExecutionContext(
    run_id=run_id,
    mission_id=run.mission_id,
    input_payload=run.input_payload or {},
    control_state=run.control_state or {},
    execution_state=copy.deepcopy(run.execution_state or {}),
    agent_snapshot=run.agent_snapshot or [],
    provider_overrides=run.provider_overrides or {},
    results=results,
)

handler = get_handler(node.type)
result = await handler.execute(node, ctx)
```

Remove the old `if node.type == "agent": ... elif ... else: raise` block entirely.

**Step 5: Run all tests**

```bash
cd /workspace/the_council && .venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 35 passed (33 existing + 2 new registry tests).

**Step 6: Commit**

```bash
git add services/runtime/app/executor.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-14): wire NodeHandler registry into MissionExecutor"
```

---

## Phase 15: AgentLoop — Unified Agentic Cycle

**Goal:** Extract `_run_agent_node` into a standalone `AgentLoop` class, then extend it with structured outputs and native function-calling. The `AgentNodeHandler` delegates to `AgentLoop`.

---

### Task 4: Create `AgentLoop` with identical behaviour to current `_run_agent_node`

**Files:**
- Create: `services/runtime/app/agent_loop.py`
- Modify: `services/runtime/app/node_handlers/agent.py`

**Step 1: Write a failing test**

```python
@pytest.mark.asyncio
async def test_agent_loop_basic_completion(monkeypatch):
    """AgentLoop produces a NodeResult with output key."""
    from app.agent_loop import AgentLoop, LoopResult
    from app.node_handlers import ExecutionContext

    async def fake_stream(*args, **kwargs):
        yield "hello "
        yield "world"

    monkeypatch.setattr("app.agent_loop.ProviderService.stream_complete", fake_stream)
    # ... build minimal node + ctx and verify result.completion == "hello world"
```

**Step 2: Create `services/runtime/app/agent_loop.py`**

```python
from __future__ import annotations

import copy
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from app.core.config import get_settings
from app.db import SessionLocal
from app.models import MissionRun
from app.providers import ProviderService
from app.schemas import MissionAgentDefinition, ProviderConfig, WorkflowNode
from app.storage import ArtifactStorage
from app.telemetry import TelemetryHub
from app.tools import ToolRunner

logger = logging.getLogger(__name__)

TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+)\s*}}")


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
        """Run the full agentic loop for one agent node invocation."""

        # Step 1: Build messages
        messages: list[dict[str, Any]] | None = None
        if prior_messages is not None:
            max_turns = 10  # overridden by node config in Phase 15
            messages = _build_messages(agent.systemPrompt, prior_messages, prompt, max_turns)

        # Step 2: Plain streaming completion (Phase 15 adds function-calling here)
        chunks: list[str] = []
        seq = 0
        async for token in self.providers.stream_complete(
            provider,
            system_prompt=agent.systemPrompt,
            user_prompt=prompt,
            messages=messages,
        ):
            chunks.append(token)
            await self.telemetry.dispatch_stream_token(run_id, node.id, token, seq)
            seq += 1
        completion = "".join(chunks)

        # Step 3: Route detection
        route: str | None = None
        if "ROUTE:" in completion:
            route = completion.split("ROUTE:", 1)[1].splitlines()[0].strip()

        # Step 4: Handoff detection
        handoff_chain: list[str] = []
        if "HANDOFF:" in completion:
            handoff_id = completion.split("HANDOFF:", 1)[1].splitlines()[0].strip()
            if handoff_id in agent.handoffTargets:
                handoff_chain.append(handoff_id)
            else:
                logger.warning("Agent %s HANDOFF:%s not in handoffTargets; ignoring", agent.id, handoff_id)

        return LoopResult(
            completion=completion,
            route=route,
            handoff_chain=handoff_chain,
        )


def _build_messages(
    system_prompt: str,
    history: list[dict],
    new_user_prompt: str,
    max_history_turns: int,
) -> list[dict]:
    messages = [{"role": "system", "content": system_prompt}]
    max_messages = max_history_turns * 2
    trimmed = history[-max_messages:] if len(history) > max_messages else history
    messages.extend(trimmed)
    messages.append({"role": "user", "content": new_user_prompt})
    return messages
```

**Step 3: Update `AgentNodeHandler`** to use `AgentLoop` (delegating the full current `_run_agent_node` logic through the loop). Keep calling `_run_agent_node` in Phase 14 for safety; in Phase 15, replace completely.

**Step 4: Run tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 35 passed.

**Step 5: Commit**

```bash
git add services/runtime/app/agent_loop.py services/runtime/app/node_handlers/agent.py
git commit -m "feat(phase-15): create AgentLoop with parity to _run_agent_node"
```

---

### Task 5: Add structured output to `AgentLoop`

**Files:**
- Modify: `services/runtime/app/agent_loop.py`
- Modify: `services/runtime/tests/test_runtime.py`

When `node.config["outputSchema"]` is present, pass `response_format` to litellm and validate the response.

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_agent_loop_structured_output_valid(monkeypatch):
    """When outputSchema present and LLM returns valid JSON, result.structured is populated."""
    import json
    schema = {"type": "object", "properties": {"score": {"type": "number"}}, "required": ["score"]}
    fake_json = json.dumps({"score": 0.9})
    # monkeypatch stream_complete to yield fake_json
    # build node with config={"agentId": "x", "outputSchema": schema}
    # assert loop_result.structured == {"score": 0.9}

@pytest.mark.asyncio
async def test_agent_loop_structured_output_invalid_reprompts(monkeypatch):
    """When LLM returns invalid JSON, AgentLoop re-prompts once."""
    # First call yields "not json", second call yields valid JSON
    # assert function was called twice
    # assert loop_result.structured is populated on second try
```

**Step 2: Implement in `agent_loop.py`**

After the streaming completion, add:

```python
# Structured output handling
structured: dict[str, Any] | None = None
output_schema = node.config.get("outputSchema")
if output_schema:
    import json
    import jsonschema
    try:
        structured = json.loads(completion)
        jsonschema.validate(structured, output_schema)
    except (json.JSONDecodeError, jsonschema.ValidationError) as exc:
        logger.warning("Structured output parse failed (%s), re-prompting once", exc)
        # Re-prompt with schema reminder
        retry_prompt = (
            f"{prompt}\n\nIMPORTANT: Your response must be valid JSON matching this schema:\n"
            f"{json.dumps(output_schema, indent=2)}\nRespond with JSON only."
        )
        chunks = []
        async for token in self.providers.stream_complete(
            provider,
            system_prompt=agent.systemPrompt,
            user_prompt=retry_prompt,
            messages=None,
        ):
            chunks.append(token)
        completion = "".join(chunks)
        try:
            structured = json.loads(completion)
            jsonschema.validate(structured, output_schema)
        except (json.JSONDecodeError, jsonschema.ValidationError):
            logger.error("Structured output failed after re-prompt for node %s", node.id)
            structured = None
```

Add `jsonschema` to `services/runtime/pyproject.toml` dependencies.

**Step 3: Run tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 37 passed.

**Step 4: Commit**

```bash
git add services/runtime/app/agent_loop.py services/runtime/pyproject.toml services/runtime/tests/test_runtime.py
git commit -m "feat(phase-15): add structured output with JSON schema validation to AgentLoop"
```

---

### Task 6: Add native function-calling to `AgentLoop`

**Files:**
- Modify: `services/runtime/app/agent_loop.py`

When `node.config["nativeFunctions"]` is present, run the function-call agentic loop.

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_agent_loop_function_call_dispatched(monkeypatch):
    """LLM tool_call is dispatched and result fed back."""
    # Mock acompletion to return tool_call on first call, text on second
    # Verify FunctionDispatcher.dispatch() called with correct args
    # Verify function_call_log has one entry

@pytest.mark.asyncio
async def test_agent_loop_function_call_max_rounds(monkeypatch):
    """Loop terminates at maxFunctionCallRounds even if LLM keeps calling tools."""
    # Mock acompletion to always return tool_call
    # Set maxFunctionCallRounds=2
    # Verify loop exits after 2 rounds, completion is empty string
```

**Step 2: Add `FunctionDispatcher` class** (same file or `app/function_dispatcher.py`):

```python
class FunctionDispatcher:
    """Routes native LLM function calls to their handlers."""

    HANDLERS = {"tool_call", "memory_search"}

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
            # Returns top-K memory records as text (delegated to MemoryNodeHandler in Phase 17)
            return f"[memory_search not yet implemented for query: {arguments.get('query', '')}]"
        else:
            return f"[unknown handler: {handler_type}]"
```

**Step 3: Implement function-call loop in `AgentLoop.run()`** before the plain streaming completion:

```python
native_functions = node.config.get("nativeFunctions", [])
max_rounds = int(node.config.get("maxFunctionCallRounds", get_settings().max_function_call_rounds))
function_call_log: list[dict[str, Any]] = []

if native_functions:
    # Build litellm tools format
    lm_tools = [
        {
            "type": "function",
            "function": {
                "name": fn["name"],
                "description": fn["description"],
                "parameters": fn["parameters"],
            },
        }
        for fn in native_functions
    ]
    fn_handler_map = {fn["name"]: fn.get("handler", "tool_call") for fn in native_functions}
    dispatcher = FunctionDispatcher(self.tools)

    loop_messages: list[dict] = messages or [
        {"role": "system", "content": agent.systemPrompt},
        {"role": "user", "content": prompt},
    ]

    for _round in range(max_rounds):
        from litellm import acompletion
        response = await acompletion(
            model=provider.model,
            messages=loop_messages,
            tools=lm_tools,
            temperature=provider.temperature,
            max_tokens=provider.maxTokens,
        )
        msg = response.choices[0].message

        if msg.tool_calls:
            loop_messages.append({"role": "assistant", "tool_calls": [tc.model_dump() for tc in msg.tool_calls]})
            for tc in msg.tool_calls:
                fn_name = tc.function.name
                import json as _json
                fn_args = _json.loads(tc.function.arguments or "{}")
                handler_type = fn_handler_map.get(fn_name, "tool_call")
                fn_result = await dispatcher.dispatch(fn_name, fn_args, handler_type, run_id, node.id)
                loop_messages.append({"role": "tool", "tool_call_id": tc.id, "content": fn_result})
                function_call_log.append({"name": fn_name, "args": fn_args, "result": fn_result})
                await self.telemetry.dispatch_stream_token(run_id, node.id, "", 0)  # progress ping
        else:
            completion = msg.content or ""
            break
    else:
        logger.warning("maxFunctionCallRounds=%d reached for node %s", max_rounds, node.id)
        completion = ""
```

**Step 4: Emit telemetry events** for each function call:

```python
# After each tool call result, emit node.function_call event
with SessionLocal() as session:
    run_db = session.get(MissionRun, run_id)
    if run_db:
        self.telemetry.persist_event(
            session, run_db.mission_id, run_id,
            "node.function_call",
            f"Function call: {fn_name}",
            node_id=node.id,
            data={"function": fn_name, "args": fn_args, "result": fn_result[:500]},
        )
```

**Step 5: Run tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 39 passed.

**Step 6: Commit**

```bash
git add services/runtime/app/agent_loop.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-15): add native LLM function-calling agentic loop to AgentLoop"
```

---

### Task 7: Fully migrate `AgentNodeHandler` to `AgentLoop` — delete `_run_agent_node`

**Files:**
- Modify: `services/runtime/app/node_handlers/agent.py`
- Modify: `services/runtime/app/executor.py`

**Step 1: Rewrite `AgentNodeHandler.execute()`** to use `AgentLoop` directly (no longer calls `_run_agent_node`). Port the full artefact storage, memory storage, conversation persistence, and handoff execution logic from `_run_agent_node` into either `AgentLoop.run()` (for loop-internal concerns) or `AgentNodeHandler.execute()` (for post-loop concerns).

Division of responsibility:
- **`AgentLoop.run()`**: streaming, multi-turn, function-calling, structured output, reflection (Phase 18)
- **`AgentNodeHandler.execute()`**: resolve agent from snapshot, build prompt, call loop, store artifact, store memory, persist conversation, execute handoff target

**Step 2: Delete `_run_agent_node`** from `executor.py` after handler is confirmed working.

**Step 3: Run all tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 39 passed.

**Step 4: Commit**

```bash
git add services/runtime/app/node_handlers/agent.py services/runtime/app/executor.py
git commit -m "refactor(phase-15): AgentNodeHandler fully owns agentic cycle via AgentLoop, remove _run_agent_node"
```

---

## Phase 16: Real Parallel Fan-out and Map Mode

---

### Task 8: Fix parallel fan-out (pass-through) and verify with topology test

The existing `_ready_nodes` batch mechanism already runs independent nodes concurrently. The `parallel` node just needs to pass input through so downstream nodes have access to prior results.

**Files:**
- Modify: `services/runtime/app/node_handlers/parallel.py`
- Modify: `services/runtime/tests/test_runtime.py`

**Step 1: Write a failing test**

```python
@pytest.mark.asyncio
async def test_parallel_fanout_passes_results_to_context():
    """Parallel node in fan_out mode returns input results so children can access them."""
    from app.node_handlers.parallel import ParallelNodeHandler
    from app.node_handlers import ExecutionContext

    handler = ParallelNodeHandler(executor=None)  # no executor needed for fan_out
    node = _make_node("p1", "parallel", config={"mode": "fan_out"})
    ctx = _make_ctx(results={"prev": {"output": "data"}})
    result = await handler.execute(node, ctx)
    assert result.payload["input"] == {"prev": {"output": "data"}}
```

**Step 2: Verify test fails**, then confirm current implementation and run:

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py::test_parallel_fanout_passes_results_to_context -v
```

**Step 3: Update `parallel.py`** — already passes through in Task 2. Confirm and run all tests:

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 40 passed.

**Step 4: Commit**

```bash
git add services/runtime/app/node_handlers/parallel.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-16): parallel fan_out passes input context to downstream nodes"
```

---

### Task 9: Implement parallel `map` mode

**Files:**
- Modify: `services/runtime/app/node_handlers/parallel.py`
- Modify: `services/runtime/app/contracts` (after Phase 19)
- Modify: `services/runtime/tests/test_runtime.py`

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_parallel_map_scatters_over_list(monkeypatch):
    """Map mode spawns one sub-execution per item and gathers results."""
    # node.config = {"mode": "map", "inputPath": "results.extract.items",
    #                "subgraph": ["process"], "outputKey": "mapped"}
    # ctx.results = {"extract": {"items": ["a", "b", "c"]}}
    # Mock _execute_subgraph to return NodeResult(payload={"output": item.upper()})
    # result.payload["mapped"] should be [{"output": "A"}, {"output": "B"}, {"output": "C"}]

@pytest.mark.asyncio
async def test_parallel_map_join_any_cancels_remainder(monkeypatch):
    """joinMode=any resolves on first completion and cancels the rest."""
    # items = ["slow", "fast", "medium"]
    # fast resolves immediately, slow/medium are cancelled
    # result has only one entry
```

**Step 2: Implement map mode** in `ParallelNodeHandler.execute()`:

```python
async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
    mode = node.config.get("mode", "fan_out")

    if mode == "fan_out":
        return NodeResult(payload={"parallel": True, "node": node.id, "input": ctx.results})

    if mode == "map":
        input_path = node.config["inputPath"]
        subgraph = node.config["subgraph"]  # list of node IDs to run per item
        output_key = node.config.get("outputKey", "mapped_results")
        join_mode = node.config.get("joinMode", "all")

        # Resolve input list
        items = self._resolve_path(input_path, ctx.results)
        if not isinstance(items, list):
            raise ValueError(f"inputPath {input_path!r} must resolve to a list, got {type(items)}")

        async def run_item(item: Any) -> dict[str, Any]:
            item_ctx = ExecutionContext(
                **{**ctx.__dict__, "results": {**ctx.results, "_item": {"value": item}}}
            )
            return await self._execute_subgraph(subgraph, item_ctx)

        tasks = [asyncio.create_task(run_item(item)) for item in items]

        if join_mode == "any":
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            results = [t.result() for t in done]
        else:
            results = await asyncio.gather(*tasks)

        return NodeResult(payload={output_key: results})

def _resolve_path(self, path: str, results: dict) -> Any:
    parts = path.split(".")
    value: Any = {"results": results}
    for part in parts:
        value = value[part]
    return value

async def _execute_subgraph(self, node_ids: list[str], ctx: ExecutionContext) -> dict[str, Any]:
    """Run a list of node IDs sequentially and return final result payload."""
    from app.node_handlers import get_handler
    # Retrieve node definitions from execution context (stored in run snapshot)
    # This is simplified — full implementation resolves nodes from workflow_snapshot
    result = {}
    for node_id in node_ids:
        node = self._get_node_from_snapshot(node_id, ctx)
        handler = get_handler(node.type)
        node_result = await handler.execute(node, ctx)
        result = node_result.payload
        ctx = ExecutionContext(**{**ctx.__dict__, "results": {**ctx.results, node_id: result}})
    return result
```

**Step 3: Run all tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 42 passed.

**Step 4: Commit**

```bash
git add services/runtime/app/node_handlers/parallel.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-16): add parallel map mode with scatter/gather and joinMode=any"
```

---

## Phase 17: Sub-workflow Composition

---

### Task 10: Create `SubworkflowNodeHandler`

**Files:**
- Create: `services/runtime/app/node_handlers/subworkflow.py`
- Modify: `services/runtime/app/node_handlers/__init__.py` (add "subworkflow" to `build_registry`)
- Modify: `services/runtime/app/executor.py` (add `_register_handlers` call)
- Modify: `services/runtime/tests/test_runtime.py`

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_subworkflow_maps_input_to_child_context(monkeypatch):
    """inputMapping injects parent results into child execution context."""
    # config = {"inline": {...minimal_workflow...}, "inputMapping": {"prompt": "{{results.intake.output}}"}}
    # ctx.results = {"intake": {"output": "test prompt"}}
    # Verify child ctx receives {"_subworkflow_input": {"prompt": "test prompt"}}

@pytest.mark.asyncio
async def test_subworkflow_depth_guard_raises():
    """Raises NodeError when ctx.depth >= maxDepth."""
    # ctx.depth = 3, config maxDepth = 3
    # Should raise RuntimeError with "depth limit"

@pytest.mark.asyncio
async def test_subworkflow_maps_output_back():
    """outputMapping extracts terminal result into parent NodeResult payload."""
    # outputMapping = {"summary": "results.sub_terminal.output"}
    # mock workflow execution returning {"sub_terminal": {"output": "done"}}
    # result.payload["summary"] == "done"
```

**Step 2: Implement `SubworkflowNodeHandler`**

```python
from __future__ import annotations

import copy
import re
from typing import Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowDefinition, WorkflowNode

TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+)\s*}}")


class SubworkflowNodeHandler:
    def __init__(self, executor: Any) -> None:
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

        # Apply inputMapping
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
        sub_results = await self._executor._execute_workflow_inline(
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

    async def _resolve_workflow(
        self, config: dict[str, Any], ctx: ExecutionContext
    ) -> WorkflowDefinition:
        if "inline" in config:
            return WorkflowDefinition.model_validate(config["inline"])
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

    def _render(self, template: str, context: dict[str, Any]) -> str:
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


def make_handler(executor: Any) -> SubworkflowNodeHandler:
    handler = SubworkflowNodeHandler(executor)
    register("subworkflow", handler)
    return handler
```

**Step 3: Add `_execute_workflow_inline` to `executor.py`**

This method is a stripped-down version of `_execute_workflow` that accepts an already-built `ExecutionContext` instead of loading from DB:

```python
async def _execute_workflow_inline(
    self,
    run_id: str,
    workflow: WorkflowDefinition,
    ctx: ExecutionContext,
    node_id_prefix: str = "",
) -> dict[str, Any]:
    """Run a workflow definition against a pre-built context. Returns final results dict."""
    from app.node_handlers import get_handler
    definition = workflow
    completed: set[str] = set()
    results: dict[str, Any] = dict(ctx.results)

    while True:
        batch = self._ready_nodes(definition, completed, results)
        if not batch:
            break
        node_map = {node.id: node for node in definition.nodes}
        batch_results = await asyncio.gather(
            *(self._execute_node(run_id, node_map[nid], results) for nid in batch)
        )
        for nid, result in zip(batch, batch_results, strict=True):
            results[nid] = result.payload
            completed.add(nid)

    return results
```

**Step 4: Register handler in `_register_handlers`:**

```python
from app.node_handlers import subworkflow
subworkflow.make_handler(self)
```

**Step 5: Run all tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 45 passed.

**Step 6: Commit**

```bash
git add services/runtime/app/node_handlers/subworkflow.py services/runtime/app/executor.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-17): add SubworkflowNodeHandler with input/output mapping and depth guard"
```

---

## Phase 18: Evaluation Node and Reflection Config

---

### Task 11: Create `EvalNodeHandler`

**Files:**
- Create: `services/runtime/app/node_handlers/eval.py`
- Modify: `services/runtime/app/executor.py` (register)
- Modify: `services/runtime/tests/test_runtime.py`

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_eval_node_passes_target_output_to_judge(monkeypatch):
    """Eval node runs judge agent against targetNodeId's output."""
    # config = {"targetNodeId": "researcher", "judgeAgentId": "qa",
    #           "rubric": "...", "passThreshold": 0.7, "onFail": "continue"}
    # ctx.results = {"researcher": {"output": "some research"}}
    # Mock AgentLoop to return LoopResult with structured={"score": 0.8, "critique": "good", "pass": True}
    # result.payload["eval"]["pass"] == True

@pytest.mark.asyncio
async def test_eval_node_on_fail_raises(monkeypatch):
    """onFail=fail raises RuntimeError when judge returns pass=False."""
    # Mock AgentLoop structured={"score": 0.3, "pass": False, "critique": "poor"}
    # Should raise RuntimeError

@pytest.mark.asyncio
async def test_eval_node_on_fail_continue_does_not_raise(monkeypatch):
    """onFail=continue stores eval result and does not raise."""
    # Mock AgentLoop structured={"score": 0.3, "pass": False}
    # Should return NodeResult with payload containing eval result
```

**Step 2: Implement `EvalNodeHandler`**

```python
from __future__ import annotations

import copy
import json
from typing import Any

from app.node_handlers import ExecutionContext, NodeResult, register
from app.schemas import WorkflowNode


class EvalNodeHandler:
    def __init__(self, agent_loop: Any) -> None:
        self._agent_loop = agent_loop

    async def execute(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        config = node.config
        target_node_id = config["targetNodeId"]
        judge_agent_id = config["judgeAgentId"]
        rubric = config.get("rubric", "Evaluate the following output. Return JSON: {score, critique, pass}")
        pass_threshold = float(config.get("passThreshold", 0.7))
        on_fail = config.get("onFail", "continue")

        # Get target output
        target_output = ctx.results.get(target_node_id, {}).get("output", "")

        # Resolve judge agent from snapshot
        judge_agent = self._resolve_agent(judge_agent_id, ctx)
        if judge_agent is None:
            raise RuntimeError(f"Judge agent {judge_agent_id!r} not found in snapshot")

        # Build eval prompt
        eval_prompt = (
            f"Evaluate the following output according to this rubric:\n{rubric}\n\n"
            f"Output to evaluate:\n{target_output}\n\n"
            f"Respond with JSON only: {{\"score\": <0-1>, \"critique\": \"<text>\", \"pass\": <true/false>}}"
        )

        # Force JSON output schema
        output_schema = {
            "type": "object",
            "properties": {
                "score": {"type": "number", "minimum": 0, "maximum": 1},
                "critique": {"type": "string"},
                "pass": {"type": "boolean"},
            },
            "required": ["score", "critique", "pass"],
        }

        # Synthetic node with outputSchema to force structured response
        eval_node = WorkflowNode(
            id=f"{node.id}-judge",
            name=f"Eval: {judge_agent.name}",
            type="agent",
            position=node.position,
            config={"agentId": judge_agent_id, "outputSchema": output_schema},
        )

        loop_result = await self._agent_loop.run(
            run_id=ctx.run_id,
            node=eval_node,
            agent=judge_agent,
            provider=judge_agent.provider,
            prompt=eval_prompt,
            prior_messages=None,
        )

        eval_result = loop_result.structured or {}
        passed = bool(eval_result.get("pass", True))

        # Persist eval in execution state
        from app.db import SessionLocal
        from app.models import MissionRun
        import copy as _copy
        with SessionLocal() as session:
            run = session.get(MissionRun, ctx.run_id)
            if run is not None:
                state = _copy.deepcopy(run.execution_state or {})
                state.setdefault("evals", {})[node.id] = eval_result
                run.execution_state = state
                session.commit()

        if not passed and on_fail == "fail":
            raise RuntimeError(
                f"Eval node {node.id} failed: score={eval_result.get('score')} "
                f"critique={eval_result.get('critique')}"
            )

        return NodeResult(payload={"eval": eval_result, "targetNodeId": target_node_id})

    def _resolve_agent(self, agent_id: str, ctx: ExecutionContext) -> Any:
        from app.schemas import MissionAgentDefinition
        for agent_dict in ctx.agent_snapshot:
            if agent_dict.get("id") == agent_id or agent_dict.get("local_id") == agent_id:
                return MissionAgentDefinition.model_validate(agent_dict)
        return None


def make_handler(agent_loop: Any) -> EvalNodeHandler:
    handler = EvalNodeHandler(agent_loop)
    register("eval", handler)
    return handler
```

**Step 3: Update `_register_handlers` in executor:**

```python
from app.node_handlers import eval as eval_handler
eval_handler.make_handler(self._agent_loop)  # needs AgentLoop instance
```

This requires `AgentLoop` to be instantiated in `MissionExecutor.__init__`:

```python
from app.agent_loop import AgentLoop
self._agent_loop = AgentLoop(self.providers, self.telemetry, self.tools, self.storage)
```

**Step 4: Run tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 48 passed.

**Step 5: Commit**

```bash
git add services/runtime/app/node_handlers/eval.py services/runtime/app/executor.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-18): add EvalNodeHandler with judge-agent scoring and onFail modes"
```

---

### Task 12: Add `reflection` config to `AgentLoop`

**Files:**
- Modify: `services/runtime/app/agent_loop.py`
- Modify: `services/runtime/tests/test_runtime.py`

**Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_agent_loop_reflection_reruns_below_threshold(monkeypatch):
    """When reflection score < passThreshold, AgentLoop re-runs with critique."""
    # node.config["reflection"] = {"judgeAgentId": "critic", "maxRounds": 2,
    #                               "rubric": "Is this good?", "passThreshold": 0.8}
    # First judge call: score=0.5 (below 0.8) → re-run
    # Second judge call: score=0.9 (above 0.8) → exit
    # result.reflection_rounds == 1

@pytest.mark.asyncio
async def test_agent_loop_reflection_exits_at_max_rounds(monkeypatch):
    """Reflection loop exits after maxRounds even if score stays below threshold."""
    # maxRounds=1, judge always returns score=0.3
    # Loop runs once then exits
    # result.reflection_rounds == 1
```

**Step 2: Implement reflection in `AgentLoop.run()`** after the main completion:

```python
reflection_cfg = node.config.get("reflection")
reflection_rounds = 0

if reflection_cfg:
    judge_agent_id = reflection_cfg["judgeAgentId"]
    max_rounds = int(reflection_cfg.get("maxRounds", get_settings().max_reflection_rounds))
    rubric = reflection_cfg.get("rubric", "Is this response accurate and complete?")
    pass_threshold = float(reflection_cfg.get("passThreshold", 0.7))

    judge_agent = self._resolve_agent(judge_agent_id, agent_snapshot_list)

    if judge_agent:
        for _round in range(max_rounds):
            eval_prompt = (
                f"Rubric: {rubric}\n\nOutput to evaluate:\n{completion}\n\n"
                f"Return JSON: {{\"score\": <0-1>, \"pass\": <bool>, \"critique\": \"<text>\"}}"
            )
            eval_schema = {"type": "object", "properties": {"score": {"type": "number"}, "pass": {"type": "boolean"}, "critique": {"type": "string"}}, "required": ["score", "pass", "critique"]}
            # Run judge agent (simplified — reuse stream_complete with JSON mode)
            judge_chunks = []
            async for token in self.providers.stream_complete(
                judge_agent.provider,
                system_prompt=judge_agent.systemPrompt,
                user_prompt=eval_prompt,
            ):
                judge_chunks.append(token)
            import json as _json
            try:
                judge_result = _json.loads("".join(judge_chunks))
            except Exception:
                judge_result = {"score": 1.0, "pass": True, "critique": ""}

            reflection_rounds += 1
            score = float(judge_result.get("score", 1.0))

            # Emit reflection telemetry
            with SessionLocal() as session:
                run_db = session.get(MissionRun, run_id)
                if run_db:
                    self.telemetry.persist_event(
                        session, run_db.mission_id, run_id,
                        "node.reflection",
                        f"Reflection round {_round + 1}: score={score:.2f}",
                        node_id=node.id,
                        data={"round": _round + 1, "score": score, "critique": judge_result.get("critique", "")},
                    )

            if score >= pass_threshold:
                break

            # Re-run main agent with critique
            critique = judge_result.get("critique", "")
            revised_prompt = f"{prompt}\n\nRevision requested. Critique: {critique}"
            revised_chunks = []
            async for token in self.providers.stream_complete(provider, system_prompt=agent.systemPrompt, user_prompt=revised_prompt):
                revised_chunks.append(token)
                await self.telemetry.dispatch_stream_token(run_id, node.id, token, seq)
                seq += 1
            completion = "".join(revised_chunks)
```

**Step 3: Run tests**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 51 passed.

**Step 4: Commit**

```bash
git add services/runtime/app/agent_loop.py services/runtime/tests/test_runtime.py
git commit -m "feat(phase-18): add reflection critic-revise loop to AgentLoop"
```

---

## Phase 19: Contracts + Frontend

---

### Task 13: Extend contracts with new node types and schemas

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `services/runtime/tests/test_runtime.py` (build verification)

**Step 1: Add to `packages/contracts/src/index.ts`**

```typescript
// Extend node types
export const WorkflowNodeTypeSchema = z.enum([
  "agent", "tool", "router", "parallel",
  "memory", "delay", "human_input", "terminal",
  "subworkflow", "eval"  // ← new
]);

// Native function calling
export const NativeFunctionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.any()),
  handler: z.enum(["tool_call", "memory_search", "agent_call"]).default("tool_call"),
});
export type NativeFunction = z.infer<typeof NativeFunctionSchema>;

// Reflection config
export const ReflectionConfigSchema = z.object({
  judgeAgentId: z.string(),
  maxRounds: z.number().int().min(1).default(2),
  rubric: z.string(),
  passThreshold: z.number().min(0).max(1).default(0.7),
});
export type ReflectionConfig = z.infer<typeof ReflectionConfigSchema>;

// Extend AgentDefinitionSchema
export const AgentDefinitionSchema = z.object({
  // ... existing fields ...
  nativeFunctions: z.array(NativeFunctionSchema).default([]),
  maxFunctionCallRounds: z.number().int().min(1).default(5),
});

// New telemetry event types (add to TelemetryEventSchema discriminated union or data field docs)
// "node.function_call", "node.function_result", "node.reflection", "node.eval"
```

**Step 2: Build contracts**

```bash
cd /workspace/the_council && npm run build --workspace @the-council/contracts
```
Expected: builds cleanly.

**Step 3: Build full app**

```bash
npm run build
```
Expected: 270 kB bundle, zero TypeScript errors.

**Step 4: Commit**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(phase-19): add subworkflow/eval node types, NativeFunction, ReflectionConfig to contracts"
```

---

### Task 14: Add `subworkflow` and `eval` to frontend node catalog

**Files:**
- Modify: `apps/web/lib/utils/constants.ts`
- Modify: `apps/web/lib/utils/workflow.ts` (defaultNodeConfig)
- Modify: `apps/web/components/stations/workflow-canvas.tsx` (visual distinction)

**Step 1: Add to `nodeTypeCatalog` in `constants.ts`**

```typescript
{ id: "subworkflow", label: "Sub-workflow" },
{ id: "eval",       label: "Eval / Judge"  },
```

**Step 2: Add default configs in `workflow.ts`**

```typescript
case "subworkflow":
  return { workflowId: "", inputMapping: {}, outputMapping: {}, maxDepth: 3 };
case "eval":
  return { targetNodeId: "", judgeAgentId: firstAgentId ?? "", rubric: "", passThreshold: 0.7, onFail: "continue" };
```

**Step 3: Add visual distinction in canvas** — give `subworkflow` and `eval` nodes a different border color:

```tsx
const borderClass =
  node.type === "subworkflow" ? "border-violet-400/50" :
  node.type === "eval"        ? "border-amber-400/50" :
  selectedNodeId === node.id  ? "border-cyan-300/60 ring-1 ring-cyan-300/40" :
                                "border-white/10";
```

**Step 4: Build and verify**

```bash
npm run build
```
Expected: clean build.

**Step 5: Run full test suite**

```bash
.venv/bin/pytest services/runtime/tests/test_runtime.py -q
```
Expected: 51+ passed.

**Step 6: Commit and push**

```bash
git add apps/web/lib/utils/constants.ts apps/web/lib/utils/workflow.ts apps/web/components/stations/workflow-canvas.tsx
git commit -m "feat(phase-19): add subworkflow and eval to node catalog and canvas"
git push
```

---

## Summary

| Phase | Tasks | New tests | Commit message prefix |
|-------|-------|-----------|----------------------|
| 14 | 1–3 | +2 | `feat(phase-14)` |
| 15 | 4–7 | +4 | `feat(phase-15)` |
| 16 | 8–9 | +4 | `feat(phase-16)` |
| 17 | 10 | +3 | `feat(phase-17)` |
| 18 | 11–12 | +5 | `feat(phase-18)` |
| 19 | 13–14 | +0 | `feat(phase-19)` |
| **Total** | **14** | **+18 → ~51 tests** | |

**Final verification:**

```bash
npm run test:ci
```
Expected: build passes, 51+ runtime tests pass, e2e passes.
