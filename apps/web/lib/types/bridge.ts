import type { MissionAgentDefinition, ToolName } from "@the-council/contracts";

export type LoginState = {
  username: string;
  password: string;
};

export type MissionDraftState = {
  name: string;
  description: string;
  prompt: string;
  route: string;
  runName: string;
  templateWorkflowId: string;
};

export type MissionAgentEditorState = {
  id: string;
  missionId: string;
  templateAgentId: string | null;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  tools: ToolName[];
  handoffTargets: string;
  memoryMode: MissionAgentDefinition["memoryProfile"]["mode"];
  memoryNamespace: string;
  memoryTopK: string;
  toolPolicyJson: string;
};
