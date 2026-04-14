"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MissionAgentDefinition,
  WorkflowDefinition,
  WorkflowNode
} from "@the-council/contracts";

const NODE_W = 224;
const NODE_H = 84;

type WorkflowCanvasProps = {
  workflow: WorkflowDefinition;
  missionAgents: MissionAgentDefinition[];
  editsAllowed: boolean;
  selectedNodeId: string | null;
  onPatchNode: (nodeId: string, updater: (node: WorkflowNode) => WorkflowNode) => void;
  onRemoveNode: (nodeId: string) => void;
  onAddEdge: (sourceId: string, targetId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onSelectNode: (nodeId: string | null) => void;
};

type Viewport = {
  panX: number;
  panY: number;
  zoom: number;
};

type PendingEdge = {
  sourceId: string;
  mouseX: number;
  mouseY: number;
};

type DragState = {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startNodeY: number;
  moved: boolean;
};

type PanState = {
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
};

export function WorkflowCanvas({
  workflow,
  editsAllowed,
  selectedNodeId,
  onPatchNode,
  onRemoveNode,
  onAddEdge,
  onRemoveEdge,
  onSelectNode
}: WorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [pendingEdge, setPendingEdge] = useState<PendingEdge | null>(null);

  const dragStateRef = useRef<DragState | null>(null);
  const panStateRef = useRef<PanState | null>(null);

  // Clamp zoom helper
  function clampZoom(z: number): number {
    return Math.min(Math.max(z, 0.3), 2.0);
  }

  // Handle wheel zoom
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      setViewport((current) => {
        const oldZoom = current.zoom;
        const newZoom = clampZoom(oldZoom * (1 - e.deltaY * 0.001));
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const scale = newZoom / oldZoom;
        return {
          zoom: newZoom,
          panX: mouseX - (mouseX - current.panX) * scale,
          panY: mouseY - (mouseY - current.panY) * scale
        };
      });
    },
    []
  );

  // Attach wheel listener with passive: false so we can preventDefault
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  // Cancel pending edge on Escape at document level
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && pendingEdge) {
        setPendingEdge(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pendingEdge]);

  // ------- Pointer handlers for panning (on container background) -------

  function handleContainerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only pan if clicking on the container itself (not a child)
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0) return;

    // Cancel pending edge on background click
    if (pendingEdge) {
      setPendingEdge(null);
      return;
    }

    onSelectNode(null);

    panStateRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: viewport.panX,
      startPanY: viewport.panY
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleContainerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    // Update pending edge mouse position
    if (pendingEdge) {
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        setPendingEdge((current) =>
          current
            ? { ...current, mouseX: e.clientX - rect.left, mouseY: e.clientY - rect.top }
            : null
        );
      }
    }

    // Handle node drag
    const drag = dragStateRef.current;
    if (drag) {
      const dx = (e.clientX - drag.startClientX) / viewport.zoom;
      const dy = (e.clientY - drag.startClientY) / viewport.zoom;
      const moved = Math.abs(e.clientX - drag.startClientX) >= 5 || Math.abs(e.clientY - drag.startClientY) >= 5;
      if (moved) {
        dragStateRef.current = { ...drag, moved: true };
        onPatchNode(drag.nodeId, (node) => ({
          ...node,
          position: {
            x: drag.startNodeX + dx,
            y: drag.startNodeY + dy
          }
        }));
      }
      return;
    }

    // Handle pan
    const pan = panStateRef.current;
    if (pan) {
      const dx = e.clientX - pan.startClientX;
      const dy = e.clientY - pan.startClientY;
      setViewport((current) => ({
        ...current,
        panX: pan.startPanX + dx,
        panY: pan.startPanY + dy
      }));
    }
  }

  function handleContainerPointerUp(_e: React.PointerEvent<HTMLDivElement>) {
    dragStateRef.current = null;
    panStateRef.current = null;
  }

  // ------- Canvas keyboard handling -------

  function handleContainerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Only handle canvas-level keys when no node is focused/selected
    if (selectedNodeId) return;

    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom + 0.1) }));
    } else if (e.key === "-") {
      e.preventDefault();
      setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom - 0.1) }));
    } else if (e.key === "0") {
      e.preventDefault();
      setViewport({ panX: 0, panY: 0, zoom: 1 });
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setViewport((v) => ({ ...v, panX: v.panX + 30 }));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setViewport((v) => ({ ...v, panX: v.panX - 30 }));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setViewport((v) => ({ ...v, panY: v.panY + 30 }));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setViewport((v) => ({ ...v, panY: v.panY - 30 }));
    }
  }

  // ------- Node pointer/click/keyboard handlers -------

  function handleNodePointerDown(e: React.PointerEvent<HTMLDivElement>, nodeId: string) {
    e.stopPropagation();
    if (!editsAllowed) return;
    if (e.button !== 0) return;

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    dragStateRef.current = {
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startNodeX: node.position.x,
      startNodeY: node.position.y,
      moved: false
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleNodeClick(e: React.MouseEvent<HTMLDivElement>, nodeId: string) {
    e.stopPropagation();

    // If drag happened, don't treat as click
    const drag = dragStateRef.current;
    if (drag && drag.moved) return;

    if (e.shiftKey) {
      // Visual edge creation
      if (pendingEdge === null) {
        // Start pending edge from this node
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          setPendingEdge({
            sourceId: nodeId,
            mouseX: e.clientX - rect.left,
            mouseY: e.clientY - rect.top
          });
        }
      } else if (pendingEdge.sourceId === nodeId) {
        // Shift+click source again to cancel
        setPendingEdge(null);
      } else {
        // Connect to this target
        onAddEdge(pendingEdge.sourceId, nodeId);
        setPendingEdge(null);
      }
      return;
    }

    // If there's a pending edge and not shift key, connect to this node
    if (pendingEdge && pendingEdge.sourceId !== nodeId) {
      onAddEdge(pendingEdge.sourceId, nodeId);
      setPendingEdge(null);
      return;
    }

    // Normal click: select node
    onSelectNode(nodeId);
  }

  function handleNodeKeyDown(e: React.KeyboardEvent<HTMLDivElement>, nodeId: string) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (editsAllowed) onPatchNode(nodeId, (n) => ({ ...n, position: { ...n.position, x: n.position.x - 10 } }));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (editsAllowed) onPatchNode(nodeId, (n) => ({ ...n, position: { ...n.position, x: n.position.x + 10 } }));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (editsAllowed) onPatchNode(nodeId, (n) => ({ ...n, position: { ...n.position, y: n.position.y - 10 } }));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (editsAllowed) onPatchNode(nodeId, (n) => ({ ...n, position: { ...n.position, y: n.position.y + 10 } }));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (editsAllowed) onRemoveNode(nodeId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSelectNode(null);
    }
  }

  // ------- Edge geometry helpers -------

  function worldToContainer(worldX: number, worldY: number): [number, number] {
    return [
      worldX * viewport.zoom + viewport.panX,
      worldY * viewport.zoom + viewport.panY
    ];
  }

  function getNodeSourcePort(node: WorkflowNode): [number, number] {
    return worldToContainer(node.position.x + NODE_W, node.position.y + NODE_H / 2);
  }

  function getNodeTargetPort(node: WorkflowNode): [number, number] {
    return worldToContainer(node.position.x, node.position.y + NODE_H / 2);
  }

  // ------- Pending edge source port -------
  const pendingSourceNode = pendingEdge
    ? workflow.nodes.find((n) => n.id === pendingEdge.sourceId)
    : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="Workflow canvas"
      style={{ overflow: "hidden", position: "relative", minHeight: "28rem" }}
      className="rounded-[1.5rem] border border-white/8 bg-black/25 outline-none"
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onKeyDown={handleContainerKeyDown}
    >
      {/* SVG layer for edges — fixed in container space */}
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible"
        }}
      >
        {workflow.edges.map((edge) => {
          const source = workflow.nodes.find((n) => n.id === edge.source);
          const target = workflow.nodes.find((n) => n.id === edge.target);
          if (!source || !target) return null;

          const [sx, sy] = getNodeSourcePort(source);
          const [tx, ty] = getNodeTargetPort(target);
          const cx1 = sx + (tx - sx) * 0.5;
          const cy1 = sy;
          const cx2 = sx + (tx - sx) * 0.5;
          const cy2 = ty;
          const d = `M ${sx} ${sy} C ${cx1} ${cy1} ${cx2} ${cy2} ${tx} ${ty}`;

          return (
            <g key={edge.id}>
              {/* Invisible wide hit area for click-to-remove */}
              {editsAllowed ? (
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={16}
                  fill="none"
                  style={{ pointerEvents: "stroke", cursor: "pointer" }}
                  onClick={() => onRemoveEdge(edge.id)}
                />
              ) : null}
              {/* Visible edge */}
              <path
                d={d}
                stroke="rgba(118,244,255,0.45)"
                strokeWidth={2}
                fill="none"
                strokeDasharray={edge.condition ? "8 8" : undefined}
              />
              {edge.condition ? (
                <text
                  x={(sx + tx) / 2}
                  y={(sy + ty) / 2 - 6}
                  fill="#f7b955"
                  fontSize="11"
                  textAnchor="middle"
                >
                  {edge.condition}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Pending edge preview */}
        {pendingEdge && pendingSourceNode ? (() => {
          const [sx, sy] = getNodeSourcePort(pendingSourceNode);
          const tx = pendingEdge.mouseX;
          const ty = pendingEdge.mouseY;
          return (
            <line
              x1={sx}
              y1={sy}
              x2={tx}
              y2={ty}
              stroke="rgba(251,191,36,0.6)"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          );
        })() : null}
      </svg>

      {/* Content wrapper with pan/zoom transform */}
      <div
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
          position: "absolute",
          inset: 0
        }}
      >
        {workflow.nodes.map((node) => (
          <div
            key={node.id}
            tabIndex={0}
            role="button"
            aria-label={`Node: ${node.name}`}
            aria-selected={selectedNodeId === node.id}
            style={{
              position: "absolute",
              left: node.position.x,
              top: node.position.y,
              width: NODE_W,
              cursor: editsAllowed ? "grab" : "default"
            }}
            className={`rounded-2xl border bg-[rgba(5,18,31,0.92)] p-4 shadow-bridge select-none ${
              selectedNodeId === node.id
                ? "border-cyan-300/60 ring-1 ring-cyan-300/40"
                : "border-white/10"
            }`}
            onPointerDown={(e) => handleNodePointerDown(e, node.id)}
            onClick={(e) => handleNodeClick(e, node.id)}
            onKeyDown={(e) => handleNodeKeyDown(e, node.id)}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <strong className="truncate text-sm text-white">{node.name}</strong>
              <span className="shrink-0 rounded-full border border-cyan-300/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                {node.type}
              </span>
            </div>
            <p className="truncate text-xs text-slate-500">{node.id}</p>
            {"agentId" in node.config ? (
              <p className="mt-1 truncate text-xs text-amber-200">{String(node.config.agentId)}</p>
            ) : null}
            {/* Port indicators */}
            <div
              style={{
                position: "absolute",
                right: -5,
                top: "50%",
                transform: "translateY(-50%)",
                width: 10,
                height: 10
              }}
              className="rounded-full border border-cyan-300/60 bg-slate-900"
            />
            <div
              style={{
                position: "absolute",
                left: -5,
                top: "50%",
                transform: "translateY(-50%)",
                width: 10,
                height: 10
              }}
              className="rounded-full border border-cyan-300/60 bg-slate-900"
            />
          </div>
        ))}
      </div>

      {/* Toolbar overlay — top-right */}
      <div
        style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}
        className="flex gap-2"
      >
        <button
          type="button"
          onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom + 0.1) }))}
          className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-300 hover:bg-black/60"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom - 0.1) }))}
          className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-300 hover:bg-black/60"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setViewport({ panX: 0, panY: 0, zoom: 1 })}
          className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-300 hover:bg-black/60"
          aria-label="Reset view"
        >
          ⌖
        </button>
      </div>

      {/* Pending edge instruction overlay */}
      {pendingEdge !== null ? (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10
          }}
          className="rounded-full border border-amber-300/30 bg-black/60 px-4 py-2 text-xs text-amber-200 backdrop-blur-sm"
        >
          Click a target node to connect — Shift+click source again or Escape to cancel
        </div>
      ) : null}
    </div>
  );
}
