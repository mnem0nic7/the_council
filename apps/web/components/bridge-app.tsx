"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type {
  AgentDefinition,
  MissionAction,
  RuntimeSettings,
  TelemetryEvent,
  ToolName,
  ToolPolicy,
  WorkflowDefinition
} from "@the-council/contracts";

import { api } from "../lib/api";
import { useCouncilStore } from "../lib/store";
import { getWsBaseUrl } from "../lib/config";
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

type AgentEditorState = {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  providerId: string;
  tools: ToolName[];
  handoffTargets: string;
  memoryMode: AgentDefinition["memoryProfile"]["mode"];
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

function sortAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return [...agents].sort((left, right) => left.name.localeCompare(right.name));
}

function nextAgentId(agents: AgentDefinition[]): string {
  let index = agents.length + 1;
  let candidate = `agent-${index}`;
  while (agents.some((agent) => agent.id === candidate)) {
    index += 1;
    candidate = `agent-${index}`;
  }
  return candidate;
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

function buildAgentEditorState(agent: AgentDefinition): AgentEditorState {
  return {
    id: agent.id,
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

function buildNewAgentEditorState(
  settings: RuntimeSettings | null,
  agents: AgentDefinition[]
): AgentEditorState {
  const providerId = settings?.providers[0]?.id ?? "";
  const tools: ToolName[] = [];

  return {
    id: nextAgentId(agents),
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

function toAgentDefinition(
  editor: AgentEditorState,
  settings: RuntimeSettings,
  existing?: AgentDefinition
): AgentDefinition {
  const provider = settings.providers.find((entry) => entry.id === editor.providerId) ?? settings.providers[0];
  if (!provider) {
    throw new Error("No providers configured for this bridge.");
  }

  const id = editor.id.trim();
  const name = editor.name.trim();
  const role = editor.role.trim();
  const systemPrompt = editor.systemPrompt.trim();
  if (!id || !name || !role || !systemPrompt) {
    throw new Error("Agent id, name, role, and system prompt are required.");
  }

  let parsedPolicy = defaultToolPolicy(settings, editor.tools);
  try {
    const policyCandidate = JSON.parse(editor.toolPolicyJson) as Partial<ToolPolicy>;
    parsedPolicy = {
      ...parsedPolicy,
      ...policyCandidate,
      allowedTools: editor.tools
    };
  } catch {
    throw new Error("Tool policy must be valid JSON.");
  }

  const topK = Number(editor.memoryTopK);
  if (!Number.isFinite(topK) || topK <= 0) {
    throw new Error("Memory recall depth must be a positive number.");
  }

  return {
    id,
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

export function BridgeApp() {
  const {
    token,
    username,
    station,
    agents,
    workflows,
    missions,
    telemetry,
    settings,
    replay,
    activeMissionId,
    activeWorkflowId,
    setAuth,
    setStation,
    setAgents,
    setWorkflows,
    setMissions,
    upsertMission,
    setTelemetry,
    appendTelemetry,
    setSettings,
    setReplay,
    setActiveMission,
    setActiveWorkflow
  } = useCouncilStore();

  const [loginState, setLoginState] = useState<LoginState>({
    username: "captain",
    password: "bridge123"
  });
  const [missionPrompt, setMissionPrompt] = useState("Assess the readiness of the current bridge systems.");
  const [missionRoute, setMissionRoute] = useState("analysis");
  const [retaskNote, setRetaskNote] = useState("");
  const [jsonEditor, setJsonEditor] = useState("");
  const [agentEditorMode, setAgentEditorMode] = useState<"create" | "edit">("create");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentEditor, setAgentEditor] = useState<AgentEditorState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];
  const activeMission = missions.find((mission) => mission.id === activeMissionId) ?? missions[0];

  useEffect(() => {
    if (!activeWorkflow) {
      setJsonEditor("");
      return;
    }
    setJsonEditor(JSON.stringify(activeWorkflow, null, 2));
  }, [activeWorkflow]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const authToken = token;

    let closed = false;

    async function load() {
      try {
        const [agentData, workflowData, missionData, settingsData] = await Promise.all([
          api.listAgents(authToken),
          api.listWorkflows(authToken),
          api.listMissions(authToken),
          api.getSettings(authToken)
        ]);
        if (closed) {
          return;
        }
        setAgents(agentData);
        setWorkflows(workflowData);
        setMissions(missionData);
        setSettings(settingsData);
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
  }, [token, setAgents, setMissions, setSettings, setWorkflows]);

  const agentMap = useMemo(() => Object.fromEntries(agents.map((agent) => [agent.id, agent])), [agents]);

  async function refreshMissionArtifacts(authToken: string, missionId: string) {
    try {
      const [mission, replayPayload] = await Promise.all([
        api.getMission(authToken, missionId),
        api.getReplay(authToken, missionId)
      ]);
      upsertMission(mission);
      setReplay(replayPayload);
    } catch {
      setReplay(null);
    }
  }

  useEffect(() => {
    if (!token || !activeMissionId) {
      return;
    }
    const authToken = token;
    const missionId = activeMissionId;

    let socket: WebSocket | null = new WebSocket(`${getWsBaseUrl()}/missions/${missionId}?token=${authToken}`);

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TelemetryEvent | { type: "history"; events: TelemetryEvent[] };
      if ("events" in payload) {
        setTelemetry(payload.events);
        void refreshMissionArtifacts(authToken, missionId);
        return;
      }
      appendTelemetry(payload);
      if (
        payload.type === "mission.completed" ||
        payload.type === "mission.failed" ||
        payload.type === "mission.cancelled" ||
        payload.type === "mission.operator_action"
      ) {
        void refreshMissionArtifacts(authToken, missionId);
      }
    };

    socket.onerror = () => {
      setError("Mission telemetry link degraded");
    };

    return () => {
      socket?.close();
      socket = null;
    };
  }, [activeMissionId, appendTelemetry, setTelemetry, token]);

  useEffect(() => {
    if (!token || !activeMissionId) {
      setReplay(null);
      return;
    }
    const authToken = token;
    const missionId = activeMissionId;
    void refreshMissionArtifacts(authToken, missionId);
  }, [activeMissionId, token]);

  useEffect(() => {
    if (!settings || agentEditor) {
      return;
    }
    if (agents.length > 0) {
      setSelectedAgentId(agents[0].id);
      setAgentEditorMode("edit");
      setAgentEditor(buildAgentEditorState(agents[0]));
      return;
    }
    setSelectedAgentId(null);
    setAgentEditorMode("create");
    setAgentEditor(buildNewAgentEditorState(settings, agents));
  }, [agentEditor, agents, settings]);

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

  async function launchMission() {
    if (!token || !activeWorkflow) {
      return;
    }
    const authToken = token;
    setBusy("launch");
    setError(null);
    try {
      const mission = await api.launchMission(authToken, {
        workflowId: activeWorkflow.id,
        name: `Mission ${new Date().toISOString()}`,
        input: {
          prompt: missionPrompt,
          route: missionRoute
        }
      });
      upsertMission(mission);
      setStation("command");
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : "Launch failed");
    } finally {
      setBusy(null);
    }
  }

  async function dispatchAction(action: MissionAction) {
    if (!token || !activeMissionId) {
      return;
    }
    const authToken = token;
    const missionId = activeMissionId;
    setBusy(action.action);
    setError(null);
    try {
      const mission = await api.actionMission(authToken, missionId, action);
      upsertMission(mission);
      if (action.action === "retask") {
        setRetaskNote("");
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveWorkflow() {
    if (!token || !activeWorkflow) {
      return;
    }
    const authToken = token;
    setBusy("save");
    setError(null);
    try {
      const parsed = JSON.parse(jsonEditor) as WorkflowDefinition;
      const saved = await api.updateWorkflow(authToken, parsed);
      setWorkflows(workflows.map((workflow) => (workflow.id === saved.id ? saved : workflow)));
      setActiveWorkflow(saved.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function patchAgentEditor(patch: Partial<AgentEditorState>) {
    setAgentEditor((current) => (current ? { ...current, ...patch } : current));
  }

  function selectAgent(agentId: string) {
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      return;
    }
    setSelectedAgentId(agent.id);
    setAgentEditorMode("edit");
    setAgentEditor(buildAgentEditorState(agent));
    setError(null);
  }

  function startAgentCreate() {
    if (!settings) {
      return;
    }
    setSelectedAgentId(null);
    setAgentEditorMode("create");
    setAgentEditor(buildNewAgentEditorState(settings, agents));
    setError(null);
  }

  function toggleAgentTool(tool: ToolName) {
    setAgentEditor((current) => {
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

  async function saveAgent() {
    if (!token || !settings || !agentEditor) {
      return;
    }
    const authToken = token;
    setBusy("save-agent");
    setError(null);
    try {
      const existing = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
      if (agentEditorMode === "edit" && existing && agentEditor.id.trim() !== existing.id) {
        throw new Error("Agent id cannot be changed after creation.");
      }
      const payload = toAgentDefinition(agentEditor, settings, existing);
      let saved: AgentDefinition;

      if (agentEditorMode === "edit" && existing) {
        saved = await api.updateAgent(authToken, existing.id, payload);
      } else {
        if (agents.some((agent) => agent.id === payload.id)) {
          throw new Error(`Agent id "${payload.id}" is already registered.`);
        }
        saved = await api.createAgent(authToken, payload);
      }

      const nextAgents = sortAgents(
        agentEditorMode === "edit" && existing
          ? agents.map((agent) => (agent.id === existing.id ? saved : agent))
          : [...agents, saved]
      );
      setAgents(nextAgents);
      setSelectedAgentId(saved.id);
      setAgentEditorMode("edit");
      setAgentEditor(buildAgentEditorState(saved));
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Agent save failed");
    } finally {
      setBusy(null);
    }
  }

  async function deleteAgent() {
    if (!token || !selectedAgentId) {
      return;
    }
    const authToken = token;
    setBusy("delete-agent");
    setError(null);
    try {
      await api.deleteAgent(authToken, selectedAgentId);
      const nextAgents = agents.filter((agent) => agent.id !== selectedAgentId);
      setAgents(nextAgents);

      if (nextAgents.length > 0) {
        setSelectedAgentId(nextAgents[0].id);
        setAgentEditorMode("edit");
        setAgentEditor(buildAgentEditorState(nextAgents[0]));
      } else if (settings) {
        setSelectedAgentId(null);
        setAgentEditorMode("create");
        setAgentEditor(buildNewAgentEditorState(settings, []));
      } else {
        setSelectedAgentId(null);
        setAgentEditorMode("create");
        setAgentEditor(null);
      }
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Agent delete failed");
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
              Authenticate as the captain to unlock mission control, tactical editing, and agent telemetry.
            </p>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Operator</span>
                <input
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-glow"
                  value={loginState.username}
                  onChange={(event) =>
                    setLoginState((state) => ({ ...state, username: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Passphrase</span>
                <input
                  type="password"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber"
                  value={loginState.password}
                  onChange={(event) =>
                    setLoginState((state) => ({ ...state, password: event.target.value }))
                  }
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
              {missions.filter((mission) => mission.status === "running").length} active missions
            </span>
            <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-amber-200">
              {agents.length} agents registered
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

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.85fr]">
          <motion.section
            key={station}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            className="panel panel-grid min-h-[72vh] rounded-[2rem] p-5"
          >
            {station === "command" ? (
              <CommandDeck
                activeWorkflowId={activeWorkflowId}
                busy={busy}
                missionPrompt={missionPrompt}
                missionRoute={missionRoute}
                onMissionPrompt={setMissionPrompt}
                onMissionRoute={setMissionRoute}
                onLaunch={() => void launchMission()}
                telemetry={telemetry}
                workflows={workflows}
                onWorkflowChange={setActiveWorkflow}
              />
            ) : null}
            {station === "tactical" ? (
              <TacticalStation
                workflow={activeWorkflow}
                workflows={workflows}
                jsonEditor={jsonEditor}
                onWorkflowChange={setActiveWorkflow}
                onJsonChange={setJsonEditor}
                onSave={() => void saveWorkflow()}
                busy={busy}
              />
            ) : null}
            {station === "crew" ? (
              <CrewStation agentMap={agentMap} missions={missions} telemetry={telemetry} />
            ) : null}
            {station === "engineering" ? (
              <EngineeringStation
                settings={settings}
                activeMission={activeMission}
                agents={agents}
                workflows={workflows}
                busy={busy}
                editor={agentEditor}
                editorMode={agentEditorMode}
                selectedAgentId={selectedAgentId}
                onSelectAgent={selectAgent}
                onStartCreate={startAgentCreate}
                onEditorChange={patchAgentEditor}
                onToggleTool={toggleAgentTool}
                onSave={() => void saveAgent()}
                onDelete={() => void deleteAgent()}
              />
            ) : null}
            {station === "archive" ? <ArchiveStation replay={replay} missions={missions} /> : null}
          </motion.section>

          <aside className="space-y-4">
            <section className="panel rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="panel-title text-cyan-300">Mission Queue</p>
                  <h2 className="mt-2 text-xl text-white">Active and historical runs</h2>
                </div>
                <div className="status-dot bg-amber-300 text-amber-300" />
              </div>
              <div className="scroll-thin max-h-[24rem] space-y-3 overflow-auto pr-1">
                {missions.map((mission) => (
                  <button
                    key={mission.id}
                    type="button"
                    onClick={() => setActiveMission(mission.id)}
                    data-testid={`mission-${mission.id}`}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      mission.id === activeMissionId
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
                    <p className="mt-2 text-xs text-slate-400">{mission.workflowId}</p>
                  </button>
                ))}
                {missions.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                    No missions launched yet.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel rounded-[2rem] p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="panel-title text-amber-300">Override Console</p>
                  <h2 className="mt-2 text-xl text-white">Operator interventions</h2>
                </div>
                <div className="status-dot bg-rose-300 text-rose-300" />
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    label="Pause"
                    tone="warning"
                    disabled={!activeMission || busy === "pause"}
                    onClick={() => void dispatchAction({ action: "pause", payload: {} })}
                  />
                  <ActionButton
                    label="Resume"
                    tone="primary"
                    disabled={!activeMission || busy === "resume"}
                    onClick={() => void dispatchAction({ action: "resume", payload: {} })}
                  />
                  <ActionButton
                    label="Cancel"
                    tone="danger"
                    disabled={!activeMission || busy === "cancel"}
                    onClick={() => void dispatchAction({ action: "cancel", payload: {} })}
                  />
                  <ActionButton
                    label="Disable Shell"
                    tone="muted"
                    disabled={!activeMission || busy === "disable_tool"}
                    onClick={() =>
                      void dispatchAction({ action: "disable_tool", payload: { tool: "shell" } })
                    }
                  />
                </div>
                <textarea
                  className="min-h-28 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/60"
                  value={retaskNote}
                  onChange={(event) => setRetaskNote(event.target.value)}
                  placeholder="Inject a course correction for the current mission."
                />
                <ActionButton
                  label="Retask Mission"
                  tone="primary"
                  disabled={!activeMission || !retaskNote.trim() || busy === "retask"}
                  onClick={() =>
                    void dispatchAction({ action: "retask", payload: { note: retaskNote.trim() } })
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
  activeWorkflowId,
  busy,
  missionPrompt,
  missionRoute,
  telemetry,
  workflows,
  onLaunch,
  onMissionPrompt,
  onMissionRoute,
  onWorkflowChange
}: {
  activeWorkflowId: string | null;
  busy: string | null;
  missionPrompt: string;
  missionRoute: string;
  telemetry: TelemetryEvent[];
  workflows: WorkflowDefinition[];
  onLaunch: () => void;
  onMissionPrompt: (value: string) => void;
  onMissionRoute: (value: string) => void;
  onWorkflowChange: (workflowId: string | null) => void;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-5">
        <div>
          <p className="panel-title text-cyan-300">Command Deck</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Launch and supervise missions</h2>
        </div>
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Workflow</span>
          <select
            value={activeWorkflowId ?? ""}
            onChange={(event) => onWorkflowChange(event.target.value || null)}
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Mission Prompt</span>
          <textarea
            value={missionPrompt}
            onChange={(event) => onMissionPrompt(event.target.value)}
            className="min-h-44 w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-300/50"
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Route Signal</span>
          <input
            value={missionRoute}
            onChange={(event) => onMissionRoute(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber-300/50"
          />
        </label>
        <button
          type="button"
          onClick={onLaunch}
          disabled={busy === "launch"}
          data-testid="launch-mission"
          className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
        >
          {busy === "launch" ? "Engaging" : "Launch Mission"}
        </button>
      </div>

      <div className="panel rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="panel-title text-amber-300">Live Telemetry</p>
            <h3 className="mt-2 text-lg text-white">Bridge event stream</h3>
          </div>
          <div className="status-dot bg-cyan-300 text-cyan-300" />
        </div>
        <div className="scroll-thin max-h-[34rem] space-y-3 overflow-auto pr-1">
          {telemetry.map((event) => (
            <div
              key={event.id}
              data-testid={`telemetry-${event.type}`}
              className="rounded-2xl border border-white/8 bg-black/20 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm text-white">{event.type}</strong>
                <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{event.severity}</span>
              </div>
              <p className="mt-2 text-sm text-slate-300">{event.message}</p>
              <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-cyan-100">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </div>
          ))}
          {telemetry.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
              Awaiting mission telemetry.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TacticalStation({
  workflow,
  workflows,
  jsonEditor,
  onWorkflowChange,
  onJsonChange,
  onSave,
  busy
}: {
  workflow?: WorkflowDefinition;
  workflows: WorkflowDefinition[];
  jsonEditor: string;
  onWorkflowChange: (workflowId: string | null) => void;
  onJsonChange: (value: string) => void;
  onSave: () => void;
  busy: string | null;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="panel-title text-cyan-300">Tactical</p>
            <h2 className="mt-2 text-3xl font-semibold text-white">Workflow topology</h2>
          </div>
          <select
            value={workflow?.id ?? ""}
            onChange={(event) => onWorkflowChange(event.target.value || null)}
            className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
          >
            {workflows.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="relative min-h-[32rem] overflow-hidden rounded-[1.8rem] border border-white/8 bg-black/20">
          <svg className="absolute inset-0 h-full w-full">
            {workflow?.edges.map((edge) => {
              const source = workflow.nodes.find((node) => node.id === edge.source);
              const target = workflow.nodes.find((node) => node.id === edge.target);
              if (!source || !target) {
                return null;
              }
              return (
                <g key={edge.id}>
                  <line
                    x1={source.position.x + 110}
                    y1={source.position.y + 42}
                    x2={target.position.x + 10}
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
          {workflow?.nodes.map((node) => (
            <div
              key={node.id}
              className="absolute w-52 rounded-2xl border border-white/10 bg-[rgba(5,18,31,0.92)] p-4 shadow-bridge"
              style={{
                left: node.position.x,
                top: node.position.y
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <strong className="text-sm text-white">{node.name}</strong>
                <span className="rounded-full border border-cyan-300/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                  {node.type}
                </span>
              </div>
              <p className="text-xs leading-5 text-slate-400">{node.id}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="panel rounded-[1.8rem] border border-white/8 bg-black/15 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="panel-title text-amber-300">Raw Definition</p>
            <h3 className="mt-2 text-lg text-white">JSON synchronized with topology</h3>
          </div>
          <button
            type="button"
            onClick={onSave}
            disabled={busy === "save"}
            className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15 disabled:opacity-60"
          >
            {busy === "save" ? "Saving" : "Save Definition"}
          </button>
        </div>
        <textarea
          value={jsonEditor}
          onChange={(event) => onJsonChange(event.target.value)}
          data-testid="workflow-json-editor"
          className="scroll-thin min-h-[32rem] w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 font-mono text-xs leading-6 text-cyan-50 outline-none transition focus:border-cyan-300/50"
        />
      </div>
    </div>
  );
}

function CrewStation({
  agentMap,
  missions,
  telemetry
}: {
  agentMap: Record<string, { name: string; role: string; tools: string[] }>;
  missions: Array<{ id: string; status: string; currentNodes: string[]; name: string }>;
  telemetry: TelemetryEvent[];
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="panel-title text-cyan-300">Crew</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Agent readiness and node activity</h2>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(agentMap).map(([agentId, agent]) => (
          <div key={agentId} className="rounded-[1.7rem] border border-white/10 bg-black/20 p-4">
            <div className="flex items-center justify-between">
              <strong className="text-lg text-white">{agent.name}</strong>
              <span className="status-dot bg-cyan-300 text-cyan-300" />
            </div>
            <p className="mt-2 text-sm text-slate-400">{agent.role}</p>
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
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Mission Current Nodes</p>
          <div className="mt-4 space-y-3">
            {missions.map((mission) => (
              <div key={mission.id} className="rounded-2xl border border-white/8 p-3">
                <div className="flex items-center justify-between">
                  <strong className="text-sm text-white">{mission.name}</strong>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">{mission.status}</span>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  {mission.currentNodes.length > 0 ? mission.currentNodes.join(", ") : "Idle"}
                </p>
              </div>
            ))}
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
          </div>
        </div>
      </div>
    </div>
  );
}

function EngineeringStation({
  settings,
  activeMission,
  agents,
  workflows,
  busy,
  editor,
  editorMode,
  selectedAgentId,
  onSelectAgent,
  onStartCreate,
  onEditorChange,
  onToggleTool,
  onSave,
  onDelete
}: {
  settings: RuntimeSettings | null;
  activeMission?: { controlState: Record<string, any> };
  agents: AgentDefinition[];
  workflows: WorkflowDefinition[];
  busy: string | null;
  editor: AgentEditorState | null;
  editorMode: "create" | "edit";
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onStartCreate: () => void;
  onEditorChange: (patch: Partial<AgentEditorState>) => void;
  onToggleTool: (tool: ToolName) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const selectedProvider =
    settings?.providers.find((provider) => provider.id === editor?.providerId) ?? settings?.providers[0];
  const workflowReferenceCount = selectedAgentId
    ? workflows.reduce(
        (count, workflow) =>
          count + workflow.nodes.filter((node) => node.config?.agentId === selectedAgentId).length,
        0
      )
    : 0;

  return (
    <div className="space-y-5">
      <div>
        <p className="panel-title text-cyan-300">Engineering</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Agent forge, providers, and hard gates</h2>
      </div>
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-amber-300">Agent Registry</p>
              <h3 className="mt-2 text-lg text-white">Crew manifest and selection</h3>
            </div>
            <button
              type="button"
              onClick={onStartCreate}
              data-testid="agent-new"
              className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-cyan-100 transition hover:border-cyan-200 hover:bg-cyan-200/15"
            >
              New Agent
            </button>
          </div>
          <div className="scroll-thin mt-4 max-h-[39rem] space-y-3 overflow-auto pr-1">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                data-testid={`agent-card-${agent.id}`}
                className={`w-full rounded-2xl border p-3 text-left transition ${
                  selectedAgentId === agent.id
                    ? "border-cyan-300/60 bg-cyan-300/10"
                    : "border-white/8 bg-black/10 hover:border-cyan-300/30"
                }`}
              >
                <div className="flex items-center justify-between">
                  <strong className="text-white">{agent.name}</strong>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                    {agent.role}
                  </span>
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
            {agents.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                No agents registered yet. Forge the first operator below.
              </p>
            ) : null}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="panel-title text-cyan-300">Agent Forge</p>
              <h3 className="mt-2 text-lg text-white">
                {editorMode === "create" ? "Create a new operator" : "Edit selected operator"}
              </h3>
            </div>
            <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-amber-100">
              {editorMode === "create" ? "new record" : "persisted record"}
            </div>
          </div>
          {editor ? (
            <div data-testid="agent-editor" className="mt-4 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Agent ID</span>
                  <input
                    value={editor.id}
                    disabled={editorMode === "edit"}
                    onChange={(event) => onEditorChange({ id: event.target.value })}
                    data-testid="agent-id"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Call Sign</span>
                  <input
                    value={editor.name}
                    onChange={(event) => onEditorChange({ name: event.target.value })}
                    data-testid="agent-name"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Duty Role</span>
                  <input
                    value={editor.role}
                    onChange={(event) => onEditorChange({ role: event.target.value })}
                    data-testid="agent-role"
                    className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Provider</span>
                  <select
                    value={editor.providerId}
                    onChange={(event) => onEditorChange({ providerId: event.target.value })}
                    data-testid="agent-provider"
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
                  data-testid="agent-system-prompt"
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
                        data-testid={`agent-tool-${tool.id}`}
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
                        memoryMode: event.target.value as AgentEditorState["memoryMode"]
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
                  Workflow references: {workflowReferenceCount}
                  {workflowReferenceCount ? " node(s) continue to target this agent id." : " no workflow bindings yet."}
                </p>
                <p className="mt-2">
                  Agent ids are immutable after creation. Tool toggles automatically synchronize allowed tools inside the JSON policy block.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={!settings?.providers.length || busy === "save-agent"}
                  data-testid="agent-save"
                  className="rounded-[1.4rem] bg-gradient-to-r from-cyan-300 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                >
                  {busy === "save-agent"
                    ? "Synchronizing"
                    : editorMode === "create"
                      ? "Forge Agent"
                      : "Update Agent"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={editorMode !== "edit" || busy === "delete-agent"}
                  data-testid="agent-delete"
                  className="rounded-[1.4rem] border border-rose-300/30 bg-rose-300/10 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-200/15 disabled:opacity-50"
                >
                  {busy === "delete-agent" ? "Purging" : "Delete Agent"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">Awaiting runtime settings before agent creation.</p>
          )}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Provider Deck</p>
          <div className="mt-4 space-y-3">
            {settings?.providers.map((provider) => (
              <div key={provider.id} className="rounded-2xl border border-white/8 p-3">
                <div className="flex items-center justify-between">
                  <strong className="text-white">{provider.label}</strong>
                  <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                    {provider.mode}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-400">{provider.model}</p>
                <p className="mt-1 text-xs text-cyan-200">{provider.baseUrl ?? provider.apiKeyEnv ?? "Embedded"}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-cyan-300">Runtime Policy</p>
          <pre className="mt-4 overflow-auto rounded-2xl bg-black/30 p-4 text-xs text-cyan-50">
            {JSON.stringify(settings?.defaultPolicy ?? {}, null, 2)}
          </pre>
          <p className="mt-4 text-sm text-slate-400">
            Artifact backend: {settings?.storage?.artifactBackend ?? "filesystem"}
            {settings?.storage?.artifactBucket ? ` / ${settings.storage.artifactBucket}` : ""}
          </p>
          <p className="mt-4 text-sm text-slate-400">
            Disabled tools for selected mission:{" "}
            {(activeMission?.controlState?.disabled_tools as string[] | undefined)?.join(", ") || "none"}
          </p>
        </div>
      </div>
    </div>
  );
}

function ArchiveStation({
  replay,
  missions
}: {
  replay: any;
  missions: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="panel-title text-cyan-300">Archive</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Mission replay, artifacts, and memory</h2>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Mission Replay</p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.events?.map((event: any) => (
              <div key={event.id} data-testid={`replay-event-${event.type}`} className="rounded-2xl border border-white/8 p-3">
                <strong className="text-sm text-white">{event.type}</strong>
                <p className="mt-2 text-sm text-slate-400">{event.message}</p>
              </div>
            )) ?? (
              <p className="text-sm text-slate-400">
                Select a mission from the queue to load its replay feed.
              </p>
            )}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-cyan-300">Artifacts</p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.artifacts?.map((artifact: any) => (
              <div key={artifact.id} data-testid={`artifact-${artifact.kind}`} className="rounded-2xl border border-white/8 p-3">
                <strong className="text-sm text-white">{artifact.label}</strong>
                <p className="mt-2 break-all text-xs text-cyan-200">{artifact.uri}</p>
                <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-slate-300">
                  {artifact.contentText}
                </pre>
              </div>
            )) ?? <p className="text-sm text-slate-400">No artifacts loaded.</p>}
          </div>
        </div>
        <div className="rounded-[1.8rem] border border-white/10 bg-black/20 p-4">
          <p className="panel-title text-amber-300">Long-Term Memory</p>
          <div className="scroll-thin mt-4 max-h-[24rem] space-y-3 overflow-auto pr-1">
            {replay?.memories?.map((memory: any) => (
              <div key={memory.id} className="rounded-2xl border border-white/8 p-3">
                <strong className="text-sm text-white">{memory.namespace}</strong>
                <p className="mt-2 text-sm text-slate-300">{memory.content}</p>
              </div>
            )) ?? <p className="text-sm text-slate-400">No memories loaded.</p>}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            {missions.length} missions available for replay.
          </p>
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
