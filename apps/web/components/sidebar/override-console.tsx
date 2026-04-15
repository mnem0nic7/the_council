"use client";

import type { MissionAction, MissionRun } from "@the-council/contracts";
import { ActionButton } from "../ui/action-button";

export function OverrideConsole({
  selectedRun,
  busy,
  retaskNote,
  onRetaskNoteChange,
  onDispatchAction
}: {
  selectedRun?: MissionRun;
  busy: string | null;
  retaskNote: string;
  onRetaskNoteChange: (value: string) => void;
  onDispatchAction: (action: MissionAction) => void;
}) {
  return (
    <section className="panel rounded-[2rem] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="panel-title text-amber-300">Override Console</p>
          <h2 className="mt-2 text-xl text-white">Run interventions</h2>
        </div>
        <div className="status-dot bg-rose-300 text-rose-300" />
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label="Pause"
            tone="warning"
            disabled={!selectedRun || busy === "pause"}
            onClick={() => onDispatchAction({ action: "pause", payload: {} })}
          />
          <ActionButton
            label="Resume"
            tone="primary"
            disabled={!selectedRun || busy === "resume"}
            onClick={() => onDispatchAction({ action: "resume", payload: {} })}
          />
          <ActionButton
            label="Cancel"
            tone="danger"
            disabled={!selectedRun || busy === "cancel"}
            onClick={() => onDispatchAction({ action: "cancel", payload: {} })}
          />
          <ActionButton
            label="Disable Shell"
            tone="muted"
            disabled={!selectedRun || busy === "disable_tool"}
            onClick={() => onDispatchAction({ action: "disable_tool", payload: { tool: "shell" } })}
          />
        </div>
        <textarea
          className="min-h-28 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/60"
          value={retaskNote}
          onChange={(event) => onRetaskNoteChange(event.target.value)}
          placeholder="Inject a course correction for the selected run."
        />
        <ActionButton
          label="Retask Run"
          tone="primary"
          disabled={!selectedRun || !retaskNote.trim() || busy === "retask"}
          onClick={() => onDispatchAction({ action: "retask", payload: { note: retaskNote.trim() } })}
        />
      </div>
    </section>
  );
}
