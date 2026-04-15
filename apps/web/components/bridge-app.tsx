"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type ReplayPayload, useCouncilStore } from "../lib/store";
import { useBridgeData } from "../lib/hooks/use-bridge-data";
import { useTelemetrySocket } from "../lib/hooks/use-telemetry-socket";
import type { LoginState, MissionAgentEditorState, MissionDraftState } from "../lib/types/bridge";
import {
  buildMissionAgentEditorState,
  buildNewMissionAgentEditorState,
  canEditMissionStructure,
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
import { useStationRouter } from "../lib/hooks/use-station-router";
import { useMediaQuery } from "../lib/hooks/use-media-query";

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
    awaitingInputPrompt,
    setAuth,
    setStation,
    upsertMission,
    upsertMissionAgent,
    removeMissionAgent,
    setMissionWorkflow,
    upsertMissionRun,
    setReplay,
    setSelectedMissionId,
    setSelectedRunId,
    setAwaitingInputPrompt
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
  const [selectedWorkflowNodeId, setSelectedWorkflowNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retaskNote, setRetaskNote] = useState("");

  const selectedMission = missions.find((mission) => mission.id === selectedMissionId) ?? missions[0];
  const selectedRun = missionRuns.find((run) => run.id === selectedRunId) ?? missionRuns[0];
  const structuralEditsAllowed = canEditMissionStructure(selectedMission);

  // Track the last mission id for which editors were initialized
  const editorInitMissionRef = useRef<string | null>(null);

  // URL-based routing: syncs station/mission/run with browser history
  useStationRouter();

  // Accessibility: reduced motion and mobile detection for CockpitScene
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isMobile = useMediaQuery("(max-width: 768px)");

  // Delegate data fetching to hooks
  useBridgeData({ token, selectedMissionId, selectedRunId });

  // refreshRunContext is still used by action handlers and the socket onHydrate callback
  async function refreshRunContext(authToken: string, missionId: string, runId: string) {
    const [run, replayPayload] = await Promise.all([
      api.getMissionRun(authToken, missionId, runId),
      api.getReplay(authToken, missionId, runId)
    ]);
    upsertMissionRun(run);
    setReplay(replayPayload as ReplayPayload);
  }

  // hydrateMissionContext is still used by action handlers (launch, dispatch, etc.)
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
    setSelectedRunId(
      runs.find((run) => run.id === selectedRunId)?.id ??
        mission.activeRunId ??
        mission.latestRunId ??
        runs[0]?.id ??
        null
    );

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

  // Initialize local editor state when the mission workspace data arrives in the store.
  // This fires after useBridgeData populates missionWorkflow and missionAgents.
  useEffect(() => {
    if (!selectedMissionId || !missionWorkflow) {
      if (!selectedMissionId) {
        setMissionDraft(missionDraftFromWorkspace(null));
        setMissionAgentEditor(null);
        setWorkflowDraft(null);
        setWorkflowJson("");
        editorInitMissionRef.current = null;
      }
      return;
    }
    // Only reinitialize editors when the mission selection changes
    if (editorInitMissionRef.current === selectedMissionId) {
      return;
    }
    editorInitMissionRef.current = selectedMissionId;

    const mission = missions.find((m) => m.id === selectedMissionId);
    setMissionDraft(missionDraftFromWorkspace(mission ?? null));
    setWorkflowDraft(cloneWorkflow(missionWorkflow));
    setWorkflowJson(JSON.stringify(missionWorkflow, null, 2));
    setImportTemplateId(
      templateAgents.find(
        (agent) => !missionAgents.some((missionAgent) => missionAgent.id === agent.id)
      )?.id ?? ""
    );

    if (missionAgents.length > 0) {
      setSelectedMissionAgentId(missionAgents[0].id);
      setMissionAgentEditorMode("edit");
      setMissionAgentEditor(buildMissionAgentEditorState(missionAgents[0]));
    } else if (settings && mission) {
      setSelectedMissionAgentId(null);
      setMissionAgentEditorMode("create");
      setMissionAgentEditor(buildNewMissionAgentEditorState(settings, mission.id, []));
    } else {
      setSelectedMissionAgentId(null);
      setMissionAgentEditorMode("create");
      setMissionAgentEditor(null);
    }
  }, [selectedMissionId, missionWorkflow, missionAgents, missions, settings, templateAgents]);

  // onHydrate callback for the telemetry socket
  const handleSocketHydrate = useCallback(
    (missionId: string, runId: string) => {
      if (!token) return;
      void refreshRunContext(token, missionId, runId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  useTelemetrySocket({
    token,
    missionId: selectedMissionId,
    runId: selectedRunId,
    onHydrate: handleSocketHydrate,
  });

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

  function addWorkflowEdge(sourceId?: string, targetId?: string) {
    if (!workflowDraft || workflowDraft.nodes.length < 2) {
      return;
    }
    const next = cloneWorkflow(workflowDraft);
    const resolvedSource = sourceId ?? next.nodes[0].id;
    const resolvedTarget = targetId ?? next.nodes[next.nodes.length - 1].id;
    next.edges.push({
      id: nextEdgeId(next),
      source: resolvedSource,
      target: resolvedTarget,
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

  async function handleProvideInput(input: string) {
    if (!token || !selectedMission?.activeRunId) return;
    try {
      await api.actionMissionRun(token, selectedMission.id, selectedMission.activeRunId, {
        action: "provide_input",
        payload: { input },
      });
      setAwaitingInputPrompt(null);
    } catch (e) {
      setError("Failed to submit input");
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
      {!reducedMotion && !isMobile && <CockpitScene />}
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
          <section className="panel panel-grid min-h-[72vh] min-w-0 rounded-[2rem] p-5">
            <div
              id={`station-panel-${station}`}
              role="tabpanel"
              aria-labelledby={`station-tab-${station}`}
            >
              {station === "command" ? (
                <CommandDeck
                  busy={busy}
                  missionDraft={missionDraft}
                  selectedMission={selectedMission}
                  selectedRun={selectedRun}
                  telemetry={telemetry}
                  templateWorkflows={templateWorkflows}
                  awaitingInputPrompt={awaitingInputPrompt}
                  onPatchDraft={patchMissionDraft}
                  onCreateMission={() => void createMission()}
                  onSaveMission={() => void saveMissionWorkspace()}
                  onLaunchRun={() => void launchRun()}
                  onProvideInput={(input) => handleProvideInput(input)}
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
                  selectedNodeId={selectedWorkflowNodeId}
                  onNewNodeType={setNewNodeType}
                  onUpdateWorkflow={updateWorkflow}
                  onPatchNode={patchWorkflowNode}
                  onPatchEdge={patchWorkflowEdge}
                  onRemoveNode={removeWorkflowNode}
                  onRemoveEdge={removeWorkflowEdge}
                  onAddNode={addWorkflowNode}
                  onAddEdge={addWorkflowEdge}
                  onSelectNode={setSelectedWorkflowNodeId}
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
              {station === "mission-builder" ? (
                <MissionBuilderStation token={token} />
              ) : null}
            </div>
          </section>

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

// ─── Mission Builder Station ──────────────────────────────────────────────────

type BuilderMessage = { role: "user" | "assistant"; content: string };

function MissionBuilderStation({ token }: { token: string | null }) {
  const { setMissions, setTemplateAgents } = useCouncilStore();
  const [messages, setMessages] = useState<BuilderMessage[]>([
    {
      role: "assistant",
      content:
        "Mission Builder online. I can create missions, agents, and workflows for you. " +
        'Try: "Create a mission called Scout Alpha that searches for anomalies" or ' +
        '"Add a recon agent to mission scout-alpha-1".'
    }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function send() {
    if (!input.trim() || busy || !token) return;
    const userMsg: BuilderMessage = { role: "user", content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    setBuildError(null);
    try {
      const res = await fetch("/api/mission-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, token })
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `Request failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        message: string;
        actionsPerformed: { type: string; name: string }[];
      };
      setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
      if (data.actionsPerformed.length > 0) {
        void api.listMissions(token).then(setMissions);
        void api.listAgents(token).then(setTemplateAgents);
      }
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Mission Builder offline");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[68vh] flex-col">
      <div className="mb-4">
        <p className="panel-title text-cyan-300">Mission Builder</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Conversational mission design</h2>
      </div>

      <div ref={scrollRef} className="scroll-thin mb-4 flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
              msg.role === "user"
                ? "ml-8 border-amber-300/20 bg-amber-300/5 text-amber-100"
                : "mr-8 border-cyan-300/20 bg-cyan-300/5 text-slate-200"
            }`}
          >
            <span className="mb-1 block text-xs uppercase tracking-[0.18em] opacity-60">
              {msg.role === "user" ? "Operator" : "Mission AI"}
            </span>
            {msg.content}
          </div>
        ))}
        {busy && (
          <div className="mr-8 rounded-2xl border border-cyan-300/20 bg-cyan-300/5 px-4 py-3 text-sm text-slate-400">
            <span className="mb-1 block text-xs uppercase tracking-[0.18em] opacity-60">Mission AI</span>
            Processing…
          </div>
        )}
        {buildError && (
          <p className="rounded-2xl border border-rose-400/40 px-4 py-3 text-sm text-rose-200">{buildError}</p>
        )}
      </div>

      <div className="flex gap-3">
        <input
          className="flex-1 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Describe a mission, agent, or workflow to create…"
          disabled={busy || !token}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !input.trim() || !token}
          className="rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
