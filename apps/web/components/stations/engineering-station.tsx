"use client";

import { type CSSProperties } from "react";
import type {
  AgentDefinition,
  MissionAgentDefinition,
  MissionWorkspace,
  RuntimeSettings,
  ToolName
} from "@the-council/contracts";
import { usePanelResize } from "../../lib/hooks/use-panel-resize";
import type { MissionAgentEditorState } from "../../lib/types/bridge";
import {
  clampEngineeringPanelWidth,
  engineeringPanelDefaultWidth,
  engineeringPanelMaxWidth,
  engineeringPanelMinWidth,
  engineeringPanelStorageKey,
  toolCatalog
} from "../../lib/utils/constants";
import { PanelResizer } from "../ui/panel-resizer";

export function EngineeringStation({
  settings,
  mission,
  missionAgents,
  templateAgents,
  busy,
  editor,
  editorMode,
  selectedMissionAgentId,
  importTemplateId,
  editsAllowed,
  onSelectMissionAgent,
  onStartCreate,
  onEditorChange,
  onToggleTool,
  onSave,
  onDelete,
  onImportTemplateChange,
  onImportTemplate
}: {
  settings: RuntimeSettings | null;
  mission?: MissionWorkspace;
  missionAgents: MissionAgentDefinition[];
  templateAgents: AgentDefinition[];
  busy: string | null;
  editor: MissionAgentEditorState | null;
  editorMode: "create" | "edit";
  selectedMissionAgentId: string | null;
  importTemplateId: string;
  editsAllowed: boolean;
  onSelectMissionAgent: (agentId: string) => void;
  onStartCreate: () => void;
  onEditorChange: (patch: Partial<MissionAgentEditorState>) => void;
  onToggleTool: (tool: ToolName) => void;
  onSave: () => void;
  onDelete: () => void;
  onImportTemplateChange: (value: string) => void;
  onImportTemplate: () => void;
}) {
  const engineeringResize = usePanelResize(
    engineeringPanelStorageKey,
    engineeringPanelDefaultWidth,
    engineeringPanelMinWidth,
    engineeringPanelMaxWidth,
    clampEngineeringPanelWidth
  );
  const engineeringLayoutStyle = {
    "--engineering-left-width": `minmax(0, ${engineeringResize.leftPanelWidth}%)`,
    "--engineering-right-width": `minmax(0, ${100 - engineeringResize.leftPanelWidth}%)`,
    "--engineering-divider-width": "1.5rem"
  } as CSSProperties;
  const selectedProvider =
    settings?.providers.find((provider) => provider.id === editor?.providerId) ?? settings?.providers[0];

  if (!mission) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.8rem] border border-dashed border-white/10 bg-black/15 p-8 text-center text-sm text-slate-400">
        Create or select a mission workspace before forging its crew.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="panel-title text-cyan-300">Engineering</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission-local crew and template library</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300">
          {mission.name}
        </div>
      </div>

      {!editsAllowed ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          Crew edits are locked while the mission has an active run. Pause the run to modify mission agents.
        </div>
      ) : null}

      <div
        ref={engineeringResize.layoutRef}
        style={engineeringLayoutStyle}
        className="grid gap-4 xl:grid-cols-[var(--engineering-left-width)_var(--engineering-divider-width)_var(--engineering-right-width)]"
      >
        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-amber-300">Mission Crew</p>
                <h3 className="mt-2 text-lg text-white">Agents scoped to this mission</h3>
              </div>
              <button
                type="button"
                onClick={onStartCreate}
                disabled={!editsAllowed}
                data-testid="mission-agent-new"
                className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
              >
                New Mission Agent
              </button>
            </div>
            <div className="scroll-thin mt-4 max-h-[20rem] space-y-3 overflow-auto pr-1">
              {missionAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onSelectMissionAgent(agent.id)}
                  data-testid={`mission-agent-card-${agent.id}`}
                  className={`w-full rounded-2xl border p-3 text-left transition ${
                    selectedMissionAgentId === agent.id
                      ? "border-cyan-300/60 bg-cyan-300/10"
                      : "border-white/8 bg-black/10 hover:border-cyan-300/30"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-white">{agent.name}</strong>
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{agent.role}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{agent.id}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {agent.tools.map((tool) => (
                      <span
                        key={tool}
                        className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-cyan-200"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
              {missionAgents.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                  No mission agents yet. Forge one or import a template below.
                </p>
              ) : null}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-cyan-300">Template Library</p>
                <h3 className="mt-2 text-lg text-white">Import global templates as mission-local copies</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {templateAgents.length} templates
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              <select
                value={importTemplateId}
                onChange={(event) => onImportTemplateChange(event.target.value)}
                data-testid="template-import-select"
                className="min-w-[14rem] rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
              >
                <option value="">Select template</option>
                {templateAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onImportTemplate}
                disabled={!editsAllowed || !importTemplateId}
                data-testid="template-import-button"
                className="rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
              >
                Import Template
              </button>
            </div>
            <div className="scroll-thin mt-4 max-h-[18rem] space-y-3 overflow-auto pr-1">
              {templateAgents.map((agent) => {
                const alreadyImported = missionAgents.some((missionAgent) => missionAgent.id === agent.id);
                return (
                  <div key={agent.id} className="rounded-2xl border border-white/8 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-white">{agent.name}</strong>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                        {alreadyImported ? "imported" : "template"}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-400">{agent.role}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="hidden xl:flex items-stretch justify-center">
          <PanelResizer
            isResizing={engineeringResize.isResizing}
            minWidth={engineeringResize.minWidth}
            maxWidth={engineeringResize.maxWidth}
            leftPanelWidth={engineeringResize.leftPanelWidth}
            label="Resize engineering registry panel"
            testId="engineering-resizer"
            onPointerDown={(event) => {
              event.preventDefault();
              engineeringResize.beginResize(event.clientX);
            }}
            onDoubleClick={() => engineeringResize.setLeftPanelWidth(engineeringResize.defaultWidth)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                engineeringResize.nudgeResize(-2);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                engineeringResize.nudgeResize(2);
              }
              if (event.key === "Home") {
                event.preventDefault();
                engineeringResize.setLeftPanelWidth(engineeringResize.minWidth);
              }
              if (event.key === "End") {
                event.preventDefault();
                engineeringResize.setLeftPanelWidth(engineeringResize.maxWidth);
              }
            }}
          />
        </div>

        <div className="min-w-0 rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-cyan-300">Mission Agent Forge</p>
              <h3 className="mt-2 text-lg text-white">
                {editorMode === "create" ? "Create a mission-local agent" : "Edit mission agent"}
              </h3>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-amber-100">
              {editorMode === "create" ? "new record" : "mission-local copy"}
            </div>
          </div>
          {editor ? (
            <div data-testid="mission-agent-editor" className="mt-4 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Agent ID</span>
                  <input
                    value={editor.id}
                    disabled={editorMode === "edit"}
                    onChange={(event) => onEditorChange({ id: event.target.value })}
                    data-testid="mission-agent-id"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Call Sign</span>
                  <input
                    value={editor.name}
                    onChange={(event) => onEditorChange({ name: event.target.value })}
                    data-testid="mission-agent-name"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Duty Role</span>
                  <input
                    value={editor.role}
                    onChange={(event) => onEditorChange({ role: event.target.value })}
                    data-testid="mission-agent-role"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Provider</span>
                  <select
                    value={editor.providerId}
                    onChange={(event) => onEditorChange({ providerId: event.target.value })}
                    data-testid="mission-agent-provider"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  >
                    {settings?.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Description</span>
                <textarea
                  value={editor.description}
                  onChange={(event) => onEditorChange({ description: event.target.value })}
                  className="min-h-20 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">System Prompt</span>
                <textarea
                  value={editor.systemPrompt}
                  onChange={(event) => onEditorChange({ systemPrompt: event.target.value })}
                  data-testid="mission-agent-system-prompt"
                  className="min-h-32 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <div>
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Tool Access</span>
                <div className="flex flex-wrap gap-2">
                  {toolCatalog.map((tool) => {
                    const enabled = editor.tools.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => onToggleTool(tool.id)}
                        data-testid={`mission-agent-tool-${tool.id}`}
                        className={`rounded-full border px-3 py-2 text-xs uppercase tracking-[0.18em] transition ${
                          enabled
                            ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-100"
                            : "border-white/10 bg-black/20 text-slate-400 hover:border-cyan-300/30"
                        }`}
                      >
                        {tool.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Memory Mode</span>
                  <select
                    value={editor.memoryMode}
                    onChange={(event) =>
                      onEditorChange({
                        memoryMode: event.target.value as MissionAgentEditorState["memoryMode"]
                      })
                    }
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  >
                    <option value="session">session</option>
                    <option value="long_term">long_term</option>
                    <option value="hybrid">hybrid</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Memory Namespace</span>
                  <input
                    value={editor.memoryNamespace}
                    onChange={(event) => onEditorChange({ memoryNamespace: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Recall Depth</span>
                  <input
                    type="number"
                    min={1}
                    value={editor.memoryTopK}
                    onChange={(event) => onEditorChange({ memoryTopK: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Handoff Targets</span>
                <input
                  value={editor.handoffTargets}
                  onChange={(event) => onEditorChange({ handoffTargets: event.target.value })}
                  placeholder="captain, archivist"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Tool Policy JSON</span>
                <textarea
                  value={editor.toolPolicyJson}
                  onChange={(event) => onEditorChange({ toolPolicyJson: event.target.value })}
                  className="scroll-thin min-h-56 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <div className="rounded-[1.5rem] border border-white/8 bg-black/20 p-4 text-sm text-slate-400">
                <p className="text-cyan-100">
                  Provider route: {selectedProvider?.label ?? "none"} / {selectedProvider?.model ?? "unconfigured"}
                </p>
                <p className="mt-2">
                  Template lineage: {editor.templateAgentId ?? "scratch-built mission agent"}
                </p>
                <p className="mt-2">
                  Structural edits update the mission workspace, and if the selected run is paused they also update that paused run snapshot.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!settings?.providers.length || !editsAllowed || busy === "save-agent"}
                  data-testid="mission-agent-save"
                  className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                >
                  {busy === "save-agent"
                    ? "Synchronizing"
                    : editorMode === "create"
                      ? "Forge Mission Agent"
                      : "Update Mission Agent"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={editorMode !== "edit" || !editsAllowed || busy === "delete-agent"}
                  data-testid="mission-agent-delete"
                  className="rounded-[1.4rem] border border-rose-300/30 bg-rose-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                >
                  {busy === "delete-agent" ? "Purging" : "Delete Mission Agent"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Awaiting mission selection before agent creation.</p>
          )}
        </div>
      </div>
    </div>
  );
}
