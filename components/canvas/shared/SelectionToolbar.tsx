"use client";

import { Copy, Group, LayoutGrid, Pencil, Trash2, Unlink, Ungroup } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasNodeData } from "@/lib/nodeTypes";
import { useCanvasStore } from "@/store/canvasStore";

const openPromptEditorEvent = "ai-canvas-open-prompt-editor";

function getNodeWidth(node: Node<CanvasNodeData>) {
  return Number(node.data.width ?? node.measured?.width ?? 320);
}

function getNodeHeight(node: Node<CanvasNodeData>) {
  return Number(node.data.height ?? node.measured?.height ?? 260);
}

export function SelectionToolbar() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const viewport = useCanvasStore((state) => state.viewport);
  const deleteSelected = useCanvasStore((state) => state.deleteSelected);
  const duplicateSelected = useCanvasStore((state) => state.duplicateSelected);
  const groupSelected = useCanvasStore((state) => state.groupSelected);
  const ungroupSelected = useCanvasStore((state) => state.ungroupSelected);
  const autoArrangeSelected = useCanvasStore((state) => state.autoArrangeSelected);
  const setImagePreviewUrl = useCanvasStore((state) => state.setImagePreviewUrl);

  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const bounds = useMemo(() => {
    if (!selectedNodes.length) return null;
    const minX = Math.min(...selectedNodes.map((node) => node.position.x));
    const minY = Math.min(...selectedNodes.map((node) => node.position.y));
    const maxX = Math.max(...selectedNodes.map((node) => node.position.x + getNodeWidth(node)));
    const maxY = Math.max(...selectedNodes.map((node) => node.position.y + getNodeHeight(node)));
    return { maxX, maxY, minX, minY };
  }, [selectedNodes]);

  if (!bounds) return null;

  const left = bounds.minX * viewport.zoom + viewport.x + ((bounds.maxX - bounds.minX) * viewport.zoom) / 2;
  const top = bounds.minY * viewport.zoom + viewport.y - 16;
  const hasGroup = selectedNodes.some((node) => node.data.kind === "group");
  const canGroup = selectedNodes.filter((node) => node.data.kind !== "group").length > 1;
  const canAutoArrange = selectedNodes.filter((node) => node.data.kind !== "group").length > 1;
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const incomingEdges = edges.filter((edge) => selectedIds.has(edge.target) && !edgeTouchesLockedNode(edge, nodes));
  const outgoingEdges = edges.filter((edge) => selectedIds.has(edge.source) && !edgeTouchesLockedNode(edge, nodes));
  const canDisconnectLeft = incomingEdges.length > 0;
  const canDisconnectRight = outgoingEdges.length > 0;
  const canDuplicate = selectedNodes.length > 0;
  const singleSelectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const canEdit = Boolean(
    singleSelectedNode &&
    (
      singleSelectedNode.data.kind === "prompt" ||
      (singleSelectedNode.data.kind === "image" && singleSelectedNode.data.imageUrl)
    )
  );
  const canDelete = selectedNodes.some((node) => !isRunningLockingNode(node)) || edges.some((edge) => edge.selected && !edgeTouchesLockedNode(edge, nodes));
  const editSelected = () => {
    if (!singleSelectedNode || !canEdit) return;
    if (singleSelectedNode.data.kind === "prompt") {
      window.dispatchEvent(new CustomEvent(openPromptEditorEvent, { detail: { nodeId: singleSelectedNode.id } }));
      return;
    }
    if (singleSelectedNode.data.kind === "image" && singleSelectedNode.data.imageUrl) {
      setImagePreviewUrl(singleSelectedNode.data.imageUrl);
    }
  };
  const disconnectLeft = () => {
    if (!canDisconnectLeft) return;
    const incomingIds = new Set(incomingEdges.map((edge) => edge.id));
    setEdges(edges.filter((edge) => !incomingIds.has(edge.id)), { record: true });
  };
  const disconnectRight = () => {
    if (!canDisconnectRight) return;
    const outgoingIds = new Set(outgoingEdges.map((edge) => edge.id));
    setEdges(edges.filter((edge) => !outgoingIds.has(edge.id)), { record: true });
  };

  return (
    <div
      className="nodrag nopan pointer-events-auto absolute z-30 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full border border-line bg-white/95 p-1 shadow-[0_16px_36px_rgba(15,23,42,0.14)] backdrop-blur"
      style={{ left, top }}
    >
      <ToolbarButton disabled={!canAutoArrange} label="自动整理" onClick={autoArrangeSelected}>
        <LayoutGrid size={17} strokeWidth={2} />
      </ToolbarButton>
      <ToolbarButton disabled={!canDuplicate} label="复制" onClick={() => duplicateSelected()}>
        <Copy size={17} strokeWidth={2} />
      </ToolbarButton>
      <ToolbarButton disabled={!canEdit} label="编辑" onClick={editSelected}>
        <Pencil size={17} strokeWidth={2} />
      </ToolbarButton>
      <ToolbarButton disabled={!canGroup} label="群组" onClick={groupSelected}>
        <Group size={17} strokeWidth={2} />
      </ToolbarButton>
      <ToolbarButton disabled={!hasGroup} label="取消群组" onClick={ungroupSelected}>
        <Ungroup size={17} strokeWidth={2} />
      </ToolbarButton>
      <ToolbarButton disabled={!canDisconnectLeft} label="断开左侧链接" onClick={disconnectLeft}>
        <DisconnectLeftIcon />
      </ToolbarButton>
      <ToolbarButton disabled={!canDisconnectRight} label="断开右侧链接" onClick={disconnectRight}>
        <DisconnectRightIcon />
      </ToolbarButton>
      <span className="mx-1 h-5 w-px bg-line" />
      <ToolbarButton danger disabled={!canDelete} label="删除" onClick={deleteSelected}>
        <Trash2 size={17} strokeWidth={2} />
      </ToolbarButton>
    </div>
  );
}

function edgeTouchesLockedNode(edge: Pick<Edge, "source" | "target">, nodes: Node<CanvasNodeData>[]) {
  return nodes.some((node) => (
    (node.id === edge.source || node.id === edge.target) &&
    isRunningLockingNode(node)
  ));
}

function isRunningLockingNode(node: Node<CanvasNodeData>) {
  return (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "mosquitoSceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "mosquitoSceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" || node.data.kind === "visual_director") && node.data.runState === "running";
}

function DisconnectLeftIcon() {
  return (
    <span className="relative grid h-[18px] w-[22px] place-items-center">
      <span className="absolute left-0 text-[13px] font-black leading-none">←</span>
      <Unlink className="absolute right-0" size={14} strokeWidth={2.1} />
    </span>
  );
}

function DisconnectRightIcon() {
  return (
    <span className="relative grid h-[18px] w-[22px] place-items-center">
      <Unlink className="absolute left-0" size={14} strokeWidth={2.1} />
      <span className="absolute right-0 text-[13px] font-black leading-none">→</span>
    </span>
  );
}

function ToolbarButton({
  children,
  danger = false,
  disabled = false,
  label,
  onClick
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`grid h-8 w-8 place-items-center rounded-full transition ${
        disabled
          ? "cursor-not-allowed text-[#B8C0CC]"
          : danger
            ? "text-primary hover:bg-[#F4F6FA]"
            : "text-primary hover:bg-[#F4F6FA]"
      }`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
