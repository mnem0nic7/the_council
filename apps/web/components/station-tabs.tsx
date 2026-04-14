"use client";

import { stations, type StationId } from "../lib/utils/constants";

export function StationTabs({
  station,
  onSetStation
}: {
  station: string;
  onSetStation: (id: StationId) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {stations.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSetStation(entry.id as StationId)}
          data-testid={`station-${entry.id}`}
          className={`rounded-full px-4 py-2 text-xs uppercase tracking-[0.22em] transition ${
            station === entry.id
              ? "bg-cyan-300 text-slate-950 shadow-pulse"
              : "border border-white/10 bg-black/20 text-slate-300 hover:border-cyan-300/40"
          }`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
