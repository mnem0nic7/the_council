"use client";

import type { MissionRun, MissionWorkspace } from "@the-council/contracts";
import type { ReplayPayload } from "../../lib/store";

export function ArchiveStation({
  replay,
  mission,
  run
}: {
  replay: ReplayPayload;
  mission?: MissionWorkspace;
  run?: MissionRun;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="panel-title text-cyan-300">Archive</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Run replay, artifacts, and mission memory</h2>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Replay</p>
          <p className="mt-2 text-sm text-slate-400">
            {mission?.name ?? "No mission selected"} / {run?.name ?? "No run selected"}
          </p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.events.map((event) => (
              <div
                key={event.id}
                data-testid={`replay-event-${event.type}`}
                className="rounded-2xl border border-white/8 p-3"
              >
                <strong className="text-sm text-white">{event.type}</strong>
                <p className="mt-2 text-sm text-slate-400">{event.message}</p>
              </div>
            )) ?? (
              <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                Select a run to load its replay feed.
              </p>
            )}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-cyan-300">Artifacts</p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                data-testid={`artifact-${artifact.kind}`}
                className="rounded-2xl border border-white/8 p-3"
              >
                <strong className="text-sm text-white">{artifact.label}</strong>
                <p className="mt-2 break-all text-xs text-cyan-200">{artifact.uri}</p>
                <pre className="mt-3 max-w-full whitespace-pre-wrap break-words rounded-xl bg-black/30 p-3 text-xs text-slate-300 [overflow-wrap:anywhere]">
                  {artifact.contentText}
                </pre>
              </div>
            )) ?? <p className="text-sm text-slate-400">No artifacts loaded.</p>}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Long-Term Memory</p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.memories.map((memory) => (
              <div key={memory.id} className="rounded-2xl border border-white/8 p-3">
                <strong className="text-sm text-white">{memory.namespace}</strong>
                <p className="mt-2 text-sm text-slate-300">{memory.content}</p>
              </div>
            )) ?? <p className="text-sm text-slate-400">No memories loaded.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
