"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, useReactFlow } from "@xyflow/react";
import { Minus } from "lucide-react";
import { useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";

export function ConnectionLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const setEdges = useCanvasStore((state) => state.setEdges);
  const activeEdgeId = useCanvasStore((state) => state.activeEdgeId);
  const nodes = useCanvasStore((state) => state.nodes);
  const { getEdges } = useReactFlow();
  const edge = getEdges().find((item) => item.id === id);
  const locked = nodes.some((node) => (
    (node.id === edge?.source || node.id === edge?.target) &&
    (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director") &&
    node.data.runState === "running"
  ));
  const active = activeEdgeId === id || selected;
  const motionState = typeof edge?.data?.motionState === "string" ? edge.data.motionState : undefined;
  const showDelete = activeEdgeId === id && !locked;
  const showLockedHint = activeEdgeId === id && locked;
  const stroke = locked ? "#AEB7C8" : active ? "var(--selected)" : hovered ? "#7F8AA3" : "var(--connection)";
  const strokeWidth = active || hovered ? 2.6 : 2;

  return (
    <>
      <path
        d={path}
        fill="none"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        pointerEvents="stroke"
        stroke="transparent"
        strokeLinecap="round"
        strokeWidth={18}
      />
      <BaseEdge
        className={`ai-canvas-edge ${locked ? "ai-canvas-edge-running" : ""} ${motionState === "connected" ? "ai-canvas-edge-connected" : ""} ${motionState === "deleting" ? "ai-canvas-edge-deleting" : ""}`}
        id={id}
        interactionWidth={18}
        path={path}
        style={{
          filter: active ? "drop-shadow(0 2px 5px rgba(108, 99, 255, 0.18))" : undefined,
          opacity: locked ? 0.72 : 1,
          stroke,
          strokeWidth,
          transition: "stroke 120ms ease, stroke-width 120ms ease, opacity 120ms ease"
        }}
      />
      {showDelete ? (
        <EdgeLabelRenderer>
          <button
            className="nodrag nopan pointer-events-auto absolute grid h-6 w-6 place-items-center rounded-full bg-danger text-white shadow-[0_8px_18px_rgba(255,77,79,0.26)]"
            onClick={(event) => {
              event.stopPropagation();
              setEdges(getEdges().filter((edge) => edge.id !== id), { record: true });
            }}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            type="button"
          >
            <Minus size={16} strokeWidth={2.4} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
      {showLockedHint ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded-full border border-[#DDE3EE] bg-white px-3 py-1 text-[11px] font-bold text-secondary shadow-soft"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            运行中，暂不可断开
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
