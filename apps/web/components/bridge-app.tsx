"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import type {
  AgentDefinition,
  MissionAction,
  MissionAgentDefinition,
  MissionRun,
  MissionWorkspace,
  RuntimeSettings,
  TelemetryEvent,
  ToolName,
  ToolPolicy,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType
} from "@the-council/contracts";

import { api } from "../lib/api";
import { getWsBaseUrl } from "../lib/config";
import { type ReplayPayload, useCouncilStore } from "../lib/store";
import { CockpitScene } from "./cockpit-scene";

const stations = [
  { id: "command", label: "Command Deck" },
  { id: "tactical", label: "Tactical" },
  { id: "crew", label: "Crew" },
  { id: "engineering", label: "Engineering" },
  { id: "archive", label: "Archive" }
] as const;

type StationId = (typeof stations)[number]["id"];

type LoginState = {
  username: string;
  password: string;
};

type MissionDraftState = {
  name: string;
  description: string;
  prompt: string;
  route: string;
  runName: string;
  templateWorkflowId: string;
};

type MissionAgentEditorState = {
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

const toolCatalog: Array<{ id: ToolName; label: string }> = [
  { id: "shell", label: "Shell" },
  { id: "filesystem", label: "Filesystem" },
  { id: "web", label: "Web" },
  { id: "api", label: "API" }
];

const nodeTypeCatalog: Array<{ id: WorkflowNodeType; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "tool", label: "Tool" },
  { id: "router", label: "Router" },
  { id: "memory", label: "Memory" },
  { id: "delay", label: "Delay" },
  { id: "human_input", label: "Human Input" },
  { id: "terminal", label: "Terminal" }
];

const engineeringPanelStorageKey = "council-engineering-left-panel-width";
const engineeringPanelDefaultWidth = 47.5;
const engineeringPanelMinWidth = 32;
const engineeringPanelMaxWidth = 62;
const commandPanelStorageKey = "council-command-left-panel-width";
const commandPanelDefaultWidth = 48;
const commandPanelMinWidth = 34;
const commandPanelMaxWidth = 62;

function clampEngineeringPanelWidth(value: number): number {
  return Math.min(engineeringPanelMaxWidth, Math.max(engineeringPanelMinWidth, value));
}

function clampCommandPanelWidth(value: number): number {
  return Math.min(commandPanelMaxWidth, Math.max(commandPanelMinWidth, value));
}

function defaultToolPolicy(settings: RuntimeSettings | null, tools: ToolName[]): ToolPolicy {
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

function syncToolPolicyJson(policyJson: string, settings: RuntimeSettings | null, tools: ToolName[]): string {
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

function cloneWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

function missionDraftFromWorkspace(mission: MissionWorkspace | null): MissionDraftState {
  return {
    name: mission?.name ?? "",
    description: mission?.description ?? "",
    prompt: String(mission?.defaultInput?.prompt ?? ""),
    route: String(mission?.defaultInput?.route ?? "analysis"),
    runName: "",
    templateWorkflowId: mission?.templateWorkflowId ?? ""
  };
}

function nextMissionAgentId(existing: MissionAgentDefinition[]): string {
  let index = existing.length + 1;
  let candidate = `mission-agent-${index}`;
  while (existing.some((agent) => agent.id === candidate)) {
    index += 1;
    candidate = `mission-agent-${index}`;
  }
  return candidate;
}

function buildNewMissionAgentEditorState(
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

function buildMissionAgentEditorState(agent: MissionAgentDefinition): MissionAgentEditorState {
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

function toMissionAgentDefinition(
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

function defaultNodeConfig(type: WorkflowNodeType, missionAgentId?: string): Record<string, unknown> {
  if (type === "agent") {
    return {
      agentId: missionAgentId ?? "",
      promptTemplate: "Mission prompt: {{mission.input.prompt}}"
    };
  }
  if (type === "tool") {
    return {
      agentId: missionAgentId ?? "",
      tool: "shell",
      args: {
        command: "echo mission-ready"
      }
    };
  }
  if (type === "router") {
    return {
      route: "{{mission.input.route}}"
    };
  }
  if (type === "memory") {
    return {
      mode: "write",
      namespace: "archive",
      content: "{{results}}"
    };
  }
  if (type === "delay") {
    return {
      seconds: 1
    };
  }
  if (type === "human_input") {
    return {
      defaultInput: "{{mission.input.prompt}}"
    };
  }
  return {
    output: "{{results}}"
  };
}

function nextNodeId(workflow: WorkflowDefinition): string {
  let index = workflow.nodes.length + 1;
  let candidate = `node-${index}`;
  while (workflow.nodes.some((node) => node.id === candidate)) {
    index += 1;
    candidate = `node-${index}`;
  }
  return candidate;
}

function nextEdgeId(workflow: WorkflowDefinition): string {
  let index = workflow.edges.length + 1;
  let candidate = `edge-${index}`;
  while (workflow.edges.some((edge) => edge.id === candidate)) {
    index += 1;
    candidate = `edge-${index}`;
  }
  return candidate;
}

function parseConfigJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function configJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

function cloneMissionAgents(agents: MissionAgentDefinition[]): MissionAgentDefinition[] {
  return [...agents].sort((left, right) => left.name.localeCompare(right.name));
}

function usePanelResize(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  clamp: (value: number) => number
) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") {
      return defaultWidth;
    }
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultWidth;
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(storageKey, String(leftPanelWidth));
  }, [leftPanelWidth, storageKey]);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const updateWidth = (clientX: number) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return;
      }
      const next = ((clientX - rect.left) / rect.width) * 100;
      setLeftPanelWidth(clamp(next));
    };

    const handlePointerMove = (event: PointerEvent) => {
      updateWidth(event.clientX);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [clamp, isResizing]);

  function beginResize(clientX: number) {
    const rect = layoutRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const next = ((clientX - rect.left) / rect.width) * 100;
      setLeftPanelWidth(clamp(next));
    }
    setIsResizing(true);
  }

  function nudgeResize(delta: number) {
    setLeftPanelWidth((current) => clamp(current + delta));
  }

  return {
    layoutRef,
    leftPanelWidth,
    isResizing,
    minWidth,
    maxWidth,
    defaultWidth,
    beginResize,
    nudgeResize,
    setLeftPanelWidth
  };
}

function canEditMissionStructure(mission: MissionWorkspace | undefined) {
  return !mission || !mission.activeRunId || mission.status === "paused";
}

export function BridgeApp() {
  const {
    token,
    username,
    station,
    templateAgents,
    templateWorkflows,
    missions,
    missionAgents,
    missionWorkflow,
    missionRuns,
    telemetry,
    settings,
    replay,
    selectedMissionId,
    selectedRunId,
    setAuth,
    setStation,
    setTemplateAgents,
    setTemplateWorkflows,
    setMissions,
    upsertMission,
    setMissionAgents,
    upsertMissionAgent,
    removeMissionAgent,
    setMissionWorkflow,
    setMissionRuns,
    upsertMissionRun,
    setTelemetry,
    appendTelemetry,
    setSettings,
    setReplay,
    setSelectedMissionId,
    setSelectedRunId
  } = useCouncilStore();

  const [loginState, setLoginState] = useState<LoginState>({
    username: "captain",
    password: "bridge123"
  });
  const [missionDraft, setMissionDraft] = useState<MissionDraftState>(() => missionDraftFromWorkspace(null));
  const [missionAgentEditorMode, setMissionAgentEditorMode] = useState<"create" | "edit">("create");
  const [selectedMissionAgentId, setSelectedMissionAgentId] = useState<string | null>(null);
  const [missionAgentEditor, setMissionAgentEditor] = useState<MissionAgentEditorState | null>(null);
  const [importTemplateId, setImportTemplateId] = useState("");
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDefinition | null>(null);
  const [workflowJson, setWorkflowJson] = useState("");
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>("agent");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retaskNote, setRetaskNote] = useState("");

  const selectedMission = missions.find((mission) => mission.id === selectedMissionId) ?? missions[0];
  const selectedRun = missionRuns.find((run) => run.id === selectedRunId) ?? missionRuns[0];
  const selectedMissionAgent = missionAgents.find((agent) => agent.id === selectedMissionAgentId) ?? null;
  const structuralEditsAllowed = canEditMissionStructure(selectedMission);

  async function hydrateMissionContext(
    authToken: string,
    missionId: string,
    refreshEditors: boolean
  ) {
    const [mission, agents, workflow, runs] = await Promise.all([
      api.getMission(authToken, missionId),
      api.listMissionAgents(authToken, missionId),
      api.getMissionWorkflow(authToken, missionId),
      api.listMissionRuns(authToken, missionId)
    ]);

    upsertMission(mission);
    setMissionAgents(cloneMissionAgents(agents));
    setMissionWorkflow(workflow);
    setMissionRuns(runs);

    const preferredRunId = runs.find((run) => run.id === selectedRunId)?.id;
    const nextRunId = preferredRunId ?? mission.activeRunId ?? mission.latestRunId ?? runs[0]?.id ?? null;
    if (nextRunId !== selectedRunId) {
      setSelectedRunId(nextRunId);
    }

    if (!refreshEditors) {
      return;
    }

    setMissionDraft(missionDraftFromWorkspace(mission));
    setWorkflowDraft(cloneWorkflow(workflow));
    setWorkflowJson(JSON.stringify(workflow, null, 2));
    setImportTemplateId(
      templateAgents.find((agent) => !agents.some((missionAgent) => missionAgent.id === agent.id))?.id ?? ""
    );

    if (agents.length > 0) {
      setSelectedMissionAgentId(agents[0].id);
      setMissionAgentEditorMode("edit");
      setMissionAgentEditor(buildMissionAgentEditorState(agents[0]));
    } else if (settings) {
      setSelectedMissionAgentId(null);
      setMissionAgentEditorMode("create");
      setMissionAgentEditor(buildNewMissionAgentEditorState(settings, mission.id, []));
    } else {
      setSelectedMissionAgentId(null);
      setMissionAgentEditorMode("create");
      setMissionAgentEditor(null);
    }
  }

  async function refreshRunContext(authToken: string, missionId: string, runId: string) {
    const [run, replayPayload] = await Promise.all([
      api.getMissionRun(authToken, missionId, runId),
      api.getReplay(authToken, missionId, runId)
    ]);
    upsertMissionRun(run);
    setReplay(replayPayload as ReplayPayload);
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    const authToken = token;
    let closed = false;

    async function load() {
      try {
        const [templateAgentData, workflowData, missionData, settingsData] = await Promise.all([
          api.listAgents(authToken),
          api.listWorkflows(authToken),
          api.listMissions(authToken),
          api.getSettings(authToken)
        ]);
        if (closed) {
          return;
        }
        setTemplateAgents(templateAgentData);
        setTemplateWorkflows(workflowData);
        setMissions(missionData);
        setSettings(settingsData);

        if (!selectedMissionId && missionData[0]) {
          setSelectedMissionId(missionData[0].id);
        }
      } catch (loadError) {
        if (!closed) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load bridge data");
        }
      }
    }

    void load();
    return () => {
      closed = true;
    };
  }, [
    selectedMissionId,
    setMissions,
    setSelectedMissionId,
    setSettings,
    setTemplateAgents,
    setTemplateWorkflows,
    token
  ]);

  useEffect(() => {
    if (!token || !selectedMissionId) {
      setMissionDraft(missionDraftFromWorkspace(null));
      setMissionAgentEditor(null);
      setWorkflowDraft(null);
      setWorkflowJson("");
      return;
    }
    let closed = false;
    const authToken = token;
    const missionId = selectedMissionId;

    async function loadMission() {
      try {
        await hydrateMissionContext(authToken, missionId, true);
      } catch (loadError) {
        if (!closed) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load mission workspace");
        }
      }
    }

    void loadMission();
    return () => {
      closed = true;
    };
  }, [selectedMissionId, token]);

  useEffect(() => {
    if (!token || !selectedMissionId || !selectedRunId) {
      setReplay(null);
      return;
    }
    let closed = false;
    const authToken = token;
    const missionId = selectedMissionId;
    const runId = selectedRunId;

    async function loadRun() {
      try {
        await refreshRunContext(authToken, missionId, runId);
      } catch (runError) {
        if (!closed) {
          setError(runError instanceof Error ? runError.message : "Unable to load run replay");
        }
      }
    }

    void loadRun();
    return () => {
      closed = true;
    };
  }, [selectedMissionId, selectedRunId, token, setReplay, upsertMissionRun]);

  useEffect(() => {
    if (!token || !selectedRunId || !selectedMissionId) {
      return;
    }
    const authToken = token;
    const missionId = selectedMissionId;
    const runId = selectedRunId;
    let socket: WebSocket | null = new WebSocket(`${getWsBaseUrl()}/runs/${runId}?token=${authToken}`);

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TelemetryEvent | { type: "history"; events: TelemetryEvent[] };
      if ("events" in payload) {
        setTelemetry(payload.events);
        void refreshRunContext(authToken, missionId, runId);
        return;
      }
      appendTelemetry(payload);
      if (
        payload.type === "mission.completed" ||
        payload.type === "mission.failed" ||
        payload.type === "mission.cancelled" ||
        payload.type === "mission.operator_action"
      ) {
        void hydrateMissionContext(authToken, missionId, false);
        void refreshRunContext(authToken, missionId, runId);
      }
    };

    socket.onerror = () => {
      setError("Mission telemetry link degraded");
    };

    return () => {
      socket?.close();
      socket = null;
    };
  }, [appendTelemetry, selectedMissionId, selectedRunId, setTelemetry, token, upsertMissionRun]);

  const activeMissionCount = missions.filter((mission) =>
    ["queued", "running", "paused", "awaiting_input"].includes(mission.status)
  ).length;

  const agentTelemetry = useMemo(() => {
    const entries = new Map<string, TelemetryEvent>();
    for (const event of telemetry) {
      if (event.agentId) {
        entries.set(event.agentId, event);
      }
    }
    return entries;
  }, [telemetry]);

  function patchMissionDraft(patch: Partial<MissionDraftState>) {
    setMissionDraft((current) => ({ ...current, ...patch }));
  }

  function patchMissionAgentEditor(patch: Partial<MissionAgentEditorState>) {
    setMissionAgentEditor((current) => (current ? { ...current, ...patch } : current));
  }

  function updateWorkflow(next: WorkflowDefinition) {
    setWorkflowDraft(next);
    setWorkflowJson(JSON.stringify(next, null, 2));
  }

  function patchWorkflowNode(nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) {
    if (!workflowDraft) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    next.nodes = next.nodes.map((node) => (node.id === nodeId ? updater(node) : node));
    updateWorkflow(next);
  }

  function patchWorkflowEdge(edgeId: string, updater: (edge: WorkflowEdge) => WorkflowEdge) {
    if (!workflowDraft) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    next.edges = next.edges.map((edge) => (edge.id === edgeId ? updater(edge) : edge));
    updateWorkflow(next);
  }

  function removeWorkflowNode(nodeId: string) {
    if (!workflowDraft) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    next.nodes = next.nodes.filter((node) => node.id !== nodeId);
    next.edges = next.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
    updateWorkflow(next);
  }

  function removeWorkflowEdge(edgeId: string) {
    if (!workflowDraft) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    next.edges = next.edges.filter((edge) => edge.id !== edgeId);
    updateWorkflow(next);
  }

  function addWorkflowNode() {
    if (!workflowDraft) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    const id = nextNodeId(next);
    next.nodes.push({
      id,
      name: `Node ${next.nodes.length + 1}`,
      type: newNodeType,
      description: "",
      position: {
        x: 80 + next.nodes.length * 180,
        y: 120 + (next.nodes.length % 3) * 120
      },
      config: defaultNodeConfig(newNodeType, missionAgents[0]?.id)
    });
    updateWorkflow(next);
  }

  function addWorkflowEdge() {
    if (!workflowDraft || workflowDraft.nodes.length < 2) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    next.edges.push({
      id: nextEdgeId(next),
      source: next.nodes[0].id,
      target: next.nodes[next.nodes.length - 1].id,
      label: "",
      condition: undefined
    });
    updateWorkflow(next);
  }

  function handleWorkflowJsonChange(value: string) {
    setWorkflowJson(value);
    try {
      const parsed = JSON.parse(value) as WorkflowDefinition;
      setWorkflowDraft(parsed);
    } catch {
      // Keep the last valid workflow draft until the editor content becomes valid JSON again.
    }
  }

  function startMissionAgentCreate() {
    if (!settings || !selectedMission) {
      return;
    }
    setSelectedMissionAgentId(null);
    setMissionAgentEditorMode("create");
    setMissionAgentEditor(buildNewMissionAgentEditorState(settings, selectedMission.id, missionAgents));
  }

  function selectMissionAgent(agentId: string) {
    const agent = missionAgents.find((entry) => entry.id === agentId);
    if (!agent) {
      return;
    }
    setSelectedMissionAgentId(agentId);
    setMissionAgentEditorMode("edit");
    setMissionAgentEditor(buildMissionAgentEditorState(agent));
  }

  function toggleMissionAgentTool(tool: ToolName) {
    setMissionAgentEditor((current) => {
      if (!current) {
        return current;
      }
      const nextTools = current.tools.includes(tool)
        ? current.tools.filter((entry) => entry !== tool)
        : [...current.tools, tool];
      const tools = [...nextTools].sort() as ToolName[];
      return {
        ...current,
        tools,
        toolPolicyJson: syncToolPolicyJson(current.toolPolicyJson, settings, tools)
      };
    });
  }

  async function handleLogin() {
    setBusy("login");
    setError(null);
    try {
      const response = await api.login(loginState);
      setAuth(response.accessToken, response.username);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed");
    } finally {
      setBusy(null);
    }
  }

  async function createMission() {
    if (!token) {
      return;
    }
    setBusy("create-mission");
    setError(null);
    try {
      const mission = await api.createMission(token, {
        name: missionDraft.name.trim() || "Untitled Mission",
        description: missionDraft.description.trim(),
        templateWorkflowId: missionDraft.templateWorkflowId || null,
        defaultInput: {
          prompt: missionDraft.prompt,
          route: missionDraft.route || "analysis"
        },
        defaultProviderOverrides: {}
      });
      upsertMission(mission);
      setSelectedMissionId(mission.id);
      await hydrateMissionContext(token, mission.id, true);
      setStation("command");
    } catch (missionError) {
      setError(missionError instanceof Error ? missionError.message : "Mission creation failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveMissionWorkspace() {
    if (!token || !selectedMission) {
      return;
    }
    setBusy("save-mission");
    setError(null);
    try {
      const mission = await api.updateMission(token, selectedMission.id, {
        name: missionDraft.name.trim() || selectedMission.name,
        description: missionDraft.description.trim(),
        defaultInput: {
          prompt: missionDraft.prompt,
          route: missionDraft.route || "analysis"
        },
        defaultProviderOverrides: selectedMission.defaultProviderOverrides ?? {}
      });
      upsertMission(mission);
      setMissionDraft(missionDraftFromWorkspace(mission));
    } catch (missionError) {
      setError(missionError instanceof Error ? missionError.message : "Mission update failed");
    } finally {
      setBusy(null);
    }
  }

  async function launchRun() {
    if (!token || !selectedMission) {
      return;
    }
    setBusy("launch");
    setError(null);
    try {
      const run = await api.launchMissionRun(token, selectedMission.id, {
        name: missionDraft.runName.trim() || undefined,
        input: {
          prompt: missionDraft.prompt,
          route: missionDraft.route || "analysis"
        },
        providerOverrides: selectedMission.defaultProviderOverrides ?? {}
      });
      upsertMissionRun(run);
      setSelectedRunId(run.id);
      patchMissionDraft({ runName: "" });
      await hydrateMissionContext(token, selectedMission.id, false);
      await refreshRunContext(token, selectedMission.id, run.id);
      setStation("command");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run launch failed");
    } finally {
      setBusy(null);
    }
  }

  async function dispatchRunAction(action: MissionAction) {
    if (!token || !selectedMission || !selectedRun) {
      return;
    }
    setBusy(action.action);
    setError(null);
    try {
      const run = await api.actionMissionRun(token, selectedMission.id, selectedRun.id, action);
      upsertMissionRun(run);
      await hydrateMissionContext(token, selectedMission.id, false);
      await refreshRunContext(token, selectedMission.id, run.id);
      if (action.action === "retask") {
        setRetaskNote("");
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Run action failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveMissionAgent() {
    if (!token || !settings || !selectedMission || !missionAgentEditor) {
      return;
    }
    setBusy("save-agent");
    setError(null);
    try {
      const existing = selectedMissionAgentId
        ? missionAgents.find((agent) => agent.id === selectedMissionAgentId)
        : undefined;
      if (missionAgentEditorMode === "edit" && existing && missionAgentEditor.id !== existing.id) {
        throw new Error("Mission agent id cannot be changed after creation.");
      }

      const payload = toMissionAgentDefinition(
        {
          ...missionAgentEditor,
          missionId: selectedMission.id
        },
        settings,
        existing
      );

      const saved =
        missionAgentEditorMode === "edit" && existing
          ? await api.updateMissionAgent(token, selectedMission.id, existing.id, payload)
          : await api.createMissionAgent(token, selectedMission.id, payload);

      upsertMissionAgent(saved);
      setSelectedMissionAgentId(saved.id);
      setMissionAgentEditorMode("edit");
      setMissionAgentEditor(buildMissionAgentEditorState(saved));
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Mission agent save failed");
    } finally {
      setBusy(null);
    }
  }

  async function deleteMissionAgent() {
    if (!token || !selectedMission || !selectedMissionAgentId) {
      return;
    }
    setBusy("delete-agent");
    setError(null);
    try {
      await api.deleteMissionAgent(token, selectedMission.id, selectedMissionAgentId);
      const remaining = missionAgents.filter((agent) => agent.id !== selectedMissionAgentId);
      removeMissionAgent(selectedMissionAgentId);
      if (remaining[0]) {
        setSelectedMissionAgentId(remaining[0].id);
        setMissionAgentEditorMode("edit");
        setMissionAgentEditor(buildMissionAgentEditorState(remaining[0]));
      } else if (settings) {
        setSelectedMissionAgentId(null);
        setMissionAgentEditorMode("create");
        setMissionAgentEditor(buildNewMissionAgentEditorState(settings, selectedMission.id, []));
      }
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Mission agent delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function importTemplateAgent() {
    if (!token || !selectedMission || !importTemplateId) {
      return;
    }
    setBusy("import-agent");
    setError(null);
    try {
      const imported = await api.importMissionAgent(token, selectedMission.id, importTemplateId);
      upsertMissionAgent(imported);
      setSelectedMissionAgentId(imported.id);
      setMissionAgentEditorMode("edit");
      setMissionAgentEditor(buildMissionAgentEditorState(imported));
      setImportTemplateId(
        templateAgents.find(
          (agent) =>
            agent.id !== imported.id &&
            !missionAgents.some((missionAgent) => missionAgent.id === agent.id)
        )?.id ?? ""
      );
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Template import failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveMissionWorkflow() {
    if (!token || !selectedMission || !workflowDraft) {
      return;
    }
    setBusy("save-workflow");
    setError(null);
    try {
      const saved = await api.updateMissionWorkflow(token, selectedMission.id, workflowDraft);
      setMissionWorkflow(saved);
      setWorkflowDraft(cloneWorkflow(saved));
      setWorkflowJson(JSON.stringify(saved, null, 2));
    } catch (workflowError) {
      setError(workflowError instanceof Error ? workflowError.message : "Mission workflow save failed");
    } finally {
      setBusy(null);
    }
  }

  if (!token) {
    return (
      <main className="relative min-h-screen overflow-hidden">
        <CockpitScene />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(118,244,255,0.15),transparent_50%)]" />
        <section className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            className="panel w-full max-w-md rounded-[2rem] p-8 shadow-bridge"
          >
            <div className="mb-6 flex items-center justify-between">
              <div>
                <p className="panel-title text-glow">The Council</p>
                <h1 className="mt-2 text-3xl font-semibold text-white">Bridge Authorization</h1>
              </div>
              <div className="status-dot bg-glow text-glow" />
            </div>
            <p className="mb-6 text-sm text-slate-300">
              Authenticate as the captain to unlock mission workspaces, crew orchestration, and live telemetry.
            </p>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Operator</span>
                <input
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-glow"
                  value={loginState.username}
                  onChange={(event) => setLoginState((state) => ({ ...state, username: event.target.value }))}
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Passphrase</span>
                <input
                  type="password"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber"
                  value={loginState.password}
                  onChange={(event) => setLoginState((state) => ({ ...state, password: event.target.value }))}
                />
              </label>
              <button
                type="button"
                onClick={() => void handleLogin()}
                disabled={busy === "login"}
                data-testid="login-submit"
                className="w-full rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
              >
                {busy === "login" ? "Synchronizing" : "Enter Bridge"}
              </button>
              {error ? <p className="text-sm text-rose-300">{error}</p> : null}
            </div>
          </motion.div>
        </section>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <CockpitScene />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(118,244,255,0.09),transparent_34%),linear-gradient(180deg,rgba(2,8,18,0.2),rgba(2,8,18,0.82))]" />

      <div className="relative z-10 min-h-screen p-4 md:p-6">
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

        <div className="mb-4 flex flex-wrap gap-2">
          {stations.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setStation(entry.id as StationId)}
              data-testid={`station-${entry.id}`}
              className={`rounded-full px-4 py-2 text-xs uppercase tracking-[0.22em] transition ${
                station === entry.id
                  ? "bg-cyan-300 text-slate-950 shadow-pulse"
                  : "border border-white/10 bg-black/20 text-slate-300 hover:border-cyan-300/40"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="panel mb-4 rounded-2xl border border-rose-400/40 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1.32fr_0.88fr]">
          <motion.section
            key={station}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            className="panel panel-grid min-h-[72vh] min-w-0 rounded-[2rem] p-5"
          >
            {station === "command" ? (
              <CommandDeck
                busy={busy}
                missionDraft={missionDraft}
                selectedMission={selectedMission}
                selectedRun={selectedRun}
                telemetry={telemetry}
                templateWorkflows={templateWorkflows}
                onPatchDraft={patchMissionDraft}
                onCreateMission={() => void createMission()}
                onSaveMission={() => void saveMissionWorkspace()}
                onLaunchRun={() => void launchRun()}
              />
            ) : null}
            {station === "tactical" ? (
              <TacticalStation
                busy={busy}
                mission={selectedMission}
                workflow={workflowDraft}
                workflowJson={workflowJson}
                missionAgents={missionAgents}
                editsAllowed={structuralEditsAllowed}
                newNodeType={newNodeType}
                onNewNodeType={setNewNodeType}
                onUpdateWorkflow={updateWorkflow}
                onPatchNode={patchWorkflowNode}
                onPatchEdge={patchWorkflowEdge}
                onRemoveNode={removeWorkflowNode}
                onRemoveEdge={removeWorkflowEdge}
                onAddNode={addWorkflowNode}
                onAddEdge={addWorkflowEdge}
                onJsonChange={handleWorkflowJsonChange}
                onSave={() => void saveMissionWorkflow()}
              />
            ) : null}
            {station === "crew" ? (
              <CrewStation
                mission={selectedMission}
                run={selectedRun}
                missionAgents={missionAgents}
                telemetry={telemetry}
                agentTelemetry={agentTelemetry}
              />
            ) : null}
            {station === "engineering" ? (
              <EngineeringStation
                settings={settings}
                mission={selectedMission}
                missionAgents={missionAgents}
                templateAgents={templateAgents}
                busy={busy}
                editor={missionAgentEditor}
                editorMode={missionAgentEditorMode}
                selectedMissionAgentId={selectedMissionAgentId}
                importTemplateId={importTemplateId}
                editsAllowed={structuralEditsAllowed}
                onSelectMissionAgent={selectMissionAgent}
                onStartCreate={startMissionAgentCreate}
                onEditorChange={patchMissionAgentEditor}
                onToggleTool={toggleMissionAgentTool}
                onSave={() => void saveMissionAgent()}
                onDelete={() => void deleteMissionAgent()}
                onImportTemplateChange={setImportTemplateId}
                onImportTemplate={() => void importTemplateAgent()}
              />
            ) : null}
            {station === "archive" ? (
              <ArchiveStation replay={replay} mission={selectedMission} run={selectedRun} />
            ) : null}
          </motion.section>

          <aside className="min-w-0 space-y-4">
            <section className="panel rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="panel-title text-cyan-300">Mission Queue</p>
                  <h2 className="mt-2 text-xl text-white">Mission workspaces</h2>
                </div>
                <div className="status-dot bg-amber-300 text-amber-300" />
              </div>
              <div className="scroll-thin max-h-[18rem] space-y-3 overflow-auto pr-1">
                {missions.map((mission) => (
                  <button
                    key={mission.id}
                    type="button"
                    onClick={() => setSelectedMissionId(mission.id)}
                    data-testid={`mission-card-${mission.id}`}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      mission.id === selectedMission?.id
                        ? "border-cyan-300/60 bg-cyan-300/10"
                        : "border-white/8 bg-black/10 hover:border-cyan-300/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <strong className="text-sm text-white">{mission.name}</strong>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                        {mission.status}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{mission.id}</p>
                  </button>
                ))}
                {missions.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                    No mission workspaces yet. Create one from Command Deck.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="panel-title text-amber-300">Run History</p>
                  <h2 className="mt-2 text-xl text-white">Launches for selected mission</h2>
                </div>
                <div className="status-dot bg-cyan-300 text-cyan-300" />
              </div>
              <div className="scroll-thin max-h-[18rem] space-y-3 overflow-auto pr-1">
                {missionRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    data-testid={`run-card-${run.id}`}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      run.id === selectedRun?.id
                        ? "border-cyan-300/60 bg-cyan-300/10"
                        : "border-white/8 bg-black/10 hover:border-cyan-300/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm text-white">{run.name}</strong>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{run.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{run.id}</p>
                  </button>
                ))}
                {selectedMission && missionRuns.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                    This mission has no runs yet.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="panel-title text-amber-300">Override Console</p>
                  <h2 className="mt-2 text-xl text-white">Run interventions</h2>
                </div>
                <div className="status-dot bg-rose-300 text-rose-300" />
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    label="Pause"
                    tone="warning"
                    disabled={!selectedRun || busy === "pause"}
                    onClick={() => void dispatchRunAction({ action: "pause", payload: {} })}
                  />
                  <ActionButton
                    label="Resume"
                    tone="primary"
                    disabled={!selectedRun || busy === "resume"}
                    onClick={() => void dispatchRunAction({ action: "resume", payload: {} })}
                  />
                  <ActionButton
                    label="Cancel"
                    tone="danger"
                    disabled={!selectedRun || busy === "cancel"}
                    onClick={() => void dispatchRunAction({ action: "cancel", payload: {} })}
                  />
                  <ActionButton
                    label="Disable Shell"
                    tone="muted"
                    disabled={!selectedRun || busy === "disable_tool"}
                    onClick={() => void dispatchRunAction({ action: "disable_tool", payload: { tool: "shell" } })}
                  />
                </div>
                <textarea
                  className="min-h-28 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/60"
                  value={retaskNote}
                  onChange={(event) => setRetaskNote(event.target.value)}
                  placeholder="Inject a course correction for the selected run."
                />
                <ActionButton
                  label="Retask Run"
                  tone="primary"
                  disabled={!selectedRun || !retaskNote.trim() || busy === "retask"}
                  onClick={() =>
                    void dispatchRunAction({ action: "retask", payload: { note: retaskNote.trim() } })
                  }
                />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function CommandDeck({
  busy,
  missionDraft,
  selectedMission,
  selectedRun,
  telemetry,
  templateWorkflows,
  onPatchDraft,
  onCreateMission,
  onSaveMission,
  onLaunchRun
}: {
  busy: string | null;
  missionDraft: MissionDraftState;
  selectedMission?: MissionWorkspace;
  selectedRun?: MissionRun;
  telemetry: TelemetryEvent[];
  templateWorkflows: WorkflowDefinition[];
  onPatchDraft: (patch: Partial<MissionDraftState>) => void;
  onCreateMission: () => void;
  onSaveMission: () => void;
  onLaunchRun: () => void;
}) {
  const commandResize = usePanelResize(
    commandPanelStorageKey,
    commandPanelDefaultWidth,
    commandPanelMinWidth,
    commandPanelMaxWidth,
    clampCommandPanelWidth
  );

  const commandLayoutStyle = {
    "--command-left-width": `minmax(0, ${commandResize.leftPanelWidth}%)`,
    "--command-right-width": `minmax(0, ${100 - commandResize.leftPanelWidth}%)`,
    "--command-divider-width": "1.5rem"
  } as CSSProperties;

  return (
    <div
      ref={commandResize.layoutRef}
      style={commandLayoutStyle}
      className="grid gap-5 lg:grid-cols-[var(--command-left-width)_var(--command-divider-width)_var(--command-right-width)]"
    >
      <div data-testid="command-launch-panel" className="min-w-0 space-y-5">
        <div>
          <p className="panel-title text-cyan-300">Command Deck</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission workspace and launch control</h2>
        </div>

        <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-amber-300">Workspace</p>
              <h3 className="mt-2 text-lg text-white">
                {selectedMission ? selectedMission.name : "Create a new mission workspace"}
              </h3>
            </div>
            <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-300">
              {selectedMission?.status ?? "draft"}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Name</span>
              <input
                value={missionDraft.name}
                onChange={(event) => onPatchDraft({ name: event.target.value })}
                data-testid="mission-name"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Seed Template</span>
              <select
                value={missionDraft.templateWorkflowId}
                onChange={(event) => onPatchDraft({ templateWorkflowId: event.target.value })}
                data-testid="mission-template"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              >
                <option value="">Blank mission</option>
                {templateWorkflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Description</span>
            <textarea
              value={missionDraft.description}
              onChange={(event) => onPatchDraft({ description: event.target.value })}
              className="min-h-24 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onCreateMission}
              disabled={busy === "create-mission"}
              data-testid="mission-create"
              className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
            >
              {busy === "create-mission" ? "Forging" : "Create Mission"}
            </button>
            <button
              type="button"
              onClick={onSaveMission}
              disabled={!selectedMission || busy === "save-mission"}
              data-testid="mission-save"
              className="rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
            >
              {busy === "save-mission" ? "Saving" : "Save Workspace"}
            </button>
          </div>
        </div>

        <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-cyan-300">Launch Control</p>
              <h3 className="mt-2 text-lg text-white">
                {selectedRun ? `Selected run: ${selectedRun.name}` : "Prepare the next launch"}
              </h3>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-amber-100">
              {selectedRun?.status ?? "idle"}
            </div>
          </div>

          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Prompt</span>
            <textarea
              value={missionDraft.prompt}
              onChange={(event) => onPatchDraft({ prompt: event.target.value })}
              data-testid="mission-prompt"
              className="min-h-40 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-300/50"
            />
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Route Signal</span>
              <input
                value={missionDraft.route}
                onChange={(event) => onPatchDraft({ route: event.target.value })}
                data-testid="mission-route"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber-300/50"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Run Name</span>
              <input
                value={missionDraft.runName}
                onChange={(event) => onPatchDraft({ runName: event.target.value })}
                data-testid="run-name"
                placeholder="Optional custom launch name"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={onLaunchRun}
            disabled={!selectedMission || busy === "launch"}
            data-testid="launch-mission"
            className="mt-4 rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
          >
            {busy === "launch" ? "Engaging" : "Launch Run"}
          </button>
        </div>
      </div>

      <div className="hidden lg:flex items-stretch justify-center">
        <button
          type="button"
          role="separator"
          aria-label="Resize command deck panels"
          aria-orientation="vertical"
          aria-valuemin={commandResize.minWidth}
          aria-valuemax={commandResize.maxWidth}
          aria-valuenow={Math.round(commandResize.leftPanelWidth)}
          data-testid="command-resizer"
          onPointerDown={(event) => {
            event.preventDefault();
            commandResize.beginResize(event.clientX);
          }}
          onDoubleClick={() => commandResize.setLeftPanelWidth(commandResize.defaultWidth)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              commandResize.nudgeResize(-2);
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              commandResize.nudgeResize(2);
            }
            if (event.key === "Home") {
              event.preventDefault();
              commandResize.setLeftPanelWidth(commandResize.minWidth);
            }
            if (event.key === "End") {
              event.preventDefault();
              commandResize.setLeftPanelWidth(commandResize.maxWidth);
            }
          }}
          className={`group relative flex h-full min-h-[42rem] w-6 cursor-col-resize items-center justify-center rounded-full border border-transparent transition ${
            commandResize.isResizing
              ? "border-cyan-300/40 bg-cyan-300/10"
              : "hover:border-cyan-300/20 hover:bg-cyan-300/5"
          }`}
        >
          <span className="h-full w-px bg-cyan-300/18 transition group-hover:bg-cyan-200/40" />
          <span className="absolute flex h-16 w-3 items-center justify-center rounded-full border border-cyan-300/20 bg-[rgba(5,18,31,0.92)]">
            <span className="h-8 w-px bg-cyan-200/60 shadow-[0_0_10px_rgba(118,244,255,0.45)]" />
          </span>
        </button>
      </div>

      <div
        data-testid="command-telemetry-panel"
        className="panel min-w-0 rounded-[1.8rem] border border-white/8 bg-black/15 p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="panel-title text-amber-300">Live Telemetry</p>
            <h3 className="mt-2 text-lg text-white">Selected run event stream</h3>
          </div>
          <div className="status-dot bg-cyan-300 text-cyan-300" />
        </div>
        <div
          data-testid="command-telemetry-stream"
          className="scroll-thin max-h-[52rem] space-y-3 overflow-y-auto overflow-x-hidden pr-1"
        >
          {telemetry.map((event) => (
            <div
              key={event.id}
              data-testid={`telemetry-${event.type}`}
              className="min-w-0 rounded-2xl border border-white/8 bg-black/20 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong className="min-w-0 break-words text-sm text-white">{event.type}</strong>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{event.severity}</span>
              </div>
              <p className="mt-2 break-words text-sm text-slate-300">{event.message}</p>
              <pre
                data-testid="telemetry-payload"
                className="mt-3 max-w-full whitespace-pre-wrap break-words rounded-xl bg-black/30 p-3 text-xs text-cyan-100 [overflow-wrap:anywhere]"
              >
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </div>
          ))}
          {telemetry.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
              Select or launch a run to stream live telemetry.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TacticalStation({
  busy,
  mission,
  workflow,
  workflowJson,
  missionAgents,
  editsAllowed,
  newNodeType,
  onNewNodeType,
  onUpdateWorkflow,
  onPatchNode,
  onPatchEdge,
  onRemoveNode,
  onRemoveEdge,
  onAddNode,
  onAddEdge,
  onJsonChange,
  onSave
}: {
  busy: string | null;
  mission?: MissionWorkspace;
  workflow: WorkflowDefinition | null;
  workflowJson: string;
  missionAgents: MissionAgentDefinition[];
  editsAllowed: boolean;
  newNodeType: WorkflowNodeType;
  onNewNodeType: (value: WorkflowNodeType) => void;
  onUpdateWorkflow: (workflow: WorkflowDefinition) => void;
  onPatchNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
  onPatchEdge: (edgeId: string, updater: (edge: WorkflowEdge) => WorkflowEdge) => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onAddNode: () => void;
  onAddEdge: () => void;
  onJsonChange: (value: string) => void;
  onSave: () => void;
}) {
  if (!mission || !workflow) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.8rem] border border-dashed border-white/10 bg-black/15 p-8 text-center text-sm text-slate-400">
        Select or create a mission workspace to edit its workflow.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="panel-title text-cyan-300">Tactical</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission workflow builder</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300">
          {mission.name}
        </div>
      </div>

      {!editsAllowed ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          Structural edits are locked while the active run is executing. Pause the run to update mission crew or workflow.
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/8 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-amber-300">Topology</p>
                <h3 className="mt-2 text-lg text-white">Live mission graph</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={newNodeType}
                  onChange={(event) => onNewNodeType(event.target.value as WorkflowNodeType)}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.16em] text-white outline-none transition focus:border-cyan-300/50"
                >
                  {nodeTypeCatalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={onAddNode}
                  disabled={!editsAllowed}
                  data-testid="workflow-add-node"
                  className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
                >
                  Add Node
                </button>
                <button
                  type="button"
                  onClick={onAddEdge}
                  disabled={!editsAllowed || workflow.nodes.length < 2}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-cyan-300/30 disabled:opacity-50"
                >
                  Add Edge
                </button>
              </div>
            </div>

            <div className="relative min-h-[28rem] overflow-hidden rounded-[1.5rem] border border-white/8 bg-black/25">
              <svg className="absolute inset-0 h-full w-full">
                {workflow.edges.map((edge) => {
                  const source = workflow.nodes.find((node) => node.id === edge.source);
                  const target = workflow.nodes.find((node) => node.id === edge.target);
                  if (!source || !target) {
                    return null;
                  }
                  return (
                    <g key={edge.id}>
                      <line
                        x1={source.position.x + 120}
                        y1={source.position.y + 42}
                        x2={target.position.x + 16}
                        y2={target.position.y + 42}
                        stroke="rgba(118,244,255,0.45)"
                        strokeWidth={2}
                        strokeDasharray={edge.condition ? "8 8" : undefined}
                      />
                      {edge.condition ? (
                        <text
                          x={(source.position.x + target.position.x) / 2}
                          y={(source.position.y + target.position.y) / 2}
                          fill="#f7b955"
                          fontSize="11"
                        >
                          {edge.condition}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              {workflow.nodes.map((node) => (
                <div
                  key={node.id}
                  className="absolute w-56 rounded-2xl border border-white/10 bg-[rgba(5,18,31,0.92)] p-4 shadow-bridge"
                  style={{ left: node.position.x, top: node.position.y }}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <strong className="text-sm text-white">{node.name}</strong>
                    <span className="rounded-full border border-cyan-300/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                      {node.type}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">{node.id}</p>
                  {"agentId" in node.config ? (
                    <p className="mt-2 text-xs text-amber-200">{String(node.config.agentId)}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/8 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-cyan-300">Edges</p>
                <h3 className="mt-2 text-lg text-white">Branch and merge control</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {workflow.edges.length} edges
              </span>
            </div>
            <div className="space-y-3">
              {workflow.edges.map((edge) => (
                <div key={edge.id} className="rounded-2xl border border-white/8 bg-black/15 p-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Source</span>
                      <select
                        value={edge.source}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({ ...current, source: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {workflow.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Target</span>
                      <select
                        value={edge.target}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({ ...current, target: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {workflow.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Condition</span>
                      <input
                        value={edge.condition ?? ""}
                        onChange={(event) =>
                          onPatchEdge(edge.id, (current) => ({
                            ...current,
                            condition: event.target.value.trim() || undefined
                          }))
                        }
                        disabled={!editsAllowed}
                        placeholder="analysis"
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRemoveEdge(edge.id)}
                      disabled={!editsAllowed}
                      className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                    >
                      Remove Edge
                    </button>
                  </div>
                </div>
              ))}
              {workflow.edges.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                  No edges yet. Add one after you place at least two nodes.
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-cyan-300">Nodes</p>
                <h3 className="mt-2 text-lg text-white">Mission node editor</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {workflow.nodes.length} nodes
              </span>
            </div>
            <div className="scroll-thin max-h-[34rem] space-y-4 overflow-auto pr-1">
              {workflow.nodes.map((node) => (
                <div key={node.id} className="rounded-2xl border border-white/8 bg-black/15 p-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Name</span>
                      <input
                        value={node.name}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({ ...current, name: event.target.value }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Type</span>
                      <select
                        value={node.type}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({
                            ...current,
                            type: event.target.value as WorkflowNodeType,
                            config: defaultNodeConfig(event.target.value as WorkflowNodeType, missionAgents[0]?.id)
                          }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {nodeTypeCatalog.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Node ID</span>
                      <input
                        value={node.id}
                        disabled
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-400 outline-none"
                      />
                    </label>
                    {node.type === "agent" || node.type === "tool" ? (
                      <label className="block">
                        <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Mission Agent</span>
                        <select
                          value={String(node.config.agentId ?? "")}
                          onChange={(event) =>
                            onPatchNode(node.id, (current) => ({
                              ...current,
                              config: { ...current.config, agentId: event.target.value }
                            }))
                          }
                          disabled={!editsAllowed}
                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                        >
                          <option value="">Unbound</option>
                          {missionAgents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label className="block">
                        <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Position</span>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="number"
                            value={node.position.x}
                            onChange={(event) =>
                              onPatchNode(node.id, (current) => ({
                                ...current,
                                position: { ...current.position, x: Number(event.target.value) || 0 }
                              }))
                            }
                            disabled={!editsAllowed}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                          />
                          <input
                            type="number"
                            value={node.position.y}
                            onChange={(event) =>
                              onPatchNode(node.id, (current) => ({
                                ...current,
                                position: { ...current.position, y: Number(event.target.value) || 0 }
                              }))
                            }
                            disabled={!editsAllowed}
                            className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                          />
                        </div>
                      </label>
                    )}
                  </div>

                  {node.type === "tool" ? (
                    <label className="mt-4 block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Tool</span>
                      <select
                        value={String(node.config.tool ?? "shell")}
                        onChange={(event) =>
                          onPatchNode(node.id, (current) => ({
                            ...current,
                            config: { ...current.config, tool: event.target.value }
                          }))
                        }
                        disabled={!editsAllowed}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-300/50"
                      >
                        {toolCatalog.map((tool) => (
                          <option key={tool.id} value={tool.id}>
                            {tool.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  <label className="mt-4 block">
                    <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">Config JSON</span>
                    <textarea
                      value={configJson(node.config)}
                      onChange={(event) => {
                        try {
                          const parsed = parseConfigJson(event.target.value);
                          onPatchNode(node.id, (current) => ({ ...current, config: parsed }));
                        } catch {
                          // Preserve the last valid draft until this node's config becomes valid again.
                        }
                      }}
                      disabled={!editsAllowed}
                      className="min-h-36 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
                    />
                  </label>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRemoveNode(node.id)}
                      disabled={!editsAllowed || workflow.nodes.length === 1}
                      className="rounded-full border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                    >
                      Remove Node
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="panel-title text-amber-300">Raw Definition</p>
                <h3 className="mt-2 text-lg text-white">JSON stays synchronized with the structured editor</h3>
              </div>
              <button
                type="button"
                onClick={onSave}
                disabled={!editsAllowed || busy === "save-workflow"}
                data-testid="workflow-save"
                className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-60"
              >
                {busy === "save-workflow" ? "Saving" : "Save Mission Workflow"}
              </button>
            </div>
            <textarea
              value={workflowJson}
              onChange={(event) => onJsonChange(event.target.value)}
              data-testid="workflow-json-editor"
              className="scroll-thin min-h-[28rem] w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CrewStation({
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

function EngineeringStation({
  settings,
  mission,
  missionAgents,
  templateAgents,
  busy,
  editor,
  editorMode,
  selectedMissionAgentId,
  importTemplateId,
  editsAllowed,
  onSelectMissionAgent,
  onStartCreate,
  onEditorChange,
  onToggleTool,
  onSave,
  onDelete,
  onImportTemplateChange,
  onImportTemplate
}: {
  settings: RuntimeSettings | null;
  mission?: MissionWorkspace;
  missionAgents: MissionAgentDefinition[];
  templateAgents: AgentDefinition[];
  busy: string | null;
  editor: MissionAgentEditorState | null;
  editorMode: "create" | "edit";
  selectedMissionAgentId: string | null;
  importTemplateId: string;
  editsAllowed: boolean;
  onSelectMissionAgent: (agentId: string) => void;
  onStartCreate: () => void;
  onEditorChange: (patch: Partial<MissionAgentEditorState>) => void;
  onToggleTool: (tool: ToolName) => void;
  onSave: () => void;
  onDelete: () => void;
  onImportTemplateChange: (value: string) => void;
  onImportTemplate: () => void;
}) {
  const engineeringResize = usePanelResize(
    engineeringPanelStorageKey,
    engineeringPanelDefaultWidth,
    engineeringPanelMinWidth,
    engineeringPanelMaxWidth,
    clampEngineeringPanelWidth
  );
  const engineeringLayoutStyle = {
    "--engineering-left-width": `minmax(0, ${engineeringResize.leftPanelWidth}%)`,
    "--engineering-right-width": `minmax(0, ${100 - engineeringResize.leftPanelWidth}%)`,
    "--engineering-divider-width": "1.5rem"
  } as CSSProperties;
  const selectedProvider =
    settings?.providers.find((provider) => provider.id === editor?.providerId) ?? settings?.providers[0];

  if (!mission) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.8rem] border border-dashed border-white/10 bg-black/15 p-8 text-center text-sm text-slate-400">
        Create or select a mission workspace before forging its crew.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="panel-title text-cyan-300">Engineering</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Mission-local crew and template library</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300">
          {mission.name}
        </div>
      </div>

      {!editsAllowed ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          Crew edits are locked while the mission has an active run. Pause the run to modify mission agents.
        </div>
      ) : null}

      <div
        ref={engineeringResize.layoutRef}
        style={engineeringLayoutStyle}
        className="grid gap-4 xl:grid-cols-[var(--engineering-left-width)_var(--engineering-divider-width)_var(--engineering-right-width)]"
      >
        <div className="min-w-0 space-y-4">
          <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-amber-300">Mission Crew</p>
                <h3 className="mt-2 text-lg text-white">Agents scoped to this mission</h3>
              </div>
              <button
                type="button"
                onClick={onStartCreate}
                disabled={!editsAllowed}
                data-testid="mission-agent-new"
                className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
              >
                New Mission Agent
              </button>
            </div>
            <div className="scroll-thin mt-4 max-h-[20rem] space-y-3 overflow-auto pr-1">
              {missionAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onSelectMissionAgent(agent.id)}
                  data-testid={`mission-agent-card-${agent.id}`}
                  className={`w-full rounded-2xl border p-3 text-left transition ${
                    selectedMissionAgentId === agent.id
                      ? "border-cyan-300/60 bg-cyan-300/10"
                      : "border-white/8 bg-black/10 hover:border-cyan-300/30"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-white">{agent.name}</strong>
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{agent.role}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{agent.id}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {agent.tools.map((tool) => (
                      <span
                        key={tool}
                        className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-cyan-200"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
              {missionAgents.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                  No mission agents yet. Forge one or import a template below.
                </p>
              ) : null}
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="panel-title text-cyan-300">Template Library</p>
                <h3 className="mt-2 text-lg text-white">Import global templates as mission-local copies</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs uppercase tracking-[0.16em] text-slate-300">
                {templateAgents.length} templates
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              <select
                value={importTemplateId}
                onChange={(event) => onImportTemplateChange(event.target.value)}
                data-testid="template-import-select"
                className="min-w-[14rem] rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
              >
                <option value="">Select template</option>
                {templateAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={onImportTemplate}
                disabled={!editsAllowed || !importTemplateId}
                data-testid="template-import-button"
                className="rounded-[1.4rem] border border-cyan-300/30 bg-cyan-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-50"
              >
                Import Template
              </button>
            </div>
            <div className="scroll-thin mt-4 max-h-[18rem] space-y-3 overflow-auto pr-1">
              {templateAgents.map((agent) => {
                const alreadyImported = missionAgents.some((missionAgent) => missionAgent.id === agent.id);
                return (
                  <div key={agent.id} className="rounded-2xl border border-white/8 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-white">{agent.name}</strong>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                        {alreadyImported ? "imported" : "template"}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-400">{agent.role}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="hidden xl:flex items-stretch justify-center">
          <button
            type="button"
            role="separator"
            aria-label="Resize engineering registry panel"
            aria-orientation="vertical"
            aria-valuemin={engineeringResize.minWidth}
            aria-valuemax={engineeringResize.maxWidth}
            aria-valuenow={Math.round(engineeringResize.leftPanelWidth)}
            data-testid="engineering-resizer"
            onPointerDown={(event) => {
              event.preventDefault();
              engineeringResize.beginResize(event.clientX);
            }}
            onDoubleClick={() => engineeringResize.setLeftPanelWidth(engineeringResize.defaultWidth)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                engineeringResize.nudgeResize(-2);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                engineeringResize.nudgeResize(2);
              }
              if (event.key === "Home") {
                event.preventDefault();
                engineeringResize.setLeftPanelWidth(engineeringResize.minWidth);
              }
              if (event.key === "End") {
                event.preventDefault();
                engineeringResize.setLeftPanelWidth(engineeringResize.maxWidth);
              }
            }}
            className={`group relative flex h-full min-h-[42rem] w-6 cursor-col-resize items-center justify-center rounded-full border border-transparent transition ${
              engineeringResize.isResizing
                ? "border-cyan-300/40 bg-cyan-300/10"
                : "hover:border-cyan-300/20 hover:bg-cyan-300/5"
            }`}
          >
            <span className="h-full w-px bg-cyan-300/18 transition group-hover:bg-cyan-200/40" />
            <span className="absolute flex h-16 w-3 items-center justify-center rounded-full border border-cyan-300/20 bg-[rgba(5,18,31,0.92)]">
              <span className="h-8 w-px bg-cyan-200/60 shadow-[0_0_10px_rgba(118,244,255,0.45)]" />
            </span>
          </button>
        </div>

        <div className="min-w-0 rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-cyan-300">Mission Agent Forge</p>
              <h3 className="mt-2 text-lg text-white">
                {editorMode === "create" ? "Create a mission-local agent" : "Edit mission agent"}
              </h3>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-amber-100">
              {editorMode === "create" ? "new record" : "mission-local copy"}
            </div>
          </div>
          {editor ? (
            <div data-testid="mission-agent-editor" className="mt-4 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Agent ID</span>
                  <input
                    value={editor.id}
                    disabled={editorMode === "edit"}
                    onChange={(event) => onEditorChange({ id: event.target.value })}
                    data-testid="mission-agent-id"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Call Sign</span>
                  <input
                    value={editor.name}
                    onChange={(event) => onEditorChange({ name: event.target.value })}
                    data-testid="mission-agent-name"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Duty Role</span>
                  <input
                    value={editor.role}
                    onChange={(event) => onEditorChange({ role: event.target.value })}
                    data-testid="mission-agent-role"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Provider</span>
                  <select
                    value={editor.providerId}
                    onChange={(event) => onEditorChange({ providerId: event.target.value })}
                    data-testid="mission-agent-provider"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  >
                    {settings?.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Description</span>
                <textarea
                  value={editor.description}
                  onChange={(event) => onEditorChange({ description: event.target.value })}
                  className="min-h-20 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">System Prompt</span>
                <textarea
                  value={editor.systemPrompt}
                  onChange={(event) => onEditorChange({ systemPrompt: event.target.value })}
                  data-testid="mission-agent-system-prompt"
                  className="min-h-32 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <div>
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Tool Access</span>
                <div className="flex flex-wrap gap-2">
                  {toolCatalog.map((tool) => {
                    const enabled = editor.tools.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => onToggleTool(tool.id)}
                        data-testid={`mission-agent-tool-${tool.id}`}
                        className={`rounded-full border px-3 py-2 text-xs uppercase tracking-[0.18em] transition ${
                          enabled
                            ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-100"
                            : "border-white/10 bg-black/20 text-slate-400 hover:border-cyan-300/30"
                        }`}
                      >
                        {tool.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Memory Mode</span>
                  <select
                    value={editor.memoryMode}
                    onChange={(event) =>
                      onEditorChange({
                        memoryMode: event.target.value as MissionAgentEditorState["memoryMode"]
                      })
                    }
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  >
                    <option value="session">session</option>
                    <option value="long_term">long_term</option>
                    <option value="hybrid">hybrid</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Memory Namespace</span>
                  <input
                    value={editor.memoryNamespace}
                    onChange={(event) => onEditorChange({ memoryNamespace: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Recall Depth</span>
                  <input
                    type="number"
                    min={1}
                    value={editor.memoryTopK}
                    onChange={(event) => onEditorChange({ memoryTopK: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Handoff Targets</span>
                <input
                  value={editor.handoffTargets}
                  onChange={(event) => onEditorChange({ handoffTargets: event.target.value })}
                  placeholder="captain, archivist"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Tool Policy JSON</span>
                <textarea
                  value={editor.toolPolicyJson}
                  onChange={(event) => onEditorChange({ toolPolicyJson: event.target.value })}
                  className="scroll-thin min-h-56 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
                />
              </label>

              <div className="rounded-[1.5rem] border border-white/8 bg-black/20 p-4 text-sm text-slate-400">
                <p className="text-cyan-100">
                  Provider route: {selectedProvider?.label ?? "none"} / {selectedProvider?.model ?? "unconfigured"}
                </p>
                <p className="mt-2">
                  Template lineage: {editor.templateAgentId ?? "scratch-built mission agent"}
                </p>
                <p className="mt-2">
                  Structural edits update the mission workspace, and if the selected run is paused they also update that paused run snapshot.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!settings?.providers.length || !editsAllowed || busy === "save-agent"}
                  data-testid="mission-agent-save"
                  className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                >
                  {busy === "save-agent"
                    ? "Synchronizing"
                    : editorMode === "create"
                      ? "Forge Mission Agent"
                      : "Update Mission Agent"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={editorMode !== "edit" || !editsAllowed || busy === "delete-agent"}
                  data-testid="mission-agent-delete"
                  className="rounded-[1.4rem] border border-rose-300/30 bg-rose-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                >
                  {busy === "delete-agent" ? "Purging" : "Delete Mission Agent"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Awaiting mission selection before agent creation.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ArchiveStation({
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

function ActionButton({
  label,
  onClick,
  disabled,
  tone
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone: "primary" | "warning" | "danger" | "muted";
}) {
  const className =
    tone === "primary"
      ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100 hover:border-cyan-200 hover:bg-cyan-200/15"
      : tone === "warning"
        ? "border-amber-300/30 bg-amber-300/10 text-amber-100 hover:border-amber-200 hover:bg-amber-200/15"
        : tone === "danger"
          ? "border-rose-300/30 bg-rose-300/10 text-rose-100 hover:border-rose-200 hover:bg-rose-200/15"
          : "border-white/10 bg-white/5 text-slate-200 hover:border-cyan-300/30";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-xs uppercase tracking-[0.18em] transition ${className} disabled:opacity-50`}
    >
      {label}
    </button>
  );
}
