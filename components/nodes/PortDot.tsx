"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeKind, Port } from "@/lib/nodeTypes";
import { useCanvasStore } from "@/store/canvasStore";

export function PortDot({ kind, nodeId, port, index }: { kind: NodeKind; nodeId: string; port: Port; index: number }) {
  const isLeft = port.direction === "input";
  const top = index === 0 ? "50%" : "70%";
  const connected = useCanvasStore((state) =>
    state.edges.some((edge) => (
      (edge.target === nodeId && edge.targetHandle === port.id) ||
      (edge.source === nodeId && edge.sourceHandle === port.id)
    ))
  );
  const locked = useCanvasStore((state) =>
    state.nodes.some((node) => node.id === nodeId && (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director") && node.data.runState === "running")
  );
  const alwaysShowInput = kind === "generateImage" || kind === "hdRedraw" || kind === "hdRedraw2" || kind === "rhinoTest" || kind === "textImageLayout" || kind === "gridImage" || kind === "sceneImage" || kind === "industrialDesignImage" || kind === "productRemix" || kind === "imageChat" || kind === "sceneDirector" || kind === "taobaoPageDirector" || kind === "industrial_designer" || kind === "visual_director";
  const visible = !isLeft || alwaysShowInput || connected;

  return (
    <Handle
      className={`ai-canvas-port ai-canvas-port--${port.type} !h-[14px] !w-[14px] !border-2 !border-white`}
      data-port-type={port.type}
      id={port.id}
      isConnectable={!locked}
      position={isLeft ? Position.Left : Position.Right}
      style={{
        top,
        background: port.color,
        zIndex: 8,
        opacity: visible ? locked ? 0.55 : 1 : 0,
        pointerEvents: locked ? "none" : "all",
        transition: "opacity 120ms ease, transform 120ms ease, box-shadow 120ms ease"
      }}
      title={locked ? "节点运行中，暂不可连接" : connected ? "已连接" : port.direction === "input" ? "输入端口" : "输出端口"}
      type={isLeft ? "target" : "source"}
    />
  );
}
