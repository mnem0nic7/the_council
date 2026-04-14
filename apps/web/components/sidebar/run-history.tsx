"use client";

import type { MissionRun, MissionWorkspace } from "@the-council/contracts";

export function RunHistory({
  missionRuns,
  selectedMission,
  selectedRun,
  onSelectRun
}: {
  missionRuns: MissionRun[];
  selectedMission?: MissionWorkspace;
  selectedRun?: MissionRun;
  onSelectRun: (id: string) => void;
}) {
  return (
    <section className="panel rounded-[2rem] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="panel-title text-amber-300">Run History</p>
          <h2 className="mt-2 text-xl text-white">Launches for selected mission</h2>
        </div>
        <div className="status-dot bg-cyan-300 text-cyan-300" />
      </div>
      <div className="scroll-thin max-h-[18rem] space-y-3 overflow-auto pr-1">
        {missionRuns.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onSelectRun(run.id)}
            data-testid={`run-card-${run.id}`}
            className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
              run.id === selectedRun?.id
                ? "border-cyan-300/60 bg-cyan-300/10"
                : "border-white/8 bg-black/10 hover:border-cyan-300/30"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <strong className="text-sm text-white">{run.name}</strong>
              <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{run.status}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">{run.id}</p>
          </button>
        ))}
        {selectedMission && missionRuns.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
            This mission has no runs yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}
