"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type {
  MissionAction,
  TelemetryEvent,
  ToolName,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType
} from "@the-council/contracts";

import { api } from "../lib/api";
import { getWsBaseUrl } from "../lib/config";
import { type ReplayPayload, useCouncilStore } from "../lib/store";
import type { LoginState, MissionAgentEditorState, MissionDraftState } from "../lib/types/bridge";
import {
  buildMissionAgentEditorState,
  buildNewMissionAgentEditorState,
  canEditMissionStructure,
  cloneMissionAgents,
  missionDraftFromWorkspace,
  syncToolPolicyJson,
  toMissionAgentDefinition
} from "../lib/utils/mission-agent";
import {
  cloneWorkflow,
  defaultNodeConfig,
  nextEdgeId,
  nextNodeId
} from "../lib/utils/workflow";
import { BridgeHeader } from "./bridge-header";
import { LoginScreen } from "./login-screen";
import { MissionQueue } from "./sidebar/mission-queue";
import { OverrideConsole } from "./sidebar/override-console";
import { RunHistory } from "./sidebar/run-history";
import { ArchiveStation } from "./stations/archive-station";
import { CommandDeck } from "./stations/command-deck";
import { CrewStation } from "./stations/crew-station";
import { EngineeringStation } from "./stations/engineering-station";
import { TacticalStation } from "./stations/tactical-station";
import { StationTabs } from "./station-tabs";
import { type StationId } from "../lib/store";
import { CockpitScene } from "./cockpit-scene";

export function BridgeApp() {
  const {
    token,
    username,
    station,
    templateAgents,
    templateWorkflows,
    missions,
    missionAgents,
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
      <LoginScreen
        loginState={loginState}
        setLoginState={setLoginState}
        busy={busy}
        error={error}
        onLogin={() => void handleLogin()}
      />
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <CockpitScene />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(118,244,255,0.09),transparent_34%),linear-gradient(180deg,rgba(2,8,18,0.2),rgba(2,8,18,0.82))]" />

      <div className="relative z-10 min-h-screen p-4 md:p-6">
        <BridgeHeader
          username={username}
          activeMissionCount={activeMissionCount}
          templateAgents={templateAgents}
          missionAgents={missionAgents}
        />

        <StationTabs station={station} onSetStation={(id) => setStation(id as StationId)} />

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
            <MissionQueue
              missions={missions}
              selectedMission={selectedMission}
              onSelectMission={setSelectedMissionId}
            />
            <RunHistory
              missionRuns={missionRuns}
              selectedMission={selectedMission}
              selectedRun={selectedRun}
              onSelectRun={setSelectedRunId}
            />
            <OverrideConsole
              selectedRun={selectedRun}
              busy={busy}
              retaskNote={retaskNote}
              onRetaskNoteChange={setRetaskNote}
              onDispatchAction={(action) => void dispatchRunAction(action)}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
