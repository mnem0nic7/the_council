"use client";

import { type CSSProperties } from "react";
import type {
  MissionRun,
  MissionWorkspace,
  TelemetryEvent,
  WorkflowDefinition
} from "@the-council/contracts";
import { usePanelResize } from "../../lib/hooks/use-panel-resize";
import type { MissionDraftState } from "../../lib/types/bridge";
import {
  clampCommandPanelWidth,
  commandPanelDefaultWidth,
  commandPanelMaxWidth,
  commandPanelMinWidth,
  commandPanelStorageKey
} from "../../lib/utils/constants";
import { PanelResizer } from "../ui/panel-resizer";

export function CommandDeck({
  busy,
  missionDraft,
  selectedMission,
  selectedRun,
  telemetry,
  templateWorkflows,
  onPatchDraft,
  onCreateMission,
  onSaveMission,
  onLaunchRun
}: {
  busy: string | null;
  missionDraft: MissionDraftState;
  selectedMission?: MissionWorkspace;
  selectedRun?: MissionRun;
  telemetry: TelemetryEvent[];
  templateWorkflows: WorkflowDefinition[];
  onPatchDraft: (patch: Partial<MissionDraftState>) => void;
  onCreateMission: () => void;
  onSaveMission: () => void;
  onLaunchRun: () => void;
}) {
  const commandResize = usePanelResize(
    commandPanelStorageKey,
    commandPanelDefaultWidth,
    commandPanelMinWidth,
    commandPanelMaxWidth,
    clampCommandPanelWidth
  );

  const commandLayoutStyle = {
    "--command-left-width": `minmax(0, ${commandResize.leftPanelWidth}%)`,
    "--command-right-width": `minmax(0, ${100 - commandResize.leftPanelWidth}%)`,
    "--command-divider-width": "1.5rem"
  } as CSSProperties;

  return (
    <div
      ref={commandResize.layoutRef}
      style={commandLayoutStyle}
      className="grid gap-5 lg:grid-cols-[var(--command-left-width)_var(--command-divider-width)_var(--command-right-width)]"
    >
      <div data-testid="command-launch-panel" className="min-w-0 space-y-5">
        <div>
          <p className="panel-title text-cyan-300">Command Deck</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission workspace and launch control</h2>
        </div>

        <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-amber-300">Workspace</p>
              <h3 className="mt-2 text-lg text-white">
                {selectedMission ? selectedMission.name : "Create a new mission workspace"}
              </h3>
            </div>
            <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-300">
              {selectedMission?.status ?? "draft"}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Name</span>
              <input
                value={missionDraft.name}
                onChange={(event) => onPatchDraft({ name: event.target.value })}
                data-testid="mission-name"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Seed Template</span>
              <select
                value={missionDraft.templateWorkflowId}
                onChange={(event) => onPatchDraft({ templateWorkflowId: event.target.value })}
                data-testid="mission-template"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              >
                <option value="">Blank mission</option>
                {templateWorkflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Description</span>
            <textarea
              value={missionDraft.description}
              onChange={(event) => onPatchDraft({ description: event.target.value })}
              className="min-h-24 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onCreateMission}
              disabled={busy === "create-mission"}
              data-testid="mission-create"
              className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
            >
              {busy === "create-mission" ? "Forging" : "Create Mission"}
            </button>
            <button
              type="button"
              onClick={onSaveMission}
              disabled={!selectedMission || busy === "save-mission"}
              data-testid="mission-save"
              className="rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
            >
              {busy === "save-mission" ? "Saving" : "Save Workspace"}
            </button>
          </div>
        </div>

        <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-cyan-300">Launch Control</p>
              <h3 className="mt-2 text-lg text-white">
                {selectedRun ? `Selected run: ${selectedRun.name}` : "Prepare the next launch"}
              </h3>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-amber-100">
              {selectedRun?.status ?? "idle"}
            </div>
          </div>

          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Prompt</span>
            <textarea
              value={missionDraft.prompt}
              onChange={(event) => onPatchDraft({ prompt: event.target.value })}
              data-testid="mission-prompt"
              className="min-h-40 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-300/50"
            />
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Route Signal</span>
              <input
                value={missionDraft.route}
                onChange={(event) => onPatchDraft({ route: event.target.value })}
                data-testid="mission-route"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber-300/50"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Run Name</span>
              <input
                value={missionDraft.runName}
                onChange={(event) => onPatchDraft({ runName: event.target.value })}
                data-testid="run-name"
                placeholder="Optional custom launch name"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={onLaunchRun}
            disabled={!selectedMission || busy === "launch"}
            data-testid="launch-mission"
            className="mt-4 rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
          >
            {busy === "launch" ? "Engaging" : "Launch Run"}
          </button>
        </div>
      </div>

      <div className="hidden lg:flex items-stretch justify-center">
        <PanelResizer
          isResizing={commandResize.isResizing}
          minWidth={commandResize.minWidth}
          maxWidth={commandResize.maxWidth}
          leftPanelWidth={commandResize.leftPanelWidth}
          label="Resize command deck panels"
          testId="command-resizer"
          onPointerDown={(event) => {
            event.preventDefault();
            commandResize.beginResize(event.clientX);
          }}
          onDoubleClick={() => commandResize.setLeftPanelWidth(commandResize.defaultWidth)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              commandResize.nudgeResize(-2);
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              commandResize.nudgeResize(2);
            }
            if (event.key === "Home") {
              event.preventDefault();
              commandResize.setLeftPanelWidth(commandResize.minWidth);
            }
            if (event.key === "End") {
              event.preventDefault();
              commandResize.setLeftPanelWidth(commandResize.maxWidth);
            }
          }}
        />
      </div>

      <div
        data-testid="command-telemetry-panel"
        className="panel min-w-0 rounded-[1.8rem] border border-white/8 bg-black/15 p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="panel-title text-amber-300">Live Telemetry</p>
            <h3 className="mt-2 text-lg text-white">Selected run event stream</h3>
          </div>
          <div className="status-dot bg-cyan-300 text-cyan-300" />
        </div>
        <div
          data-testid="command-telemetry-stream"
          className="scroll-thin max-h-[52rem] space-y-3 overflow-y-auto overflow-x-hidden pr-1"
        >
          {telemetry.map((event) => (
            <div
              key={event.id}
              data-testid={`telemetry-${event.type}`}
              className="min-w-0 rounded-2xl border border-white/8 bg-black/20 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong className="min-w-0 break-words text-sm text-white">{event.type}</strong>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{event.severity}</span>
              </div>
              <p className="mt-2 break-words text-sm text-slate-300">{event.message}</p>
              <pre
                data-testid="telemetry-payload"
                className="mt-3 max-w-full whitespace-pre-wrap break-words rounded-xl bg-black/30 p-3 text-xs text-cyan-100 [overflow-wrap:anywhere]"
              >
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </div>
          ))}
          {telemetry.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
              Select or launch a run to stream live telemetry.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
