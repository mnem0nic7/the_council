"use client";

import type { TelemetryEvent } from "@the-council/contracts";

export function TelemetryEventCard({ event }: { event: TelemetryEvent }) {
  const severityColor = {
    info: "text-cyan-400",
    warning: "text-yellow-400",
    error: "text-red-400",
  }[event.severity] ?? "text-cyan-400";

  return (
    <div className="border-b border-gray-700/50 py-1.5 px-2" data-testid={`telemetry-${event.type}`}>
      <div className="flex items-start gap-2">
        <span className={`text-xs font-mono shrink-0 ${severityColor}`}>
          [{event.sequence.toString().padStart(3, "0")}]
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-mono text-gray-300 break-words">{event.message}</span>
          {event.nodeId && (
            <span className="ml-1 text-xs text-gray-500">node:{event.nodeId}</span>
          )}
        </div>
        <span className="text-xs text-gray-600 shrink-0 font-mono">
          {event.type}
        </span>
      </div>
      {event.agentId && (
        <div className="text-xs text-gray-500 ml-8">agent:{event.agentId}</div>
      )}
    </div>
  );
}
