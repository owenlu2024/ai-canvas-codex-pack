"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
  type ReactFlowInstance
} from "@xyflow/react";
import { Copy, Trash2, X } from "lucide-react";
import { AddNodePopover } from "@/components/canvas/AddNodePopover";
import { ConnectionLine } from "@/components/canvas/ConnectionLine";
import { CanvasContextMenu, type CanvasContextMenuState } from "@/components/canvas/shared/CanvasContextMenu";
import { ImageAnnotationEditor } from "@/components/canvas/shared/ImageAnnotationEditor";
import { SelectionToolbar } from "@/components/canvas/shared/SelectionToolbar";
import { ImageChatNode } from "@/components/nodes/ImageChatNode";
import { ImageNode } from "@/components/nodes/ImageNode";
import { MultiGenerateNode } from "@/components/nodes/MultiGenerateNode";
import { PromptNode } from "@/components/nodes/PromptNode";
import { useDisplayScale } from "@/components/layout/useDisplayScale";
import { isSameColorConnection } from "@/lib/connectionRules";
import { getReadableZoomFloor } from "@/lib/displayScale";
import { getHandlePortType, portsByNode, type CanvasNodeData, type PortType } from "@/lib/nodeTypes";
import { buildVisibleTextPromptRichHtml } from "@/lib/promptHighlight";
import { nextZIndex } from "@/lib/zIndex";
import { type CanvasWorkspaceSnapshot, useCanvasStore } from "@/store/canvasStore";

const workspaceStorageKey = "ai-canvas-workspace-v1";
const localStorageWorkspaceLimit = 4_500_000;
const openPromptEditorEvent = "ai-canvas-open-prompt-editor";

const nodeTypes = {
  image: ImageNode,
  prompt: PromptNode,
  imageChat: ImageChatNode,
  sceneDirector: ImageChatNode,
  taobaoPageDirector: ImageChatNode,
  industrial_designer: ImageChatNode,
  visual_director: MultiGenerateNode,
  multiGenerate: MultiGenerateNode,
  generateImage: MultiGenerateNode,
  rhinoTest: MultiGenerateNode,
  textImageLayout: MultiGenerateNode,
  gridImage: MultiGenerateNode,
  sceneImage: MultiGenerateNode,
  industrialDesignImage: MultiGenerateNode,
  productRemix: MultiGenerateNode,
  groupFrame: ImageNode
};

const edgeTypes = {
  deletable: ConnectionLine
};

const initialViewport = { x: 0, y: 0, zoom: 1 };
const promptEditorMinWidth = 360;
const promptEditorMinHeight = 260;
const promptEditorMargin = 24;
const annotatedImageNodeGap = 48;
const annotatedImageNodeOffset = 28;
const annotatedImageNodeWidth = 320;
const annotatedImageNodeHeight = 260;
const promptEditorDefaultTextColor = "#111827";
const promptEditorTextColors = [
  "#111827",
  "#FF3B63",
  "#FF8A00",
  "#FFC400",
  "#22C55E",
  "#14B8A6",
  "#3F7CF5",
  "#7C3AED"
];

interface ImageMentionOption {
  id: string;
  imageNumber: number;
  imageUrl?: string;
  label: string;
}

interface PromptEditorState {
  height: number;
  nodeId: string;
  width: number;
  x: number;
  y: number;
}

type PromptEditorResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function getTextRangeByOffsets(root: HTMLElement, startOffset: number, endOffset: number) {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentOffset = 0;
  let startSet = false;
  let node = walker.nextNode();

  while (node) {
    const textLength = node.textContent?.length ?? 0;
    const nextOffset = currentOffset + textLength;

    if (!startSet && startOffset <= nextOffset) {
      range.setStart(node, Math.max(0, startOffset - currentOffset));
      startSet = true;
    }

    if (endOffset <= nextOffset) {
      range.setEnd(node, Math.max(0, endOffset - currentOffset));
      return range;
    }

    currentOffset = nextOffset;
    node = walker.nextNode();
  }

  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function getGroupMemberIds(node: Node<CanvasNodeData>) {
  return Array.isArray(node.data.memberIds) ? node.data.memberIds.filter((id): id is string => typeof id === "string") : [];
}

function resizeGroupsToMembers(nodes: Node<CanvasNodeData>[]) {
  return nodes.map((node) => {
    if (node.data.kind !== "group") return node;
    const memberIds = new Set(getGroupMemberIds(node));
    const members = nodes.filter((item) => memberIds.has(item.id));
    if (!members.length) return node;

    const minX = Math.min(...members.map((member) => member.position.x));
    const minY = Math.min(...members.map((member) => member.position.y));
    const maxX = Math.max(...members.map((member) => member.position.x + (member.measured?.width ?? 320)));
    const maxY = Math.max(...members.map((member) => member.position.y + (member.measured?.height ?? 260)));
    const position = { x: minX - 26, y: minY - 26 };
    const width = maxX - minX + 52;
    const height = maxY - minY + 52;

    return {
      ...node,
      position,
      data: {
        ...node.data,
        width,
        height
      }
    };
  });
}

function isPositionChange(change: NodeChange<Node<CanvasNodeData>>): change is Extract<NodeChange<Node<CanvasNodeData>>, { type: "position" }> {
  return change.type === "position" && Boolean(change.position);
}

function getNodeWidth(node: Node<CanvasNodeData>) {
  return Number(node.data.width ?? node.measured?.width ?? 320);
}

function getNodeHeight(node: Node<CanvasNodeData>) {
  return Number(node.data.height ?? node.measured?.height ?? 260);
}

function canvasRectsOverlap(
  a: { height: number; width: number; x: number; y: number },
  b: { height: number; width: number; x: number; y: number },
  margin = 18
) {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

function findNearbyAnnotatedImagePosition(sourceNode: Node<CanvasNodeData>, nodes: Node<CanvasNodeData>[]) {
  const sourceWidth = getNodeWidth(sourceNode);
  const sourceHeight = getNodeHeight(sourceNode);
  const existingRects = nodes.map((node) => ({
    height: getNodeHeight(node),
    width: getNodeWidth(node),
    x: node.position.x,
    y: node.position.y
  }));
  const candidates = [
    { x: sourceNode.position.x + sourceWidth + annotatedImageNodeGap, y: sourceNode.position.y + annotatedImageNodeOffset },
    { x: sourceNode.position.x + sourceWidth + annotatedImageNodeGap, y: sourceNode.position.y + sourceHeight + annotatedImageNodeGap },
    { x: sourceNode.position.x, y: sourceNode.position.y + sourceHeight + annotatedImageNodeGap },
    { x: sourceNode.position.x - annotatedImageNodeWidth - annotatedImageNodeGap, y: sourceNode.position.y + annotatedImageNodeOffset }
  ];

  for (let ring = 0; ring < 8; ring += 1) {
    for (const candidate of candidates) {
      const position = {
        x: candidate.x + ring * (annotatedImageNodeWidth + annotatedImageNodeGap),
        y: candidate.y + ring * annotatedImageNodeOffset
      };
      const rect = {
        ...position,
        height: annotatedImageNodeHeight,
        width: annotatedImageNodeWidth
      };
      if (existingRects.every((existing) => !canvasRectsOverlap(rect, existing))) return position;
    }
  }

  return {
    x: sourceNode.position.x + sourceWidth + annotatedImageNodeGap,
    y: sourceNode.position.y + sourceHeight + annotatedImageNodeGap
  };
}

function clampPromptEditorPanel(panel: PromptEditorState, bounds: { height: number; width: number }): PromptEditorState {
  const maxWidth = Math.max(promptEditorMinWidth, bounds.width - promptEditorMargin * 2);
  const maxHeight = Math.max(promptEditorMinHeight, bounds.height - promptEditorMargin * 2);
  const width = Math.min(maxWidth, Math.max(promptEditorMinWidth, panel.width));
  const height = Math.min(maxHeight, Math.max(promptEditorMinHeight, panel.height));
  return {
    ...panel,
    width,
    height,
    x: Math.min(bounds.width - width - promptEditorMargin, Math.max(promptEditorMargin, panel.x)),
    y: Math.min(bounds.height - height - promptEditorMargin, Math.max(promptEditorMargin, panel.y))
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizePromptRichHtml(value: string) {
  const container = document.createElement("div");
  container.innerHTML = value;
  const allowedTags = new Set(["B", "BR", "DIV", "EM", "I", "P", "SPAN", "STRONG", "U"]);
  const safeColor = /^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;

  const cleanNode = (node: globalThis.Node) => {
    Array.from(node.childNodes).forEach(cleanNode);
    if (!(node instanceof HTMLElement)) return;
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    const color = node instanceof HTMLSpanElement ? node.style.color : "";
    Array.from(node.attributes).forEach((attribute) => node.removeAttribute(attribute.name));
    if (node instanceof HTMLSpanElement && color && safeColor.test(color)) {
      node.style.color = color;
    }
  };

  cleanNode(container);
  return container.innerHTML;
}

function isRunningLockingNode(node?: Node<CanvasNodeData>) {
  return (node?.data.kind === "generateImage" || node?.data.kind === "rhinoTest" || node?.data.kind === "textImageLayout" || node?.data.kind === "gridImage" || node?.data.kind === "sceneImage" || node?.data.kind === "industrialDesignImage" || node?.data.kind === "productRemix" || node?.data.kind === "imageChat" || node?.data.kind === "sceneDirector" || node?.data.kind === "taobaoPageDirector" || node?.data.kind === "industrial_designer" || node?.data.kind === "visual_director") && node.data.runState === "running";
}

function connectionTouchesRunningLockingNode(connection: Pick<Connection, "source" | "target">, nodes: Node<CanvasNodeData>[]) {
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  return isRunningLockingNode(source) || isRunningLockingNode(target);
}

function hasCopyModifier(event: MouseEvent | TouchEvent) {
  return "metaKey" in event && (event.metaKey || event.ctrlKey);
}

function getNextCopyImageNumber(nodes: Node<CanvasNodeData>[], reserved = new Set<number>()) {
  const used = new Set(
    nodes
      .filter((node) => node.data.kind === "image")
      .map((node) => Number(node.data.imageNumber))
      .filter((number) => Number.isInteger(number) && number >= 1 && number <= 100)
  );
  for (let number = 1; number <= 100; number += 1) {
    if (!used.has(number) && !reserved.has(number)) return number;
  }
  return undefined;
}

function makeDragCopiedNodes(sourceNodes: Node<CanvasNodeData>[], allNodes: Node<CanvasNodeData>[], startZIndex: number) {
  let zIndex = startZIndex;
  const idMap: Record<string, string> = {};
  const reservedImageNumbers = new Set<number>();
  const selectedSourceIds = new Set(sourceNodes.map((node) => node.id));
  const copiedNodes: Node<CanvasNodeData>[] = [];

  sourceNodes.forEach((node, index) => {
    zIndex = nextZIndex(zIndex);
    const id = `${node.data.kind}-drag-copy-${Date.now()}-${index}-${Math.round(Math.random() * 1000)}`;
    idMap[node.id] = id;
    const data: CanvasNodeData = {
      ...node.data,
      errorMessage: undefined,
      generatedBy: undefined,
      generationId: undefined,
      runState: node.data.runState === "running" ? "idle" : node.data.runState,
      zIndex
    };
    if (node.data.kind === "image") {
      const imageNumber = getNextCopyImageNumber([...allNodes, ...copiedNodes], reservedImageNumbers);
      if (imageNumber) {
        reservedImageNumbers.add(imageNumber);
        data.imageNumber = imageNumber;
      } else {
        delete data.imageNumber;
      }
    }
    copiedNodes.push({
      ...node,
      id,
      position: { ...node.position },
      selected: true,
      zIndex,
      data
    });
  });

  return {
    copiedNodes: copiedNodes.map((node) => {
      if (node.data.kind !== "group") return node;
      const memberIds = Array.isArray(node.data.memberIds)
        ? node.data.memberIds
            .map((id) => typeof id === "string" && selectedSourceIds.has(id) ? idMap[id] : undefined)
            .filter((id): id is string => Boolean(id))
        : [];
      return { ...node, data: { ...node.data, memberIds } };
    }),
    idMap
  };
}

function edgeTouchesRunningLockingNode(edge: Pick<Edge, "source" | "target"> | undefined, nodes: Node<CanvasNodeData>[]) {
  if (!edge) return false;
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  return isRunningLockingNode(source) || isRunningLockingNode(target);
}

function isRemoveEdgeChange(change: EdgeChange<Edge>): change is Extract<EdgeChange<Edge>, { type: "remove" }> {
  return change.type === "remove";
}

function isAutoMentionImageEdge(edge: Edge) {
  return edge.id.startsWith("edge-mention-image-") || edge.id.startsWith("edge-virtual-mention-image-") || edge.data?.autoLinkedFromMention === true || edge.data?.virtualAutoMention === true;
}

function getOutputHandleForPortType(node: Node<CanvasNodeData>, portType: PortType | null) {
  if (!portType) return null;
  return portsByNode[node.data.kind].find((port) => port.direction === "output" && port.type === portType)?.id ?? null;
}

function getInputHandleForPortType(node: Node<CanvasNodeData>, portType: PortType | null) {
  if (!portType) return null;
  return portsByNode[node.data.kind].find((port) => port.direction === "input" && port.type === portType)?.id ?? null;
}

function getHandleDirection(node: Node<CanvasNodeData> | undefined, handleId?: string | null) {
  if (!node || !handleId) return null;
  return portsByNode[node.data.kind].find((port) => port.id === handleId)?.direction ?? null;
}

function normalizeConnectionDirection(connection: Connection, nodes: Node<CanvasNodeData>[]): Connection | null {
  if (!connection.source || !connection.target) return null;
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  const sourceDirection = getHandleDirection(sourceNode, connection.sourceHandle);
  const targetDirection = getHandleDirection(targetNode, connection.targetHandle);
  if (sourceDirection === "output" && targetDirection === "input") return connection;
  if (sourceDirection === "input" && targetDirection === "output") {
    return {
      source: connection.target,
      sourceHandle: connection.targetHandle,
      target: connection.source,
      targetHandle: connection.sourceHandle
    };
  }
  return null;
}

function hasSameConnection(edges: Edge[], connection: Pick<Edge, "source" | "sourceHandle" | "target" | "targetHandle">) {
  return edges.some((edge) => (
    edge.source === connection.source &&
    edge.target === connection.target &&
    edge.sourceHandle === connection.sourceHandle &&
    edge.targetHandle === connection.targetHandle
  ));
}

function getWorkspaceSavedTime(workspace?: Partial<CanvasWorkspaceSnapshot> | null) {
  if (!workspace || typeof workspace.savedAt !== "string") return 0;
  const time = Date.parse(workspace.savedAt);
  if (!Number.isFinite(time)) return 0;
  return time > Date.now() + 5 * 60 * 1000 ? 0 : time;
}

function getLatestWorkspace(workspaces: Array<CanvasWorkspaceSnapshot | null>) {
  return workspaces
    .filter((workspace): workspace is CanvasWorkspaceSnapshot => Boolean(workspace))
    .sort((a, b) => getWorkspaceSavedTime(b) - getWorkspaceSavedTime(a))[0] ?? null;
}

function isInitialExampleWorkspace(workspace: CanvasWorkspaceSnapshot) {
  const nodeIds = workspace.nodes.map((node) => node.id);
  const expectedIds = ["image-1", "prompt-1", "image-2", "prompt-2", "image-3"];
  return (
    workspace.nodes.length === 5 &&
    workspace.edges.length === 1 &&
    expectedIds.every((id, index) => nodeIds[index] === id) &&
    workspace.nodes.every((node) => !node.data.prompt) &&
    workspace.nodes.filter((node) => node.data.kind === "image").every((node) => typeof node.data.imageUrl === "string" && node.data.imageUrl.startsWith("/reference-assets/chair-"))
  );
}

export function AiCanvas() {
  const flowRef = useRef<ReactFlowInstance<Node<CanvasNodeData>, Edge> | null>(null);
  const viewportInitializedRef = useRef(false);
  const restoredFromSavedRef = useRef(false);
  const savedViewportAppliedRef = useRef(false);
  const latestSerializedWorkspaceRef = useRef("");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const copiedNodesRef = useRef<Node<CanvasNodeData>[]>([]);
  const dragCopyRef = useRef<{ idMap: Record<string, string> } | null>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [middlePanning, setMiddlePanning] = useState(false);
  const [connectingPortType, setConnectingPortType] = useState<PortType | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [promptEditor, setPromptEditor] = useState<PromptEditorState | null>(null);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const viewport = useCanvasStore((state) => state.viewport);
  const projectTitle = useCanvasStore((state) => state.projectTitle);
  const globalZIndex = useCanvasStore((state) => state.globalZIndex);
  const activeEdgeId = useCanvasStore((state) => state.activeEdgeId);
  const workspaceHydrated = useCanvasStore((state) => state.workspaceHydrated);
  const workspaceRevision = useCanvasStore((state) => state.workspaceRevision);
  const gridEnabled = useCanvasStore((state) => state.gridEnabled);
  const showAutoImageLinks = useCanvasStore((state) => state.showAutoImageLinks);
  const hydrateWorkspace = useCanvasStore((state) => state.hydrateWorkspace);
  const createWorkspaceSnapshot = useCanvasStore((state) => state.createWorkspaceSnapshot);
  const setNodes = useCanvasStore((state) => state.setNodes);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const setZoom = useCanvasStore((state) => state.setZoom);
  const openAddMenu = useCanvasStore((state) => state.openAddMenu);
  const closeAddMenu = useCanvasStore((state) => state.closeAddMenu);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const bringNodesToFront = useCanvasStore((state) => state.bringNodesToFront);
  const deleteSelected = useCanvasStore((state) => state.deleteSelected);
  const duplicateSelected = useCanvasStore((state) => state.duplicateSelected);
  const pasteNodes = useCanvasStore((state) => state.pasteNodes);
  const groupSelected = useCanvasStore((state) => state.groupSelected);
  const ungroupSelected = useCanvasStore((state) => state.ungroupSelected);
  const saveHistory = useCanvasStore((state) => state.saveHistory);
  const setActiveEdgeId = useCanvasStore((state) => state.setActiveEdgeId);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const imagePreviewUrl = useCanvasStore((state) => state.imagePreviewUrl);
  const setImagePreviewUrl = useCanvasStore((state) => state.setImagePreviewUrl);
  const displayScale = useDisplayScale();

  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)), [nodes]);
  const visibleEdges = useMemo(() => (showAutoImageLinks ? edges : edges.filter((edge) => !isAutoMentionImageEdge(edge))), [edges, showAutoImageLinks]);
  const promptEditorNode = useMemo(
    () => promptEditor ? nodes.find((node) => node.id === promptEditor.nodeId && node.data.kind === "prompt") : undefined,
    [nodes, promptEditor]
  );
  const readableZoomFloor = getReadableZoomFloor(displayScale);

  const toCanvasPosition = useCallback((point: { x: number; y: number }) => {
    if (!flowRef.current) return point;
    return flowRef.current.screenToFlowPosition(point);
  }, []);

  const getCursorPasteOffset = useCallback(() => {
    const pointer = lastCanvasPointerRef.current;
    const copiedNodes = copiedNodesRef.current;
    if (!pointer || !copiedNodes.length) return undefined;
    const minX = Math.min(...copiedNodes.map((node) => node.position.x));
    const minY = Math.min(...copiedNodes.map((node) => node.position.y));
    return {
      x: pointer.x - minX,
      y: pointer.y - minY
    };
  }, []);

  const openPromptEditor = useCallback(
    (node: Node<CanvasNodeData>) => {
      const wrapperBounds = wrapperRef.current?.getBoundingClientRect();
      if (!wrapperBounds) return;
      const prompt = typeof node.data.prompt === "string" ? node.data.prompt.trim() : "";
      if (!prompt) return;

      const nodeX = node.position.x * viewport.zoom + viewport.x;
      const nodeY = node.position.y * viewport.zoom + viewport.y;
      const nodeWidth = getNodeWidth(node) * viewport.zoom;
      const nodeHeight = getNodeHeight(node) * viewport.zoom;
      const sourceRight = nodeX + nodeWidth;
      const maxWidth = Math.max(promptEditorMinWidth, wrapperBounds.width - promptEditorMargin * 2);
      const maxHeight = Math.max(promptEditorMinHeight, wrapperBounds.height - promptEditorMargin * 2);
      const lineCount = Math.max(1, prompt.split(/\r?\n/).length);
      const idealHeight = Math.min(maxHeight, Math.max(360, Math.min(680, lineCount * 28 + 148)));
      const rightSpace = wrapperBounds.width - sourceRight - promptEditorMargin * 2;
      const idealWidth = Math.min(maxWidth, Math.max(520, Math.min(820, rightSpace)));
      const canFitRight = rightSpace >= promptEditorMinWidth;
      const x = canFitRight ? sourceRight + promptEditorMargin : (wrapperBounds.width - idealWidth) / 2;
      const y = Math.min(nodeY + Math.max(0, (nodeHeight - idealHeight) / 2), wrapperBounds.height - idealHeight - promptEditorMargin);

      setPromptEditor(clampPromptEditorPanel({
        height: idealHeight,
        nodeId: node.id,
        width: idealWidth,
        x,
        y
      }, wrapperBounds));
      closeAddMenu();
      setContextMenu(null);
      setImagePreviewUrl(null);
      setActiveEdgeId(null);
    },
    [closeAddMenu, setActiveEdgeId, setImagePreviewUrl, viewport]
  );

  useEffect(() => {
    const onOpenPromptEditor = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (!nodeId) return;
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId && item.data.kind === "prompt");
      if (!node) return;
      openPromptEditor(node);
    };
    window.addEventListener(openPromptEditorEvent, onOpenPromptEditor);
    return () => window.removeEventListener(openPromptEditorEvent, onOpenPromptEditor);
  }, [openPromptEditor]);

  const persistWorkspace = useCallback((options?: { beacon?: boolean; localOnly?: boolean }) => {
    if (!workspaceHydrated) return;
    const workspace = createWorkspaceSnapshot();
    const serializedWorkspace = JSON.stringify(workspace);
    latestSerializedWorkspaceRef.current = serializedWorkspace;
    try {
      if (serializedWorkspace.length <= localStorageWorkspaceLimit) {
        window.localStorage.setItem(workspaceStorageKey, serializedWorkspace);
      } else {
        window.localStorage.removeItem(workspaceStorageKey);
      }
    } catch {
      // localStorage can be unavailable in private or restricted browser contexts.
    }

    if (options?.localOnly) return;

    if (options?.beacon && typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon("/api/canvas/workspace", new Blob([serializedWorkspace], { type: "application/json" }));
      if (sent) return;
    }

    void fetch("/api/canvas/workspace", {
      body: serializedWorkspace,
      headers: { "Content-Type": "application/json" },
      keepalive: options?.beacon,
      method: "POST"
    }).catch(() => {
      // Browser local storage remains the immediate fallback.
    });
  }, [createWorkspaceSnapshot, workspaceHydrated]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const normalizedConnection = normalizeConnectionDirection(connection, nodes);
      if (!normalizedConnection) return;
      if (!isSameColorConnection(normalizedConnection.sourceHandle, normalizedConnection.targetHandle)) return;
      if (connectionTouchesRunningLockingNode(normalizedConnection, nodes)) return;
      const sourceNode = nodes.find((node) => node.id === normalizedConnection.source);
      const targetNode = nodes.find((node) => node.id === normalizedConnection.target);
      const sourcePortType = getHandlePortType(normalizedConnection.sourceHandle);
      if (!targetNode) return;
      const targetHandle = getInputHandleForPortType(targetNode, sourcePortType);
      if (!targetHandle) return;
      const sourceNodes = sourceNode?.selected
        ? nodes.filter((node) => node.selected)
        : sourceNode
          ? [sourceNode]
          : [];
      const nextEdges = sourceNodes.reduce<Edge[]>((currentEdges, node, index) => {
        const sourceHandle = getOutputHandleForPortType(node, sourcePortType);
        if (!sourceHandle || node.id === normalizedConnection.target) return currentEdges;
        const nextConnection: Edge = {
          id: `edge-${Date.now()}-${index}`,
          source: node.id,
          sourceHandle,
          target: normalizedConnection.target,
          targetHandle,
          type: "deletable",
          data: { motionState: "connected", portType: sourcePortType }
        };
        if (!isSameColorConnection(nextConnection.sourceHandle, nextConnection.targetHandle)) return currentEdges;
        if (connectionTouchesRunningLockingNode(nextConnection, nodes)) return currentEdges;
        if (hasSameConnection(currentEdges, nextConnection)) return currentEdges;
        return addEdge(nextConnection, currentEdges);
      }, edges);
      if (nextEdges === edges) return;
      setEdges(
        nextEdges,
        { record: true }
      );
    },
    [edges, nodes, setEdges]
  );

  useEffect(() => {
    const animatedNodeIds = nodes
      .filter((node) => node.data.motionState === "entering" || node.data.motionState === "duplicating")
      .map((node) => node.id);
    const animatedEdgeIds = edges
      .filter((edge) => edge.data?.motionState === "connected")
      .map((edge) => edge.id);
    if (!animatedNodeIds.length && !animatedEdgeIds.length) return;

    const timer = window.setTimeout(() => {
      const state = useCanvasStore.getState();
      if (animatedNodeIds.length) {
        state.setNodes(state.nodes.map((node) => (
          animatedNodeIds.includes(node.id)
            ? { ...node, data: { ...node.data, motionState: undefined } }
            : node
        )));
      }
      if (animatedEdgeIds.length) {
        state.setEdges(state.edges.map((edge) => (
          animatedEdgeIds.includes(edge.id)
            ? { ...edge, data: { ...(edge.data ?? {}), motionState: undefined } }
            : edge
        )));
      }
    }, 420);

    return () => window.clearTimeout(timer);
  }, [edges, nodes, setEdges, setNodes]);

  const findEmptyImageNodeAtPoint = useCallback(
    (canvasPoint: { x: number; y: number }) => {
      return [...nodes]
        .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
        .find((node) => {
          if (node.data.kind !== "image" || node.data.imageUrl) return false;
          const width = getNodeWidth(node);
          const height = getNodeHeight(node);
          return canvasPoint.x >= node.position.x && canvasPoint.x <= node.position.x + width && canvasPoint.y >= node.position.y && canvasPoint.y <= node.position.y + height;
        });
    },
    [nodes]
  );

  const getSingleSelectedEmptyImageNode = useCallback(() => {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length !== 1) return undefined;
    const [node] = selected;
    return node.data.kind === "image" && !node.data.imageUrl ? node : undefined;
  }, [nodes]);

  const addImageFiles = useCallback(
    (files: File[], screenPoint: { x: number; y: number }, options?: { mode?: "drop" | "paste" }) => {
      const imageFiles = files.filter((file) => ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.type));
      if (!imageFiles.length) return;

      const canvasPoint = toCanvasPosition(screenPoint);
      const fillTargetId = options?.mode === "paste" ? getSingleSelectedEmptyImageNode()?.id : findEmptyImageNodeAtPoint(canvasPoint)?.id;

      files
        .filter((file) => ["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(file.type))
        .forEach((file, index) => {
          const reader = new FileReader();
          reader.onload = () => {
            const imageUrl = String(reader.result);
            if (index === 0 && fillTargetId) {
              updateNodeData(fillTargetId, { imageUrl, runState: "idle" }, { record: true });
              return;
            }
            const offsetIndex = fillTargetId ? index - 1 : index;
            addNode("image", { x: canvasPoint.x + offsetIndex * 34, y: canvasPoint.y + offsetIndex * 34 }, { imageUrl });
          };
          reader.readAsDataURL(file);
        });
    },
    [addNode, findEmptyImageNodeAtPoint, getSingleSelectedEmptyImageNode, toCanvasPosition, updateNodeData]
  );

  useEffect(() => {
    let active = true;
    const hydrateSavedWorkspace = async () => {
      let fileWorkspace: CanvasWorkspaceSnapshot | null = null;
      let browserWorkspace: CanvasWorkspaceSnapshot | null = null;
      let fileRequestFailed = false;
      let fileMissing = false;
      try {
        const response = await fetch("/api/canvas/workspace", { cache: "no-store" });
        if (response.ok) {
          fileWorkspace = (await response.json()) as CanvasWorkspaceSnapshot;
        } else {
          let errorMessage = "";
          try {
            const payload = (await response.json()) as { error?: string };
            errorMessage = typeof payload.error === "string" ? payload.error : "";
          } catch {
            // A non-JSON 404 can happen briefly during dev hot reload; do not treat it as an empty workspace.
          }
          fileMissing = response.status === 404 && errorMessage === "还没有保存工作区。";
          fileRequestFailed = !fileMissing;
        }
      } catch {
        fileRequestFailed = true;
      }

      try {
        const saved = window.localStorage.getItem(workspaceStorageKey);
        if (saved) {
          browserWorkspace = JSON.parse(saved) as CanvasWorkspaceSnapshot;
        }
      } catch {
        window.localStorage.removeItem(workspaceStorageKey);
      }

      if (!active) return;
      const latestWorkspace = fileWorkspace && browserWorkspace && fileWorkspace.nodes.length > 0 && browserWorkspace.nodes.length === 0
        ? fileWorkspace
        : fileWorkspace && browserWorkspace && !isInitialExampleWorkspace(fileWorkspace) && isInitialExampleWorkspace(browserWorkspace)
          ? fileWorkspace
          : getLatestWorkspace([fileWorkspace, browserWorkspace]);
      if (latestWorkspace) {
        restoredFromSavedRef.current = true;
        hydrateWorkspace(latestWorkspace);
        return;
      }
      if (fileRequestFailed && !fileMissing) return;
      hydrateWorkspace(null);
    };

    hydrateSavedWorkspace();
    return () => {
      active = false;
    };
  }, [hydrateWorkspace]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    if (nodes.some((node) => isRunningLockingNode(node))) return;
    persistWorkspace({ localOnly: true });
    const saveTimer = window.setTimeout(() => {
      persistWorkspace();
    }, 150);
    return () => window.clearTimeout(saveTimer);
  }, [activeEdgeId, edges, globalZIndex, gridEnabled, nodes, persistWorkspace, projectTitle, showAutoImageLinks, viewport, workspaceHydrated]);

  useEffect(() => {
    if (!promptEditor) return;
    const nodeStillExists = nodes.some((node) => node.id === promptEditor.nodeId && node.data.kind === "prompt");
    if (!nodeStillExists) setPromptEditor(null);
  }, [nodes, promptEditor]);

  useEffect(() => {
    const onResize = () => {
      const bounds = wrapperRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setPromptEditor((current) => current ? clampPromptEditorPanel(current, bounds) : current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const saveBeforeLeaving = () => persistWorkspace({ beacon: true });
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") persistWorkspace({ beacon: true });
    };
    window.addEventListener("pagehide", saveBeforeLeaving);
    window.addEventListener("beforeunload", saveBeforeLeaving);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
      window.removeEventListener("beforeunload", saveBeforeLeaving);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [persistWorkspace, workspaceHydrated]);

  useEffect(() => {
    if (viewportInitializedRef.current || !nodes.length || !flowRef.current) return;
    viewportInitializedRef.current = true;
    window.requestAnimationFrame(() => {
      flowRef.current?.fitView({ duration: 0, maxZoom: Math.max(1, displayScale), padding: 0.2 });
      setZoom(flowRef.current?.getZoom() ?? initialViewport.zoom);
    });
  }, [displayScale, nodes.length, setZoom]);

  useEffect(() => {
    if (!workspaceHydrated || !restoredFromSavedRef.current || !flowRef.current) return;
    if (savedViewportAppliedRef.current) return;
    savedViewportAppliedRef.current = true;
    window.requestAnimationFrame(() => {
      const readableViewport = readableZoomFloor && viewport.zoom < readableZoomFloor
        ? { ...viewport, zoom: readableZoomFloor }
        : viewport;
      flowRef.current?.setViewport(readableViewport, { duration: 0 });
      setViewport(readableViewport);
    });
  }, [readableZoomFloor, setViewport, viewport, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated || !workspaceRevision || !flowRef.current || !nodes.length) return;
    window.requestAnimationFrame(() => {
      const instance = flowRef.current;
      if (!instance) return;
      instance.fitView({ duration: 0, maxZoom: Math.max(1, displayScale), padding: 0.2 });
      setViewport(instance.getViewport());
    });
  // workspaceRevision intentionally limits this to project loads, not ordinary canvas movement.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRevision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return;
      if (isTextEditingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const selectedNodes = nodes.filter((node) => node.selected);
        if (selectedNodes.length) {
          event.preventDefault();
          copiedNodesRef.current = selectedNodes.map((node) => ({
            ...node,
            data: { ...node.data },
            position: { ...node.position },
            selected: false
          }));
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        if (copiedNodesRef.current.length) {
          event.preventDefault();
          pasteNodes(copiedNodesRef.current, getCursorPasteOffset());
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) {
          ungroupSelected();
        } else {
          groupSelected();
        }
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      }
      if (event.key === "Escape") {
        setPromptEditor(null);
        setNodes(nodes.map((node) => ({ ...node, selected: false })));
        setEdges(edges.map((edge) => ({ ...edge, selected: false })));
        setActiveEdgeId(null);
        setImagePreviewUrl(null);
        closeAddMenu();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextEditingTarget(event.target)) return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (files.length) addImageFiles(files, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, { mode: "paste" });
    };
    const stopMiddlePanning = () => setMiddlePanning(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    window.addEventListener("mouseup", stopMiddlePanning);
    window.addEventListener("pointerup", stopMiddlePanning);
    window.addEventListener("blur", stopMiddlePanning);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("mouseup", stopMiddlePanning);
      window.removeEventListener("pointerup", stopMiddlePanning);
      window.removeEventListener("blur", stopMiddlePanning);
    };
  }, [addImageFiles, closeAddMenu, deleteSelected, duplicateSelected, edges, getCursorPasteOffset, groupSelected, nodes, pasteNodes, redo, setActiveEdgeId, setEdges, setImagePreviewUrl, setNodes, undo, ungroupSelected]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CanvasNodeData>>[]) => {
      const dragCopy = dragCopyRef.current;
      const effectiveChanges = dragCopy
        ? changes
            .map((change) => {
              if (!("id" in change)) return change;
              const copyId = dragCopy.idMap[change.id];
              return copyId ? { ...change, id: copyId } as NodeChange<Node<CanvasNodeData>> : change;
            })
        : changes;
      const movedGroups = effectiveChanges
        .filter(isPositionChange)
        .map((change) => {
          const group = nodes.find((node) => node.id === change.id && node.data.kind === "group");
          if (!group || !change.position) return null;
          return {
            id: group.id,
            dx: change.position.x - group.position.x,
            dy: change.position.y - group.position.y,
            memberIds: getGroupMemberIds(group)
          };
        })
        .filter((group): group is { id: string; dx: number; dy: number; memberIds: string[] } => Boolean(group));

      let nextNodes = applyNodeChanges(effectiveChanges, nodes);
      if (movedGroups.length) {
        const offsets = new Map<string, { dx: number; dy: number }>();
        movedGroups.forEach((group) => {
          group.memberIds.forEach((id) => {
            const current = offsets.get(id) ?? { dx: 0, dy: 0 };
            offsets.set(id, { dx: current.dx + group.dx, dy: current.dy + group.dy });
          });
        });
        nextNodes = nextNodes.map((node) => {
          const offset = offsets.get(node.id);
          if (!offset) return node;
          return { ...node, position: { x: node.position.x + offset.dx, y: node.position.y + offset.dy } };
        });
      }
      setNodes(resizeGroupsToMembers(nextNodes));
    },
    [nodes, setNodes]
  );

  return (
    <div
      className={`absolute inset-0 ${middlePanning ? "canvas-middle-panning" : ""} ${connectingPortType ? `canvas-connecting canvas-connecting-${connectingPortType}` : ""}`}
      onDoubleClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains("react-flow__pane")) return;
        event.preventDefault();
        setActiveEdgeId(null);
        openAddMenu({ x: event.clientX, y: event.clientY });
        window.requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
      }}
      onMouseDownCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest("[data-image-preview='true']")) return;
        if (event.button !== 1) return;
        event.preventDefault();
        setMiddlePanning(true);
      }}
      onMouseUpCapture={(event) => {
        if (event.button === 1) setMiddlePanning(false);
      }}
      onMouseLeave={() => {
        lastCanvasPointerRef.current = null;
      }}
      onMouseMoveCapture={(event) => {
        const bounds = wrapperRef.current?.getBoundingClientRect();
        if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
          lastCanvasPointerRef.current = toCanvasPosition({ x: event.clientX, y: event.clientY });
        } else {
          lastCanvasPointerRef.current = null;
        }
        if (middlePanning && (event.buttons & 4) === 0) setMiddlePanning(false);
      }}
      ref={wrapperRef}
      style={{ position: "absolute", inset: 0, zIndex: 0 }}
    >
      <ReactFlow
        className="bg-canvas"
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        edges={visibleEdges}
        edgeTypes={edgeTypes}
        isValidConnection={(connection) => (
          isSameColorConnection(connection.sourceHandle, connection.targetHandle) &&
          !connectionTouchesRunningLockingNode(connection, nodes)
        )}
        maxZoom={4}
        minZoom={0.1}
        multiSelectionKeyCode="Shift"
        nodeTypes={nodeTypes}
        nodes={sortedNodes}
        viewport={viewport}
        onConnect={onConnect}
        onConnectEnd={() => setConnectingPortType(null)}
        onConnectStart={(_, params) => {
          setConnectingPortType(getHandlePortType(params.handleId));
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          addImageFiles(Array.from(event.dataTransfer.files), { x: event.clientX, y: event.clientY }, { mode: "drop" });
        }}
        onEdgesChange={(changes) => {
          const unlockedChanges = changes.filter((change) => {
            if (!isRemoveEdgeChange(change)) return true;
            const edge = edges.find((item) => item.id === change.id);
            return !edgeTouchesRunningLockingNode(edge, nodes);
          });
          setEdges(applyEdgeChanges(unlockedChanges, edges));
        }}
        onEdgeClick={(event, edge) => {
          event.stopPropagation();
          setContextMenu(null);
          setImagePreviewUrl(null);
          setActiveEdgeId(edge.id);
        }}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          setImagePreviewUrl(null);
          setActiveEdgeId(edge.id);
          setEdges(edges.map((item) => ({ ...item, selected: item.id === edge.id })));
          setContextMenu({ edgeId: edge.id, type: "edge", x: event.clientX, y: event.clientY });
        }}
        onInit={(instance) => {
          flowRef.current = instance;
          viewportInitializedRef.current = true;
          window.requestAnimationFrame(() => {
            if (restoredFromSavedRef.current) {
              savedViewportAppliedRef.current = true;
              instance.setViewport(viewport, { duration: 0 });
              setViewport(viewport);
            } else {
              instance.fitView({ duration: 0, maxZoom: 1, padding: 0.2 });
              setViewport(instance.getViewport());
            }
            setZoom(instance.getZoom());
          });
        }}
        onMove={(_, nextViewport) => setViewport(nextViewport)}
        onNodeClick={(event, node) => {
          setContextMenu(null);
          setActiveEdgeId(null);
          setImagePreviewUrl(null);
          if (event.shiftKey) {
            const clickedNodeId = node.id;
            const selectedBeforeClick = new Set(nodes.filter((item) => item.selected).map((item) => item.id));
            const clickedWasSelected = selectedBeforeClick.has(clickedNodeId);
            window.requestAnimationFrame(() => {
              const state = useCanvasStore.getState();
              state.setNodes(state.nodes.map((item) => (
                item.id === clickedNodeId
                  ? { ...item, selected: !clickedWasSelected }
                  : { ...item, selected: selectedBeforeClick.has(item.id) }
              )));
              state.setEdges(state.edges.map((edge) => ({ ...edge, selected: false })));
            });
            return;
          }
          window.requestAnimationFrame(() => {
            const state = useCanvasStore.getState();
            state.setNodes(state.nodes.map((item) => ({ ...item, selected: item.id === node.id })));
            state.setEdges(state.edges.map((edge) => ({ ...edge, selected: false })));
          });
          if (node.data.kind === "group") return;
          bringNodesToFront([node.id]);
        }}
        onNodeDoubleClick={(event, node) => {
          const target = event.target;
          const clickedTitle = target instanceof HTMLElement && Boolean(target.closest("[data-prompt-title-region='true']"));
          const currentNode = nodes.find((item) => item.id === node.id);
          if (node.data.kind !== "prompt" || !currentNode?.selected || !clickedTitle || !node.data.prompt?.trim()) return;
          event.preventDefault();
          event.stopPropagation();
          openPromptEditor(node);
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          event.stopPropagation();
          setActiveEdgeId(null);
          setImagePreviewUrl(null);
          closeAddMenu();
          if (!node.selected) {
            setNodes(nodes.map((item) => ({ ...item, selected: item.id === node.id })));
            setEdges(edges.map((edge) => ({ ...edge, selected: false })));
          }
          setContextMenu({ nodeId: node.id, type: "node", x: event.clientX, y: event.clientY });
        }}
        onNodeDragStart={(event, node) => {
          saveHistory();
          const selectedForDrag = node.selected
            ? nodes.filter((item) => item.selected)
            : [node];
          if (hasCopyModifier(event)) {
            const { copiedNodes, idMap } = makeDragCopiedNodes(selectedForDrag, nodes, globalZIndex);
            dragCopyRef.current = { idMap };
            setNodes([
              ...nodes.map((item) => ({ ...item, selected: false })),
              ...copiedNodes
            ]);
            setEdges(edges.map((edge) => ({ ...edge, selected: false })));
            bringNodesToFront(copiedNodes.map((item) => item.id));
            return;
          }
          dragCopyRef.current = null;
          if (node.data.kind === "group") return;
          const selectedIds = nodes.filter((item) => item.selected).map((item) => item.id);
          bringNodesToFront(selectedIds.length ? selectedIds : [node.id]);
        }}
        onNodeDragStop={() => {
          dragCopyRef.current = null;
        }}
        onNodesChange={onNodesChange}
        onPaneClick={() => {
          setContextMenu(null);
          setActiveEdgeId(null);
          setImagePreviewUrl(null);
          closeAddMenu();
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setContextMenu(null);
          setActiveEdgeId(null);
          openAddMenu({ x: event.clientX, y: event.clientY });
        }}
        onSelectionStart={(event) => {
          setActiveEdgeId(null);
          if (event.shiftKey) return;
          setNodes(nodes.map((node) => ({ ...node, selected: false })));
          setEdges(edges.map((edge) => ({ ...edge, selected: false })));
        }}
        onlyRenderVisibleElements
        panOnDrag={[1, 2]}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        proOptions={{ hideAttribution: true }}
        selectionMode={SelectionMode.Full}
        selectionOnDrag
        snapGrid={[32, 32]}
        snapToGrid={gridEnabled}
        zoomOnDoubleClick={false}
        zoomOnPinch
        zoomActivationKeyCode={["Meta", "Control"]}
        zoomOnScroll
      >
        {gridEnabled ? <Background color="#D6DBE6" gap={32} size={1.5} variant={BackgroundVariant.Dots} /> : null}
      </ReactFlow>
      <SelectionToolbar />
      <CanvasContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      {promptEditor && promptEditorNode ? (
        <PromptFloatingEditor
          nodeId={promptEditorNode.id}
          onBeginEdit={saveHistory}
          onChangePrompt={(next) => updateNodeData(promptEditorNode.id, { prompt: next })}
          onChangeRichHtml={(next) => updateNodeData(promptEditorNode.id, { promptRichHtml: next })}
          onClose={() => setPromptEditor(null)}
          onPanelChange={setPromptEditor}
          panel={promptEditor}
          prompt={promptEditorNode.data.prompt ?? ""}
          richHtml={typeof promptEditorNode.data.promptRichHtml === "string" ? promptEditorNode.data.promptRichHtml : buildVisibleTextPromptRichHtml(promptEditorNode.data.prompt ?? "")}
          wrapperRef={wrapperRef}
        />
      ) : null}
      {imagePreviewUrl ? (
        <ImageAnnotationEditor
          imageUrl={imagePreviewUrl}
          onClose={() => setImagePreviewUrl(null)}
          onSend={(annotatedImageUrl) => {
            const sourceNode = nodes.find((node) => node.selected && node.data.kind === "image" && node.data.imageUrl === imagePreviewUrl)
              ?? nodes.find((node) => node.data.kind === "image" && node.data.imageUrl === imagePreviewUrl);
            const fallback = toCanvasPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            addNode("image", sourceNode
              ? findNearbyAnnotatedImagePosition(sourceNode, nodes)
              : fallback, { imageUrl: annotatedImageUrl });
            setImagePreviewUrl(null);
          }}
        />
      ) : null}
      <AddNodePopover toCanvasPosition={toCanvasPosition} />
    </div>
  );
}

function PromptFloatingEditor({
  nodeId,
  onBeginEdit,
  onChangePrompt,
  onChangeRichHtml,
  onClose,
  onPanelChange,
  panel,
  prompt,
  richHtml,
  wrapperRef
}: {
  nodeId: string;
  onBeginEdit: () => void;
  onChangePrompt: (prompt: string) => void;
  onChangeRichHtml: (html: string) => void;
  onClose: () => void;
  onPanelChange: Dispatch<SetStateAction<PromptEditorState | null>>;
  panel: PromptEditorState;
  prompt: string;
  richHtml?: string;
  wrapperRef: RefObject<HTMLDivElement>;
}) {
  const [draft, setDraft] = useState(prompt);
  const nodes = useCanvasStore((state) => state.nodes);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedTextColor, setSelectedTextColor] = useState(promptEditorDefaultTextColor);
  const [copied, setCopied] = useState(false);
  const imageMentions = useMemo<ImageMentionOption[]>(() =>
    nodes
      .filter((node) => node.data.kind === "image" && typeof node.data.imageNumber === "number")
      .map((node) => ({
        id: node.id,
        imageNumber: node.data.imageNumber as number,
        imageUrl: typeof node.data.imageUrl === "string" ? node.data.imageUrl : undefined,
        label: `Image ${String(node.data.imageNumber as number).padStart(3, "0")}`
      }))
      .sort((a, b) => a.imageNumber - b.imageNumber),
    [nodes]
  );
  const filteredMentions = useMemo(() => (
    mentionQuery === null
      ? []
      : imageMentions.filter((image) => image.label.toLowerCase().includes(mentionQuery.trim().toLowerCase()))
  ), [imageMentions, mentionQuery]);
  const composingRef = useRef(false);
  const editHistorySavedRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const mentionOptionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelRef = useRef(panel);
  const savedSelectionRef = useRef<Range | null>(null);
  const interactionRef = useRef<{
    handle?: PromptEditorResizeHandle;
    height: number;
    mode: "drag" | "resize";
    pointerX: number;
    pointerY: number;
    width: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (composingRef.current) return;
    const editor = editorRef.current;
    if (!editor) {
      setDraft(prompt);
      return;
    }
    const currentText = editor.innerText.replace(/\n$/, "");
    if (currentText === prompt) return;
    editor.innerHTML = richHtml ? sanitizePromptRichHtml(richHtml) : escapeHtml(prompt).replace(/\n/g, "<br>");
    setDraft(prompt);
  }, [prompt, richHtml]);

  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  useEffect(() => {
    editHistorySavedRef.current = false;
  }, [nodeId]);

  useEffect(() => {
    if (!filteredMentions.length) setMentionIndex(0);
    else setMentionIndex((current) => Math.min(current, filteredMentions.length - 1));
  }, [filteredMentions.length]);

  useEffect(() => {
    const activeMention = filteredMentions[mentionIndex];
    if (!activeMention) return;
    mentionOptionRefs.current[activeMention.id]?.scrollIntoView({ block: "nearest" });
  }, [filteredMentions, mentionIndex]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const syncEditorContent = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = editor.innerText.replace(/\n$/, "");
    setDraft(next);
    const sanitizedHtml = sanitizePromptRichHtml(editor.innerHTML);
    if (sanitizedHtml !== editor.innerHTML) editor.innerHTML = sanitizedHtml;
    onChangeRichHtml(sanitizedHtml);
    if (!composingRef.current) onChangePrompt(next);
  };

  const syncMentionState = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      setMentionQuery(null);
      mentionRangeRef.current = null;
      return;
    }

    const caretRange = selection.getRangeAt(0);
    if (!editor.contains(caretRange.commonAncestorContainer)) {
      setMentionQuery(null);
      mentionRangeRef.current = null;
      return;
    }

    const beforeCaretRange = caretRange.cloneRange();
    beforeCaretRange.selectNodeContents(editor);
    beforeCaretRange.setEnd(caretRange.endContainer, caretRange.endOffset);
    const beforeCaret = beforeCaretRange.toString();
    const match = beforeCaret.match(/(?:^|\s)@([A-Za-z0-9 ]{0,24})$/);

    if (!match) {
      setMentionQuery(null);
      mentionRangeRef.current = null;
      return;
    }

    const query = match[1] ?? "";
    const mentionStart = beforeCaret.length - query.length - 1;
    mentionRangeRef.current = getTextRangeByOffsets(editor, mentionStart, beforeCaret.length);
    setMentionQuery(query);
  };

  const selectMention = (image: ImageMentionOption) => {
    const editor = editorRef.current;
    const range = mentionRangeRef.current;
    if (!editor || !range) return;
    beginEdit();
    const selection = window.getSelection();
    range.deleteContents();
    const mentionText = document.createTextNode(`@${image.label} `);
    range.insertNode(mentionText);
    const nextRange = document.createRange();
    nextRange.setStartAfter(mentionText);
    nextRange.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(nextRange);
    mentionRangeRef.current = null;
    setMentionQuery(null);
    syncEditorContent();
    editor.focus();
  };

  const beginEdit = () => {
    if (editHistorySavedRef.current) return;
    editHistorySavedRef.current = true;
    onBeginEdit();
  };

  const copyPrompt = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = draft;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const clearPrompt = () => {
    if (!draft) return;
    beginEdit();
    if (editorRef.current) editorRef.current.innerHTML = "";
    setDraft("");
    onChangeRichHtml("");
    onChangePrompt("");
    setMentionQuery(null);
    mentionRangeRef.current = null;
  };

  const saveEditorSelection = () => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection || !editor || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    savedSelectionRef.current = range.cloneRange();
  };

  const restoreEditorSelection = () => {
    const selection = window.getSelection();
    const range = savedSelectionRef.current;
    if (!selection || !range) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return !selection.isCollapsed;
  };

  const applySelectedTextColor = (color: string) => {
    if (!restoreEditorSelection()) return;
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection || !editor || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    beginEdit();
    const span = document.createElement("span");
    span.style.color = color;
    span.appendChild(range.extractContents());
    range.insertNode(span);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(span);
    nextRange.collapse(false);
    selection.addRange(nextRange);
    savedSelectionRef.current = null;
    syncEditorContent();
    editorRef.current?.focus();
  };

  const startPanelInteraction = (event: ReactPointerEvent<HTMLElement>, mode: "drag" | "resize", handle?: PromptEditorResizeHandle) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      handle,
      height: panel.height,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: panel.width,
      x: panel.x,
      y: panel.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startPanelMouseInteraction = (event: ReactMouseEvent<HTMLElement>, mode: "drag" | "resize", handle?: PromptEditorResizeHandle) => {
    if (event.button !== 0 || interactionRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      handle,
      height: panel.height,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: panel.width,
      x: panel.x,
      y: panel.y
    };
  };

  const movePanelInteraction = (clientX: number, clientY: number) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const dx = clientX - interaction.pointerX;
    const dy = clientY - interaction.pointerY;

    if (interaction.mode === "drag") {
      onPanelChange((current) => current ? clampPromptEditorPanel({
        ...current,
        x: interaction.x + dx,
        y: interaction.y + dy
      }, bounds) : current);
      return;
    }

    const handle = interaction.handle ?? "se";
    const movesWest = handle.includes("w");
    const movesNorth = handle.includes("n");
    const nextWidth = interaction.width + (movesWest ? -dx : handle.includes("e") ? dx : 0);
    const nextHeight = interaction.height + (movesNorth ? -dy : handle.includes("s") ? dy : 0);
    const currentPanel = panelRef.current;
    const clampedSize = clampPromptEditorPanel({
      ...currentPanel,
      height: nextHeight,
      width: nextWidth,
      x: movesWest ? interaction.x + interaction.width - Math.max(promptEditorMinWidth, nextWidth) : interaction.x,
      y: movesNorth ? interaction.y + interaction.height - Math.max(promptEditorMinHeight, nextHeight) : interaction.y
    }, bounds);
    onPanelChange((current) => current ? { ...clampedSize, nodeId: current.nodeId } : current);
  };

  const updatePanelInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    event.preventDefault();
    event.stopPropagation();
    movePanelInteraction(event.clientX, event.clientY);
  };

  const stopPanelInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    if (!interactionRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = null;
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!interactionRef.current) return;
      event.preventDefault();
      movePanelInteraction(event.clientX, event.clientY);
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!interactionRef.current) return;
      event.preventDefault();
      movePanelInteraction(event.clientX, event.clientY);
    };
    const stop = (event: Event) => {
      if (!interactionRef.current) return;
      event.preventDefault();
      interactionRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stop);
    };
  });

  const resizeHandles: Array<{ className: string; cursor: string; handle: PromptEditorResizeHandle }> = [
    { className: "left-0 top-0 h-3 w-full", cursor: "ns-resize", handle: "n" },
    { className: "bottom-0 left-0 h-3 w-full", cursor: "ns-resize", handle: "s" },
    { className: "right-0 top-0 h-full w-3", cursor: "ew-resize", handle: "e" },
    { className: "left-0 top-0 h-full w-3", cursor: "ew-resize", handle: "w" },
    { className: "right-0 top-0 h-5 w-5", cursor: "nesw-resize", handle: "ne" },
    { className: "left-0 top-0 h-5 w-5", cursor: "nwse-resize", handle: "nw" },
    { className: "bottom-0 right-0 h-5 w-5", cursor: "nwse-resize", handle: "se" },
    { className: "bottom-0 left-0 h-5 w-5", cursor: "nesw-resize", handle: "sw" }
  ];
  return (
    <section
      aria-label="Prompt 编辑器"
      className="nodrag nopan nowheel absolute z-[70] flex flex-col overflow-hidden rounded-[14px] border border-[#D9DDE6] bg-white shadow-[0_18px_48px_rgba(15,23,42,0.14)]"
      onPointerMove={updatePanelInteraction}
      onPointerUp={stopPanelInteraction}
      style={{ height: panel.height, left: panel.x, top: panel.y, width: panel.width }}
    >
      <div
        className="flex h-12 shrink-0 cursor-grab items-center gap-3 border-b border-[#ECEFF5] px-4 active:cursor-grabbing"
        onMouseDown={(event) => startPanelMouseInteraction(event, "drag")}
        onPointerDown={(event) => startPanelInteraction(event, "drag")}
      >
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-primary">Prompt</h3>
        <div
          className="relative flex shrink-0 items-center gap-2"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            aria-label="字体颜色"
            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition hover:bg-[#F4F6FA] hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
              setColorMenuOpen((open) => !open);
            }}
            title="字体颜色"
            type="button"
          >
            <span className="text-[18px] font-bold leading-none" style={{ color: selectedTextColor }}>A</span>
          </button>
          <button
            aria-label={copied ? "已复制全文" : "复制全文"}
            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition hover:bg-[#F4F6FA] hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            disabled={!draft}
            onClick={(event) => {
              event.stopPropagation();
              void copyPrompt();
            }}
            title={copied ? "已复制全文" : "复制全文"}
            type="button"
          >
            <Copy size={17} strokeWidth={2.2} />
          </button>
          <button
            aria-label="清空全文"
            className="grid h-8 w-8 place-items-center rounded-full text-secondary transition hover:bg-[#FFF1F1] hover:text-danger disabled:cursor-not-allowed disabled:opacity-35"
            disabled={!draft}
            onClick={(event) => {
              event.stopPropagation();
              clearPrompt();
              setColorMenuOpen(false);
            }}
            title="清空全文"
            type="button"
          >
            <Trash2 size={17} strokeWidth={2.2} />
          </button>
          {colorMenuOpen ? (
            <div
              className="absolute right-0 top-10 z-[80] grid w-[286px] grid-cols-8 gap-[10px] rounded-[10px] border border-[#D9DDE6] bg-white p-3 shadow-[0_14px_34px_rgba(15,23,42,0.16)]"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {promptEditorTextColors.map((color) => (
                <button
                  aria-label={`选择颜色 ${color}`}
                  className="h-6 w-6 rounded-[4px] border border-[#C8CCD4] transition hover:ring-2 hover:ring-[#D9DDE6]"
                  key={color}
                  onClick={(event) => {
                    event.preventDefault();
                    applySelectedTextColor(color);
                    setSelectedTextColor(color);
                    setColorMenuOpen(false);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  style={{ backgroundColor: color }}
                  title={color}
                  type="button"
                />
              ))}
            </div>
          ) : null}
        </div>
        <button
          aria-label="关闭"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition hover:bg-[#F4F6FA] hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <X size={17} strokeWidth={2.2} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          className="nodrag nopan nowheel h-full overflow-y-auto whitespace-pre-wrap border-0 bg-[#FFFDF8] p-5 text-[15px] leading-7 outline-none"
          contentEditable
          onBlur={() => {
            editHistorySavedRef.current = false;
            window.setTimeout(() => {
              setMentionQuery(null);
              mentionRangeRef.current = null;
            }, 120);
          }}
          onInput={() => {
            syncEditorContent();
            if (!composingRef.current) window.setTimeout(syncMentionState, 0);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncEditorContent();
            window.setTimeout(syncMentionState, 0);
            event.stopPropagation();
          }}
          onCompositionStart={(event) => {
            composingRef.current = true;
            event.stopPropagation();
          }}
          onCompositionUpdate={(event) => event.stopPropagation()}
          onFocus={() => {
            beginEdit();
            window.setTimeout(syncMentionState, 0);
          }}
          onKeyUp={() => {
            saveEditorSelection();
            syncMentionState();
          }}
          onKeyDown={(event) => {
            if (mentionQuery !== null && filteredMentions.length) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((current) => (current + 1) % filteredMentions.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex((current) => (current - 1 + filteredMentions.length) % filteredMentions.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                selectMention(filteredMentions[mentionIndex] ?? filteredMentions[0]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                mentionRangeRef.current = null;
                return;
              }
            }
            event.stopPropagation();
          }}
          onMouseUp={() => {
            saveEditorSelection();
            syncMentionState();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => {
            event.stopPropagation();
            window.setTimeout(() => {
              saveEditorSelection();
              syncMentionState();
            }, 0);
          }}
          onPaste={(event) => {
            event.preventDefault();
            document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
            syncEditorContent();
            window.setTimeout(syncMentionState, 0);
          }}
          ref={editorRef}
          onWheel={(event) => event.stopPropagation()}
          role="textbox"
          spellCheck={false}
          style={{ color: promptEditorDefaultTextColor }}
          suppressContentEditableWarning
        />
        {mentionQuery !== null && filteredMentions.length ? (
          <div
            className="nodrag nopan nowheel absolute left-5 top-4 z-[80] max-h-[240px] w-[240px] overflow-y-auto rounded-[12px] border border-[#D9DDE6] bg-white p-1 shadow-[0_14px_34px_rgba(15,23,42,0.16)]"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {filteredMentions.map((image, index) => (
              <button
                className={`flex h-10 w-full items-center gap-2 rounded-[9px] px-2 text-left text-[13px] font-semibold transition ${
                  index === mentionIndex ? "bg-selected text-white" : "text-primary hover:bg-[#F4F6FA]"
                }`}
                key={image.id}
                onClick={() => selectMention(image)}
                ref={(element) => {
                  mentionOptionRefs.current[image.id] = element;
                }}
                type="button"
              >
                <span className={`grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[7px] border ${
                  index === mentionIndex ? "border-white/45 bg-white/15" : "border-[#E3E7EF] bg-[#F5F6FA]"
                }`}>
                  {image.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" className="h-full w-full object-cover" draggable={false} src={image.imageUrl} />
                  ) : (
                    <span className={index === mentionIndex ? "text-[10px] text-white/85" : "text-[10px] text-secondary"}>空</span>
                  )}
                </span>
                <span>{image.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {resizeHandles.map((item) => (
        <span
          aria-hidden="true"
          className={`absolute ${item.className}`}
          key={item.handle}
          onMouseDown={(event) => startPanelMouseInteraction(event, "resize", item.handle)}
          onPointerDown={(event) => startPanelInteraction(event, "resize", item.handle)}
          style={{ cursor: item.cursor }}
        />
      ))}
    </section>
  );
}
