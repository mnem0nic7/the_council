import type {
  AgentDefinition,
  LoginRequest,
  LoginResponse,
  MissionAction,
  MissionRun,
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
  listWorkflows: (token: string) => request<WorkflowDefinition[]>("/workflows", {}, token),
  updateWorkflow: (token: string, definition: WorkflowDefinition) =>
    request<WorkflowDefinition>(
      `/workflows/${definition.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ definition })
      },
      token
    ),
  createWorkflow: (token: string, definition: WorkflowDefinition) =>
    request<WorkflowDefinition>(
      "/workflows",
      {
        method: "POST",
        body: JSON.stringify({ definition })
      },
      token
    ),
  listMissions: (token: string) => request<MissionRun[]>("/missions", {}, token),
  getMission: (token: string, missionId: string) => request<MissionRun>(`/missions/${missionId}`, {}, token),
  launchMission: (
    token: string,
    payload: { workflowId: string; name: string; input: Record<string, unknown>; providerOverrides?: Record<string, unknown> }
  ) =>
    request<MissionRun>(
      "/missions",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  actionMission: (token: string, missionId: string, payload: MissionAction) =>
    request<MissionRun>(
      `/missions/${missionId}/actions`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      token
    ),
  getReplay: (token: string, missionId: string) => request<any>(`/missions/${missionId}/replay`, {}, token),
  getSettings: (token: string) => request<RuntimeSettings>("/settings/runtime", {}, token)
};
