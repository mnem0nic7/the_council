"use client";

import { useCallback, useEffect } from "react";
import { api } from "../api";
import type { ReplayPayload } from "../store";
import { useCouncilStore } from "../store";

type UseBridgeDataProps = {
  token: string | null;
  selectedMissionId: string | null;
  selectedRunId: string | null;
};

export function useBridgeData({ token, selectedMissionId, selectedRunId }: UseBridgeDataProps) {
  const {
    setTemplateAgents,
    setTemplateWorkflows,
    setMissions,
    setSettings,
    setSelectedMissionId,
    upsertMission,
    setMissionAgents,
    setMissionWorkflow,
    setMissionRuns,
    setSelectedRunId,
    upsertMissionRun,
    setReplay,
    setInitialLoad,
  } = useCouncilStore();

  // Initial load of global data
  useEffect(() => {
    if (!token) return;
    const authToken = token;
    let cancelled = false;

    async function load() {
      try {
        const [agents, workflows, missions, settings] = await Promise.all([
          api.listAgents(authToken),
          api.listWorkflows(authToken),
          api.listMissions(authToken),
          api.getSettings(authToken),
        ]);
        if (cancelled) return;
        setTemplateAgents(agents);
        setTemplateWorkflows(workflows);
        setMissions(missions);
        setSettings(settings);
        setInitialLoad(true);
        if (missions[0] && !selectedMissionId) {
          setSelectedMissionId(missions[0].id);
        }
      } catch {
        // errors handled by caller
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load mission workspace when selection changes
  useEffect(() => {
    if (!token || !selectedMissionId) return;
    const authToken = token;
    const missionId = selectedMissionId;
    let cancelled = false;

    async function loadMission() {
      try {
        const [mission, agents, workflow, runs] = await Promise.all([
          api.getMission(authToken, missionId),
          api.listMissionAgents(authToken, missionId),
          api.getMissionWorkflow(authToken, missionId),
          api.listMissionRuns(authToken, missionId),
        ]);
        if (cancelled) return;
        upsertMission(mission);
        setMissionAgents(agents);
        setMissionWorkflow(workflow);
        setMissionRuns(runs);
        const next = mission.activeRunId ?? mission.latestRunId ?? runs[0]?.id ?? null;
        setSelectedRunId(next);
      } catch {
        // errors handled by caller
      }
    }
    void loadMission();
    return () => {
      cancelled = true;
    };
  }, [token, selectedMissionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load run replay when run selection changes
  useEffect(() => {
    if (!token || !selectedMissionId || !selectedRunId) {
      setReplay(null);
      return;
    }
    const authToken = token;
    const missionId = selectedMissionId;
    const runId = selectedRunId;
    let cancelled = false;

    async function loadRun() {
      try {
        const [run, replay] = await Promise.all([
          api.getMissionRun(authToken, missionId, runId),
          api.getReplay(authToken, missionId, runId),
        ]);
        if (cancelled) return;
        upsertMissionRun(run);
        setReplay(replay as ReplayPayload);
      } catch {
        // errors handled by caller
      }
    }
    void loadRun();
    return () => {
      cancelled = true;
    };
  }, [token, selectedMissionId, selectedRunId]); // eslint-disable-line react-hooks/exhaustive-deps
}
