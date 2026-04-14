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
import { WorkflowCanvas } from "./workflow-canvas";

export function TacticalStation({
  busy,
  mission,
  workflow,
  workflowJson,
  missionAgents,
  editsAllowed,
  newNodeType,
  selectedNodeId,
  onNewNodeType,
  onUpdateWorkflow,
  onPatchNode,
  onPatchEdge,
  onRemoveNode,
  onRemoveEdge,
  onAddNode,
  onAddEdge,
  onSelectNode,
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
  selectedNodeId: string | null;
  onNewNodeType: (value: WorkflowNodeType) => void;
  onUpdateWorkflow: (workflow: WorkflowDefinition) => void;
  onPatchNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
  onPatchEdge: (edgeId: string, updater: (edge: WorkflowEdge) => WorkflowEdge) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onAddNode: () => void;
  onAddEdge: (sourceId?: string, targetId?: string) => void;
  onSelectNode: (nodeId: string | null) => void;
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

  const selectedNode = selectedNodeId ? workflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null;

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
                  onClick={() => onAddEdge()}
                  disabled={!editsAllowed || workflow.nodes.length < 2}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-cyan-300/30 disabled:opacity-50"
                >
                  Add Edge
                </button>
              </div>
            </div>

            <WorkflowCanvas
              workflow={workflow}
              missionAgents={missionAgents}
              editsAllowed={editsAllowed}
              selectedNodeId={selectedNodeId}
              onPatchNode={onPatchNode}
              onRemoveNode={onRemoveNode}
              onAddEdge={(sourceId, targetId) => onAddEdge(sourceId, targetId)}
              onRemoveEdge={onRemoveEdge}
              onSelectNode={onSelectNode}
            />
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
              {selectedNode ? (
                <div key={selectedNode.id} className="rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Name</span>
                      <input
                        value={selectedNode.name}
                        onChange={(event) =>
                          onPatchNode(selectedNode.id, (current) => ({ ...current, name: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Type</span>
                      <select
                        value={selectedNode.type}
                        onChange={(event) =>
                          onPatchNode(selectedNode.id, (current) => ({
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
                        value={selectedNode.id}
                        disabled
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-400 outline-none"
                      />
                    </label>
                    {selectedNode.type === "agent" || selectedNode.type === "tool" ? (
                      <label className="block">
                        <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Mission Agent</span>
                        <select
                          value={String(selectedNode.config.agentId ?? "")}
                          onChange={(event) =>
                            onPatchNode(selectedNode.id, (current) => ({
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
                            value={selectedNode.position.x}
                            onChange={(event) =>
                              onPatchNode(selectedNode.id, (current) => ({
                                ...current,
                                position: { ...current.position, x: Number(event.target.value) || 0 }
                              }))
                            }
                            disabled={!editsAllowed}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                          />
                          <input
                            type="number"
                            value={selectedNode.position.y}
                            onChange={(event) =>
                              onPatchNode(selectedNode.id, (current) => ({
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

                  {selectedNode.type === "tool" ? (
                    <label className="mt-4 block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Tool</span>
                      <select
                        value={String(selectedNode.config.tool ?? "shell")}
                        onChange={(event) =>
                          onPatchNode(selectedNode.id, (current) => ({
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
                      value={configJson(selectedNode.config)}
                      onChange={(event) => {
                        try {
                          const parsed = parseConfigJson(event.target.value);
                          onPatchNode(selectedNode.id, (current) => ({ ...current, config: parsed }));
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
                      onClick={() => onRemoveNode(selectedNode.id)}
                      disabled={!editsAllowed || workflow.nodes.length === 1}
                      className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                    >
                      Remove Node
                    </button>
                  </div>
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">
                  Click a node in the canvas to select and edit it.
                </p>
              )}
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
