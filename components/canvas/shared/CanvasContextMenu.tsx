"use client";

import { BringToFront, Copy, Group, LayoutGrid, Trash2, Unlink, Ungroup } from "lucide-react";
import type { ReactNode } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasNodeData } from "@/lib/nodeTypes";
import { useCanvasStore } from "@/store/canvasStore";

export type CanvasContextMenuState =
  | { edgeId: string; type: "edge"; x: number; y: number }
  | { nodeId: string; type: "node"; x: number; y: number };

export function CanvasContextMenu({ menu, onClose }: { menu: CanvasContextMenuState | null; onClose: () => void }) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const bringNodesToFront = useCanvasStore((state) => state.bringNodesToFront);
  const deleteSelected = useCanvasStore((state) => state.deleteSelected);
  const duplicateSelected = useCanvasStore((state) => state.duplicateSelected);
  const groupSelected = useCanvasStore((state) => state.groupSelected);
  const ungroupSelected = useCanvasStore((state) => state.ungroupSelected);
  const autoArrangeSelected = useCanvasStore((state) => state.autoArrangeSelected);

  if (!menu) return null;

  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNodeIds = selectedNodes.map((node) => node.id);
  const selectedNonGroupCount = selectedNodes.filter((node) => node.data.kind !== "group").length;
  const selectedHasGroup = selectedNodes.some((node) => node.data.kind === "group");
  const canDelete = selectedNodes.some((node) => !isRunningLockingNode(node)) || edges.some((edge) => edge.selected && !edgeTouchesLockedNode(edge, nodes));
  const targetEdge = menu.type === "edge" ? edges.find((edge) => edge.id === menu.edgeId) : undefined;
  const targetEdgeLocked = edgeTouchesLockedNode(targetEdge, nodes);

  const runAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      className="nodrag nopan absolute z-50 min-w-[168px] overflow-hidden rounded-[12px] border border-line bg-white py-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.16)]"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.type === "node" ? (
        <>
          <MenuItem disabled={selectedNonGroupCount < 2} icon={<LayoutGrid size={16} />} label="自动整理" onClick={() => runAction(autoArrangeSelected)} />
          <MenuItem icon={<Copy size={16} />} label="复制" onClick={() => runAction(() => duplicateSelected())} />
          <MenuItem icon={<BringToFront size={16} />} label="置顶" onClick={() => runAction(() => bringNodesToFront(selectedNodeIds))} />
          <MenuItem disabled={selectedNonGroupCount < 2} icon={<Group size={16} />} label="群组" onClick={() => runAction(groupSelected)} />
          <MenuItem disabled={!selectedHasGroup} icon={<Ungroup size={16} />} label="取消群组" onClick={() => runAction(ungroupSelected)} />
          <MenuDivider />
          <MenuItem danger disabled={!canDelete} icon={<Trash2 size={16} />} label="删除" onClick={() => runAction(deleteSelected)} />
        </>
      ) : (
        <MenuItem
          danger
          disabled={targetEdgeLocked}
          icon={<Unlink size={16} />}
          label={targetEdgeLocked ? "运行中，暂不可断开" : "断开连接"}
          onClick={() => runAction(() => setEdges(edges.filter((edge) => edge.id !== menu.edgeId), { record: true }))}
        />
      )}
    </div>
  );
}

function edgeTouchesLockedNode(edge: Pick<Edge, "source" | "target"> | undefined, nodes: Node<CanvasNodeData>[]) {
  if (!edge) return false;
  return nodes.some((node) => (
    (node.id === edge.source || node.id === edge.target) &&
    isRunningLockingNode(node)
  ));
}

function isRunningLockingNode(node: Node<CanvasNodeData>) {
  return (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director") && node.data.runState === "running";
}

function MenuItem({
  danger = false,
  disabled = false,
  icon,
  label,
  onClick
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-semibold transition ${
        disabled
          ? "cursor-not-allowed text-[#B8C0CC]"
          : danger
            ? "text-danger hover:bg-[#FFF3F3]"
            : "text-primary hover:bg-[#F5F7FB]"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-line" />;
}
