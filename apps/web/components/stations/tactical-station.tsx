"use client";

import type {
  MissionAgentDefinition,
  MissionWorkspace,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType
} from "@the-council/contracts";
import { nodeTypeCatalog, toolCatalog } from "../../lib/utils/constants";
import { configJson, defaultNodeConfig, parseConfigJson } from "../../lib/utils/workflow";

export function TacticalStation({
  busy,
  mission,
  workflow,
  workflowJson,
  missionAgents,
  editsAllowed,
  newNodeType,
  onNewNodeType,
  onUpdateWorkflow,
  onPatchNode,
  onPatchEdge,
  onRemoveNode,
  onRemoveEdge,
  onAddNode,
  onAddEdge,
  onJsonChange,
  onSave
}: {
  busy: string | null;
  mission?: MissionWorkspace;
  workflow: WorkflowDefinition | null;
  workflowJson: string;
  missionAgents: MissionAgentDefinition[];
  editsAllowed: boolean;
  newNodeType: WorkflowNodeType;
  onNewNodeType: (value: WorkflowNodeType) => void;
  onUpdateWorkflow: (workflow: WorkflowDefinition) => void;
  onPatchNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
  onPatchEdge: (edgeId: string, updater: (edge: WorkflowEdge) => WorkflowEdge) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onAddNode: () => void;
  onAddEdge: () => void;
  onJsonChange: (value: string) => void;
  onSave: () => void;
}) {
  if (!mission || !workflow) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.8rem] border border-dashed border-white/10 bg-black/15 p-8 text-center text-sm text-slate-400">
        Select or create a mission workspace to edit its workflow.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="panel-title text-cyan-300">Tactical</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission workflow builder</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300">
          {mission.name}
        </div>
      </div>

      {!editsAllowed ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          Structural edits are locked while the active run is executing. Pause the run to update mission crew or workflow.
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/8 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-amber-300">Topology</p>
                <h3 className="mt-2 text-lg text-white">Live mission graph</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={newNodeType}
                  onChange={(event) => onNewNodeType(event.target.value as WorkflowNodeType)}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.16em] text-white outline-none transition focus:border-cyan-300/50"
                >
                  {nodeTypeCatalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={onAddNode}
                  disabled={!editsAllowed}
                  data-testid="workflow-add-node"
                  className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
                >
                  Add Node
                </button>
                <button
                  type="button"
                  onClick={onAddEdge}
                  disabled={!editsAllowed || workflow.nodes.length < 2}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-cyan-300/30 disabled:opacity-50"
                >
                  Add Edge
                </button>
              </div>
            </div>

            <div className="relative min-h-[28rem] overflow-hidden rounded-[1.5rem] border border-white/8 bg-black/25">
              <svg className="absolute inset-0 h-full w-full">
                {workflow.edges.map((edge) => {
                  const source = workflow.nodes.find((node) => node.id === edge.source);
                  const target = workflow.nodes.find((node) => node.id === edge.target);
                  if (!source || !target) {
                    return null;
                  }
                  return (
                    <g key={edge.id}>
                      <line
                        x1={source.position.x + 120}
                        y1={source.position.y + 42}
                        x2={target.position.x + 16}
                        y2={target.position.y + 42}
                        stroke="rgba(118,244,255,0.45)"
                        strokeWidth={2}
                        strokeDasharray={edge.condition ? "8 8" : undefined}
                      />
                      {edge.condition ? (
                        <text
                          x={(source.position.x + target.position.x) / 2}
                          y={(source.position.y + target.position.y) / 2}
                          fill="#f7b955"
                          fontSize="11"
                        >
                          {edge.condition}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              {workflow.nodes.map((node) => (
                <div
                  key={node.id}
                  className="absolute w-56 rounded-2xl border border-white/10 bg-[rgba(5,18,31,0.92)] p-4 shadow-bridge"
                  style={{ left: node.position.x, top: node.position.y }}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <strong className="text-sm text-white">{node.name}</strong>
                    <span className="rounded-full border border-cyan-300/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                      {node.type}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{node.id}</p>
                  {"agentId" in node.config ? (
                    <p className="mt-2 text-xs text-amber-200">{String(node.config.agentId)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/8 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-cyan-300">Edges</p>
                <h3 className="mt-2 text-lg text-white">Branch and merge control</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {workflow.edges.length} edges
              </span>
            </div>
            <div className="space-y-3">
              {workflow.edges.map((edge) => (
                <div key={edge.id} className="rounded-2xl border border-white/8 bg-black/15 p-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Source</span>
                      <select
                        value={edge.source}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({ ...current, source: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {workflow.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Target</span>
                      <select
                        value={edge.target}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({ ...current, target: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {workflow.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Condition</span>
                      <input
                        value={edge.condition ?? ""}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({
                            ...current,
                            condition: event.target.value.trim() || undefined
                          }))
                        }
                        disabled={!editsAllowed}
                        placeholder="analysis"
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRemoveEdge(edge.id)}
                      disabled={!editsAllowed}
                      className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                    >
                      Remove Edge
                    </button>
                  </div>
                </div>
              ))}
              {workflow.edges.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                  No edges yet. Add one after you place at least two nodes.
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-cyan-300">Nodes</p>
                <h3 className="mt-2 text-lg text-white">Mission node editor</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {workflow.nodes.length} nodes
              </span>
            </div>
            <div className="scroll-thin max-h-[34rem] space-y-4 overflow-auto pr-1">
              {workflow.nodes.map((node) => (
                <div key={node.id} className="rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Name</span>
                      <input
                        value={node.name}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({ ...current, name: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Type</span>
                      <select
                        value={node.type}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({
                            ...current,
                            type: event.target.value as WorkflowNodeType,
                            config: defaultNodeConfig(event.target.value as WorkflowNodeType, missionAgents[0]?.id)
                          }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {nodeTypeCatalog.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Node ID</span>
                      <input
                        value={node.id}
                        disabled
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-400 outline-none"
                      />
                    </label>
                    {node.type === "agent" || node.type === "tool" ? (
                      <label className="block">
                        <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Mission Agent</span>
                        <select
                          value={String(node.config.agentId ?? "")}
                          onChange={(event) =>
                            onPatchNode(node.id, (current) => ({
                              ...current,
                              config: { ...current.config, agentId: event.target.value }
                            }))
                          }
                          disabled={!editsAllowed}
                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                        >
                          <option value="">Unbound</option>
                          {missionAgents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label className="block">
                        <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Position</span>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="number"
                            value={node.position.x}
                            onChange={(event) =>
                              onPatchNode(node.id, (current) => ({
                                ...current,
                                position: { ...current.position, x: Number(event.target.value) || 0 }
                              }))
                            }
                            disabled={!editsAllowed}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                          />
                          <input
                            type="number"
                            value={node.position.y}
                            onChange={(event) =>
                              onPatchNode(node.id, (current) => ({
                                ...current,
                                position: { ...current.position, y: Number(event.target.value) || 0 }
                              }))
                            }
                            disabled={!editsAllowed}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                          />
                        </div>
                      </label>
                    )}
                  </div>

                  {node.type === "tool" ? (
                    <label className="mt-4 block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Tool</span>
                      <select
                        value={String(node.config.tool ?? "shell")}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({
                            ...current,
                            config: { ...current.config, tool: event.target.value }
                          }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {toolCatalog.map((tool) => (
                          <option key={tool.id} value={tool.id}>
                            {tool.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  <label className="mt-4 block">
                    <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Config JSON</span>
                    <textarea
                      value={configJson(node.config)}
                      onChange={(event) => {
                        try {
                          const parsed = parseConfigJson(event.target.value);
                          onPatchNode(node.id, (current) => ({ ...current, config: parsed }));
                        } catch {
                          // Preserve the last valid draft until this node's config becomes valid again.
                        }
                      }}
                      disabled={!editsAllowed}
                      className="min-h-36 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
                    />
                  </label>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRemoveNode(node.id)}
                      disabled={!editsAllowed || workflow.nodes.length === 1}
                      className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                    >
                      Remove Node
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-amber-300">Raw Definition</p>
                <h3 className="mt-2 text-lg text-white">JSON stays synchronized with the structured editor</h3>
              </div>
              <button
                type="button"
                onClick={onSave}
                disabled={!editsAllowed || busy === "save-workflow"}
                data-testid="workflow-save"
                className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-60"
              >
                {busy === "save-workflow" ? "Saving" : "Save Mission Workflow"}
              </button>
            </div>
            <textarea
              value={workflowJson}
              onChange={(event) => onJsonChange(event.target.value)}
              data-testid="workflow-json-editor"
              className="scroll-thin min-h-[28rem] w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
