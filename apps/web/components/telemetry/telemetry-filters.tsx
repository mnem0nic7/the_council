"use client";

import type { TelemetryEvent, TelemetrySeverity } from "@the-council/contracts";

export type TelemetryFilterState = {
  search: string;
  severities: Set<TelemetrySeverity>;
  agentId: string;
  eventType: string;
};

export function defaultFilters(): TelemetryFilterState {
  return {
    search: "",
    severities: new Set(["info", "warning", "error"]),
    agentId: "",
    eventType: "",
  };
}

export function applyFilters(events: TelemetryEvent[], filters: TelemetryFilterState): TelemetryEvent[] {
  return events.filter((event) => {
    if (!filters.severities.has(event.severity)) return false;
    if (filters.agentId && event.agentId !== filters.agentId) return false;
    if (filters.eventType && event.type !== filters.eventType) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!event.message.toLowerCase().includes(q) && !event.type.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

export function TelemetryFilters({
  events,
  filters,
  onFiltersChange,
}: {
  events: TelemetryEvent[];
  filters: TelemetryFilterState;
  onFiltersChange: (filters: TelemetryFilterState) => void;
}) {
  const agentIds = [...new Set(events.map((e) => e.agentId).filter(Boolean) as string[])];
  const eventTypes = [...new Set(events.map((e) => e.type))];
  const severities: TelemetrySeverity[] = ["info", "warning", "error"];

  return (
    <div className="flex flex-wrap gap-2 p-2 border-b border-gray-700/50">
      <input
        type="text"
        placeholder="Search..."
        value={filters.search}
        onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 w-32"
      />
      <div className="flex gap-1">
        {severities.map((sev) => {
          const active = filters.severities.has(sev);
          return (
            <button
              key={sev}
              onClick={() => {
                const next = new Set(filters.severities);
                if (active) next.delete(sev);
                else next.add(sev);
                onFiltersChange({ ...filters, severities: next });
              }}
              className={`px-2 py-0.5 text-xs rounded font-mono ${
                active
                  ? sev === "error" ? "bg-red-900 text-red-300"
                    : sev === "warning" ? "bg-yellow-900 text-yellow-300"
                    : "bg-cyan-900 text-cyan-300"
                  : "bg-gray-800 text-gray-500"
              }`}
            >
              {sev}
            </button>
          );
        })}
      </div>
      {agentIds.length > 0 && (
        <select
          value={filters.agentId}
          onChange={(e) => onFiltersChange({ ...filters, agentId: e.target.value })}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
        >
          <option value="">All agents</option>
          {agentIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      )}
      {eventTypes.length > 0 && (
        <select
          value={filters.eventType}
          onChange={(e) => onFiltersChange({ ...filters, eventType: e.target.value })}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
        >
          <option value="">All types</option>
          {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
    </div>
  );
}
