"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeKind, Port } from "@/lib/nodeTypes";
import { useCanvasStore } from "@/store/canvasStore";

export function PortDot({ inputCount = 1, kind, label, nodeId, port, index }: { inputCount?: number; kind: NodeKind; label?: string; nodeId: string; port: Port; index: number }) {
  const isLeft = port.direction === "input";
  const top = (kind === "videoDirector" || kind === "minimaxH3Video" || kind === "seedanceVideo" || kind === "veo31Video") && isLeft
    ? `${Math.round(((index + 1) / (inputCount + 1)) * 100)}%`
    : index === 0 ? "50%" : "70%";
  const connected = useCanvasStore((state) =>
    state.edges.some((edge) => (
      (edge.target === nodeId && edge.targetHandle === port.id) ||
      (edge.source === nodeId && edge.sourceHandle === port.id)
    ))
  );
  const locked = useCanvasStore((state) =>
    state.nodes.some((node) => node.id === nodeId && (node.data.kind === "veo31Video" || node.data.kind === "seedanceVideo") && node.data.runState === "running") ||
    state.nodes.some((node) => node.id === nodeId && (node.data.kind === "generateImage" || node.data.kind === "storyboardImage" || node.data.kind === "minimaxH3Prompt" || node.data.kind === "minimaxH3Video" || node.data.kind === "imageTextEditor" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "mosquitoSceneImage" || node.data.kind === "productRetouch" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "videoDirector" || node.data.kind === "mosquitoSceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" || node.data.kind === "visual_director") && node.data.runState === "running")
  );
  const alwaysShowInput = kind === "videoDirector" || kind === "minimaxH3Prompt" || kind === "minimaxH3Video" || kind === "seedanceVideo" || kind === "generateImage" || kind === "storyboardImage" || kind === "imageTextEditor" || kind === "hdRedraw" || kind === "hdRedraw2" || kind === "rhinoTest" || kind === "textImageLayout" || kind === "gridImage" || kind === "sceneImage" || kind === "mosquitoSceneImage" || kind === "productRetouch" || kind === "industrialDesignImage" || kind === "productRemix" || kind === "imageChat" || kind === "sceneDirector" || kind === "mosquitoSceneDirector" || kind === "taobaoPageDirector" || kind === "industrial_designer" || kind === "product_poster" || kind === "visual_director";
  const visible = !isLeft || kind === "veo31Video" || kind === "seedanceVideo" || alwaysShowInput || connected;

  return (
    <>
      <Handle
        className={`ai-canvas-port ai-canvas-port--${port.type} !h-[14px] !w-[14px] !border-2 !border-white`}
        data-port-label={label}
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
        title={locked ? "节点运行中，暂不可连接" : connected ? "已连接" : label ? `${label}图片输入` : port.direction === "input" ? "输入端口" : "输出端口"}
        type={isLeft ? "target" : "source"}
      />
      {label ? (
        <span
          className="pointer-events-none absolute right-[calc(100%+12px)] z-[7] -translate-y-1/2 whitespace-nowrap rounded-full border border-[#DDE3EC] bg-white px-2 py-1 text-[11px] font-semibold leading-none text-[#526075] shadow-sm"
          data-video-frame-label={label}
          style={{ top }}
        >
          {label}
        </span>
      ) : null}
    </>
  );
}
