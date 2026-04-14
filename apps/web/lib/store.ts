"use client";

import type {
  AgentDefinition,
  MissionRun,
  RuntimeSettings,
  TelemetryEvent,
  WorkflowDefinition
} from "@the-council/contracts";
import { create } from "zustand";

export type StationId = "command" | "tactical" | "crew" | "engineering" | "archive";

type ReplayPayload = {
  events: TelemetryEvent[];
  artifacts: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
} | null;

type CouncilState = {
  token: string | null;
  username: string | null;
  station: StationId;
  agents: AgentDefinition[];
  workflows: WorkflowDefinition[];
  missions: MissionRun[];
  telemetry: TelemetryEvent[];
  settings: RuntimeSettings | null;
  replay: ReplayPayload;
  activeWorkflowId: string | null;
  activeMissionId: string | null;
  setAuth: (token: string | null, username: string | null) => void;
  setStation: (station: StationId) => void;
  setAgents: (agents: AgentDefinition[]) => void;
  setWorkflows: (workflows: WorkflowDefinition[]) => void;
  setMissions: (missions: MissionRun[]) => void;
  upsertMission: (mission: MissionRun) => void;
  setTelemetry: (events: TelemetryEvent[]) => void;
  appendTelemetry: (event: TelemetryEvent) => void;
  setSettings: (settings: RuntimeSettings) => void;
  setReplay: (replay: ReplayPayload) => void;
  setActiveWorkflow: (workflowId: string | null) => void;
  setActiveMission: (missionId: string | null) => void;
};

export const useCouncilStore = create<CouncilState>((set) => ({
  token: null,
  username: null,
  station: "command",
  agents: [],
  workflows: [],
  missions: [],
  telemetry: [],
  settings: null,
  replay: null,
  activeWorkflowId: null,
  activeMissionId: null,
  setAuth: (token, username) => set({ token, username }),
  setStation: (station) => set({ station }),
  setAgents: (agents) => set({ agents }),
  setWorkflows: (workflows) =>
    set((state) => ({
      workflows,
      activeWorkflowId: state.activeWorkflowId ?? workflows[0]?.id ?? null
    })),
  setMissions: (missions) =>
    set((state) => ({
      missions,
      activeMissionId: state.activeMissionId ?? missions[0]?.id ?? null
    })),
  upsertMission: (mission) =>
    set((state) => {
      const existing = state.missions.findIndex((entry) => entry.id === mission.id);
      const missions = [...state.missions];
      if (existing >= 0) {
        missions[existing] = mission;
      } else {
        missions.unshift(mission);
      }
      return { missions, activeMissionId: mission.id };
    }),
  setTelemetry: (telemetry) => set({ telemetry }),
  appendTelemetry: (event) => set((state) => ({ telemetry: [...state.telemetry, event] })),
  setSettings: (settings) => set({ settings }),
  setReplay: (replay) => set({ replay }),
  setActiveWorkflow: (workflowId) => set({ activeWorkflowId: workflowId }),
  setActiveMission: (missionId) => set({ activeMissionId: missionId, telemetry: [] })
}));

