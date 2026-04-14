"use client";

import { useRef } from "react";
import { type StationId } from "../lib/store";
import { stations } from "../lib/utils/constants";

export function StationTabs({
  station,
  onSetStation
}: {
  station: StationId;
  onSetStation: (id: StationId) => void;
}) {
  const tablistRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = stations.findIndex((entry) => entry.id === station);
    let nextIndex: number;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + stations.length) % stations.length;
    } else {
      nextIndex = (currentIndex + 1) % stations.length;
    }
    const nextStation = stations[nextIndex];
    onSetStation(nextStation.id as StationId);
    // Move focus to the newly active tab button
    const buttons = tablistRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[nextIndex]?.focus();
  }

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label="Station navigation"
      className="mb-4 flex flex-wrap gap-2"
      onKeyDown={handleKeyDown}
    >
      {stations.map((entry) => (
        <button
          key={entry.id}
          id={`station-tab-${entry.id}`}
          type="button"
          role="tab"
          aria-selected={station === entry.id}
          aria-controls={`station-panel-${entry.id}`}
          tabIndex={station === entry.id ? 0 : -1}
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
