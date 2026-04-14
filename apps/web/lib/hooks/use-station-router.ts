"use client";
import { useEffect, useCallback } from "react";
import { useCouncilStore } from "../store";
import type { StationId } from "../store";

export function useStationRouter() {
  const station = useCouncilStore((s) => s.station);
  const selectedMissionId = useCouncilStore((s) => s.selectedMissionId);
  const selectedRunId = useCouncilStore((s) => s.selectedRunId);
  const setStation = useCouncilStore((s) => s.setStation);
  const setSelectedMissionId = useCouncilStore((s) => s.setSelectedMissionId);
  const setSelectedRunId = useCouncilStore((s) => s.setSelectedRunId);

  // On mount: read URL params and hydrate store
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlStation = params.get("station") as StationId | null;
    const urlMission = params.get("mission");
    const urlRun = params.get("run");

    const validStations: StationId[] = ["command", "tactical", "crew", "engineering", "archive"];
    if (urlStation && validStations.includes(urlStation)) {
      setStation(urlStation);
    }
    if (urlMission) setSelectedMissionId(urlMission);
    if (urlRun) setSelectedRunId(urlRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount only

  // When station changes: pushState (back button works)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const current = params.get("station");
    if (current === station) return; // avoid loop on mount hydration
    params.set("station", station);
    window.history.pushState(null, "", `?${params.toString()}`);
  }, [station]);

  // When mission/run changes: replaceState (not in back button history)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedMissionId) params.set("mission", selectedMissionId);
    else params.delete("mission");
    if (selectedRunId) params.set("run", selectedRunId);
    else params.delete("run");
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [selectedMissionId, selectedRunId]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search);
      const urlStation = params.get("station") as StationId | null;
      const validStations: StationId[] = ["command", "tactical", "crew", "engineering", "archive"];
      if (urlStation && validStations.includes(urlStation)) {
        setStation(urlStation);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setStation]);
}
