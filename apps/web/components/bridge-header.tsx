"use client";

import type { AgentDefinition, MissionAgentDefinition } from "@the-council/contracts";

export function BridgeHeader({
  username,
  activeMissionCount,
  templateAgents,
  missionAgents
}: {
  username: string | null;
  activeMissionCount: number;
  templateAgents: AgentDefinition[];
  missionAgents: MissionAgentDefinition[];
}) {
  return (
    <header className="panel mb-4 flex flex-col gap-4 rounded-[1.8rem] px-5 py-4 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="panel-title text-cyan-300">Starship Agent Mission Control</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Bridge Online</h1>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
        <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5">
          Operator {username}
        </span>
        <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-cyan-200">
          {activeMissionCount} active missions
        </span>
        <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-amber-200">
          {templateAgents.length} templates / {missionAgents.length} mission crew
        </span>
      </div>
    </header>
  );
}
