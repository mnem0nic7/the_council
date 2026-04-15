"use client";

import type { MissionWorkspace } from "@the-council/contracts";

export function MissionQueue({
  missions,
  selectedMission,
  onSelectMission
}: {
  missions: MissionWorkspace[];
  selectedMission?: MissionWorkspace;
  onSelectMission: (id: string) => void;
}) {
  return (
    <section className="panel rounded-[2rem] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="panel-title text-cyan-300">Mission Queue</p>
          <h2 className="mt-2 text-xl text-white">Mission workspaces</h2>
        </div>
        <div className="status-dot bg-amber-300 text-amber-300" />
      </div>
      <div className="scroll-thin max-h-[18rem] space-y-3 overflow-auto pr-1">
        {missions.map((mission) => (
          <button
            key={mission.id}
            type="button"
            onClick={() => onSelectMission(mission.id)}
            data-testid={`mission-card-${mission.id}`}
            className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
              mission.id === selectedMission?.id
                ? "border-cyan-300/60 bg-cyan-300/10"
                : "border-white/8 bg-black/10 hover:border-cyan-300/30"
            }`}
          >
            <div className="flex items-center justify-between">
              <strong className="text-sm text-white">{mission.name}</strong>
              <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                {mission.status}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">{mission.id}</p>
          </button>
        ))}
        {missions.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
            No mission workspaces yet. Create one from Command Deck.
          </p>
        ) : null}
      </div>
    </section>
  );
}
