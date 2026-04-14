# Orchestration Parity Design

**Date:** 2026-04-14  
**Status:** Approved  
**Scope:** Full agentic orchestration parity (Approach C — handler registry + unified AgentLoop)

---

## Problem

The current executor (`services/runtime/app/executor.py`, 933 lines) handles all node types in a single monolithic dispatch chain. Five capability gaps exist relative to mature agentic orchestration frameworks:

1. `parallel` node is a stub — returns immediately, no real fan-out/join or map
2. No structured outputs — agents return raw text; downstream nodes cannot reliably parse typed data
3. No native LLM tool-calling — function-call API unused; only external shell/web/api tools available
4. No sub-workflow composition — workflows cannot invoke other workflows as a unit
5. No evaluation/reflection — no mechanism to score or critique agent outputs

---

## Approach

**Option chosen: Approach C — NodeHandler registry + AgentLoop refactor.**

Replace the monolithic `_execute_node_once` dispatch chain with a `NodeHandler` protocol and registry. Extract a shared `AgentLoop` class that owns the full inner agentic execution cycle. Add `subworkflow` and `eval` node types.

Rejected alternatives:
- **Approach A** (additive node types only): structured output and tool-calling don't fit as node types — they are agent invocation config.
- **Approach B** (capability flags on existing nodes): cleaner than A but still complicates `_run_agent_node` without structural improvement.

---

## Architecture

### New File Layout

```
services/runtime/app/
├── executor.py              ← ~350 lines (orchestration only)
├── agent_loop.py            ← new: unified agentic loop
└── node_handlers/
    ├── __init__.py          ← NodeHandler protocol + registry
    ├── agent.py             ← delegates to AgentLoop
    ├── tool.py
    ├── router.py
    ├── parallel.py          ← real fan-out/join + map mode
    ├── memory.py
    ├── delay.py
    ├── human_input.py
    ├── terminal.py
    ├── subworkflow.py       ← new
    └── eval.py              ← new
```

### NodeHandler Protocol

```python
class NodeHandler(Protocol):
    async def execute(
        self,
        run_id: str,
        node: WorkflowNode,
        ctx: ExecutionContext,
    ) -> NodeResult: ...
```

`ExecutionContext` is a lightweight dataclass carrying: `run`, `mission`, `agent_snapshot`, `execution_state`, `results`, `depth`.

Executor's dispatch becomes:

```python
handler = NODE_HANDLERS[node.type]
return await handler.execute(run_id, node, ctx)
```

### Handler Registry

```python
NODE_HANDLERS: dict[str, type[NodeHandler]] = {
    "agent": AgentNodeHandler,
    "tool": ToolNodeHandler,
    "router": RouterNodeHandler,
    "parallel": ParallelNodeHandler,
    "memory": MemoryNodeHandler,
    "delay": DelayNodeHandler,
    "human_input": HumanInputNodeHandler,
    "terminal": TerminalNodeHandler,
    "subworkflow": SubworkflowNodeHandler,
    "eval": EvalNodeHandler,
}

def register_handler(node_type: str, handler: type[NodeHandler]) -> None:
    NODE_HANDLERS[node_type] = handler
```

---

## AgentLoop

Instantiated once per `MissionExecutor`, shared across all agent-type handlers.

```python
class AgentLoop:
    def __init__(
        self,
        providers: ProviderService,
        telemetry: TelemetryHub,
        tools: ToolRunner,
        embeddings: EmbeddingService,
    ): ...

    async def run(
        self,
        run_id: str,
        node: WorkflowNode,
        agent: MissionAgentDefinition,
        ctx: ExecutionContext,
    ) -> LoopResult: ...
```

**Execution order inside `run()`:**

1. Prompt rendering (`_render_value` on `promptTemplate`)
2. Conversation history prepend (if `multiTurn=True`)
3. Native function-call loop (if `nativeFunctions` in config):
   - Call LLM with `tools=` parameter
   - On `tool_calls`: dispatch via `FunctionDispatcher`, append `tool` role messages, loop
   - Cap at `maxFunctionCallRounds` (default 5)
4. Plain streaming completion (no native functions)
5. Structured output (if `outputSchema` in config):
   - Pass `response_format={"type": "json_schema", ...}` to litellm
   - Parse + validate; re-prompt once on failure
   - Store as `result.structured`
6. Reflection loop (if `reflection` in config):
   - Judge agent evaluates completion
   - Below `passThreshold`: prepend critique, re-run from step 3
   - Cap at `maxRounds` (default 2)
7. Handoff detection (`HANDOFF:<id>`, validate against `handoffTargets`, recurse `depth+1`)
8. Conversation persistence to `ctx.execution_state.conversations`

**`LoopResult`**: `completion`, `structured`, `handoff_chain`, `function_call_log`, `reflection_rounds`.

---

## Capability Details

### 1. Parallel Fan-out/Join + Map

**`fan_out` mode** (default): Node passes context through; existing `_ready_nodes` batch mechanism handles concurrent execution via `asyncio.gather`. Fix: remove stub, return input context.

**`map` mode**: Dynamic scatter/gather.

```json
{
  "mode": "map",
  "inputPath": "results.extract.items",
  "subgraph": ["process-item", "score-item"],
  "outputKey": "mapped_results"
}
```

Resolves `inputPath` to a list, spawns one task per item, gathers into `outputKey`.

`joinMode: "all" | "any"` — `"any"` resolves on first completion, cancels remainder.

### 2. Structured Outputs

Config on agent node:

```json
{
  "outputSchema": {
    "type": "object",
    "properties": {
      "analysis": { "type": "string" },
      "confidence": { "type": "number" },
      "recommendation": { "type": "string" }
    },
    "required": ["analysis", "confidence", "recommendation"]
  }
}
```

Stored in `execution_state.structured[nodeId]`. Accessible as `results.<nodeId>.structured` in downstream templates.

### 3. Native LLM Tool-calling

```json
{
  "nativeFunctions": [
    {
      "name": "search_memory",
      "description": "Search the knowledge base",
      "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
      "handler": "memory_search"
    }
  ],
  "maxFunctionCallRounds": 5
}
```

Supported `handler` values (v1): `tool_call`, `memory_search`.  
Future: `agent_call`, `inline_python`.

Telemetry events: `node.function_call` (LLM issued call), `node.function_result` (result fed back).

### 4. Sub-workflow Composition

```json
{
  "type": "subworkflow",
  "config": {
    "workflowId": "analysis-pipeline",
    "inputMapping": { "prompt": "{{results.intake.output}}" },
    "outputMapping": { "summary": "results.sub_terminal.output" },
    "maxDepth": 3
  }
}
```

- Loads workflow from DB by `workflowId` or uses `inline` definition
- Builds child `ExecutionContext` with `inputMapping` applied and `depth+1`
- Calls `MissionExecutor._execute_workflow_inline()` with isolated state
- Maps terminal results back via `outputMapping`
- Telemetry events prefixed `sub:{node.id}:`
- Recursion guard: raises `NodeError` if `ctx.depth >= maxDepth`

### 5. Evaluation & Reflection

**`eval` node type:**

```json
{
  "type": "eval",
  "config": {
    "targetNodeId": "researcher",
    "judgeAgentId": "qa-critic",
    "rubric": "Rate accuracy 1-5 and completeness 1-5. Return JSON {score, critique, pass}.",
    "passThreshold": 0.7,
    "onFail": "continue"
  }
}
```

Forces `outputSchema` on judge call. Stores `{score, critique, pass}` in `execution_state.evals[nodeId]`.  
`onFail: "continue" | "fail"` — `"fail"` applies the node's retry/exhaustion policy.

**`reflection` config on agent nodes (inline critic-revise):**

```json
{
  "reflection": {
    "judgeAgentId": "critic",
    "maxRounds": 2,
    "rubric": "Is this response accurate and complete?",
    "passThreshold": 0.8
  }
}
```

Handled entirely within `AgentLoop.run()`. Emits `node.reflection` telemetry per round.

---

## Contracts Changes (`packages/contracts/src/index.ts`)

```typescript
// Extend node types
WorkflowNodeTypeSchema: add "subworkflow" | "eval"

// New schemas
NativeFunctionSchema: { name, description, parameters, handler }
ReflectionConfigSchema: { judgeAgentId, maxRounds, rubric, passThreshold }

// Extend AgentDefinitionSchema
nativeFunctions?: NativeFunctionSchema[]
maxFunctionCallRounds?: number  // default 5

// New telemetry event types
"node.function_call"    // LLM issued a native tool call
"node.function_result"  // tool call result fed back
"node.reflection"       // reflection round result (score, critique)
"node.eval"             // eval node result (score, pass)
```

## Data Model

No new DB tables. All new state stored in existing JSON columns:

| Data | Column |
|------|--------|
| Function call log | `MissionEvent.data` |
| Structured output | `execution_state.structured[nodeId]` |
| Reflection rounds | `execution_state.reflections[nodeId]` |
| Eval scores | `execution_state.evals[nodeId]` |
| Sub-workflow results | `execution_state.subworkflows[nodeId]` |
| Map results | `execution_state.mapped[nodeId]` |

## New Settings (`app/core/config.py`)

```python
max_function_call_rounds: int = 5
max_subworkflow_depth: int = 3
max_reflection_rounds: int = 3
eval_judge_timeout_seconds: int = 30
```

---

## Testing Strategy

**Target: 33 existing + ~24 new = ~57 tests.**

| Area | Test count |
|------|-----------|
| `ParallelNodeHandler` fan-out + map | 5 |
| `AgentLoop` native function calls | 4 |
| `AgentLoop` structured output | 3 |
| `AgentLoop` reflection | 3 |
| `SubworkflowNodeHandler` | 4 |
| `EvalNodeHandler` | 3 |
| Handler registry | 2 |

Existing e2e test (`bridge.spec.ts`) unchanged — exercises agent/tool/human_input/memory paths preserved through refactor.

Migration safety: each handler extracted from `_execute_node_once` with identical logic. Side-by-side diff is the primary review artifact.

---

## Implementation Phases

| Phase | Scope |
|-------|-------|
| 14 | Executor refactor: NodeHandler registry + ExecutionContext (behaviour-preserving) |
| 15 | AgentLoop: extract from _run_agent_node, add structured output + native function calling |
| 16 | ParallelNodeHandler: fan-out fix + map mode |
| 17 | SubworkflowNodeHandler |
| 18 | EvalNodeHandler + AgentLoop reflection config |
| 19 | Contracts updates + frontend: subworkflow/eval in canvas node catalog |
