import type {
  MissionAgentDefinition,
  MissionWorkspace,
  RuntimeSettings,
  ToolName,
  ToolPolicy
} from "@the-council/contracts";
import type { MissionAgentEditorState, MissionDraftState } from "../types/bridge";

export function defaultToolPolicy(settings: RuntimeSettings | null, tools: ToolName[]): ToolPolicy {
  if (settings) {
    return {
      ...settings.defaultPolicy,
      allowedTools: tools
    };
  }

  return {
    allowedTools: tools,
    domainAllowlist: [],
    shellAllowlist: [],
    shellDenylist: [],
    writableRoots: [],
    maxRuntimeSeconds: 300,
    maxArtifacts: 20,
    maxTokens: 4000
  };
}

export function syncToolPolicyJson(policyJson: string, settings: RuntimeSettings | null, tools: ToolName[]): string {
  let policy = defaultToolPolicy(settings, tools);
  try {
    const parsed = JSON.parse(policyJson) as Partial<ToolPolicy>;
    policy = {
      ...policy,
      ...parsed,
      allowedTools: tools
    };
  } catch {
    policy = defaultToolPolicy(settings, tools);
  }

  return JSON.stringify(policy, null, 2);
}

export function missionDraftFromWorkspace(mission: MissionWorkspace | null): MissionDraftState {
  return {
    name: mission?.name ?? "",
    description: mission?.description ?? "",
    prompt: String(mission?.defaultInput?.prompt ?? ""),
    route: String(mission?.defaultInput?.route ?? "analysis"),
    runName: "",
    templateWorkflowId: mission?.templateWorkflowId ?? ""
  };
}

export function nextMissionAgentId(existing: MissionAgentDefinition[]): string {
  let index = existing.length + 1;
  let candidate = `mission-agent-${index}`;
  while (existing.some((agent) => agent.id === candidate)) {
    index += 1;
    candidate = `mission-agent-${index}`;
  }
  return candidate;
}

export function buildNewMissionAgentEditorState(
  settings: RuntimeSettings | null,
  missionId: string,
  existing: MissionAgentDefinition[]
): MissionAgentEditorState {
  const providerId = settings?.providers[0]?.id ?? "";
  const tools: ToolName[] = [];
  return {
    id: nextMissionAgentId(existing),
    missionId,
    templateAgentId: null,
    name: "",
    role: "",
    description: "",
    systemPrompt: "",
    providerId,
    tools,
    handoffTargets: "",
    memoryMode: "hybrid",
    memoryNamespace: settings?.storage.memoryNamespace ?? "bridge",
    memoryTopK: "5",
    toolPolicyJson: JSON.stringify(defaultToolPolicy(settings, tools), null, 2)
  };
}

export function buildMissionAgentEditorState(agent: MissionAgentDefinition): MissionAgentEditorState {
  return {
    id: agent.id,
    missionId: agent.missionId,
    templateAgentId: agent.templateAgentId ?? null,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    providerId: agent.provider.id,
    tools: agent.tools,
    handoffTargets: agent.handoffTargets.join(", "),
    memoryMode: agent.memoryProfile.mode,
    memoryNamespace: agent.memoryProfile.namespace,
    memoryTopK: String(agent.memoryProfile.topK),
    toolPolicyJson: JSON.stringify(agent.toolPolicy, null, 2)
  };
}

export function toMissionAgentDefinition(
  editor: MissionAgentEditorState,
  settings: RuntimeSettings,
  existing?: MissionAgentDefinition
): MissionAgentDefinition {
  const provider = settings.providers.find((entry) => entry.id === editor.providerId) ?? settings.providers[0];
  if (!provider) {
    throw new Error("No providers configured for this bridge.");
  }

  const id = editor.id.trim();
  const name = editor.name.trim();
  const role = editor.role.trim();
  const systemPrompt = editor.systemPrompt.trim();
  if (!editor.missionId || !id || !name || !role || !systemPrompt) {
    throw new Error("Mission agent id, call sign, role, and system prompt are required.");
  }

  let parsedPolicy = defaultToolPolicy(settings, editor.tools);
  try {
    const candidate = JSON.parse(editor.toolPolicyJson) as Partial<ToolPolicy>;
    parsedPolicy = {
      ...parsedPolicy,
      ...candidate,
      allowedTools: editor.tools
    };
  } catch {
    throw new Error("Tool policy must be valid JSON.");
  }

  const topK = Number(editor.memoryTopK);
  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("Recall depth must be a positive number.");
  }

  return {
    id,
    missionId: editor.missionId,
    templateAgentId: editor.templateAgentId ?? undefined,
    name,
    role,
    description: editor.description.trim(),
    systemPrompt,
    provider,
    tools: editor.tools,
    toolPolicy: parsedPolicy,
    memoryProfile: {
      mode: editor.memoryMode,
      namespace: editor.memoryNamespace.trim() || settings.storage.memoryNamespace,
      topK: Math.round(topK)
    },
    handoffTargets: editor.handoffTargets
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    createdAt: existing?.createdAt,
    updatedAt: existing?.updatedAt
  };
}

export function cloneMissionAgents(agents: MissionAgentDefinition[]): MissionAgentDefinition[] {
  return [...agents].sort((left, right) => left.name.localeCompare(right.name));
}

export function canEditMissionStructure(mission: MissionWorkspace | undefined) {
  return !mission || !mission.activeRunId || mission.status === "paused";
}
