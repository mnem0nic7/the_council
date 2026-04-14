"use client";

import type {
  MissionAgentDefinition,
  MissionRun,
  MissionWorkspace,
  TelemetryEvent
} from "@the-council/contracts";

export function CrewStation({
  mission,
  run,
  missionAgents,
  telemetry,
  agentTelemetry
}: {
  mission?: MissionWorkspace;
  run?: MissionRun;
  missionAgents: MissionAgentDefinition[];
  telemetry: TelemetryEvent[];
  agentTelemetry: Map<string, TelemetryEvent>;
}) {
  if (!mission) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.8rem] border border-dashed border-white/10 bg-black/15 p-8 text-center text-sm text-slate-400">
        Select a mission workspace to inspect its crew.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="panel-title text-cyan-300">Crew</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Mission crew readiness and live activity</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {missionAgents.map((agent) => {
          const lastEvent = agentTelemetry.get(agent.id);
          return (
            <div key={agent.id} className="rounded-[1.7rem] border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <strong className="text-lg text-white">{agent.name}</strong>
                  <p className="mt-2 text-sm text-slate-400">{agent.role}</p>
                </div>
                <span className="status-dot bg-cyan-300 text-cyan-300" />
              </div>
              <p className="mt-4 text-xs uppercase tracking-[0.2em] text-slate-500">Tools</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {agent.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-cyan-200"
                  >
                    {tool}
                  </span>
                ))}
              </div>
              <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Latest activity</p>
                <p className="mt-2 text-sm text-slate-200">
                  {lastEvent?.message ?? "No live telemetry for this agent yet."}
                </p>
              </div>
            </div>
          );
        })}
        {missionAgents.length === 0 ? (
          <div className="rounded-[1.7rem] border border-dashed border-white/10 bg-black/20 p-6 text-sm text-slate-400">
            This mission has no crew yet. Add mission-local agents from Engineering.
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Selected Mission</p>
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl border border-white/8 p-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm text-white">{mission.name}</strong>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{mission.status}</span>
              </div>
              <p className="mt-2 text-sm text-slate-400">{mission.description || "No mission description."}</p>
            </div>
            <div className="rounded-2xl border border-white/8 p-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm text-white">{run?.name ?? "No selected run"}</strong>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{run?.status ?? "idle"}</span>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                {run?.currentNodes?.length ? run.currentNodes.join(", ") : "No active nodes for the selected run."}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-cyan-300">Recent Bridge Events</p>
          <div className="scroll-thin mt-4 max-h-[20rem] space-y-3 overflow-auto pr-1">
            {telemetry.slice(-8).reverse().map((event) => (
              <div key={event.id} className="rounded-2xl border border-white/8 p-3">
                <strong className="text-sm text-white">{event.message}</strong>
                <p className="mt-2 text-xs text-slate-400">{event.type}</p>
              </div>
            ))}
            {telemetry.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                No telemetry yet for the selected run.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
