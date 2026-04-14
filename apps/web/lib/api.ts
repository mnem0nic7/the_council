import type {
  AgentDefinition,
  LoginRequest,
  LoginResponse,
  MissionAction,
  MissionAgentDefinition,
  MissionRun,
  MissionWorkspace,
  RuntimeSettings,
  WorkflowDefinition
} from "@the-council/contracts";

import { getRuntimeUrl } from "./config";

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${getRuntimeUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  login: (payload: LoginRequest) =>
    request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listAgents: (token: string) => request<AgentDefinition[]>("/agents", {}, token),
  createAgent: (token: string, definition: AgentDefinition) =>
    request<AgentDefinition>(
      "/agents",
      {
        method: "POST",
        body: JSON.stringify(definition)
      },
      token
    ),
  updateAgent: (token: string, agentId: string, definition: AgentDefinition) =>
    request<AgentDefinition>(
      `/agents/${agentId}`,
      {
        method: "PUT",
        body: JSON.stringify(definition)
      },
      token
    ),
  deleteAgent: (token: string, agentId: string) =>
    request<void>(
      `/agents/${agentId}`,
      {
        method: "DELETE"
      },
      token
    ),
  listWorkflows: (token: string) => request<WorkflowDefinition[]>("/workflows", {}, token),
  createWorkflow: (token: string, definition: WorkflowDefinition) =>
    request<WorkflowDefinition>(
      "/workflows",
      {
        method: "POST",
        body: JSON.stringify({ definition })
      },
      token
    ),
  updateWorkflow: (token: string, definition: WorkflowDefinition) =>
    request<WorkflowDefinition>(
      `/workflows/${definition.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ definition })
      },
      token
    ),
  deleteWorkflow: (token: string, workflowId: string) =>
    request<void>(
      `/workflows/${workflowId}`,
      {
        method: "DELETE"
      },
      token
    ),
  listMissions: (token: string) => request<MissionWorkspace[]>("/missions", {}, token),
  createMission: (
    token: string,
    payload: {
      name: string;
      description?: string;
      templateWorkflowId?: string | null;
      defaultInput?: Record<string, unknown>;
      defaultProviderOverrides?: Record<string, unknown>;
    }
  ) =>
    request<MissionWorkspace>(
      "/missions",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  getMission: (token: string, missionId: string) =>
    request<MissionWorkspace>(`/missions/${missionId}`, {}, token),
  updateMission: (
    token: string,
    missionId: string,
    payload: {
      name: string;
      description?: string;
      defaultInput?: Record<string, unknown>;
      defaultProviderOverrides?: Record<string, unknown>;
    }
  ) =>
    request<MissionWorkspace>(
      `/missions/${missionId}`,
      {
        method: "PUT",
        body: JSON.stringify(payload)
      },
      token
    ),
  listMissionAgents: (token: string, missionId: string) =>
    request<MissionAgentDefinition[]>(`/missions/${missionId}/agents`, {}, token),
  createMissionAgent: (token: string, missionId: string, payload: MissionAgentDefinition) =>
    request<MissionAgentDefinition>(
      `/missions/${missionId}/agents`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  importMissionAgent: (token: string, missionId: string, templateAgentId: string) =>
    request<MissionAgentDefinition>(
      `/missions/${missionId}/agents/import`,
      {
        method: "POST",
        body: JSON.stringify({ templateAgentId })
      },
      token
    ),
  updateMissionAgent: (
    token: string,
    missionId: string,
    missionAgentId: string,
    payload: MissionAgentDefinition
  ) =>
    request<MissionAgentDefinition>(
      `/missions/${missionId}/agents/${missionAgentId}`,
      {
        method: "PUT",
        body: JSON.stringify(payload)
      },
      token
    ),
  deleteMissionAgent: (token: string, missionId: string, missionAgentId: string) =>
    request<void>(
      `/missions/${missionId}/agents/${missionAgentId}`,
      {
        method: "DELETE"
      },
      token
    ),
  getMissionWorkflow: (token: string, missionId: string) =>
    request<WorkflowDefinition>(`/missions/${missionId}/workflow`, {}, token),
  updateMissionWorkflow: (token: string, missionId: string, definition: WorkflowDefinition) =>
    request<WorkflowDefinition>(
      `/missions/${missionId}/workflow`,
      {
        method: "PUT",
        body: JSON.stringify({ definition })
      },
      token
    ),
  listMissionRuns: (token: string, missionId: string) =>
    request<MissionRun[]>(`/missions/${missionId}/runs`, {}, token),
  getMissionRun: (token: string, missionId: string, runId: string) =>
    request<MissionRun>(`/missions/${missionId}/runs/${runId}`, {}, token),
  launchMissionRun: (
    token: string,
    missionId: string,
    payload: { name?: string | null; input?: Record<string, unknown>; providerOverrides?: Record<string, unknown> }
  ) =>
    request<MissionRun>(
      `/missions/${missionId}/runs`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  actionMissionRun: (token: string, missionId: string, runId: string, payload: MissionAction) =>
    request<MissionRun>(
      `/missions/${missionId}/runs/${runId}/actions`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  getReplay: (token: string, missionId: string, runId: string) =>
    request<any>(`/missions/${missionId}/runs/${runId}/replay`, {}, token),
  getSettings: (token: string) => request<RuntimeSettings>("/settings/runtime", {}, token)
};
