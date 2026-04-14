"use client";

import { useEffect, useRef, useState } from "react";
import type { TelemetryEvent } from "@the-council/contracts";
import { getWsBaseUrl } from "../config";
import { useCouncilStore } from "../store";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

type UseTelemetrySocketProps = {
  token: string | null;
  missionId: string | null;
  runId: string | null;
  onHydrate: (missionId: string, runId: string) => void;
};

export function useTelemetrySocket({
  token,
  missionId,
  runId,
  onHydrate,
}: UseTelemetrySocketProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("closed");
  const reconnectAttemptRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    setTelemetry,
    appendTelemetry,
    appendStreamToken,
    clearStreamToken,
    setAwaitingInputPrompt,
  } = useCouncilStore();

  useEffect(() => {
    if (!token || !runId || !missionId) {
      setConnectionStatus("closed");
      return;
    }

    let destroyed = false;

    function connect() {
      if (destroyed) return;

      setConnectionStatus(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");
      const ws = new WebSocket(`${getWsBaseUrl()}/runs/${runId}?token=${token}`);
      socketRef.current = ws;

      ws.onopen = () => {
        if (destroyed) {
          ws.close();
          return;
        }
        setConnectionStatus("open");
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        const payload = JSON.parse(event.data as string) as
          | TelemetryEvent
          | { type: "history"; events: TelemetryEvent[] }
          | { type: "node.stream_token"; nodeId: string; token: string; sequence: number; runId: string };

        if ("events" in payload) {
          setTelemetry(payload.events);
          onHydrate(missionId!, runId!);
          return;
        }

        const msg = payload as { type: string; [key: string]: unknown };

        if (msg.type === "node.stream_token") {
          appendStreamToken(msg.nodeId as string, msg.token as string);
          return;
        }
        if (msg.type === "node.completed" && msg.nodeId) {
          clearStreamToken(msg.nodeId as string);
        }
        if (msg.type === "node.awaiting_input") {
          setAwaitingInputPrompt(
            (msg as any).data?.prompt as string ?? "Operator input required"
          );
          appendTelemetry(msg as TelemetryEvent);
          return;
        }

        appendTelemetry(payload as TelemetryEvent);

        if (
          msg.type === "mission.completed" ||
          msg.type === "mission.failed" ||
          msg.type === "mission.cancelled" ||
          msg.type === "mission.operator_action"
        ) {
          onHydrate(missionId!, runId!);
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        setConnectionStatus("reconnecting");
        // Exponential backoff: 1s, 2s, 4s, 8s, cap at 30s
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror, so reconnect logic is there
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
      reconnectAttemptRef.current = 0;
      setConnectionStatus("closed");
    };
  }, [token, runId, missionId, onHydrate, appendStreamToken, appendTelemetry, clearStreamToken, setAwaitingInputPrompt, setTelemetry]);

  return { connectionStatus };
}
