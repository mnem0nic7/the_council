"use client";

import type {
  AgentDefinition,
  ArtifactRecord,
  MemoryRecord,
  MissionAgentDefinition,
  MissionRun,
  MissionWorkspace,
  RuntimeSettings,
  TelemetryEvent,
  WorkflowDefinition
} from "@the-council/contracts";
import { create } from "zustand";

export type StationId = "command" | "tactical" | "crew" | "engineering" | "archive";

export type ReplayPayload = {
  mission: MissionRun;
  events: TelemetryEvent[];
  artifacts: ArtifactRecord[];
  memories: MemoryRecord[];
} | null;

type CouncilState = {
  token: string | null;
  username: string | null;
  station: StationId;
  templateAgents: AgentDefinition[];
  templateWorkflows: WorkflowDefinition[];
  missions: MissionWorkspace[];
  missionAgents: MissionAgentDefinition[];
  missionWorkflow: WorkflowDefinition | null;
  missionRuns: MissionRun[];
  telemetry: TelemetryEvent[];
  settings: RuntimeSettings | null;
  replay: ReplayPayload;
  selectedMissionId: string | null;
  selectedRunId: string | null;
  streamingTokens: Record<string, string>;
  awaitingInputPrompt: string | null;
  initialLoad: boolean;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  setAuth: (token: string | null, username: string | null) => void;
  setStation: (station: StationId) => void;
  setTemplateAgents: (agents: AgentDefinition[]) => void;
  setTemplateWorkflows: (workflows: WorkflowDefinition[]) => void;
  setMissions: (missions: MissionWorkspace[]) => void;
  upsertMission: (mission: MissionWorkspace) => void;
  setMissionAgents: (agents: MissionAgentDefinition[]) => void;
  upsertMissionAgent: (agent: MissionAgentDefinition) => void;
  removeMissionAgent: (agentId: string) => void;
  setMissionWorkflow: (workflow: WorkflowDefinition | null) => void;
  setMissionRuns: (runs: MissionRun[]) => void;
  upsertMissionRun: (run: MissionRun) => void;
  setTelemetry: (events: TelemetryEvent[]) => void;
  appendTelemetry: (event: TelemetryEvent) => void;
  setSettings: (settings: RuntimeSettings) => void;
  setReplay: (replay: ReplayPayload) => void;
  setSelectedMissionId: (missionId: string | null) => void;
  setSelectedRunId: (runId: string | null) => void;
  appendStreamToken: (nodeId: string, token: string) => void;
  clearStreamToken: (nodeId: string) => void;
  setAwaitingInputPrompt: (prompt: string | null) => void;
  setInitialLoad: (loaded: boolean) => void;
  setLoading: (key: string, loading: boolean) => void;
  setError: (key: string, error: string | null) => void;
};

export const useCouncilStore = create<CouncilState>((set) => ({
  token: null,
  username: null,
  station: "command",
  templateAgents: [],
  templateWorkflows: [],
  missions: [],
  missionAgents: [],
  missionWorkflow: null,
  missionRuns: [],
  telemetry: [],
  settings: null,
  replay: null,
  selectedMissionId: null,
  selectedRunId: null,
  streamingTokens: {},
  awaitingInputPrompt: null,
  initialLoad: false,
  loading: {},
  errors: {},
  setAuth: (token, username) => set({ token, username }),
  setStation: (station) => set({ station }),
  setTemplateAgents: (templateAgents) => set({ templateAgents }),
  setTemplateWorkflows: (templateWorkflows) => set({ templateWorkflows }),
  setMissions: (missions) =>
    set((state) => ({
      missions,
      selectedMissionId: state.selectedMissionId ?? missions[0]?.id ?? null
    })),
  upsertMission: (mission) =>
    set((state) => {
      const missions = [...state.missions];
      const existing = missions.findIndex((entry) => entry.id === mission.id);
      if (existing >= 0) {
        missions[existing] = mission;
      } else {
        missions.unshift(mission);
      }
      return {
        missions,
        selectedMissionId: state.selectedMissionId ?? mission.id,
        selectedRunId:
          mission.activeRunId ??
          mission.latestRunId ??
          (state.selectedMissionId === mission.id ? state.selectedRunId : null)
      };
    }),
  setMissionAgents: (missionAgents) => set({ missionAgents }),
  upsertMissionAgent: (agent) =>
    set((state) => {
      const missionAgents = [...state.missionAgents];
      const existing = missionAgents.findIndex((entry) => entry.id === agent.id);
      if (existing >= 0) {
        missionAgents[existing] = agent;
      } else {
        missionAgents.push(agent);
      }
      missionAgents.sort((left, right) => left.name.localeCompare(right.name));
      return { missionAgents };
    }),
  removeMissionAgent: (agentId) =>
    set((state) => ({ missionAgents: state.missionAgents.filter((agent) => agent.id !== agentId) })),
  setMissionWorkflow: (missionWorkflow) => set({ missionWorkflow }),
  setMissionRuns: (missionRuns) =>
    set((state) => ({
      missionRuns,
      selectedRunId:
        state.selectedRunId ??
        missionRuns[0]?.id ??
        null
    })),
  upsertMissionRun: (run) =>
    set((state) => {
      const missionRuns = [...state.missionRuns];
      const existing = missionRuns.findIndex((entry) => entry.id === run.id);
      if (existing >= 0) {
        missionRuns[existing] = run;
      } else {
        missionRuns.unshift(run);
      }
      missionRuns.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return { missionRuns, selectedRunId: run.id };
    }),
  setTelemetry: (telemetry) => set({ telemetry }),
  appendTelemetry: (event) => set((state) => ({ telemetry: [...state.telemetry, event] })),
  setSettings: (settings) => set({ settings }),
  setReplay: (replay) => set({ replay }),
  setSelectedMissionId: (selectedMissionId) =>
    set({
      selectedMissionId,
      selectedRunId: null,
      missionAgents: [],
      missionWorkflow: null,
      missionRuns: [],
      telemetry: [],
      replay: null
    }),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId, telemetry: [], replay: null }),
  appendStreamToken: (nodeId, token) =>
    set((state) => ({
      streamingTokens: {
        ...state.streamingTokens,
        [nodeId]: (state.streamingTokens[nodeId] ?? "") + token,
      },
    })),
  clearStreamToken: (nodeId) =>
    set((state) => {
      const next = { ...state.streamingTokens };
      delete next[nodeId];
      return { streamingTokens: next };
    }),
  setAwaitingInputPrompt: (prompt) => set({ awaitingInputPrompt: prompt }),
  setInitialLoad: (loaded) => set({ initialLoad: loaded }),
  setLoading: (key, value) =>
    set((state) => ({ loading: { ...state.loading, [key]: value } })),
  setError: (key, value) =>
    set((state) => ({ errors: { ...state.errors, [key]: value } })),
}));
