import { create } from "zustand";
import type { Edge, Node, Viewport, XYPosition } from "@xyflow/react";
import { getClientAiSettingsPayload } from "@/lib/clientAiSettings";
import { defaultIndustrialDesignImageModelId, defaultProductRemixModelId, defaultSceneImageModelId, getDefaultIndustrialDesignImageParams, getDefaultProductRemixParams, getDefaultSceneImageParams, getReferenceImageLimit } from "@/lib/generateImageModels";
import { nodeLabels, type CanvasNodeData, type NodeKind } from "@/lib/nodeTypes";
import { nextZIndex } from "@/lib/zIndex";

const historyLimit = 10;
const outputNodeGap = 32;
const outputNodeColumnGap = 36;
const outputNodeInitialGap = 56;
const outputNodeWidth = 320;
const imageNodeHeight = 260;
const promptNodeHeight = 260;
const generatedOutputRows = 2;
const maxImageNumber = 100;
const maxReferenceImageInputs = 12;
const maxTaobaoPlannerImageInputs = 10;
const taobaoClientPreviewMaxEdge = 1400;
const generationControllers = new Map<string, AbortController>();
const deleteAnimationTimers = new Set<ReturnType<typeof setTimeout>>();
const defaultAiPromptModel = "gemini-2.5-flash";
const defaultSceneDirectorModel = "gemini-2.5-flash";
const defaultTaobaoPageDirectorModel = "gemini-2.5-flash";
const defaultIndustrialDesignerModel = "gemini-2.5-flash";
const defaultVisualDirectorModel = "gpt-image-2";
const defaultGridImageModel = "gpt-image-2";

function makeNode(id: string, kind: NodeKind, position: XYPosition, zIndex: number, extra?: Partial<CanvasNodeData>): Node<CanvasNodeData> {
  return {
    id,
    type: kind === "group" ? "groupFrame" : kind,
    position,
    zIndex,
    selected: Boolean(extra?.selected),
    data: {
      kind,
      title: nodeLabels[kind],
      zIndex,
      runState: "idle",
      ...extra
    }
  };
}

function isRunningLockingNode(node: Node<CanvasNodeData>) {
  return (node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director") && node.data.runState === "running";
}

function edgeTouchesRunningLockingNode(edge: Pick<Edge, "source" | "target">, nodes: Node<CanvasNodeData>[]) {
  return nodes.some((node) => (node.id === edge.source || node.id === edge.target) && isRunningLockingNode(node));
}

function getNextImageNumber(nodes: Node<CanvasNodeData>[], reserved = new Set<number>()) {
  const used = new Set(
    nodes
      .filter((node) => node.data.kind === "image")
      .map((node) => Number(node.data.imageNumber))
      .filter((number) => Number.isInteger(number) && number >= 1 && number <= maxImageNumber)
  );
  for (let number = 1; number <= maxImageNumber; number += 1) {
    if (!used.has(number) && !reserved.has(number)) return number;
  }
  return undefined;
}

function makeCopiedNodes(
  sourceNodes: Node<CanvasNodeData>[],
  baseNodes: Node<CanvasNodeData>[],
  startZIndex: number,
  offset: XYPosition
) {
  let zIndex = startZIndex;
  const reservedImageNumbers = new Set<number>();
  const idMap = new Map<string, string>();
  const copiedNodes: Node<CanvasNodeData>[] = [];
  const selectedSourceIds = new Set(sourceNodes.map((node) => node.id));

  sourceNodes.forEach((node, index) => {
    zIndex = nextZIndex(zIndex);
    const nextId = `${node.data.kind}-copy-${Date.now()}-${index}-${Math.round(Math.random() * 1000)}`;
    idMap.set(node.id, nextId);
    const nextData: CanvasNodeData = {
      ...node.data,
      errorMessage: undefined,
      generatedBy: undefined,
      generationId: undefined,
      runState: node.data.runState === "running" ? "idle" : node.data.runState,
      selected: true,
      zIndex
    };

    if (node.data.kind === "image") {
      const imageNumber = getNextImageNumber([...baseNodes, ...copiedNodes], reservedImageNumbers);
      if (imageNumber) {
        reservedImageNumbers.add(imageNumber);
        nextData.imageNumber = imageNumber;
      } else {
        delete nextData.imageNumber;
      }
    }

    copiedNodes.push({
      ...node,
      id: nextId,
      position: {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y
      },
      selected: true,
      zIndex,
      data: nextData
    });
  });

  return {
    copiedNodes: copiedNodes.map((node) => {
      if (node.data.kind !== "group") return node;
      const memberIds = Array.isArray(node.data.memberIds)
        ? node.data.memberIds
            .map((id) => typeof id === "string" && selectedSourceIds.has(id) ? idMap.get(id) : undefined)
            .filter((id): id is string => Boolean(id))
        : [];
      return { ...node, data: { ...node.data, memberIds } };
    }),
    zIndex
  };
}

function getNodeSize(node: Node<CanvasNodeData>) {
  const isIndustrialAiPrompt = node.data.kind === "imageChat" && node.data.modelParams?.module === "Industrial Design";
  return {
    height: Number(node.data.height ?? (node.data.kind === "taobaoPageDirector" ? 560 : node.data.kind === "sceneDirector" ? 760 : node.data.kind === "industrial_designer" ? 620 : node.data.kind === "visual_director" ? 400 : node.data.kind === "productRemix" ? 500 : node.data.kind === "rhinoTest" ? 420 : node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" ? 390 : node.data.kind === "generateImage" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "imageChat" ? isIndustrialAiPrompt ? 420 : 360 : 260)),
    width: Number(node.data.width ?? (node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" ? 620 : node.data.kind === "visual_director" || node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" ? 420 : 320))
  };
}

function rectsOverlap(
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

function findGeneratedOutputPositions(source: Node<CanvasNodeData>, nodes: Node<CanvasNodeData>[], outputCount: number) {
  const sourceSize = getNodeSize(source);
  const rows = Math.min(generatedOutputRows, outputCount);
  const groupHeight = rows * imageNodeHeight + (rows - 1) * outputNodeGap;
  const preferredY = source.position.y + (sourceSize.height - groupHeight) / 2;
  const generatedBySource = nodes.filter((node) => node.data.generatedBy === source.id);
  const rightOfSource = source.position.x + sourceSize.width + outputNodeInitialGap;
  const rightOfExistingGenerated = generatedBySource.length
    ? Math.max(...generatedBySource.map((node) => node.position.x + getNodeSize(node).width)) + outputNodeColumnGap
    : rightOfSource;
  const startX = Math.max(rightOfSource, rightOfExistingGenerated);
  const existingRects = nodes.map((node) => {
    const size = getNodeSize(node);
    return {
      height: size.height,
      width: size.width,
      x: node.position.x,
      y: node.position.y
    };
  });
  const yOffsets = [0, imageNodeHeight + outputNodeGap, -(imageNodeHeight + outputNodeGap), (imageNodeHeight + outputNodeGap) * 2, -(imageNodeHeight + outputNodeGap) * 2];

  for (let columnOffset = 0; columnOffset < 24; columnOffset += 1) {
    for (const yOffset of yOffsets) {
      const baseX = startX + columnOffset * (outputNodeWidth + outputNodeColumnGap);
      const baseY = preferredY + yOffset;
      const positions = Array.from({ length: outputCount }, (_, index) => {
        const column = Math.floor(index / rows);
        const row = index % rows;
        return {
          x: baseX + column * (outputNodeWidth + outputNodeColumnGap),
          y: baseY + row * (imageNodeHeight + outputNodeGap)
        };
      });
      const nextRects = positions.map((position) => ({
        height: imageNodeHeight,
        width: outputNodeWidth,
        x: position.x,
        y: position.y
      }));
      if (nextRects.every((rect) => existingRects.every((existing) => !rectsOverlap(rect, existing)))) {
        return positions;
      }
    }
  }

  return Array.from({ length: outputCount }, (_, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    return {
      x: startX + column * (outputNodeWidth + outputNodeColumnGap),
      y: preferredY + row * (imageNodeHeight + outputNodeGap)
    };
  });
}

function getConnectedGeneratedOutputIds(sourceId: string, nodes: Node<CanvasNodeData>[], edges: Edge[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return new Set(
    edges
      .filter((edge) => edge.source === sourceId)
      .map((edge) => nodeById.get(edge.target))
      .filter((node): node is Node<CanvasNodeData> => Boolean(node && node.data.generatedBy === sourceId))
      .map((node) => node.id)
  );
}

function removeConnectedGeneratedOutputs(state: CanvasState, sourceId: string) {
  const outputIds = getConnectedGeneratedOutputIds(sourceId, state.nodes, state.edges);
  if (!outputIds.size) {
    return {
      edges: state.edges,
      nodes: state.nodes
    };
  }
  return {
    edges: state.edges.filter((edge) => !outputIds.has(edge.source) && !outputIds.has(edge.target)),
    nodes: state.nodes.filter((node) => !outputIds.has(node.id))
  };
}

function findSingleOutputPosition(source: Node<CanvasNodeData>, nodes: Node<CanvasNodeData>[], size = { height: promptNodeHeight, width: outputNodeWidth }) {
  const sourceSize = getNodeSize(source);
  const startX = source.position.x + sourceSize.width + outputNodeInitialGap;
  const preferredY = source.position.y + (sourceSize.height - size.height) / 2;
  const existingRects = nodes.map((node) => {
    const nodeSize = getNodeSize(node);
    return {
      height: nodeSize.height,
      width: nodeSize.width,
      x: node.position.x,
      y: node.position.y
    };
  });
  const yOffsets = [0, size.height + outputNodeGap, -(size.height + outputNodeGap), (size.height + outputNodeGap) * 2, -(size.height + outputNodeGap) * 2];

  for (let columnOffset = 0; columnOffset < 24; columnOffset += 1) {
    for (const yOffset of yOffsets) {
      const rect = {
        height: size.height,
        width: size.width,
        x: startX + columnOffset * (size.width + outputNodeColumnGap),
        y: preferredY + yOffset
      };
      if (existingRects.every((existing) => !rectsOverlap(rect, existing))) {
        return { x: rect.x, y: rect.y };
      }
    }
  }

  return { x: startX, y: preferredY };
}

function withImageNumbers(nodes: Node<CanvasNodeData>[]) {
  const reserved = new Set<number>();
  return nodes.map((node) => {
    if (node.data.kind !== "image") return node;
    const current = Number(node.data.imageNumber);
    if (Number.isInteger(current) && current >= 1 && current <= maxImageNumber && !reserved.has(current)) {
      reserved.add(current);
      return node;
    }
    const imageNumber = getNextImageNumber(nodes, reserved);
    if (!imageNumber) return node;
    reserved.add(imageNumber);
    return { ...node, data: { ...node.data, imageNumber } };
  });
}

function parseImageMentionNumbers(text: string) {
  const numbers: number[] = [];
  const seen = new Set<number>();
  const mentionPattern = /(?:@(?:image\s*)?|<\s*image\s*)(\d{1,3})(?:\s*>)?/gi;
  for (const match of text.matchAll(mentionPattern)) {
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number < 1 || number > maxImageNumber || seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  return numbers;
}

function getPromptMentionedImageNodes(nodes: Node<CanvasNodeData>[], promptNodes: Node<CanvasNodeData>[]) {
  const imageByNumber = new Map<number, Node<CanvasNodeData>>();
  nodes.forEach((node) => {
    if (node.data.kind !== "image" || typeof node.data.imageNumber !== "number") return;
    imageByNumber.set(node.data.imageNumber, node);
  });

  const mentionedNodes: Node<CanvasNodeData>[] = [];
  const seenNodeIds = new Set<string>();
  promptNodes.forEach((node) => {
    const prompt = typeof node.data.prompt === "string" ? node.data.prompt : "";
    parseImageMentionNumbers(prompt).forEach((imageNumber) => {
      const imageNode = imageByNumber.get(imageNumber);
      if (!imageNode || seenNodeIds.has(imageNode.id)) return;
      seenNodeIds.add(imageNode.id);
      mentionedNodes.push(imageNode);
    });
  });
  return mentionedNodes;
}

function getTargetInputNodes(nodes: Node<CanvasNodeData>[], edges: Edge[], targetId: string) {
  return edges
    .filter((edge) => edge.target === targetId)
    .map((edge) => nodes.find((node) => node.id === edge.source))
    .filter((node): node is Node<CanvasNodeData> => Boolean(node));
}

function getTargetPromptInputNodes(nodes: Node<CanvasNodeData>[], edges: Edge[], targetId: string) {
  return edges
    .filter((edge) => edge.target === targetId && edge.targetHandle === "text-in")
    .map((edge) => nodes.find((node) => node.id === edge.source))
    .filter((node): node is Node<CanvasNodeData> => Boolean(node))
    .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim());
}

function syncMentionImageEdgesForTarget(targetId: string, nodes: Node<CanvasNodeData>[], edges: Edge[]) {
  const promptNodes = getTargetPromptInputNodes(nodes, edges, targetId);
  const mentionedImageNodes = getPromptMentionedImageNodes(nodes, promptNodes);
  return syncMentionImageEdges(targetId, mentionedImageNodes, edges);
}

function syncMentionImageEdgesForRunningTarget(targetId: string, generationId: string, getState: () => CanvasState, setState: (partial: CanvasState | Partial<CanvasState> | ((state: CanvasState) => CanvasState | Partial<CanvasState>)) => void) {
  const snapshot = getState();
  const syncedEdges = syncMentionImageEdgesForTarget(targetId, snapshot.nodes, snapshot.edges);
  if (!syncedEdges) return snapshot;
  const currentSource = snapshot.nodes.find((node) => node.id === targetId);
  if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return snapshot;
  setState({ activeEdgeId: null, edges: syncedEdges });
  return getState();
}

function getAgentInputNodesWithMentionedImages(nodes: Node<CanvasNodeData>[], edges: Edge[], targetId: string) {
  return uniqueNodesById(getTargetInputNodes(nodes, edges, targetId));
}

function uniqueNodesById(nodes: Node<CanvasNodeData>[]) {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function getReferenceImageNodes(inputNodes: Node<CanvasNodeData>[], limit = maxReferenceImageInputs) {
  return sortNodesVisually(uniqueNodesById(inputNodes).filter((node) => node.data.kind === "image" && node.data.imageUrl))
    .slice(0, limit);
}

function getRhinoPrimaryReferenceImage(inputEdges: Edge[], inputNodes: Node<CanvasNodeData>[], instruction = "") {
  const imageNodes = new Map(
    inputNodes
      .filter((node) => node.data.kind === "image" && node.data.imageUrl)
      .map((node) => [node.id, node])
  );
  const manualImageInputIds = inputEdges
    .filter((edge) => edge.targetHandle === "image-in" && !isAutoMentionImageEdge(edge))
    .map((edge) => edge.source);
  const manualImages = manualImageInputIds
    .map((nodeId) => imageNodes.get(nodeId))
    .filter((node): node is Node<CanvasNodeData> => Boolean(node));
  const manualByImageNumber = new Map<number, Node<CanvasNodeData>>();
  manualImages.forEach((node) => {
    if (typeof node.data.imageNumber === "number") manualByImageNumber.set(node.data.imageNumber, node);
  });
  const roleLines = instruction
    .split(/\n|。|；|;/)
    .map((line) => line.trim())
    .filter(Boolean);
  const primaryRolePattern = /主图|产品主图|主体图|输入图|原图|rhino|锁定|产品源图|main product/i;
  for (const line of roleLines) {
    if (!primaryRolePattern.test(line)) continue;
    for (const imageNumber of parseImageMentionNumbers(line)) {
      const node = manualByImageNumber.get(imageNumber);
      if (node) return node;
    }
  }
  for (const imageNumber of parseImageMentionNumbers(instruction)) {
    const node = manualByImageNumber.get(imageNumber);
    if (node) return node;
  }
  return sortNodesVisually(manualImages)[0] ?? sortNodesVisually(Array.from(imageNodes.values()))[0];
}

function orderRhinoReferenceImages(referenceImages: Node<CanvasNodeData>[], primaryImage?: Node<CanvasNodeData>) {
  if (!primaryImage) return referenceImages;
  return [
    primaryImage,
    ...referenceImages.filter((node) => node.id !== primaryImage.id)
  ];
}

function getTaobaoReferenceImageNodes(inputNodes: Node<CanvasNodeData>[], instruction: string) {
  const imageNodes = uniqueNodesById(inputNodes).filter((node) => node.data.kind === "image" && node.data.imageUrl);
  const imageByNumber = new Map<number, Node<CanvasNodeData>>();
  imageNodes.forEach((node) => {
    if (typeof node.data.imageNumber === "number") imageByNumber.set(node.data.imageNumber, node);
  });
  const pickedIds = new Set<string>();
  const picked: Node<CanvasNodeData>[] = [];
  parseImageMentionNumbers(instruction).forEach((imageNumber) => {
    const node = imageByNumber.get(imageNumber);
    if (!node || pickedIds.has(node.id)) return;
    pickedIds.add(node.id);
    picked.push(node);
  });
  sortNodesVisually(imageNodes).forEach((node) => {
    if (pickedIds.has(node.id)) return;
    pickedIds.add(node.id);
    picked.push(node);
  });
  return picked.slice(0, maxTaobaoPlannerImageInputs);
}

function loadBrowserImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = src;
  });
}

async function prepareTaobaoPlannerImageUrl(imageUrl: string) {
  if (typeof window === "undefined" || !imageUrl.startsWith("data:image/")) return imageUrl;
  try {
    const image = await loadBrowserImage(imageUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const maxEdge = Math.max(width, height);
    if (!width || !height) return imageUrl;
    const scale = Math.min(1, taobaoClientPreviewMaxEdge / maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return imageUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return imageUrl;
  }
}

function getImageRoleFromPrompt(prompt: string, imageNumber: number) {
  const imageToken = String(imageNumber).padStart(3, "0");
  const escapedToken = imageToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(?:<\\s*Image\\s*${escapedToken}\\s*>|@\\s*(?:Image\\s*)?0*${imageNumber}\\b)`, "i");
  const explicitStyleLabels = getStyleReferenceLabelsFromPrompt(prompt);
  if (explicitStyleLabels.includes(`<Image${imageToken}>`)) return "style";
  const matchedLines = prompt.split(/\r?\n/).filter((line) => mentionPattern.test(line));
  const matchedLine = matchedLines[0] ?? "";
  const segment = matchedLine
    .split(/[,，;；、]/)
    .find((part) => mentionPattern.test(part))
    ?.trim() ?? "";
  const matchIndex = prompt.search(mentionPattern);
  const context = segment || (matchIndex >= 0 ? prompt.slice(Math.max(0, matchIndex - 80), matchIndex + 140) : "");
  if (/主图|主产品|main\s*product|hero\s*product|primary\s*product|product\s*(?:identity\s*)?source|identity\s*source|商品主体|产品主体/i.test(context)) return "main";
  if (/结构|structure|造型|形体|geometry/i.test(context)) return "structure";
  if (/尺寸|size|scale|比例|dimension/i.test(context)) return "size";
  if (/场景|scene|environment|setting|background|背景|空间/i.test(context)) return "scene";
  if (/风格|style|mood|氛围|cmf|规范|设计规范|视觉规范|design\s*(?:spec|system|guideline|standard)|visual\s*(?:guideline|standard)|brand\s*(?:guideline|system)/i.test(context)) return "style";
  return "reference";
}

function getImageRolePriority(role: string) {
  switch (role) {
    case "main":
      return 0;
    case "structure":
      return 1;
    case "size":
      return 2;
    case "style":
      return 3;
    case "scene":
      return 5;
    default:
      return 4;
  }
}

function orderReferenceImagesForPrompt(referenceImages: Node<CanvasNodeData>[], prompt: string) {
  return [...referenceImages].sort((a, b) => {
    const aNumber = typeof a.data.imageNumber === "number" ? a.data.imageNumber : Number.POSITIVE_INFINITY;
    const bNumber = typeof b.data.imageNumber === "number" ? b.data.imageNumber : Number.POSITIVE_INFINITY;
    const aRole = Number.isFinite(aNumber) ? getImageRoleFromPrompt(prompt, aNumber) : "reference";
    const bRole = Number.isFinite(bNumber) ? getImageRoleFromPrompt(prompt, bNumber) : "reference";
    const roleDelta = getImageRolePriority(aRole) - getImageRolePriority(bRole);
    if (roleDelta) return roleDelta;
    return aNumber - bNumber;
  });
}

function getGenerationLockState(prompt: string) {
  return {
    cameraStrict: /Camera Lock\s*:\s*Strict|镜头锁定\s*[：:]\s*严格|Double Strict Lock|exact original viewing angle|exact main product angle/i.test(prompt),
    productStrict: /Product Lock\s*:\s*Strict|产品锁定\s*[：:]\s*严格|Product Unchanged|main product is unchanged|Double Strict Lock/i.test(prompt)
  };
}

function getGenerateImageErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "AI 生成已停止。";
  if (error instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(error.message)) {
    return "本地生成服务连接失败，请刷新页面；如果仍失败，请重启本地预览服务后再运行。";
  }
  return error instanceof Error ? error.message : "AI 生成失败。";
}

function prepareSceneReferenceImagesForGeneration(referenceImages: Node<CanvasNodeData>[], prompt: string) {
  const ordered = orderReferenceImagesForPrompt(referenceImages, prompt);
  const hasMainProduct = ordered.some((node) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : Number.NaN;
    return Number.isFinite(imageNumber) && getImageRoleFromPrompt(prompt, imageNumber) === "main";
  });
  if (!hasMainProduct) return { included: ordered, omitted: [] as Node<CanvasNodeData>[] };

  const included: Node<CanvasNodeData>[] = [];
  const omitted: Node<CanvasNodeData>[] = [];
  ordered.forEach((node) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : Number.NaN;
    const role = Number.isFinite(imageNumber) ? getImageRoleFromPrompt(prompt, imageNumber) : "reference";
    if (role === "main") included.push(node);
    else omitted.push(node);
  });
  return { included, omitted };
}

function buildReferenceAttachmentManifest(referenceImages: Node<CanvasNodeData>[], prompt: string, omittedImages: Node<CanvasNodeData>[] = []) {
  if (!referenceImages.length) return "";
  const rows = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    const label = `<Image${String(imageNumber).padStart(3, "0")}>`;
    const role = getImageRoleFromPrompt(prompt, imageNumber);
    const roleText = role === "main"
      ? "MAIN PRODUCT SOURCE. Treat this attached image as the exact product asset and the only source for product identity, geometry, appearance, angle, perspective, silhouette, color blocks, material layout, details, markings, openings, vents, lights, proportions, and visible faces. If any prompt text conflicts with this image, this image wins."
      : role === "scene"
        ? "SCENE / ENVIRONMENT REFERENCE ONLY. Use only its background, setting, atmosphere, props, surface, depth, and lighting. Do not copy, use, redesign, or borrow any product/object from this image as the main product."
        : role === "structure"
          ? "STRUCTURE REFERENCE ONLY. Use for structure details only; it must not replace the main product."
          : role === "size"
            ? "SIZE / SCALE REFERENCE ONLY. Use for dimensions and proportion guidance only; it must not replace the main product."
            : role === "style"
              ? "STYLE REFERENCE ONLY. Use for visual mood/material/style only; it must not replace the main product."
              : "SUPPORTING REFERENCE ONLY. Use only according to the role stated in the prompt; it must not override the main product.";
    return `- Attached image ${index + 1} = ${label}: ${roleText}`;
  });
  return [
    "REFERENCE ATTACHMENT MAP - mandatory:",
    ...rows,
    omittedImages.length
      ? `The following referenced images are intentionally NOT attached for final generation because Scene Image strict product-asset mode is active: ${omittedImages.map((node) => `<Image${String(Number(node.data.imageNumber)).padStart(3, "0")}>`).join(", ")}. Use only their textual scene/structure/size descriptions from the prompt; do not copy their pixels, objects, products, colors, silhouettes, or appearance.`
      : "",
    "Role priority is mandatory: if a prompt declares a Main Product, only that Main Product image may define the product. Scene, style, size, structure references, and product wording in the prompt must never replace the main product or contribute a different product design.",
    "If a scene reference contains a product/object, ignore that product/object completely. Keep only the scene environment, lighting, surface, background, depth, and atmosphere.",
    "Product words in the prompt, such as category, function, dimensions, or marketing name, are semantic placement notes only. They must not be used to invent or redraw the product appearance.",
    "Use the label mapping above when reading <Image###> mentions. The attachment order is explicitly defined by this map."
  ].join("\n");
}

function getGridLayoutHint(count: number) {
  if (count <= 1) return "one full-frame panel";
  if (count === 2) return "two equal panels in a clean side-by-side or stacked layout, whichever best fits the selected aspect ratio";
  if (count === 3) return "three equal panels in one clean row or column, whichever best fits the selected aspect ratio";
  if (count === 4) return "a clean 2 by 2 grid";
  if (count === 5) return "a balanced 2 plus 3 or 3 plus 2 grid";
  if (count === 6) return "a clean 2 by 3 or 3 by 2 grid";
  if (count <= 9) return "a clean 3 by 3 grid with empty space removed or balanced";
  return "a clean 2 by 5 or 5 by 2 grid";
}

function getMainProductLabelsFromPrompt(prompt: string) {
  const labels = new Set<string>();
  prompt.split(/\r?\n/).forEach((line) => {
    if (!/主图|主产品|main\s*product|hero\s*product|product\s*source/i.test(line)) return;
    line.match(/<\s*Image\s*\d{3}\s*>/gi)?.forEach((match) => {
      const number = match.match(/\d{3}/)?.[0];
      if (number) labels.add(`<Image${number}>`);
    });
    line.match(/@\s*(?:Image\s*)?0*\d+\b/gi)?.forEach((match) => {
      const number = match.match(/\d+/)?.[0];
      if (number) labels.add(`<Image${String(Number(number)).padStart(3, "0")}>`);
    });
  });
  return [...labels];
}

function buildGridProductConsistencyLock(prompt: string) {
  const mainProductLabels = getMainProductLabelsFromPrompt(prompt);
  if (!mainProductLabels.length) return "";
  const mainProductText = mainProductLabels.length === 1 ? mainProductLabels[0] : mainProductLabels.join(" / ");
  return [
    "GRID PRODUCT VIEW CONSISTENCY LOCK - mandatory:",
    `Use ${mainProductText} as the single fixed Main Product visual asset for every panel that mentions it.`,
    "Before designing any panel, lock the product identity and view from the Main Product image. Then design each panel's environment around that locked view.",
    "Across all grid panels, the product must keep the same yaw, pitch, roll, camera angle, perspective, silhouette, visible top/front/side face ratio, geometry, proportions, openings, vents, lights, material layout, color blocks, markings, and details.",
    "Do not rotate, front-face, side-face, tilt, straighten, remodel, redraw, simplify, replace, relight into a new material layout, or reinterpret the product separately per panel.",
    "Do not let panel composition, scene camera, table angle, props, background, grid cropping, or layout convenience change the product's original viewpoint.",
    "Only the surrounding scene, props, support surface, background, atmosphere, contact shadows, reflections, and environmental lighting may vary between panels.",
    "For each panel, adapt the table plane, horizon, props, shadows, reflections, and background perspective to the fixed product angle. Never adapt the product angle to the scene.",
    "If a panel scene conflicts with the fixed product viewpoint, change the scene layout or camera framing, not the product."
  ].join("\n");
}

function buildGridImagePrompt(promptNodes: Node<CanvasNodeData>[]) {
  const prompts = sortNodesVisually(promptNodes)
    .map((node) => typeof node.data.prompt === "string" ? node.data.prompt.trim() : "")
    .filter(Boolean)
    .slice(0, 10);
  if (!prompts.length) return "";
  const combinedPrompt = prompts.join("\n\n");
  const productConsistencyLock = buildGridProductConsistencyLock(combinedPrompt);
  const panelInstructions = prompts.map((prompt, index) => {
    const ordinal = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][index] ?? `panel ${index + 1}`;
    return `For the ${ordinal} panel only: ${prompt}`;
  });

  return [
    `Create one single image containing ${prompts.length} separate grid panel${prompts.length === 1 ? "" : "s"}.`,
    `Use ${getGridLayoutHint(prompts.length)}.`,
    productConsistencyLock,
    "Every panel must be visually separated by clean spacing or subtle dividers, but the final result must still be one unified image.",
    "Each panel must follow only its matching prompt below, in the same order as the prompt list.",
    "Use reference images only according to the explicit role stated in each panel prompt and in the reference attachment map. Never treat scene references as product references.",
    "If a panel declares a Main Product image, that image is the only source for the product. Other reference images may guide only their declared role and must not replace or alter the main product.",
    "Do not add visible numbers, captions, labels, subtitles, watermarks, panel titles, UI text, or any extra written annotations unless a panel prompt explicitly asks for text.",
    "Do not merge concepts between panels. Keep each panel independent and faithful to its own prompt.",
    panelInstructions.join("\n\n")
  ].join("\n\n");
}

function buildRhinoTestPrompt(userPrompt: string) {
  return [
    "RHINO PRODUCT RENDER TEST - mandatory:",
    "Use the FIRST attached Rhino product image as the locked source of truth for product geometry, camera, perspective, crop, and composition.",
    "STRICT CAMERA AND PERSPECTIVE LOCK:",
    "- The product camera angle is locked to the Rhino image. Preserve the exact yaw, pitch, roll, camera height, camera distance, lens perspective, horizon relationship, and product orientation.",
    "- Preserve the exact visible top/front/side face ratio from the Rhino image. Do not show more top surface, less top surface, more front face, less front face, or a different side visibility ratio.",
    "- Preserve the exact 2D silhouette projection, rim ellipse shape, top ellipse tilt, vertical axis tilt, visible openings, cutout positions, edge alignment, and crop relationship from the Rhino image.",
    "- Do not rotate, orbit, tilt, straighten, front-face, side-face, top-down, raise the camera, lower the camera, zoom to a different crop, or convert the product into a new hero angle.",
    "- If the desired scene, material, lighting, shadow, or commercial photography style conflicts with the locked viewpoint, adapt the scene and lighting to the fixed Rhino viewpoint. Never adapt the product viewpoint to the scene.",
    "STRICT FULL-PRODUCT COMPOSITION LOCK:",
    "- Render the complete whole product, not a partial close-up, not a cropped top, not a cropped bottom, not a local detail view.",
    "- Match the source image framing: keep the whole product inside the image with similar margins, similar object scale, similar center position, and the same overall crop relationship.",
    "- Do not zoom in, do not crop off the lower body, do not crop off the top cap, do not enlarge a detail area, and do not turn the product into a macro or hero close-up.",
    "- The output must align to the input image as if the original Rhino render was directly retouched: same product bounding box logic, same full-body visibility, same visible outline, same top-to-bottom extent.",
    "AUXILIARY IMAGE RULE:",
    "- If additional attached images are present because the prompt mentions other Image nodes, they may only provide local screen content, texture, material, color, or style details explicitly requested by the user.",
    "- Additional attached images must never define or influence the product's overall geometry, camera angle, perspective, crop, composition, silhouette, product scale, or full-product framing. The first attached Rhino image always wins.",
    "Strictly preserve the product exterior shape, silhouette, proportions, structure, visible edges, openings, face ratios, camera angle, yaw, pitch, roll, perspective, crop relationship, and product orientation from the Rhino image.",
    "Do not redesign, rotate, straighten, simplify, replace, add, remove, or reinterpret the product structure.",
    "Only change the elements described by the user: material, color, finish, texture, lighting, reflections, background, surface, shadows, and commercial photography treatment.",
    "Generate a realistic photorealistic product rendering that looks like a finished commercial product photo while keeping the Rhino product appearance and the exact original viewing angle.",
    "If the user asks for a material or color on a specific part, apply it to that part without changing the underlying geometry.",
    "Do not add visible UI text, labels, watermarks, annotations, dimensions, CAD grid lines, or extra written marks unless the user explicitly asks.",
    "",
    "用户渲染要求：",
    userPrompt
  ].join("\n");
}

function buildRhinoReferenceManifest(referenceImages: Node<CanvasNodeData>[]) {
  if (!referenceImages.length) return "";
  const lines = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? String(node.data.imageNumber).padStart(3, "0") : String(index + 1).padStart(3, "0");
    if (index === 0) {
      return `- Attached image ${index + 1} / Image ${imageNumber}: PRIMARY RHINO PRODUCT SOURCE. This is the only source for product geometry, full product framing, crop, camera angle, yaw, pitch, roll, perspective, silhouette, visible face ratio, and overall composition.`;
    }
    return `- Attached image ${index + 1} / Image ${imageNumber}: AUXILIARY DETAIL ONLY. Use only for explicitly requested local screen content, texture, material, color, or style detail. Do not use it for product geometry, camera angle, perspective, crop, scale, silhouette, or composition.`;
  });
  return [
    "RHINO REFERENCE IMAGE MAP:",
    ...lines,
    "Priority rule: attached image 1 overrides all prompt text and all auxiliary images for the product's complete shape, angle, perspective, crop, and full-body framing."
  ].join("\n");
}

function buildSceneImageRules() {
  return [
    "SCENE IMAGE STRICT LOCK:",
    "- Treat the declared Main Product image as an exact product asset, not a loose visual reference.",
    "- The attached Main Product image is the only image input that may define the product. Other reference images are intentionally not attached in this mode.",
    "- The declared Main Product image is the only visual source for product identity, geometry, silhouette, proportions, details, labels, colors, material layout, openings, vents, lights, markings, and visible faces.",
    "- Preserve the exact main product camera angle, yaw, pitch, roll, perspective, visible top/front/side face ratio, silhouette, crop relationship, scale logic, and internal cutouts/openings from the Main Product image.",
    "- Do not use product category words, function words, dimensions, or marketing names from the prompt to invent a new product design. Those words are only for scene placement and scale.",
    "- Do not rotate, front-face, side-face, tilt, straighten, redraw, remodel, simplify, replace, recolor, relabel, add parts, remove parts, or reinterpret the product to fit the scene.",
    "- If the scene concept conflicts with the main product's exact shape or viewpoint, change the scene instead of changing the product.",
    "- The scene must adapt to the product viewpoint. Adjust the table, ground plane, horizon, props, shadows, and background perspective around the fixed product angle.",
    "- For multi-panel or grid output, repeat this exact same product viewpoint in every panel. Do not solve each panel with a different product camera angle.",
    "SCENE INTEGRATION:",
    "- The product must look physically present in the scene, not pasted onto the background.",
    "- Match the product lighting direction, color temperature, contrast, exposure, and shadow softness to the surrounding scene.",
    "- Add believable contact shadows, grounding shadows, ambient occlusion, surface reflections, and subtle bounce light from nearby materials.",
    "- The product must sit on or interact with the support surface with correct scale, gravity, perspective, and occlusion.",
    "- Preserve product sharpness while matching the scene depth of field naturally; do not leave a cutout edge, halo, flat studio lighting, or isolated white-background look.",
    "- If the scene is outdoor or lifestyle, integrate dust, micro reflections, surface tint, local color spill, and environmental light only as subtle realism cues without changing product design."
  ].join("\n");
}

function cleanSceneDirectorPromptForSceneImage(prompt: string) {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const usefulLines = lines.filter((line) => {
    if (/^(Image References?|图像参考|图片引用|Main Product|Structure Reference|Size Reference|Style Reference|Scene Reference|Reference Weights?|Product Lock|Camera Lock|Product Integrity|Product View Lock|Double Strict Lock|Scene Adaptation|Rendering Requirements|Final Prompt)\s*[:：]/i.test(line)) return false;
    if (/^(主产品|主图|结构参考|尺寸参考|风格参考|场景参考|参考权重|产品锁定|镜头锁定|产品完整性|视角锁定|双重严格锁定|场景适配|渲染要求|最终提示)\s*[:：]/i.test(line)) return false;
    return true;
  });
  const joined = usefulLines.join("\n");
  return joined
    .replace(/<Main Product>/gi, "the exact attached Main Product asset")
    .replace(/<Image\d{3}>/gi, "the referenced scene notes")
    .replace(/\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|in|inch|inches)?\b/gi, "the intended real-world scale")
    .replace(/\b(?:suction[-\s–—]*type\s+)?(?:mosquito|insect)\s+(?:killer|repellent|killing|trap|trapping)\s+(?:lamp|light|device|product)\b/gi, "the exact attached Main Product asset")
    .replace(/\b(?:mosquito|insect)\s+(?:lamp|light|device|product)\b/gi, "the exact attached Main Product asset")
    .replace(/\bthe\s+(?:lamp|device|product)\b/gi, "the exact attached Main Product asset")
    .replace(/\b(?:lamp|device|product)\b/gi, "exact attached Main Product asset")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1800);
}

function buildScenePanelPrompt(prompt: string) {
  const sceneNotes = cleanSceneDirectorPromptForSceneImage(prompt);
  return [
    buildSceneImageRules(),
    "SCENE NOTES:",
    sceneNotes || "Create a natural scene around the exact attached Main Product asset.",
    "Use the scene notes only for environment, support surface, props, lighting, camera mood, and atmosphere.",
    "Do not use any product noun, product category, function, size text, or marketing wording from the scene notes to create the product."
  ].join("\n\n");
}

function buildSceneGridImagePrompt(promptNodes: Node<CanvasNodeData>[]) {
  const prompts = sortNodesVisually(promptNodes)
    .map((node) => typeof node.data.prompt === "string" ? node.data.prompt.trim() : "")
    .filter(Boolean)
    .slice(0, 10);
  if (!prompts.length) return "";
  const combinedPrompt = prompts.join("\n\n");
  const productConsistencyLock = buildGridProductConsistencyLock(combinedPrompt);
  const panelInstructions = prompts.map((prompt, index) => {
    const ordinal = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][index] ?? `panel ${index + 1}`;
    return `For the ${ordinal} panel only:\n${buildScenePanelPrompt(prompt)}`;
  });

  return [
    `Create one single scene image containing ${prompts.length} separate grid panel${prompts.length === 1 ? "" : "s"}.`,
    `Use ${getGridLayoutHint(prompts.length)}.`,
    productConsistencyLock,
    "Every panel must be visually separated by clean spacing or subtle dividers, but the final result must still be one unified image.",
    "Each panel must follow only its matching Scene Director prompt below, in the same order as the prompt list.",
    "Every panel must obey the main product lock and scene integration rules inside its own panel prompt.",
    "Across all panels, use the same exact Main Product visual asset and the same exact Main Product viewing angle. Only the surrounding scene, props, lighting, and background may vary.",
    "Grid layout is only a presentation container. It must not cause per-panel product reposing, product re-framing, product angle optimization, or separate product redraws.",
    "Do not synthesize a product from the text description in any panel. The text may describe product category, function, or size, but the visual product must come from the attached Main Product image.",
    "Do not add visible numbers, captions, labels, subtitles, watermarks, panel titles, UI text, or any extra written annotations unless a panel prompt explicitly asks for text.",
    "Do not merge concepts between panels. Keep each panel independent and faithful to its own prompt.",
    panelInstructions.join("\n\n")
  ].join("\n\n");
}

function buildSceneImagePrompt(promptNodes: Node<CanvasNodeData>[], gridEnabled: boolean) {
  if (gridEnabled) return buildSceneGridImagePrompt(promptNodes);
  const prompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
  if (!prompt) return "";
  return buildScenePanelPrompt(prompt);
}

function buildIndustrialDesignImageRules() {
  return [
    "INDUSTRIAL DESIGN IMAGE RULES:",
    "- Generate a product-focused commercial studio product image / industrial design render, not a lifestyle scene and not an advertisement.",
    "- Prioritize exterior appearance and product form: silhouette, volume hierarchy, proportion, top cap, front opening/window, grille/perforation layout, side ribs, panel seams, base treatment, vents, interface placement, edge transitions, and visual center of gravity.",
    "- Show high-quality material tactility and CMF: believable roughness, reflections, specular highlights, micro-texture, edge bevels, seams, soft/hard material transitions, contact shadows, and finish differences such as matte plastic, glossy plastic, anodized metal, brushed metal, silicone, rubber, fabric, leather, glass, transparent parts, foam, or plush.",
    "- CMF supports the product design unless the prompt explicitly asks for CMF design. Even when CMF is secondary, material quality must be clearly rendered and not look like low-quality generic AI plastic.",
    "- The final product must visibly synthesize the connected reference images. It should not look like a generic product from memory.",
    "- Use competitor references to preserve product category, exterior architecture, benchmark proportions, functional layout, body massing, opening/window logic, grille/perforation strategy, and key usability cues. Do not copy logos, exact labels, or a one-to-one silhouette.",
    "- Use supporting reference images to visibly influence form language, silhouette rhythm, volume stacking, panel segmentation, side ribs, vents/openings, top/middle/bottom proportions, base treatment, edge transitions, and detail density.",
    "- Use mood references only for emotional direction, lighting, material mood, and design tone. Do not import unrelated props, rooms, scenery, or brand marks.",
    "- Use material and CMF references only for light color/material/finish support unless the prompt explicitly asks for CMF design.",
    "- Use structure references for exterior architecture, opening/air-path logic, assembly relationships, dimension logic, component hierarchy, and manufacturable constraints.",
    "- If the prompt contains an existing product reference, keep its required functional layout and core structure according to the structure-lock wording, while improving the industrial design language.",
    "- Use a clean commercial photography studio setup by default: white, light gray, subtle gradient, seamless backdrop, simple product surface, soft studio key light, rim light, natural shadow, and no distracting background clutter.",
    "- Keep the product as the visual hero. The product should be complete, readable, sharply defined, and not cropped in a way that hides important structure unless the prompt explicitly requests a close-up detail shot.",
    "- If the product type requires a human or animal carrier, include only what is necessary to explain use, scale, ergonomics, wearing, holding, or fit. Wearable products may show a model, hand, wrist, ear, foot, head, or relevant body part. Pet products may show the relevant pet. The person or animal must support the product, not become the main subject, and the image should still feel like a clean studio product shoot.",
    "- Avoid random lifestyle props, complex rooms, outdoor scenes, home interiors, offices, kitchens, exhibitions, cinematic environments, or narrative moments unless the prompt explicitly asks for them.",
    "- Do not add random text labels, captions, watermarks, UI chrome, fake brand logos, fake certification marks, or illegible decorative writing. If the prompt or reference explicitly specifies a logo, silkscreen, engraved mark, product label, button text, screen UI, packaging text, nameplate, warning mark, or brand graphic, it must appear on the correct product surface, screen, package, or label with plausible scale, placement, perspective, and material integration.",
    "- The result should look like a professional industrial design render suitable for concept review, design presentation, and downstream product iteration.",
    "- Reference visibility check: a reviewer should be able to point to which visible elements came from each important reference image, while still seeing a new original design."
  ].join("\n");
}

function getIndustrialDesignRoleFromPrompt(prompt: string, imageNumber: number) {
  const imageToken = String(imageNumber).padStart(3, "0");
  const escapedToken = imageToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(?:<\\s*Image\\s*${escapedToken}\\s*>|@\\s*(?:Image\\s*)?0*${imageNumber}\\b)`, "i");
  const matchedLine = prompt.split(/\r?\n/).find((line) => mentionPattern.test(line)) ?? "";
  const matchIndex = prompt.search(mentionPattern);
  const context = matchedLine || (matchIndex >= 0 ? prompt.slice(Math.max(0, matchIndex - 100), matchIndex + 180) : "");
  if (/竞品|竞争|benchmark|competitor|competing|market reference/i.test(context)) return "competitor";
  if (/现有产品|原产品|主产品|main product|existing product|current product/i.test(context)) return "existing";
  if (/结构|structure|造型|形体|geometry|layout|assembly/i.test(context)) return "structure";
  if (/材质|材料|cmf|material|finish|color|colour|texture|surface/i.test(context)) return "cmf";
  if (/情绪|mood|氛围|emotion|atmosphere/i.test(context)) return "mood";
  if (/风格|style|design language|aesthetic/i.test(context)) return "style";
  if (/尺寸|size|scale|比例|dimension/i.test(context)) return "size";
  return getImageRoleFromPrompt(prompt, imageNumber);
}

function getIndustrialDesignBaseAndFusionLabels(referenceImages: Node<CanvasNodeData>[], prompt: string) {
  const labeled = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    return {
      label: `<Image${String(imageNumber).padStart(3, "0")}>`,
      role: getIndustrialDesignRoleFromPrompt(prompt, imageNumber)
    };
  });
  const explicitBase = labeled.find((item) => item.role === "main" || item.role === "existing");
  const base = explicitBase ?? labeled[0];
  return {
    baseLabel: base?.label ?? "",
    fusionLabels: labeled.filter((item) => item.label !== base?.label).map((item) => item.label)
  };
}

function buildIndustrialDesignReferenceManifest(referenceImages: Node<CanvasNodeData>[], prompt: string) {
  if (!referenceImages.length) return "";
  const { baseLabel, fusionLabels } = getIndustrialDesignBaseAndFusionLabels(referenceImages, prompt);
  const rows = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    const label = `<Image${String(imageNumber).padStart(3, "0")}>`;
    const role = getIndustrialDesignRoleFromPrompt(prompt, imageNumber);
    const roleText = role === "competitor"
      ? "COMPETITOR / BENCHMARK REFERENCE. Make its product category, functional layout, ergonomic grip/battery/tool-head relationship, body proportion, market cues, and usability logic visibly influence the new design. Do not copy logos, exact labels, or clone the whole silhouette."
      : role === "existing" || role === "main"
      ? "EXISTING PRODUCT / MAIN PRODUCT REFERENCE. Use for required product category, functional layout, proportions, and core identity only when the prompt asks for an appearance variant or redesign."
      : role === "structure"
        ? "STRUCTURE REFERENCE. Use for exterior architecture, part relationships, geometry logic, vents/openings, grille/perforation layout, assembly hierarchy, and manufacturability."
      : role === "size"
          ? "SIZE / SCALE REFERENCE. Use for dimensions, product-to-hand/object scale, footprint, and realistic proportion."
          : role === "style"
            ? "STYLE REFERENCE. Make its form language, silhouette rhythm, volume stacking, top/middle/bottom proportion, surface transitions, panel breaks, grille/opening language, detail density, and visual identity visibly influence the new product."
          : role === "cmf"
            ? "CMF / MATERIAL REFERENCE. Use colors, material balance, finish, texture, and accent treatment as secondary support. Do not let CMF replace exterior form fusion."
            : role === "scene"
              ? "MOOD / USE-CONTEXT REFERENCE. Use only for emotional tone, usage atmosphere, and target environment. Do not turn the output into a scene unless requested."
          : role === "mood"
            ? "MOOD REFERENCE. Use for emotional tone and product character, while keeping the output product-focused."
              : "SUPPORTING DESIGN REFERENCE. Use only according to the role described in the prompt.";
    return `- Attached image ${index + 1} = ${label}: ${roleText}`;
  });
  return [
    "INDUSTRIAL DESIGN REFERENCE MAP - mandatory:",
    ...rows,
    baseLabel
      ? `PRIMARY BASE PRODUCT: ${baseLabel}. Use this image as the structural and exterior foundation for product category, functional architecture, silhouette, main massing, top/middle/bottom proportion, opening/window relationship, base logic, scale logic, and ergonomic layout.`
      : "",
    fusionLabels.length
      ? `FUSION REFERENCES: ${fusionLabels.join(", ")}. Integrate visible exterior design DNA from these references into the base product: silhouette rhythm, volume stacking, top cap, waistline, front opening/window shape, grille/perforation strategy, panel breaks, vents/openings, side ribs, base treatment, proportions, detail density, and construction cues. Keep CMF secondary.`
      : "",
    "Fusion mode means base product plus reference traits in one coherent product. It does not mean ignoring the base product, generating an unrelated concept, or merely changing colors.",
    "For multi-image reference boards, inspect the individual variants inside the board and extract recurring exterior traits such as silhouette rhythm, body-panel strategy, top/middle/bottom proportions, opening/window placement, grille/perforation patterns, vertical grooves, side vent language, base treatment, and detail density.",
    "Preserve all <Image###> references in the prompt. If the prompt also uses custom aliases such as <竞品01>, <情绪图01>, <材质参考01>, <结构参考01>, or <现有产品01>, preserve those aliases as design notes and map them to the connected references by the user's wording.",
    "Reference priority: industrial design intent and user requirements win over exact copying, but the final product must still visibly carry design DNA from the connected references.",
    "For every important reference image, extract 3-5 visible exterior traits before rendering: silhouette/proportion, volume stacking, component layout, top cap, front opening/window, grille/perforation layout, body panels, vents/openings, side ribs, base treatment, edge transitions, and detail density.",
    "Competitor products must never be copied directly. Borrow category cues, functional expectations, market lessons, ergonomic layout, and proportion logic, then transform them into an original design.",
    "Do not ignore attached references and do not replace them with a generic product archetype."
  ].join("\n");
}

function buildIndustrialDesignPanelPrompt(prompt: string) {
  return [
    buildIndustrialDesignImageRules(),
    "DESIGN PROMPT:",
    prompt,
    "REFERENCE FUSION REQUIREMENT:",
    "Make the final product visibly inherit selected design traits from the attached reference images according to their roles. Keep the design original, but avoid generic output that has no clear connection to the references.",
    "FINAL RENDERING INTENT:",
    "Create a refined industrial design product render based on the design prompt. Focus on exterior form, silhouette, volume hierarchy, opening/grille design, structural clarity, manufacturing feasibility, and clean presentation. Keep CMF as a light supporting layer."
  ].join("\n\n");
}

function buildIndustrialDesignGridImagePrompt(promptNodes: Node<CanvasNodeData>[]) {
  const prompts = sortNodesVisually(promptNodes)
    .map((node) => typeof node.data.prompt === "string" ? node.data.prompt.trim() : "")
    .filter(Boolean)
    .slice(0, 10);
  if (!prompts.length) return "";
  const panelInstructions = prompts.map((prompt, index) => {
    const ordinal = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][index] ?? `panel ${index + 1}`;
    return `For the ${ordinal} panel only:\n${buildIndustrialDesignPanelPrompt(prompt)}`;
  });

  return [
    `Create one single industrial design presentation image containing ${prompts.length} separate grid panel${prompts.length === 1 ? "" : "s"}.`,
    `Use ${getGridLayoutHint(prompts.length)}.`,
    "All panels must follow the same primary base product and fusion reference relationship defined in the INDUSTRIAL DESIGN REFERENCE MAP. Each panel is a different design direction built from the same base + reference fusion system.",
    "In every panel, keep the base product's category and functional architecture recognizable while visibly integrating reference traits. Do not let any panel drift into an unrelated generic product.",
    "Every panel must be visually separated by clean spacing or subtle dividers, but the final result must still be one unified industrial design board.",
    "Each panel must show one distinct product design proposal. Do not merge concepts between panels.",
    "Keep each panel product-focused with neutral studio presentation, clean background, clear exterior form, readable silhouette, clear structural details, and high-quality material tactility. Include a human or pet carrier only when the panel prompt makes it necessary for wearing, scale, ergonomics, or product use.",
    "Do not add visible numbers, captions, subtitles, watermarks, panel titles, UI text, or extra written annotations unless a panel prompt explicitly asks for text. Prompt-specified logos, silkscreen, labels, screen UI, nameplates, packaging text, or product markings must still appear in the correct place.",
    panelInstructions.join("\n\n")
  ].join("\n\n");
}

function buildIndustrialDesignImagePrompt(promptNodes: Node<CanvasNodeData>[], gridEnabled: boolean) {
  if (gridEnabled) return buildIndustrialDesignGridImagePrompt(promptNodes);
  const prompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
  if (!prompt) return "";
  return buildIndustrialDesignPanelPrompt(prompt);
}

function normalizeRemixPercent(value: unknown, fallback: number) {
  const numeric = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(0, Math.round(numeric / 5) * 5));
}

function getProductRemixValues(params: Record<string, unknown>) {
  const gridMode = [1, 2, 4, 6, 9].includes(Number(params.gridMode)) ? Number(params.gridMode) : 1;
  if (gridMode === 1) return [normalizeRemixPercent(params.remix, 50)];
  const start = normalizeRemixPercent(params.startRemix, 0);
  const end = normalizeRemixPercent(params.endRemix, 100);
  return Array.from({ length: gridMode }, (_, index) => {
    const raw = start + ((end - start) * index) / Math.max(1, gridMode - 1);
    return normalizeRemixPercent(String(raw), start);
  });
}

function getProductRemixGridLayout(count: number) {
  if (count === 1) return "single full-frame product design image";
  if (count === 2) return "one image containing 2 equal panels, arranged side-by-side or stacked according to the selected aspect ratio";
  if (count === 4) return "one image containing a clean 2 by 2 grid";
  if (count === 6) return "one image containing a clean 2 by 3 or 3 by 2 grid";
  return "one image containing a clean 3 by 3 grid";
}

function buildProductRemixPrompt(referenceImages: Node<CanvasNodeData>[], rolePrompt: string, params: Record<string, unknown>) {
  const remixValues = getProductRemixValues(params);
  const labels = (nodes: Node<CanvasNodeData>[]) => nodes
    .map((node, index) => `<Image${String(typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1).padStart(3, "0")}>`)
    .join(", ");
  const panelRows = remixValues.map((value, index) => `- Panel ${index + 1}: Remix ${value}/100. ${value === 0 ? "Keep the main product almost unchanged." : value === 100 ? "Fully follow the reference product direction." : value < 50 ? "Main product remains dominant; borrow only the appropriate amount of design language from the reference product." : value === 50 ? "Balance the main product and reference product equally." : "Reference product direction is dominant while retaining only necessary main-product identity cues."}`);

  return [
    "TASK: Product Remix Synthesizer.",
    "Generate exactly ONE final image. Do not output text, captions, labels, annotations, UI, watermarks, or prompt text inside the image.",
    "",
    `Connected product images: ${labels(referenceImages)}.`,
    "The pre-prompt below defines which connected image is the main product, which image is the reference product, and how each image should be used. Follow that role definition strictly.",
    "",
    "PRE-PROMPT ROLE DEFINITION:",
    rolePrompt,
    "",
    `Output layout: ${getProductRemixGridLayout(remixValues.length)}.`,
    "Each panel must show a complete, polished product design render. Keep all panels visually comparable, with consistent camera, lighting, scale, background simplicity, and product presentation.",
    "Remix scale rule: 0 means fully main product; 100 means fully reference product. All listed values are mandatory.",
    ...panelRows,
    "",
    "Quality requirements: professional product concept render, clean background, clear product body, realistic structure, coherent industrial design, suitable for e-commerce or product-design exploration."
  ].join("\n");
}

function getTextImageLayoutStyleReferenceImages(referenceImages: Node<CanvasNodeData>[], prompt: string) {
  const candidates = referenceImages.filter((node) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : Number.NaN;
    return Number.isFinite(imageNumber) && getImageRoleFromPrompt(prompt, imageNumber) === "style";
  });
  const verifiedDesignSpecImages = candidates.filter(isDesignSpecReferenceNode);
  return verifiedDesignSpecImages.length ? verifiedDesignSpecImages : candidates;
}

function sanitizeStyleSummaryForFinalPrompt(summary: string) {
  return summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/品牌视觉规范|视觉规范|设计规范图|规范板|guideline\s*board|visual\s*guideline|brand\s*visual\s*guideline|design\s*spec/i.test(line))
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、]|0\d\s*)\s*/, ""))
    .join("\n")
    .trim();
}

function getStyleReferenceLabelsFromPrompt(prompt: string) {
  const labels = new Set<string>();
  const styleMarker = /(?:Design\s+Style(?:\s*\/\s*Design\s*Spec)?\s*Reference|Style\s*Reference|Design\s*Spec\s*Reference|设计规范图|风格参考图|视觉规范|品牌视觉规范)\s*[:：]/gi;
  const fieldBoundary = /\s(?:Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Bilingual Text|Final Prompt|输出规格|用途|分辨率|画幅比例|目标|构图|文案)\s*[:：]/i;
  for (const marker of prompt.matchAll(styleMarker)) {
    const start = (marker.index ?? 0) + marker[0].length;
    const rest = prompt.slice(start);
    const boundary = rest.search(fieldBoundary);
    const segment = (boundary >= 0 ? rest.slice(0, boundary) : rest).slice(0, 320);
    segment.match(/<\s*Image\s*\d{3}\s*>/gi)?.forEach((match) => {
      const number = match.match(/\d{3}/)?.[0];
      if (number) labels.add(`<Image${number}>`);
    });
    segment.match(/@\s*(?:Image\s*)?0*\d+\b/gi)?.forEach((match) => {
      const number = match.match(/\d+/)?.[0];
      if (number) labels.add(`<Image${String(Number(number)).padStart(3, "0")}>`);
    });
  }
  prompt.split(/\r?\n/).forEach((line) => {
    if (!/是.*(?:设计规范图|风格参考图|视觉规范|品牌规范)|(?:设计规范图|风格参考图|视觉规范|品牌规范)/i.test(line)) return;
    const markerOffset = line.search(/设计规范图|风格参考图|视觉规范|品牌规范/i);
    const mentions = [...line.matchAll(/(?:<\s*Image\s*(\d{1,3})\s*>|@\s*(?:Image\s*)?0*(\d{1,3})\b)/gi)];
    mentions
      .map((match) => ({ index: match.index ?? 0, number: Number(match[1] ?? match[2]) }))
      .sort((a, b) => Math.abs(a.index - markerOffset) - Math.abs(b.index - markerOffset))
      .slice(0, 1)
      .forEach((item) => {
        if (Number.isInteger(item.number) && item.number > 0) labels.add(`<Image${String(item.number).padStart(3, "0")}>`);
      });
  });
  return [...labels];
}

function isDesignSpecReferenceNode(node: Node<CanvasNodeData>) {
  const text = [
    node.id,
    node.data.title,
    node.data.generatedBy,
    node.data.prompt
  ].map((value) => typeof value === "string" ? value : "").join("\n");
  return /visual[_\s-]*director|visual\s*guideline|guideline\s*board|brand\s*visual|design\s*(?:spec|system|guideline|standard)|style\s*reference|设计规范|视觉规范|品牌规范|风格参考/i.test(text);
}

function readPromptField(prompt: string, names: string[]) {
  const pattern = new RegExp(`(?:^|[\\n\\r.。;；])\\s*(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*[:：]\\s*([^\\n\\r.。;；]+)`, "i");
  return prompt.match(pattern)?.[1]?.trim() ?? "";
}

const textImageLayoutFieldBoundary = "画面文字清单|VISIBLE_TEXT_TO_RENDER|ON[-_\\s]*IMAGE\\s*TEXT|文字渲染规则|TEXT_RENDERING_RULE|画面文字布局表|VISIBLE_TEXT_LAYOUT|参考图用途|Image Role References|Image References|商品锁定|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Bilingual Text|Final Prompt|输出规格|用途|分辨率|画幅比例|目标|构图|文案";

function readPromptSection(prompt: string, names: string[]) {
  const headers = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const boundary = textImageLayoutFieldBoundary
    .split("|")
    .filter((name) => !names.includes(name))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`(?:^|[\\n\\r])\\s*(?:${headers})(?:（[^）]*）|\\([^)]*\\))?\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${boundary})(?:（[^）]*）|\\([^)]*\\))?\\s*[:：]|$)`, "i");
  return prompt.match(pattern)?.[1]?.trim() ?? "";
}

function sanitizeTextImageLayoutConnectedPrompt(prompt: string, verifiedStyleLabels?: string[]) {
  const styleLabels = verifiedStyleLabels ?? getStyleReferenceLabelsFromPrompt(prompt);
  const styleReferenceSegmentPattern = new RegExp(`(?:Design\\s+Style(?:\\s*\\/\\s*Design\\s*Spec)?\\s*Reference|Style\\s*Reference|Style\\s*Reference\\s*Rule|Design\\s*Spec\\s*Reference|设计规范图|风格参考图|风格参考规则|视觉规范|品牌视觉规范)\\s*[:：]\\s*[\\s\\S]*?(?=\\s*(?:${textImageLayoutFieldBoundary})\\s*[:：]|$)`, "gi");
  let cleaned = prompt
    .replace(styleReferenceSegmentPattern, " ")
    .replace(/\([^)]*(?:only defines design style|does not provide picture content|不得复制|不得提取|不得复用|只用于提取|只定义设计风格)[^)]*\)/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*(?:Design Style\s*\/\s*Design Spec Reference|Style Reference Rule|Style Reference|Design Spec Reference|设计规范图|风格参考图|风格参考规则|视觉规范|品牌视觉规范|Visual Guideline|Guideline Board|Brand Visual Guideline)\s*[:：]/i.test(line))
    .filter((line) => !/only defines design style|does not provide picture content|不得复制|不得提取|不得复用|只用于提取|只定义设计风格/i.test(line))
    .join("\n")
    .trim();
  styleLabels.forEach((label) => {
    const imageNumber = Number(label.match(/\d{3}/)?.[0] ?? 0);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned
      .replace(new RegExp(`,?\\s*${escaped}`, "g"), "")
      .replace(new RegExp(`,?\\s*@\\s*(?:Image\\s*)?0*${imageNumber}\\b`, "gi"), "")
      .replace(new RegExp(`符合\\s*${escaped}\\s*的`, "g"), "符合隐形风格规范的")
      .replace(new RegExp(`according to\\s*${escaped}`, "gi"), "according to hidden style tokens")
      .replace(new RegExp(`match\\s*${escaped}`, "gi"), "match hidden style tokens")
      .replace(/符合\s*[,，]?\s*的/g, "符合隐形风格规范的")
      .replace(/根据\s*[,，]?\s*的/g, "根据隐形风格规范的")
      .replace(/Image References\s*:\s*[,，]\s*/gi, "Image References: ")
      .replace(/Image References\s*:\s*([.\n]|$)/gi, "");
  });
  const roleReferenceSection = readPromptSection(cleaned, ["参考图用途", "Image Role References", "Image References"]);
  const visibleTextSection = readPromptSection(cleaned, ["画面文字清单", "VISIBLE_TEXT_TO_RENDER", "ON[-_\\s]*IMAGE\\s*TEXT"]);
  const textRenderingRuleSection = readPromptSection(cleaned, ["文字渲染规则", "TEXT_RENDERING_RULE"]);
  const visibleTextLayoutSection = readPromptSection(cleaned, ["画面文字布局表", "VISIBLE_TEXT_LAYOUT"]);
  const compactTask = [
    roleReferenceSection ? `参考图用途（不渲染为画面文字）：\n${roleReferenceSection}` : "",
    readPromptField(cleaned, ["Product Lock", "产品锁定", "商品锁定"]) ? `Product Lock: ${readPromptField(cleaned, ["Product Lock", "产品锁定", "商品锁定"])}` : "",
    visibleTextSection ? `画面文字清单（VISIBLE_TEXT_TO_RENDER）：\n${visibleTextSection}` : "",
    textRenderingRuleSection ? `文字渲染规则（TEXT_RENDERING_RULE）：${textRenderingRuleSection}` : "",
    visibleTextLayoutSection ? `画面文字布局表（VISIBLE_TEXT_LAYOUT）：\n${visibleTextLayoutSection}` : "",
    readPromptField(cleaned, ["Usage", "用途"]) ? `Usage: ${readPromptField(cleaned, ["Usage", "用途"])}` : "",
    readPromptField(cleaned, ["Resolution", "分辨率"]) ? `Resolution: ${readPromptField(cleaned, ["Resolution", "分辨率"])}` : "",
    readPromptField(cleaned, ["Aspect Ratio", "画幅比例"]) ? `Aspect Ratio: ${readPromptField(cleaned, ["Aspect Ratio", "画幅比例"])}` : "",
    readPromptField(cleaned, ["Goal", "目标"]) ? `Goal: ${readPromptField(cleaned, ["Goal", "目标"])}` : "",
    readPromptField(cleaned, ["Composition", "构图"]) ? `Composition: ${readPromptField(cleaned, ["Composition", "构图"]).replace(/<Image\d{3}>/g, "hidden style tokens")}` : "",
    readPromptField(cleaned, ["Bilingual Text", "文案"]) ? `Bilingual Text: ${readPromptField(cleaned, ["Bilingual Text", "文案"])}` : ""
  ].filter(Boolean).join("\n");
  return (compactTask || cleaned)
    .replace(/符合\s*隐形样式规范的色彩系统/g, "符合隐形样式规范的色彩系统")
    .replace(/符合\s*隐形风格规范的色彩系统/g, "符合隐形风格规范的色彩系统")
    .replace(/,\s*,/g, ",")
    .replace(/:\s*,/g, ":")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hasStrictProductLock(prompt: string) {
  return /(?:Product Lock|商品锁定)\s*[:：]\s*(?:Strict|严格)/i.test(prompt);
}

function buildTextImageLayoutReferenceManifest(referenceImages: Node<CanvasNodeData>[], prompt: string, styleReferenceImages: Node<CanvasNodeData>[] = [], styleSummary = "") {
  if (!referenceImages.length && !styleReferenceImages.length && !styleSummary) return "";
  const strictProductLock = hasStrictProductLock(prompt);
  const rows = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    const label = `<Image${String(imageNumber).padStart(3, "0")}>`;
    const role = getImageRoleFromPrompt(prompt, imageNumber);
    const roleText = role === "main" || strictProductLock && role !== "scene"
      ? "PRIMARY PRODUCT IDENTITY SOURCE. This is the only allowed product. The final image must preserve this product's visible identity: category, silhouette, geometry, proportions, color/material separation, transparent/base parts, nozzle/cap/openings, connector details, and key structural features. Do not replace it with a similar generic product, different bottle, cable, wire, appliance, container, or any invented object."
        : role === "size"
          ? "PRODUCT SIZE / STRUCTURE REFERENCE. Preserve visible product proportions, structure, and scale cues; do not use only as loose measurement inspiration."
          : role === "scene"
            ? "SCENE / ENVIRONMENT REFERENCE. Use only if the prompt asks for a scene; do not let it override design-spec references."
            : "PRODUCT / CONTENT REFERENCE. Use as visual evidence for the requested product or content; do not substitute unrelated objects.";
    return `- Attached image ${index + 1} = ${label}: ${roleText}`;
  });
  const hasInvisibleStyle = styleReferenceImages.length > 0;
  const safeStyleSummary = sanitizeStyleSummaryForFinalPrompt(styleSummary);
  return [
    "TEXT IMAGE LAYOUT REFERENCE MAP - mandatory:",
    ...rows,
    strictProductLock && referenceImages.length
      ? "STRICT PRODUCT LOCK: all non-style attached images are product/content evidence. Generate the exact same product identity, not a redesigned, simplified, abstracted, stylized, or category-similar item. If a product image is a dimension, specification, side-view, or white-background reference, it still defines the product appearance and structure."
      : "",
    strictProductLock && referenceImages.length
      ? "Allowed changes under Product Lock: placement, lighting, perspective, scene integration, and commercial retouching only. Forbidden changes: changing product type, changing main geometry, inventing different attachments, removing transparent/base parts, changing color/material layout, adding unrelated objects as the product, or swapping to another object."
      : "",
    hasInvisibleStyle
      ? "INVISIBLE STYLE TOKENS: a separate preprocessing step extracted abstract style tokens from hidden style-only references. The hidden source images are not available as visual content in this final generation step."
      : "",
    hasInvisibleStyle
      ? "Use the tokens only as quiet art direction for the requested Taobao image module. The final image must be one commercial product page image, not a multi-section reference board."
      : "",
    safeStyleSummary ? `Abstract style tokens to apply:\n${safeStyleSummary}` : "",
    "Apply only abstract visual rules: palette, spacing, composition rhythm, typography feeling, information hierarchy, density, border/radius language, shadow softness, labels, chips, tables, dividers, and overall e-commerce design quality.",
    "Hard prohibition: the final image must be the requested Taobao image module, not a multi-section reference board."
  ].join("\n");
}

function buildTextImageLayoutPrompt(promptNodes: Node<CanvasNodeData>[], verifiedStyleLabels?: string[]) {
  const prompt = sanitizeTextImageLayoutConnectedPrompt(promptNodes.map((node) => node.data.prompt).join("\n\n").trim(), verifiedStyleLabels);
  if (!prompt) return "";
  return [
    "TEXT IMAGE LAYOUT GENERATION RULES:",
    "READ THIS AS A PRODUCTION SPEC, NOT AS CREATIVE INSPIRATION. The final image must satisfy every hard lock below.",
    "TASK TYPE LOCK: Create the requested Taobao e-commerce image module only. Do not create a multi-section reference board or standards page.",
    "Create one final e-commerce graphic image with product + text layout according to the cleaned connected prompt.",
    "PRODUCT IDENTITY LOCK: when Product Lock is Strict, the attached non-style product images define the only allowed product. Preserve the same product type, silhouette, structure, proportions, color/material layout, transparent parts, openings, caps, connectors, and distinctive details. Do not generate a similar replacement product. Do not replace the product with cables, wires, generic bottles, other appliances, or unrelated props.",
    "PROMPT ADHERENCE LOCK: the output must directly depict the Goal and Composition from the connected prompt. For a comparison/pain-point image, create the requested comparison layout and use only the locked product as the improved/solution product. Any pain-point side may use abstract/contextual clutter only; it must not replace the locked product.",
    "FAIL CONDITIONS: wrong product, different product silhouette, unrelated object as the product, missing requested comparison/scene/goal, copied style board, extra unlisted text, or using a style reference as visual content.",
    "Respect the output specification written inside the prompt, especially resolution, aspect ratio, usage, and native composition fit.",
    "When the prompt includes a line such as 分辨率：750×1000 px or Resolution: 750x1000 px, compose the image natively for that exact size.",
    "Design the page as a polished image, not a UI screenshot unless explicitly requested.",
    "Use the prompt's product/content references only for the intended product, scene, size, or content role.",
    "Style-only references are hidden and have already been converted into abstract style tokens. Never reconstruct or depict them.",
    "VISIBLE TEXT LOCK: render only the exact strings listed under VISIBLE_TEXT_TO_RENDER / 画面文字清单 in the connected prompt. This list is the complete typography inventory. Do not invent, add, OCR, copy, or render any other visible text, labels, logo text, watermark, placeholder text, price, parameter, unit, number, icon caption, badge text, footer note, product UI text, or text-like mark.",
    "VISIBLE TEXT LAYOUT LOCK: if the connected prompt includes VISIBLE_TEXT_LAYOUT / 画面文字布局表, place each listed string according to that layout table. The table defines each text string's role, hierarchy, and approximate location. Do not create extra text areas or labels outside that table.",
    "If the visible-text list is Chinese, the final image must be Chinese-led and must not auto-add English section titles, English explanatory labels, English selling-point headings, or English body copy. English may appear only if that exact English string is explicitly listed in VISIBLE_TEXT_TO_RENDER / 画面文字清单.",
    "If a visual element would normally need a label, icon caption, parameter, or footer note but that exact text is not listed, render the visual element without text.",
    "Never render internal prompt metadata as on-image text, including Image References, Primary Product Identity Source, Product Lock, Design Style Reference, Downstream Generation Rule, Resolution, Aspect Ratio, Goal, Composition, or any <Image###> token.",
    "If the prompt asks for text areas, hierarchy, labels, or selling-point blocks, create clean readable e-commerce typography and layout. Do not copy text from style/spec reference images.",
    "Avoid platform logos, third-party brand marks, fake certifications, misleading claims, or copied ad text unless the user supplied exact approved copy.",
    "CONNECTED PROMPT:",
    prompt
  ].join("\n\n");
}

function parsePromptResolution(prompt: string) {
  const match = prompt.match(/(?:分辨率|输出尺寸|尺寸|resolution|size)\s*[：:]\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*(?:px|像素)?/i)
    ?? prompt.match(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\s*px\b/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function getAspectRatioLabelFromSize(width: number, height: number) {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function escapePromptHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTaobaoPromptRichHtml(prompt: string) {
  const lines = prompt.split(/\r?\n/);
  let highlighting = false;
  return lines.map((line) => {
    const isVisibleTextStart = /^\s*(?:VISIBLE_TEXT_TO_RENDER|画面文字清单|ON[-_\s]*IMAGE\s*TEXT)\s*[:：]?/i.test(line);
    const isTextRule = /^\s*(?:TEXT_RENDERING_RULE|文字渲染规则)\s*[:：]?/i.test(line);
    const startsNextSection = highlighting && line.trim() && (
      /^(?:Image Role References|Image References|Reference Image Usage|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Prompt|Design Style Reference|Downstream Generation Rule)\s*[:：]/i.test(line) ||
      /^(?:参考图用途|引用图片|图片引用|输出规格|用途|分辨率|画幅比例|目标|构图|提示词|风格参考|设计规范|商品锁定)\s*[:：]/.test(line)
    ) && !/^\s*[-*]/.test(line) && !isTextRule;
    if (isVisibleTextStart) highlighting = true;
    else if (startsNextSection) highlighting = false;
    const escaped = escapePromptHtml(line);
    return highlighting || isTextRule
      ? `<span style="color:#FF3B30;font-weight:700">${escaped}</span>`
      : escaped;
  }).join("<br>");
}

function createMissingMentionImageEdges(targetId: string, imageNodes: Node<CanvasNodeData>[], edges: Edge[]) {
  return imageNodes
    .filter((node) => !edges.some((edge) => (
      edge.source === node.id &&
      edge.target === targetId &&
      edge.sourceHandle === "image-out" &&
      edge.targetHandle === "image-in"
    )))
    .map((node, index): Edge => ({
      id: `edge-mention-image-${targetId}-${node.id}-${Date.now()}-${index}`,
      source: node.id,
      target: targetId,
      sourceHandle: "image-out",
      targetHandle: "image-in",
      type: "deletable",
      selected: false,
      data: { autoLinkedFromMention: true, generatedBy: targetId, portType: "image" }
    }));
}

function isAutoMentionImageEdge(edge: Edge) {
  return edge.id.startsWith("edge-mention-image-") || edge.data?.autoLinkedFromMention === true;
}

function syncMentionImageEdges(targetId: string, imageNodes: Node<CanvasNodeData>[], edges: Edge[]) {
  const mentionedIds = new Set(imageNodes.map((node) => node.id));
  const prunedEdges = edges.filter((edge) => {
    if (!isAutoMentionImageEdge(edge)) return true;
    if (edge.target !== targetId || edge.targetHandle !== "image-in") return true;
    return mentionedIds.has(edge.source);
  });
  const missingEdges = createMissingMentionImageEdges(targetId, imageNodes, prunedEdges);
  const nextEdges = [...prunedEdges, ...missingEdges];
  if (nextEdges.length === edges.length && missingEdges.length === 0) return null;
  return nextEdges;
}

function sortNodesVisually(nodes: Node<CanvasNodeData>[]) {
  return [...nodes].sort((a, b) => {
    if (a.data.kind === "image" && b.data.kind === "image") {
      const aNumber = typeof a.data.imageNumber === "number" ? a.data.imageNumber : Number.POSITIVE_INFINITY;
      const bNumber = typeof b.data.imageNumber === "number" ? b.data.imageNumber : Number.POSITIVE_INFINITY;
      if (aNumber !== bNumber) return aNumber - bNumber;
    }
    const yDelta = a.position.y - b.position.y;
    if (Math.abs(yDelta) > 24) return yDelta;
    return a.position.x - b.position.x;
  });
}

function getNodeBounds(nodes: Node<CanvasNodeData>[]) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + getNodeSize(node).width));
  const maxY = Math.max(...nodes.map((node) => node.position.y + getNodeSize(node).height));
  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    height: maxY - minY,
    width: maxX - minX
  };
}

function getConnectedNodeIds(edges: Edge[], nodeId: string, direction: "incoming" | "outgoing") {
  return new Set(
    edges
      .filter((edge) => direction === "incoming" ? edge.target === nodeId : edge.source === nodeId)
      .map((edge) => direction === "incoming" ? edge.source : edge.target)
  );
}

function isGenerateImageOutput(node: Node<CanvasNodeData>, selectedById: Map<string, Node<CanvasNodeData>>, edges: Edge[]) {
  if (node.data.kind !== "image") return false;
  if (typeof node.data.generatedBy === "string") {
    const sourceKind = selectedById.get(node.data.generatedBy)?.data.kind;
    if (sourceKind === "generateImage" || sourceKind === "rhinoTest" || sourceKind === "textImageLayout" || sourceKind === "gridImage" || sourceKind === "sceneImage" || sourceKind === "industrialDesignImage" || sourceKind === "productRemix") return true;
  }
  return edges.some((edge) => {
    const sourceKind = selectedById.get(edge.source)?.data.kind;
    return edge.target === node.id && (sourceKind === "generateImage" || sourceKind === "rhinoTest" || sourceKind === "textImageLayout" || sourceKind === "gridImage" || sourceKind === "sceneImage" || sourceKind === "industrialDesignImage" || sourceKind === "productRemix" || sourceKind === "visual_director");
  });
}

function getOrderIndex(nodeIds: Set<string>, orderedNodes: Node<CanvasNodeData>[]) {
  const indexes = orderedNodes.map((node, index) => nodeIds.has(node.id) ? index : Number.POSITIVE_INFINITY);
  return Math.min(...indexes);
}

function getGeneratorIdsForOutput(node: Node<CanvasNodeData>, edges: Edge[]) {
  const ids = new Set<string>();
  if (typeof node.data.generatedBy === "string") ids.add(node.data.generatedBy);
  edges.forEach((edge) => {
    if (edge.target === node.id) ids.add(edge.source);
  });
  return ids;
}

function getWorkflowColumns(selectedNodes: Node<CanvasNodeData>[], edges: Edge[]) {
  const selectedById = new Map(selectedNodes.map((node) => [node.id, node]));
  const referenceImages: Node<CanvasNodeData>[] = [];
  const userPrompts: Node<CanvasNodeData>[] = [];
  const aiPrompts: Node<CanvasNodeData>[] = [];
  const schemePrompts: Node<CanvasNodeData>[] = [];
  const generators: Node<CanvasNodeData>[] = [];
  const outputImages: Node<CanvasNodeData>[] = [];
  const others: Node<CanvasNodeData>[] = [];

  selectedNodes.forEach((node) => {
    if (node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer") {
      aiPrompts.push(node);
      return;
    }
    if (node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "visual_director") {
      generators.push(node);
      return;
    }
    if (isGenerateImageOutput(node, selectedById, edges)) {
      outputImages.push(node);
      return;
    }
    if (node.data.kind === "image") {
      referenceImages.push(node);
      return;
    }
    if (node.data.kind === "prompt") {
      const incomingIds = getConnectedNodeIds(edges, node.id, "incoming");
      const outgoingIds = getConnectedNodeIds(edges, node.id, "outgoing");
      const isSchemePrompt = [...incomingIds].some((id) => {
        const sourceKind = selectedById.get(id)?.data.kind;
        return sourceKind === "imageChat" || sourceKind === "sceneDirector" || sourceKind === "taobaoPageDirector" || sourceKind === "industrial_designer";
      }) ||
        [...outgoingIds].some((id) => {
          const targetKind = selectedById.get(id)?.data.kind;
          return targetKind === "generateImage" || targetKind === "rhinoTest" || targetKind === "textImageLayout" || targetKind === "gridImage" || targetKind === "sceneImage" || targetKind === "industrialDesignImage" || targetKind === "productRemix";
        });
      if (isSchemePrompt) schemePrompts.push(node);
      else userPrompts.push(node);
      return;
    }
    others.push(node);
  });

  const sortedSchemePromptsBase = sortNodesVisually(schemePrompts);
  const sortedGenerators = sortNodesVisually(generators).sort((a, b) => {
    const aIncoming = getConnectedNodeIds(edges, a.id, "incoming");
    const bIncoming = getConnectedNodeIds(edges, b.id, "incoming");
    const aIndex = getOrderIndex(aIncoming, sortedSchemePromptsBase);
    const bIndex = getOrderIndex(bIncoming, sortedSchemePromptsBase);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.position.y - b.position.y;
  });
  const sortedSchemePrompts = sortedSchemePromptsBase.sort((a, b) => {
    const aOutgoing = getConnectedNodeIds(edges, a.id, "outgoing");
    const bOutgoing = getConnectedNodeIds(edges, b.id, "outgoing");
    const aIndex = getOrderIndex(aOutgoing, sortedGenerators);
    const bIndex = getOrderIndex(bOutgoing, sortedGenerators);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.position.y - b.position.y;
  });
  const sortedOutputImages = sortNodesVisually(outputImages).sort((a, b) => {
    const aIndex = getOrderIndex(getGeneratorIdsForOutput(a, edges), sortedGenerators);
    const bIndex = getOrderIndex(getGeneratorIdsForOutput(b, edges), sortedGenerators);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.position.y - b.position.y;
  });

  return [
    [...sortNodesVisually(referenceImages), ...sortNodesVisually(userPrompts)],
    sortNodesVisually(aiPrompts),
    sortedSchemePrompts,
    sortedGenerators,
    sortedOutputImages,
    sortNodesVisually(others)
  ]
    .filter((column) => column.length);
}

function layoutColumns(selectedNodes: Node<CanvasNodeData>[], columns: Array<Array<Node<CanvasNodeData>>>) {
  const bounds = getNodeBounds(selectedNodes);
  const columnGap = 96;
  const rowGap = 40;
  const columnMetrics = columns.map((column) => {
    const width = Math.max(...column.map((node) => getNodeSize(node).width));
    const height = column.reduce((total, node, index) => total + getNodeSize(node).height + (index ? rowGap : 0), 0);
    return { height, width };
  });
  const totalWidth = columnMetrics.reduce((total, column, index) => total + column.width + (index ? columnGap : 0), 0);
  const totalHeight = Math.max(...columnMetrics.map((column) => column.height));
  let x = bounds.centerX - totalWidth / 2;
  const positions = new Map<string, XYPosition>();

  columns.forEach((column, columnIndex) => {
    const metric = columnMetrics[columnIndex];
    let y = bounds.centerY - totalHeight / 2 + (totalHeight - metric.height) / 2;
    column.forEach((node) => {
      const size = getNodeSize(node);
      positions.set(node.id, {
        x: x + (metric.width - size.width) / 2,
        y
      });
      y += size.height + rowGap;
    });
    x += metric.width + columnGap;
  });

  return positions;
}

function layoutGrid(selectedNodes: Node<CanvasNodeData>[]) {
  const sortedNodes = sortNodesVisually(selectedNodes);
  const bounds = getNodeBounds(sortedNodes);
  const columns = Math.ceil(Math.sqrt(sortedNodes.length));
  const rows = Math.ceil(sortedNodes.length / columns);
  const columnGap = 56;
  const rowGap = 44;
  const maxWidth = Math.max(...sortedNodes.map((node) => getNodeSize(node).width));
  const maxHeight = Math.max(...sortedNodes.map((node) => getNodeSize(node).height));
  const totalWidth = columns * maxWidth + (columns - 1) * columnGap;
  const totalHeight = rows * maxHeight + (rows - 1) * rowGap;
  const startX = bounds.centerX - totalWidth / 2;
  const startY = bounds.centerY - totalHeight / 2;
  const positions = new Map<string, XYPosition>();

  sortedNodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const size = getNodeSize(node);
    positions.set(node.id, {
      x: startX + column * (maxWidth + columnGap) + (maxWidth - size.width) / 2,
      y: startY + row * (maxHeight + rowGap) + (maxHeight - size.height) / 2
    });
  });

  return positions;
}

function normalizeHydratedNodes(nodes: Node<CanvasNodeData>[]) {
  return withImageNumbers(nodes).map((node) => {
    const { motionState, ...hydratedData } = node.data;
    const cleanNode = { ...node, data: hydratedData };
    const nodeWithCurrentTitle = node.data.kind === "imageChat" && node.data.title !== nodeLabels.imageChat
      ? { ...cleanNode, data: { ...cleanNode.data, title: nodeLabels.imageChat } }
      : node.data.kind === "industrialDesignImage" && node.data.title === "Industrial Design Image"
        ? { ...cleanNode, data: { ...cleanNode.data, title: nodeLabels.industrialDesignImage } }
      : cleanNode;
    if (nodeWithCurrentTitle.data.runState !== "running") return nodeWithCurrentTitle;
    return {
      ...nodeWithCurrentTitle,
      data: {
        ...nodeWithCurrentTitle.data,
        errorMessage: nodeWithCurrentTitle.data.kind === "generateImage" || nodeWithCurrentTitle.data.kind === "rhinoTest" || nodeWithCurrentTitle.data.kind === "textImageLayout" || nodeWithCurrentTitle.data.kind === "gridImage" || nodeWithCurrentTitle.data.kind === "sceneImage" || nodeWithCurrentTitle.data.kind === "industrialDesignImage" || nodeWithCurrentTitle.data.kind === "productRemix" || nodeWithCurrentTitle.data.kind === "imageChat" || nodeWithCurrentTitle.data.kind === "sceneDirector" || nodeWithCurrentTitle.data.kind === "taobaoPageDirector" || nodeWithCurrentTitle.data.kind === "industrial_designer" || nodeWithCurrentTitle.data.kind === "visual_director" ? "上次生成请求已中断，请重新 Run。" : nodeWithCurrentTitle.data.errorMessage,
        generationId: undefined,
        runState: "failed" as const
      }
    };
  });
}

function normalizeHydratedEdges(edges: Edge[]) {
  return edges.map((edge) => {
    const { motionState, ...edgeData } = edge.data ?? {};
    const cleanEdge = edge.data ? { ...edge, data: edgeData } : edge;
    if (edge.targetHandle !== "main-product-in" && edge.targetHandle !== "reference-product-in") return cleanEdge;
    return {
      ...cleanEdge,
      targetHandle: "image-in",
      data: {
        ...(cleanEdge.data ?? {}),
        portType: "image"
      }
    };
  });
}

function createInitialNodes(): Node<CanvasNodeData>[] {
  return [];
}

function createInitialEdges(): Edge[] {
  return [];
}

interface CanvasSnapshot {
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  globalZIndex: number;
  activeEdgeId: string | null;
}

export interface CanvasWorkspaceSnapshot {
  format: "ai-canvas-workspace";
  version: 1;
  projectTitle: string;
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  viewport: Viewport;
  gridEnabled: boolean;
  showAutoImageLinks?: boolean;
  globalZIndex: number;
  activeEdgeId: string | null;
  savedAt: string;
}

function makeSnapshot(state: Pick<CanvasState, "nodes" | "edges" | "globalZIndex" | "activeEdgeId">): CanvasSnapshot {
  return {
    nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data }, position: { ...node.position } })),
    edges: state.edges.map((edge) => ({ ...edge, data: edge.data ? { ...edge.data } : edge.data })),
    globalZIndex: state.globalZIndex,
    activeEdgeId: state.activeEdgeId
  };
}

function pushHistory(state: CanvasState) {
  return [...state.historyPast, makeSnapshot(state)].slice(-historyLimit);
}

interface CanvasState {
  projectTitle: string;
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  historyPast: CanvasSnapshot[];
  historyFuture: CanvasSnapshot[];
  workspaceHydrated: boolean;
  workspaceRevision: number;
  viewport: Viewport;
  zoom: number;
  gridEnabled: boolean;
  addMenuOpen: boolean;
  addMenuPosition: { x: number; y: number };
  globalZIndex: number;
  activeEdgeId: string | null;
  imagePreviewUrl: string | null;
  showAutoImageLinks: boolean;
  generatedImagesPanelOpen: boolean;
  settingsPanelOpen: boolean;
  hydrateWorkspace: (workspace?: Partial<CanvasWorkspaceSnapshot> | null) => void;
  createWorkspaceSnapshot: () => CanvasWorkspaceSnapshot;
  setProjectTitle: (title: string) => void;
  setNodes: (nodes: Node<CanvasNodeData>[], options?: { record?: boolean }) => void;
  setEdges: (edges: Edge[], options?: { record?: boolean }) => void;
  setViewport: (viewport: Viewport) => void;
  setZoom: (zoom: number) => void;
  setGridEnabled: (enabled: boolean) => void;
  setActiveEdgeId: (id: string | null) => void;
  setImagePreviewUrl: (url: string | null) => void;
  toggleAutoImageLinks: () => void;
  setGeneratedImagesPanelOpen: (open: boolean) => void;
  toggleGeneratedImagesPanel: () => void;
  setSettingsPanelOpen: (open: boolean) => void;
  toggleSettingsPanel: () => void;
  openAddMenu: (position: { x: number; y: number }) => void;
  setAddMenuPosition: (position: { x: number; y: number }) => void;
  closeAddMenu: () => void;
  addNode: (kind: NodeKind, position: XYPosition, data?: Partial<CanvasNodeData>) => void;
  runAiPromptNode: (id: string, generationId: string) => Promise<void>;
  runSceneDirectorNode: (id: string, generationId: string) => Promise<void>;
  runTaobaoPageDirectorNode: (id: string, generationId: string) => Promise<void>;
  runIndustrialDesignerNode: (id: string, generationId: string) => Promise<void>;
  runVisualDirectorNode: (id: string, generationId: string) => Promise<void>;
  runGenerateImageNode: (id: string, generationId: string) => Promise<void>;
  stopGenerateImageNode: (id: string) => void;
  saveHistory: () => void;
  undo: () => void;
  redo: () => void;
  updateNodeData: (id: string, data: Partial<CanvasNodeData>, options?: { record?: boolean }) => void;
  bringNodesToFront: (ids: string[]) => void;
  duplicateSelected: (offset?: XYPosition) => void;
  pasteNodes: (nodes: Node<CanvasNodeData>[], offset?: XYPosition) => void;
  deleteSelected: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  autoArrangeSelected: () => void;
  resetCanvas: (options?: { blank?: boolean; record?: boolean; title?: string }) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projectTitle: "未命名项目",
  nodes: createInitialNodes(),
  edges: createInitialEdges(),
  historyPast: [],
  historyFuture: [],
  workspaceHydrated: false,
  workspaceRevision: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  zoom: 1,
  gridEnabled: true,
  addMenuOpen: false,
  addMenuPosition: { x: 110, y: 170 },
  globalZIndex: 5,
  activeEdgeId: null,
  imagePreviewUrl: null,
  showAutoImageLinks: true,
  generatedImagesPanelOpen: false,
  settingsPanelOpen: false,
  hydrateWorkspace: (workspace) => {
    if (!workspace) {
      set((state) => ({ workspaceHydrated: true, workspaceRevision: state.workspaceRevision + 1 }));
      return;
    }

    const viewport = workspace.viewport ?? { x: 0, y: 0, zoom: 1 };
    set((state) => ({
      projectTitle: workspace.projectTitle || "未命名项目",
      nodes: workspace.nodes ? normalizeHydratedNodes(workspace.nodes) : createInitialNodes(),
      edges: workspace.edges ? normalizeHydratedEdges(workspace.edges) : createInitialEdges(),
      historyPast: [],
      historyFuture: [],
      workspaceHydrated: true,
      workspaceRevision: state.workspaceRevision + 1,
      viewport,
      zoom: viewport.zoom,
      gridEnabled: workspace.gridEnabled ?? true,
      showAutoImageLinks: workspace.showAutoImageLinks ?? true,
      addMenuOpen: false,
      addMenuPosition: { x: 110, y: 170 },
      globalZIndex: workspace.globalZIndex ?? Math.max(5, ...(workspace.nodes ?? []).map((node) => node.zIndex ?? Number(node.data?.zIndex) ?? 0)),
      activeEdgeId: workspace.activeEdgeId ?? null,
      imagePreviewUrl: null,
      generatedImagesPanelOpen: false,
      settingsPanelOpen: false
    }));
  },
  createWorkspaceSnapshot: () => {
    const state = get();
    return {
      format: "ai-canvas-workspace",
      version: 1,
      projectTitle: state.projectTitle,
      nodes: state.nodes
        .filter((node) => node.data.motionState !== "deleting")
        .map((node) => {
          const { motionState, ...data } = node.data;
          return { ...node, data, position: { ...node.position } };
        }),
      edges: state.edges
        .filter((edge) => edge.data?.motionState !== "deleting")
        .map((edge) => {
          if (!edge.data) return edge;
          const { motionState, ...data } = edge.data;
          return { ...edge, data };
        }),
      viewport: { ...state.viewport },
      gridEnabled: state.gridEnabled,
      showAutoImageLinks: state.showAutoImageLinks,
      globalZIndex: state.globalZIndex,
      activeEdgeId: state.activeEdgeId,
      savedAt: new Date().toISOString()
    };
  },
  setProjectTitle: (title) => set({ projectTitle: title.trim() || "未命名项目" }),
  setNodes: (nodes, options) => {
    if (!options?.record) {
      set({ nodes });
      return;
    }
    set((state) => ({ nodes, historyPast: pushHistory(state), historyFuture: [] }));
  },
  setEdges: (edges, options) => {
    if (!options?.record) {
      set({ edges });
      return;
    }
    set((state) => ({ edges, historyPast: pushHistory(state), historyFuture: [] }));
  },
  setViewport: (viewport) => set({ viewport, zoom: viewport.zoom }),
  setZoom: (zoom) => set({ zoom }),
  setGridEnabled: (enabled) => set({ gridEnabled: enabled }),
  setActiveEdgeId: (id) => set({ activeEdgeId: id }),
  setImagePreviewUrl: (url) => set({ imagePreviewUrl: url }),
  toggleAutoImageLinks: () => set((state) => ({ activeEdgeId: null, showAutoImageLinks: !state.showAutoImageLinks })),
  setGeneratedImagesPanelOpen: (open) => set({ generatedImagesPanelOpen: open }),
  toggleGeneratedImagesPanel: () => set((state) => ({ generatedImagesPanelOpen: !state.generatedImagesPanelOpen })),
  setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),
  toggleSettingsPanel: () => set((state) => ({ settingsPanelOpen: !state.settingsPanelOpen })),
  openAddMenu: (position) => set({ addMenuOpen: true, addMenuPosition: position }),
  setAddMenuPosition: (position) => set({ addMenuPosition: position }),
  closeAddMenu: () => set({ addMenuOpen: false }),
  saveHistory: () => {
    set((state) => ({ historyPast: pushHistory(state), historyFuture: [] }));
  },
  undo: () => {
    set((state) => {
      const previous = state.historyPast[state.historyPast.length - 1];
      if (!previous) return state;
      return {
        nodes: previous.nodes,
        edges: previous.edges,
        globalZIndex: previous.globalZIndex,
        activeEdgeId: previous.activeEdgeId,
        addMenuOpen: false,
        historyPast: state.historyPast.slice(0, -1),
        historyFuture: [makeSnapshot(state), ...state.historyFuture].slice(0, historyLimit)
      };
    });
  },
  redo: () => {
    set((state) => {
      const next = state.historyFuture[0];
      if (!next) return state;
      return {
        nodes: next.nodes,
        edges: next.edges,
        globalZIndex: next.globalZIndex,
        activeEdgeId: next.activeEdgeId,
        addMenuOpen: false,
        historyPast: pushHistory(state),
        historyFuture: state.historyFuture.slice(1)
      };
    });
  },
  addNode: (kind, position, data) => {
    const current = get().globalZIndex;
    const zIndex = nextZIndex(current);
    const id = `${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    set((state) => {
      const imageNumber = kind === "image" ? data?.imageNumber ?? getNextImageNumber(state.nodes) : data?.imageNumber;
      if (kind === "image" && !imageNumber) {
        return { addMenuOpen: false };
      }
      const defaultData = kind === "imageChat"
        ? { modelId: defaultAiPromptModel, modelParams: { module: "Normal", output: "Chinese", schemes: "1" }, ...data }
        : kind === "sceneDirector"
          ? {
              modelId: defaultSceneDirectorModel,
              modelParams: {
                cameraLock: "严格",
                lensDirection: "自动",
                lightingPreset: "自动",
                outputLanguage: "中文",
                photographyStyle: "自动",
                productLock: "严格",
                promptStyle: "导演模式",
                schemeDiversity: "高",
                schemes: "6",
                sceneWeight: "90",
                sizeWeight: "80",
                structureWeight: "70",
                styleWeight: "90"
              },
              ...data
            }
        : kind === "taobaoPageDirector"
          ? {
              modelId: defaultTaobaoPageDirectorModel,
              modelParams: {
                categoryMode: "自动识别",
                detailCount: "2",
                detailSize: "800x800",
                functionCount: "1",
                functionSize: "750x1200",
                heroCount: "1",
                heroSize: "800x800",
                infoDensity: "标准",
                lifestyleCount: "2",
                lifestyleSize: "750x1000",
                marketingIntensity: "标准",
                moodCount: "1",
                moodSize: "750x1000",
                outputLanguage: "中文",
                painPointCount: "1",
                painPointSize: "750x1200",
                productLock: "严格",
                sellingPointCount: "2",
                sellingPointSize: "800x800",
                sizeCount: "1",
                sizeSize: "750x1000",
                styleReferenceMode: "自动识别",
                targetImageType: "hero",
                visualStyle: "自动"
              },
              ...data
            }
        : kind === "industrial_designer"
          ? {
              modelId: defaultIndustrialDesignerModel,
              modelParams: {
                designMode: "融合设计",
                innovationLevel: "平衡创新",
                outputLanguage: "中文",
                promptStyle: "设计总监模式",
                referenceFusion: "自动融合",
                schemes: "6",
                structureLock: "严格保持",
                visualStyle: "自动判断"
              },
              ...data
            }
        : kind === "visual_director"
          ? {
              modelId: defaultVisualDirectorModel,
              modelParams: {
                aspectRatio: "9:16",
                imageCount: "1",
                outputLanguage: "中文",
                resolution: "2K"
              },
              ...data
            }
        : kind === "gridImage"
          ? { modelId: defaultGridImageModel, modelParams: { aspectRatio: "Auto", resolution: "1K", quality: "Auto" }, ...data }
        : kind === "rhinoTest"
          ? { modelId: defaultGridImageModel, modelParams: { aspectRatio: "Auto", gridEnabled: "false", imageCount: "1", resolution: "1K", quality: "Auto" }, ...data }
          : kind === "textImageLayout"
            ? { modelId: defaultGridImageModel, modelParams: { aspectRatio: "Auto", imageCount: "1", resolution: "Auto" }, ...data }
          : kind === "sceneImage"
            ? { modelId: defaultSceneImageModelId, modelParams: getDefaultSceneImageParams(defaultSceneImageModelId), ...data }
            : kind === "industrialDesignImage"
              ? { modelId: defaultIndustrialDesignImageModelId, modelParams: getDefaultIndustrialDesignImageParams(defaultIndustrialDesignImageModelId), ...data }
              : kind === "productRemix"
                ? { modelId: defaultProductRemixModelId, modelParams: getDefaultProductRemixParams(defaultProductRemixModelId), ...data }
          : data;
      return {
        globalZIndex: zIndex,
        addMenuOpen: false,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...state.nodes,
          makeNode(id, kind, position, zIndex, {
            ...defaultData,
            imageNumber,
            motionState: "entering"
          })
        ]
      };
    });
  },
  runGenerateImageNode: async (id, generationId) => {
    let snapshot = get();
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    let inputEdges = snapshot.edges.filter((edge) => edge.target === id);
    let inputNodes = inputEdges
      .map((edge) => snapshot.nodes.find((node) => node.id === edge.source))
      .filter((node): node is Node<CanvasNodeData> => Boolean(node));
    let promptNodes = inputNodes.filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim());
    const isGenerateImageNode = source.data.kind === "generateImage";
    const isRhinoTestNode = source.data.kind === "rhinoTest";
    const isTextImageLayoutNode = source.data.kind === "textImageLayout";
    const isGridImageNode = source.data.kind === "gridImage";
    const isSceneImageNode = source.data.kind === "sceneImage";
    const isIndustrialDesignImageNode = source.data.kind === "industrialDesignImage";
    const isProductRemixNode = source.data.kind === "productRemix";
    const generateGridEnabled = isGenerateImageNode && source.data.modelParams?.gridEnabled === "true";
    const sceneGridEnabled = isSceneImageNode && source.data.modelParams?.gridEnabled === "true";
    const industrialDesignGridEnabled = isIndustrialDesignImageNode && source.data.modelParams?.gridEnabled === "true";
    const gridOutputEnabled = isGridImageNode || generateGridEnabled || sceneGridEnabled || industrialDesignGridEnabled;
    let gridPromptCount = promptNodes.length;
    let rolePrompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
    let prompt = isProductRemixNode
      ? ""
      : isTextImageLayoutNode
        ? buildTextImageLayoutPrompt(promptNodes)
        : isRhinoTestNode
        ? buildRhinoTestPrompt(promptNodes.map((node) => node.data.prompt).join("\n\n").trim())
        : isSceneImageNode
        ? buildSceneImagePrompt(promptNodes, sceneGridEnabled)
        : isIndustrialDesignImageNode
          ? buildIndustrialDesignImagePrompt(promptNodes, industrialDesignGridEnabled)
          : isGridImageNode || generateGridEnabled
            ? buildGridImagePrompt(promptNodes)
            : promptNodes.map((node) => node.data.prompt).join("\n\n").trim();

    if (!isProductRemixNode && (!prompt || (gridOutputEnabled && gridPromptCount < 1))) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接 Prompt 文本输入。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (gridOutputEnabled && gridPromptCount > 10) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "宫格图最多支持 10 个 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    const mentionedImageNodes = isProductRemixNode ? [] : getPromptMentionedImageNodes(snapshot.nodes, promptNodes);
    const syncedMentionEdges = isProductRemixNode ? null : syncMentionImageEdges(id, mentionedImageNodes, snapshot.edges);
    if (syncedMentionEdges) {
      set((state) => {
        const currentSource = state.nodes.find((node) => node.id === id);
        if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return state;
        const currentPromptNodes = state.edges
          .filter((edge) => edge.target === id)
          .map((edge) => state.nodes.find((node) => node.id === edge.source))
          .filter((node): node is Node<CanvasNodeData> => {
            if (!node) return false;
            return typeof node.data.prompt === "string" && node.data.prompt.trim().length > 0;
          });
        const currentMentionedImageNodes = getPromptMentionedImageNodes(state.nodes, currentPromptNodes);
        const currentSyncedMentionEdges = syncMentionImageEdges(id, currentMentionedImageNodes, state.edges);
        if (!currentSyncedMentionEdges) return state;
        return {
          activeEdgeId: null,
          edges: currentSyncedMentionEdges
        };
      });
      snapshot = get();
      inputEdges = snapshot.edges.filter((edge) => edge.target === id);
      inputNodes = inputEdges
        .map((edge) => snapshot.nodes.find((node) => node.id === edge.source))
        .filter((node): node is Node<CanvasNodeData> => Boolean(node));
      promptNodes = inputNodes.filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim());
      gridPromptCount = promptNodes.length;
      if (gridOutputEnabled && gridPromptCount > 10) {
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "宫格图最多支持 10 个 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
        }));
        return;
      }
      rolePrompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
      prompt = isTextImageLayoutNode
        ? buildTextImageLayoutPrompt(promptNodes)
        : isRhinoTestNode
          ? buildRhinoTestPrompt(rolePrompt)
        : isSceneImageNode
          ? buildSceneImagePrompt(promptNodes, sceneGridEnabled)
        : isIndustrialDesignImageNode
          ? buildIndustrialDesignImagePrompt(promptNodes, industrialDesignGridEnabled)
          : isGridImageNode || generateGridEnabled
            ? buildGridImagePrompt(promptNodes)
            : rolePrompt;
    }

    const modelId = typeof source.data.modelId === "string" ? source.data.modelId : undefined;
    const referenceImageLimit = getReferenceImageLimit(modelId);
    const rhinoPrimaryReferenceImage = isRhinoTestNode ? getRhinoPrimaryReferenceImage(inputEdges, inputNodes, rolePrompt) : undefined;
    const allReferenceImages = isRhinoTestNode
      ? orderRhinoReferenceImages(getReferenceImageNodes(inputNodes, Number.POSITIVE_INFINITY), rhinoPrimaryReferenceImage)
      : getReferenceImageNodes(inputNodes, Number.POSITIVE_INFINITY);
    if (isRhinoTestNode && !allReferenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接 Rhino 产品截图图片。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (isProductRemixNode && !allReferenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接产品图片。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (isProductRemixNode && !rolePrompt) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接前置 Prompt，用来定义主产品图和参考产品图。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (isProductRemixNode && allReferenceImages.length > 5) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "产品 Remix 最多支持 5 张连接图片。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (isProductRemixNode) {
      prompt = buildProductRemixPrompt(allReferenceImages, rolePrompt, source.data.modelParams ?? {});
    }
    if (isProductRemixNode) {
      console.info("[product-remix] prepared request", {
        imageCount: allReferenceImages.length,
        model: source.data.modelId,
        promptLength: prompt.length,
        sourceNodeId: id
      });
    }
    const preparedReferenceImages = isSceneImageNode
      ? prepareSceneReferenceImagesForGeneration(allReferenceImages, rolePrompt)
      : { included: allReferenceImages, omitted: [] as Node<CanvasNodeData>[] };
    let referenceImages = isRhinoTestNode
      ? orderRhinoReferenceImages(preparedReferenceImages.included, rhinoPrimaryReferenceImage)
      : preparedReferenceImages.included;
    const textLayoutStyleReferenceImages = isTextImageLayoutNode ? getTextImageLayoutStyleReferenceImages(referenceImages, rolePrompt) : [];
    const textLayoutVerifiedStyleLabels = textLayoutStyleReferenceImages.map((node, index) => {
      const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
      return `<Image${String(imageNumber).padStart(3, "0")}>`;
    });
    if (isTextImageLayoutNode && textLayoutStyleReferenceImages.length) {
      const styleIds = new Set(textLayoutStyleReferenceImages.map((node) => node.id));
      referenceImages = referenceImages.filter((node) => !styleIds.has(node.id));
    }
    if (isSceneImageNode && allReferenceImages.length > 1 && referenceImages.length === allReferenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "Scene Image 需要在 Prompt 里明确主图，例如 Main Product: <Image010>。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (referenceImages.length > referenceImageLimit) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: `当前模型最多支持 ${referenceImageLimit} 张参考图。`, generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    let textLayoutStyleSummary = "";
    if (isTextImageLayoutNode && textLayoutStyleReferenceImages.length) {
      try {
      const response = await fetch("/api/ai/style-reference-summary", {
        body: JSON.stringify({
            aiSettings: getClientAiSettingsPayload(),
            images: textLayoutStyleReferenceImages.map((node) => ({
              imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
              url: node.data.imageUrl
            })),
            instruction: rolePrompt,
            model: "gemini-2.5-flash",
            sourceNodeId: id
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST"
        });
        const responseText = await response.text();
        let payload: { error?: string; summary?: string };
        try {
          payload = JSON.parse(responseText) as { error?: string; summary?: string };
        } catch {
          throw new Error(response.ok ? "设计规范图解析结果格式异常。" : `设计规范图解析失败：${response.status}`);
        }
        if (!response.ok) throw new Error(payload.error || `设计规范图解析失败：${response.status}`);
        textLayoutStyleSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
        if (!textLayoutStyleSummary) throw new Error("设计规范图没有返回可用摘要。");
      } catch (error) {
        set((state) => ({
          nodes: state.nodes.map((node) => (
            node.id === id && node.data.generationId === generationId
              ? { ...node, data: { ...node.data, errorMessage: error instanceof Error ? error.message : "设计规范图解析失败。", generationId: undefined, runState: "failed" as const } }
              : node
          ))
        }));
        return;
      }
    }
    if (isTextImageLayoutNode) {
      prompt = buildTextImageLayoutPrompt(promptNodes, textLayoutVerifiedStyleLabels);
    }
    const referenceManifest = isTextImageLayoutNode
      ? buildTextImageLayoutReferenceManifest(referenceImages, rolePrompt, textLayoutStyleReferenceImages, textLayoutStyleSummary)
      : isSceneImageNode
        ? buildReferenceAttachmentManifest(referenceImages, rolePrompt, preparedReferenceImages.omitted)
        : isIndustrialDesignImageNode
          ? buildIndustrialDesignReferenceManifest(referenceImages, rolePrompt)
          : isRhinoTestNode
            ? buildRhinoReferenceManifest(referenceImages)
          : "";
    const requestPrompt = referenceManifest ? `${referenceManifest}\n\n${prompt}` : prompt;
    const promptResolution = isTextImageLayoutNode ? parsePromptResolution(rolePrompt) : null;
    const baseRequestParams = isProductRemixNode
      ? { ...(source.data.modelParams ?? {}), imageCount: "1" }
      : gridOutputEnabled
      ? { ...(source.data.modelParams ?? {}), imageCount: "1" }
      : source.data.modelParams ?? {};
    const requestParams = isTextImageLayoutNode && promptResolution
      ? {
          ...baseRequestParams,
          aspectRatio: baseRequestParams.aspectRatio === "Auto" || baseRequestParams.aspectRatio === "自动" || !baseRequestParams.aspectRatio ? getAspectRatioLabelFromSize(promptResolution.width, promptResolution.height) : baseRequestParams.aspectRatio,
          targetHeight: String(promptResolution.height),
          targetWidth: String(promptResolution.width)
        }
      : baseRequestParams;

    let images: Array<{ url: string }>;
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      console.info("[generate-image] sending request", {
        imageCount: referenceImages.length,
        model: modelId,
        sourceNodeId: id
      });
      const response = await fetch("/api/ai/generate-image", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages.map((node) => node.data.imageUrl).filter((imageUrl): imageUrl is string => Boolean(imageUrl)),
          model: modelId,
          params: requestParams,
          prompt: requestPrompt,
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const responseText = await response.text();
      let payload: { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string };
      try {
        payload = JSON.parse(responseText) as { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string };
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `AI 生成失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      const debugText = payload.debug ? ` (${payload.debug.mode ?? "unknown"}, ${payload.debug.size ?? "unknown"})` : "";
      if (!response.ok) throw new Error(`${payload.error || `AI 生成失败：${response.status}`}${debugText}`);
      images = (payload.images ?? []).map((image) => ({ url: image.url ?? "" })).filter((image) => Boolean(image.url));
      if (!images.length) throw new Error("AI 服务没有返回图片。");
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: getGenerateImageErrorMessage(error), generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const source = cleaned.nodes.find((node) => node.id === id);
      if (!source) return state;
      if (source.data.generationId !== generationId || source.data.runState !== "running") return state;

      const inputEdges = cleaned.edges.filter((edge) => edge.target === id);
      const inputNodes = inputEdges
        .map((edge) => cleaned.nodes.find((node) => node.id === edge.source))
        .filter((node): node is Node<CanvasNodeData> => Boolean(node));
      const promptNodes = inputNodes.filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim());
      const outputRolePrompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
      const outputRhinoPrimaryReferenceImage = source.data.kind === "rhinoTest" ? getRhinoPrimaryReferenceImage(inputEdges, inputNodes, outputRolePrompt) : undefined;
      const referenceImages = source.data.kind === "rhinoTest"
        ? orderRhinoReferenceImages(getReferenceImageNodes(inputNodes, getReferenceImageLimit(typeof source.data.modelId === "string" ? source.data.modelId : undefined)), outputRhinoPrimaryReferenceImage)
        : getReferenceImageNodes(inputNodes, getReferenceImageLimit(typeof source.data.modelId === "string" ? source.data.modelId : undefined));
      const isGenerateImageOutput = source.data.kind === "generateImage";
      const isRhinoTestOutput = source.data.kind === "rhinoTest";
      const isTextImageLayoutOutput = source.data.kind === "textImageLayout";
      const isSceneImageOutput = source.data.kind === "sceneImage";
      const isIndustrialDesignImageOutput = source.data.kind === "industrialDesignImage";
      const isProductRemixOutput = source.data.kind === "productRemix";
      const generateGridOutput = isGenerateImageOutput && source.data.modelParams?.gridEnabled === "true";
      const sceneGridOutput = isSceneImageOutput && source.data.modelParams?.gridEnabled === "true";
      const industrialDesignGridOutput = isIndustrialDesignImageOutput && source.data.modelParams?.gridEnabled === "true";
      const generationMode = source.data.kind === "gridImage"
        ? `Grid Image ${Math.min(10, promptNodes.length)}`
        : generateGridOutput
          ? `Grid Image ${Math.min(10, promptNodes.length)}`
        : sceneGridOutput
          ? `Scene Grid Image ${Math.min(10, promptNodes.length)}`
        : industrialDesignGridOutput
          ? `ID Grid Image ${Math.min(10, promptNodes.length)}`
        : isProductRemixOutput
          ? `产品 Remix ${source.data.modelParams?.gridMode ?? "1"}宫`
        : isTextImageLayoutOutput
          ? "Text Image Layout"
        : isSceneImageOutput
          ? "Scene Image"
        : isIndustrialDesignImageOutput
          ? "ID Image"
        : isRhinoTestOutput
          ? "Rhino 产品渲染"
        : referenceImages.length && promptNodes.length
        ? "Image + Text"
        : referenceImages.length > 1
          ? "Multi Image Reference"
          : referenceImages.length
            ? "Image to Image"
            : "Text to Image";

      let currentZIndex = state.globalZIndex;
      const reservedImageNumbers = new Set<number>();
      const imagesWithNumbers = images
        .map((image) => {
          const imageNumber = getNextImageNumber(cleaned.nodes, reservedImageNumbers);
          if (!imageNumber) return null;
          reservedImageNumbers.add(imageNumber);
          return { image, imageNumber };
        })
        .filter((item): item is { image: { url: string }; imageNumber: number } => Boolean(item));
      const outputCount = imagesWithNumbers.length;
      if (!outputCount) {
        return {
          nodes: state.nodes.map((node) => (
            node.id === id
              ? { ...node, data: { ...node.data, errorMessage: "Image 图框已达到 100 个上限，请删除后再生成。", generationId: undefined, runState: "failed" as const } }
              : node
          ))
        };
      }
      const outputPositions = findGeneratedOutputPositions(source, cleaned.nodes, outputCount);
      const generatedAt = Date.now();
      const generatedNodes = imagesWithNumbers.map(({ image, imageNumber }, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        const outputPrompt = source.data.kind === "textImageLayout"
          ? buildTextImageLayoutPrompt(promptNodes, textLayoutVerifiedStyleLabels)
          : source.data.kind === "sceneImage"
          ? buildSceneImagePrompt(promptNodes, source.data.modelParams?.gridEnabled === "true")
          : source.data.kind === "industrialDesignImage"
            ? buildIndustrialDesignImagePrompt(promptNodes, source.data.modelParams?.gridEnabled === "true")
          : source.data.kind === "productRemix"
            ? buildProductRemixPrompt(referenceImages, promptNodes.map((node) => node.data.prompt).join("\n\n").trim(), source.data.modelParams ?? {})
          : source.data.kind === "rhinoTest"
            ? `${buildRhinoReferenceManifest(referenceImages)}\n\n${buildRhinoTestPrompt(outputRolePrompt)}`
          : source.data.kind === "gridImage" || (source.data.kind === "generateImage" && source.data.modelParams?.gridEnabled === "true")
            ? buildGridImagePrompt(promptNodes)
            : promptNodes.map((node) => node.data.prompt).join("\n\n");
        return makeNode(
          `image-generated-${generatedAt}-${index}-${Math.round(Math.random() * 1000)}`,
          "image",
          outputPositions[index],
          currentZIndex,
          {
            generatedBy: id,
            imageNumber,
            imageUrl: image.url,
            title: source.data.kind === "sceneImage"
              ? source.data.modelParams?.gridEnabled === "true" ? `Scene Grid Image ${String(Math.min(10, promptNodes.length)).padStart(2, "0")}` : "Scene Image"
              : source.data.kind === "industrialDesignImage"
                ? source.data.modelParams?.gridEnabled === "true" ? `ID Grid Image ${String(Math.min(10, promptNodes.length)).padStart(2, "0")}` : "ID Image"
              : source.data.kind === "productRemix"
                ? `产品 Remix ${source.data.modelParams?.gridMode ?? "1"}宫图`
              : source.data.kind === "rhinoTest"
                ? "Rhino 产品渲染"
              : source.data.kind === "textImageLayout"
                ? "Text Image Layout"
              : source.data.kind === "gridImage" || (source.data.kind === "generateImage" && source.data.modelParams?.gridEnabled === "true") ? `Grid Image ${String(Math.min(10, promptNodes.length)).padStart(2, "0")}` : "Image",
            prompt: outputPrompt,
            runState: "completed"
          }
        );
      });
      const generatedEdges: Edge[] = generatedNodes.map((node, index) => ({
        id: `edge-generated-${generatedAt}-${index}`,
        source: id,
        target: node.id,
        sourceHandle: "image-out",
        targetHandle: "image-in",
        type: "deletable",
        selected: false,
        data: { generatedBy: id, portType: "image" }
      }));

      return {
        globalZIndex: currentZIndex,
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...cleaned.nodes
            .map((node) => (node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, runState: "completed" as const, prompt: generationMode } } : node)),
          ...generatedNodes
        ],
        edges: [
          ...cleaned.edges,
          ...generatedEdges
        ]
      };
    });
  },
  runVisualDirectorNode: async (id, generationId) => {
    const snapshot = syncMentionImageEdgesForRunningTarget(id, generationId, get, set);
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    const inputNodes = getAgentInputNodesWithMentionedImages(snapshot.nodes, snapshot.edges, id);
    const visualModel = typeof source.data.modelId === "string" ? source.data.modelId : defaultVisualDirectorModel;
    const referenceImages = getReferenceImageNodes(inputNodes, getReferenceImageLimit(visualModel));
    const instruction = inputNodes
      .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim())
      .map((node) => node.data.prompt)
      .join("\n\n")
      .trim();

    if (!referenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请至少连接 1 张产品图片。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    const controller = new AbortController();
    generationControllers.get(id)?.abort();
    generationControllers.set(id, controller);
    try {
      const analysisResponse = await fetch("/api/ai/visual-director", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages.map((node) => ({
            imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
            title: node.data.title,
            url: node.data.imageUrl
          })),
          instruction,
          model: "gemini-2.5-flash",
          params: source.data.modelParams ?? {},
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      const analysisText = await analysisResponse.text();
      let analysisPayload: { error?: string; prompt?: string };
      try {
        analysisPayload = JSON.parse(analysisText) as { error?: string; prompt?: string };
      } catch {
        throw new Error(analysisResponse.ok ? "Visual Director 分析结果格式异常。" : `Visual Director 分析失败：${analysisResponse.status}`);
      }
      if (!analysisResponse.ok) throw new Error(analysisPayload.error || `Visual Director 分析失败：${analysisResponse.status}`);
      const boardPrompt = analysisPayload.prompt?.trim();
      if (!boardPrompt) throw new Error("Visual Director 没有返回视觉规范指令。");

      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const params = source.data.modelParams ?? {};
      const imageResponse = await fetch("/api/ai/generate-image", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages.map((node) => node.data.imageUrl).filter((url): url is string => Boolean(url)),
          model: visualModel,
          params: {
            aspectRatio: params.aspectRatio ?? "9:16",
            imageCount: source.data.modelParams?.imageCount ?? "1",
            resolution: params.resolution ?? "2K"
          },
          prompt: boardPrompt,
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      const imageText = await imageResponse.text();
      let imagePayload: { error?: string; images?: Array<{ url?: string }> };
      try {
        imagePayload = JSON.parse(imageText) as { error?: string; images?: Array<{ url?: string }> };
      } catch {
        throw new Error(imageResponse.ok ? "视觉规范图返回格式异常。" : `视觉规范图生成失败：${imageResponse.status}`);
      }
      if (!imageResponse.ok) throw new Error(imagePayload.error || `视觉规范图生成失败：${imageResponse.status}`);
      const imageUrls = (imagePayload.images ?? [])
        .map((image) => typeof image.url === "string" ? image.url : "")
        .filter(Boolean)
        .slice(0, Math.min(6, Math.max(1, Number.parseInt(source.data.modelParams?.imageCount ?? "1", 10) || 1)));
      if (!imageUrls.length) throw new Error("AI 服务没有返回视觉规范图。");
      generationControllers.delete(id);

      set((state) => {
        const cleaned = removeConnectedGeneratedOutputs(state, id);
        const currentSource = cleaned.nodes.find((node) => node.id === id);
        if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return state;
        let zIndex = state.globalZIndex;
        const reservedImageNumbers = new Set<number>();
        const numberedImages = imageUrls.map((imageUrl) => {
          const imageNumber = getNextImageNumber(cleaned.nodes, reservedImageNumbers);
          if (!imageNumber) return null;
          reservedImageNumbers.add(imageNumber);
          return { imageNumber, imageUrl };
        }).filter((image): image is { imageNumber: number; imageUrl: string } => Boolean(image));
        if (!numberedImages.length) {
          return {
            nodes: state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, errorMessage: "Image 图框已达到 100 个上限。", generationId: undefined, runState: "failed" as const } } : node)
          };
        }
        const generatedAt = Date.now();
        const outputPositions = findGeneratedOutputPositions(currentSource, cleaned.nodes, numberedImages.length);
        const outputNodes = numberedImages.map(({ imageNumber, imageUrl }, index) => {
          zIndex = nextZIndex(zIndex);
          return makeNode(
            `image-visual-guideline-${generatedAt}-${index}-${Math.round(Math.random() * 1000)}`,
            "image",
            outputPositions[index],
            zIndex,
            {
              generatedBy: id,
              imageNumber,
              imageUrl,
              prompt: boardPrompt,
              runState: "completed",
              title: "Visual Guideline Board"
            }
          );
        });
        return {
          globalZIndex: zIndex,
          activeEdgeId: null,
          historyPast: pushHistory(state),
          historyFuture: [],
          nodes: [
            ...cleaned.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, imageUrl: imageUrls[0], prompt: boardPrompt, runState: "completed" as const } } : node),
            ...outputNodes
          ],
          edges: [
            ...cleaned.edges,
            ...outputNodes.map((outputNode, index) => ({
              id: `edge-visual-guideline-${generatedAt}-${index}`,
              source: id,
              target: outputNode.id,
              sourceHandle: "image-out",
              targetHandle: "image-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "image" }
            }))
          ]
        };
      });
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: error instanceof Error && error.name === "AbortError" ? "Visual Director 已停止。" : error instanceof Error ? error.message : "Visual Director 失败。", generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
    }
  },
  runAiPromptNode: async (id, generationId) => {
    const snapshot = syncMentionImageEdgesForRunningTarget(id, generationId, get, set);
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    const inputEdges = snapshot.edges.filter((edge) => edge.target === id);
    const inputNodes = inputEdges
      .map((edge) => snapshot.nodes.find((node) => node.id === edge.source))
      .filter((node): node is Node<CanvasNodeData> => Boolean(node));
    const referenceImages = inputNodes
      .filter((node) => node.data.kind === "image" && node.data.imageUrl)
      .map((node) => ({
        imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
        url: node.data.imageUrl as string
      }));
    const instruction = inputNodes
      .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim())
      .map((node) => node.data.prompt)
      .join("\n\n")
      .trim();

    if (!referenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接 Image 图框。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    let prompt = "";
    let generatedSchemes: Array<{ prompt: string; title?: string }> = [];
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      const response = await fetch("/api/ai/prompt-image", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages,
          instruction,
          model: typeof source.data.modelId === "string" ? source.data.modelId : defaultAiPromptModel,
          module: typeof source.data.modelParams?.module === "string" ? source.data.modelParams.module : "Normal",
          output: typeof source.data.modelParams?.output === "string" ? source.data.modelParams.output : "Chinese",
          schemes: typeof source.data.modelParams?.schemes === "string" ? source.data.modelParams.schemes : "1",
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const responseText = await response.text();
      let payload: { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      try {
        payload = JSON.parse(responseText) as { prompt?: string; error?: string };
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `AI Prompt 失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      if (!response.ok) throw new Error(payload.error || `AI Prompt 失败：${response.status}`);
      generatedSchemes = Array.isArray(payload.schemes)
        ? payload.schemes
            .map((scheme) => ({
              prompt: typeof scheme.prompt === "string" ? scheme.prompt.trim() : "",
              title: typeof scheme.title === "string" ? scheme.title.trim() : undefined
            }))
            .filter((scheme) => scheme.prompt)
        : [];
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt && generatedSchemes.length) {
        prompt = generatedSchemes.map((scheme, index) => `${scheme.title || `方案 ${String(index + 1).padStart(2, "0")}`}：${scheme.prompt}`).join("\n\n");
      }
      if (!prompt) throw new Error("AI 没有返回可用 Prompt。");
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: error instanceof Error && error.name === "AbortError" ? "AI Prompt 已停止。" : error instanceof Error ? error.message : "AI Prompt 失败。", generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const source = cleaned.nodes.find((node) => node.id === id);
      if (!source) return state;
      if (source.data.generationId !== generationId || source.data.runState !== "running") return state;

      let currentZIndex = state.globalZIndex;
      const generatedAt = Date.now();
      const promptPayloads = generatedSchemes.length ? generatedSchemes : [{ prompt, title: "Prompt" }];
      const positions = generatedSchemes.length > 1 ? findGeneratedOutputPositions(source, cleaned.nodes, promptPayloads.length) : [findSingleOutputPosition(source, cleaned.nodes)];
      const promptNodes = promptPayloads.map((scheme, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        return makeNode(
          `prompt-generated-${generatedAt}-${index + 1}-${Math.round(Math.random() * 1000)}`,
          "prompt",
          positions[index],
          currentZIndex,
          {
            generatedBy: id,
            prompt: scheme.prompt,
            runState: "completed",
            title: scheme.title || "Prompt"
          }
        );
      });
      const promptEdges: Edge[] = promptNodes.map((promptNode, index) => ({
        id: `edge-prompt-generated-${generatedAt}-${index + 1}`,
        source: id,
        target: promptNode.id,
        sourceHandle: "text-out",
        targetHandle: "text-in",
        type: "deletable",
        selected: false,
        data: { generatedBy: id, portType: "text" }
      }));

      return {
        globalZIndex: currentZIndex,
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...cleaned.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt, runState: "completed" as const } } : node)),
          ...promptNodes
        ],
        edges: [
          ...cleaned.edges,
          ...promptEdges
        ]
      };
    });
  },
  runSceneDirectorNode: async (id, generationId) => {
    const snapshot = syncMentionImageEdgesForRunningTarget(id, generationId, get, set);
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    const inputNodes = getAgentInputNodesWithMentionedImages(snapshot.nodes, snapshot.edges, id);
    const referenceImages = getReferenceImageNodes(inputNodes).map((node) => ({
      imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
      url: node.data.imageUrl as string
    }));
    const instruction = inputNodes
      .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim())
      .map((node) => node.data.prompt)
      .join("\n\n")
      .trim();

    if (!referenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接 Image 图框。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (!instruction) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接导演说明 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    let prompt = "";
    let generatedSchemes: Array<{ prompt: string; title?: string }> = [];
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      const response = await fetch("/api/ai/scene-director", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages,
          instruction,
          model: typeof source.data.modelId === "string" ? source.data.modelId : defaultSceneDirectorModel,
          params: source.data.modelParams ?? {},
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const responseText = await response.text();
      let payload: { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      try {
        payload = JSON.parse(responseText) as { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `Scene Director 失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      if (!response.ok) throw new Error(payload.error || `Scene Director 失败：${response.status}`);
      generatedSchemes = Array.isArray(payload.schemes)
        ? payload.schemes
            .map((scheme) => ({
              prompt: typeof scheme.prompt === "string" ? scheme.prompt.trim() : "",
              title: typeof scheme.title === "string" ? scheme.title.trim() : undefined
            }))
            .filter((scheme) => scheme.prompt)
        : [];
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt && generatedSchemes.length) {
        prompt = generatedSchemes.map((scheme, index) => `${scheme.title || `Scene ${String(index + 1).padStart(2, "0")}`}：${scheme.prompt}`).join("\n\n");
      }
      if (!generatedSchemes.length && prompt) generatedSchemes = [{ prompt, title: "Scene Prompt" }];
      if (!prompt || !generatedSchemes.length) throw new Error("Scene Director 没有返回可用 Prompt。");
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: error instanceof Error && error.name === "AbortError" ? "Scene Director 已停止。" : error instanceof Error ? error.message : "Scene Director 失败。", generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const source = cleaned.nodes.find((node) => node.id === id);
      if (!source) return state;
      if (source.data.generationId !== generationId || source.data.runState !== "running") return state;

      let currentZIndex = state.globalZIndex;
      const generatedAt = Date.now();
      const positions = generatedSchemes.length > 1 ? findGeneratedOutputPositions(source, cleaned.nodes, generatedSchemes.length) : [findSingleOutputPosition(source, cleaned.nodes)];
      const promptNodes = generatedSchemes.map((scheme, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        return makeNode(
          `prompt-scene-director-${generatedAt}-${index + 1}-${Math.round(Math.random() * 1000)}`,
          "prompt",
          positions[index],
          currentZIndex,
          {
            generatedBy: id,
            prompt: scheme.prompt,
            runState: "completed",
            title: scheme.title || `Scene ${String(index + 1).padStart(2, "0")}`
          }
        );
      });
      const promptEdges: Edge[] = promptNodes.map((promptNode, index) => ({
        id: `edge-scene-director-${generatedAt}-${index + 1}`,
        source: id,
        target: promptNode.id,
        sourceHandle: "text-out",
        targetHandle: "text-in",
        type: "deletable",
        selected: false,
        data: { generatedBy: id, portType: "text" }
      }));

      return {
        globalZIndex: currentZIndex,
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...cleaned.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt, runState: "completed" as const } } : node)),
          ...promptNodes
        ],
        edges: [
          ...cleaned.edges,
          ...promptEdges
        ]
      };
    });
  },
  runTaobaoPageDirectorNode: async (id, generationId) => {
    const snapshot = syncMentionImageEdgesForRunningTarget(id, generationId, get, set);
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    const inputNodes = getAgentInputNodesWithMentionedImages(snapshot.nodes, snapshot.edges, id);
    const instruction = inputNodes
      .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim())
      .map((node) => node.data.prompt)
      .join("\n\n")
      .trim();
    const referenceImageNodes = getTaobaoReferenceImageNodes(inputNodes, instruction);
    const referenceImages = await Promise.all(referenceImageNodes.map(async (node) => ({
      imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
      title: typeof node.data.title === "string" ? node.data.title : undefined,
      url: await prepareTaobaoPlannerImageUrl(node.data.imageUrl as string)
    })));

    if (!referenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接商品 Image 图框。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (!instruction) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接淘宝图片页说明 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    let prompt = "";
    let generatedSchemes: Array<{ prompt: string; title?: string }> = [];
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      const response = await fetch("/api/ai/taobao-page-director", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages,
          instruction,
          model: typeof source.data.modelId === "string" ? source.data.modelId : defaultTaobaoPageDirectorModel,
          params: source.data.modelParams ?? {},
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const responseText = await response.text();
      let payload: { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      try {
        payload = JSON.parse(responseText) as { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `Taobao Page Director 失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      if (!response.ok) throw new Error(payload.error || `Taobao Page Director 失败：${response.status}`);
      generatedSchemes = Array.isArray(payload.schemes)
        ? payload.schemes
            .map((scheme) => ({
              prompt: typeof scheme.prompt === "string" ? scheme.prompt.trim() : "",
              title: typeof scheme.title === "string" ? scheme.title.trim() : undefined
            }))
            .filter((scheme) => scheme.prompt)
        : [];
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt && generatedSchemes.length) {
        prompt = generatedSchemes.map((scheme, index) => `${scheme.title || `淘宝图${String(index + 1).padStart(2, "0")}`}：${scheme.prompt}`).join("\n\n");
      }
      if (!generatedSchemes.length && prompt) generatedSchemes = [{ prompt, title: "Taobao Page Prompt" }];
      if (!prompt || !generatedSchemes.length) throw new Error("Taobao Page Director 没有返回可用 Prompt。");
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: error instanceof Error && error.name === "AbortError" ? "Taobao Page Director 已停止。" : error instanceof Error ? error.message : "Taobao Page Director 失败。", generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const source = cleaned.nodes.find((node) => node.id === id);
      if (!source) return state;
      if (source.data.generationId !== generationId || source.data.runState !== "running") return state;

      let currentZIndex = state.globalZIndex;
      const generatedAt = Date.now();
      const positions = generatedSchemes.length > 1 ? findGeneratedOutputPositions(source, cleaned.nodes, generatedSchemes.length) : [findSingleOutputPosition(source, cleaned.nodes)];
      const promptNodes = generatedSchemes.map((scheme, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        return makeNode(
          `prompt-taobao-page-director-${generatedAt}-${index + 1}-${Math.round(Math.random() * 1000)}`,
          "prompt",
          positions[index],
          currentZIndex,
          {
            generatedBy: id,
            prompt: scheme.prompt,
            promptRichHtml: buildTaobaoPromptRichHtml(scheme.prompt),
            runState: "completed",
            title: scheme.title || `淘宝图${String(index + 1).padStart(2, "0")}`
          }
        );
      });
      const promptEdges: Edge[] = promptNodes.map((promptNode, index) => ({
        id: `edge-taobao-page-director-${generatedAt}-${index + 1}`,
        source: id,
        target: promptNode.id,
        sourceHandle: "text-out",
        targetHandle: "text-in",
        type: "deletable",
        selected: false,
        data: { generatedBy: id, portType: "text" }
      }));

      return {
        globalZIndex: currentZIndex,
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...cleaned.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt, runState: "completed" as const } } : node)),
          ...promptNodes
        ],
        edges: [
          ...cleaned.edges,
          ...promptEdges
        ]
      };
    });
  },
  runIndustrialDesignerNode: async (id, generationId) => {
    const snapshot = syncMentionImageEdgesForRunningTarget(id, generationId, get, set);
    const source = snapshot.nodes.find((node) => node.id === id);
    if (!source) return;

    const inputNodes = getAgentInputNodesWithMentionedImages(snapshot.nodes, snapshot.edges, id);
    const referenceImages = getReferenceImageNodes(inputNodes).map((node) => ({
      imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
      title: typeof node.data.title === "string" ? node.data.title : undefined,
      url: node.data.imageUrl as string
    }));
    const instruction = inputNodes
      .filter((node) => typeof node.data.prompt === "string" && node.data.prompt.trim())
      .map((node) => node.data.prompt)
      .join("\n\n")
      .trim();

    if (!referenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接 Image 图框。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (!instruction) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先连接设计需求 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }

    let prompt = "";
    let generatedSchemes: Array<{ prompt: string; title?: string }> = [];
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      const response = await fetch("/api/ai/industrial-designer", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: referenceImages,
          instruction,
          model: typeof source.data.modelId === "string" ? source.data.modelId : defaultIndustrialDesignerModel,
          params: source.data.modelParams ?? {},
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal
      });
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      const responseText = await response.text();
      let payload: { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      try {
        payload = JSON.parse(responseText) as { prompt?: string; schemes?: Array<{ prompt?: string; title?: string }>; error?: string };
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `Industrial Designer 失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      if (!response.ok) throw new Error(payload.error || `Industrial Designer 失败：${response.status}`);
      generatedSchemes = Array.isArray(payload.schemes)
        ? payload.schemes
            .map((scheme) => ({
              prompt: typeof scheme.prompt === "string" ? scheme.prompt.trim() : "",
              title: typeof scheme.title === "string" ? scheme.title.trim() : undefined
            }))
            .filter((scheme) => scheme.prompt)
        : [];
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt && generatedSchemes.length) {
        prompt = generatedSchemes.map((scheme, index) => `${scheme.title || `方案${String(index + 1).padStart(2, "0")}`}：${scheme.prompt}`).join("\n\n");
      }
      if (!generatedSchemes.length && prompt) generatedSchemes = [{ prompt, title: "Industrial Design Prompt" }];
      if (!prompt || !generatedSchemes.length) throw new Error("Industrial Designer 没有返回可用 Prompt。");
    } catch (error) {
      generationControllers.delete(id);
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? { ...node, data: { ...node.data, errorMessage: error instanceof Error && error.name === "AbortError" ? "Industrial Designer 已停止。" : error instanceof Error ? error.message : "Industrial Designer 失败。", generationId: undefined, runState: error instanceof Error && error.name === "AbortError" ? "idle" as const : "failed" as const } }
            : node
        ))
      }));
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const source = cleaned.nodes.find((node) => node.id === id);
      if (!source) return state;
      if (source.data.generationId !== generationId || source.data.runState !== "running") return state;

      let currentZIndex = state.globalZIndex;
      const generatedAt = Date.now();
      const positions = generatedSchemes.length > 1 ? findGeneratedOutputPositions(source, cleaned.nodes, generatedSchemes.length) : [findSingleOutputPosition(source, cleaned.nodes)];
      const promptNodes = generatedSchemes.map((scheme, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        return makeNode(
          `prompt-industrial-designer-${generatedAt}-${index + 1}-${Math.round(Math.random() * 1000)}`,
          "prompt",
          positions[index],
          currentZIndex,
          {
            generatedBy: id,
            prompt: scheme.prompt,
            runState: "completed",
            title: scheme.title || `方案${String(index + 1).padStart(2, "0")}`
          }
        );
      });
      const promptEdges: Edge[] = promptNodes.map((promptNode, index) => ({
        id: `edge-industrial-designer-${generatedAt}-${index + 1}`,
        source: id,
        target: promptNode.id,
        sourceHandle: "text-out",
        targetHandle: "text-in",
        type: "deletable",
        selected: false,
        data: { generatedBy: id, portType: "text" }
      }));

      return {
        globalZIndex: currentZIndex,
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...cleaned.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt, runState: "completed" as const } } : node)),
          ...promptNodes
        ],
        edges: [
          ...cleaned.edges,
          ...promptEdges
        ]
      };
    });
  },
  stopGenerateImageNode: (id) => {
    generationControllers.get(id)?.abort();
    generationControllers.delete(id);
    set((state) => ({
      nodes: state.nodes.map((node) => (
        node.id === id
          ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, runState: "idle" as const } }
          : node
      ))
    }));
  },
  updateNodeData: (id, data, options) => {
    if (options?.record) {
      set((state) => ({
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: state.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...data } } : node))
      }));
      return;
    }
    set((state) => ({
      nodes: state.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...data } } : node))
    }));
  },
  bringNodesToFront: (ids) => {
    if (!ids.length) return;
    set((state) => {
      let zIndex = state.globalZIndex;
      const idSet = new Set(ids);
      const nodes = state.nodes.map((node) => {
        if (!idSet.has(node.id)) return node;
        zIndex = nextZIndex(zIndex);
        return { ...node, zIndex, data: { ...node.data, zIndex } };
      });
      return { nodes, globalZIndex: zIndex };
    });
  },
  duplicateSelected: (offset = { x: 34, y: 34 }) => {
    set((state) => {
      const sourceNodes = state.nodes.filter((node) => node.selected);
      if (!sourceNodes.length) return state;
      const { copiedNodes, zIndex } = makeCopiedNodes(sourceNodes, state.nodes, state.globalZIndex, offset);
      if (!copiedNodes.length) return state;
      return {
        activeEdgeId: null,
        edges: state.edges.map((edge) => ({ ...edge, selected: false })),
        globalZIndex: zIndex,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...state.nodes.map((node) => ({ ...node, selected: false })),
          ...copiedNodes.map((node) => ({ ...node, data: { ...node.data, motionState: "duplicating" as const } }))
        ]
      };
    });
  },
  pasteNodes: (sourceNodes, offset = { x: 34, y: 34 }) => {
    set((state) => {
      if (!sourceNodes.length) return state;
      const { copiedNodes, zIndex } = makeCopiedNodes(sourceNodes, state.nodes, state.globalZIndex, offset);
      if (!copiedNodes.length) return state;
      return {
        activeEdgeId: null,
        edges: state.edges.map((edge) => ({ ...edge, selected: false })),
        globalZIndex: zIndex,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          ...state.nodes.map((node) => ({ ...node, selected: false })),
          ...copiedNodes.map((node) => ({ ...node, data: { ...node.data, motionState: "duplicating" as const } }))
        ]
      };
    });
  },
  deleteSelected: () => {
    let selectedNodeIdsForRemoval = new Set<string>();
    let selectedEdgeIdsForRemoval = new Set<string>();
    set((state) => {
      const selectedNodeIds = new Set(state.nodes.filter((node) => node.selected && !isRunningLockingNode(node)).map((node) => node.id));
      const selectedEdgeIds = new Set(state.edges.filter((edge) => edge.selected && !edgeTouchesRunningLockingNode(edge, state.nodes)).map((edge) => edge.id));
      if (!selectedNodeIds.size && !selectedEdgeIds.size) return state;
      selectedNodeIdsForRemoval = selectedNodeIds;
      selectedEdgeIdsForRemoval = selectedEdgeIds;
      return {
        activeEdgeId: selectedEdgeIds.has(state.activeEdgeId ?? "") ? null : state.activeEdgeId,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: state.nodes.map((node) => selectedNodeIds.has(node.id) ? { ...node, data: { ...node.data, motionState: "deleting" as const } } : node),
        edges: state.edges.map((edge) => selectedEdgeIds.has(edge.id) ? { ...edge, data: { ...(edge.data ?? {}), motionState: "deleting" } } : edge)
      };
    });
    if (!selectedNodeIdsForRemoval.size && !selectedEdgeIdsForRemoval.size) return;
    const timer = setTimeout(() => {
      deleteAnimationTimers.delete(timer);
      set((state) => ({
        nodes: state.nodes.filter((node) => !selectedNodeIdsForRemoval.has(node.id)),
        edges: state.edges.filter((edge) => (
          !selectedEdgeIdsForRemoval.has(edge.id) &&
          !selectedNodeIdsForRemoval.has(edge.source) &&
          !selectedNodeIdsForRemoval.has(edge.target)
        ))
      }));
    }, 140);
    deleteAnimationTimers.add(timer);
  },
  groupSelected: () => {
    set((state) => {
      const selectedNodes = state.nodes.filter((node) => node.selected && node.data.kind !== "group");
      if (selectedNodes.length < 2) return state;
      const minX = Math.min(...selectedNodes.map((node) => node.position.x));
      const minY = Math.min(...selectedNodes.map((node) => node.position.y));
      const maxX = Math.max(...selectedNodes.map((node) => node.position.x + getNodeSize(node).width));
      const maxY = Math.max(...selectedNodes.map((node) => node.position.y + getNodeSize(node).height));
      const groupId = `group-${Date.now()}`;
      const zIndex = Math.max(0, Math.min(...selectedNodes.map((node) => node.zIndex ?? 1)) - 1);
      const selectedIds = new Set(selectedNodes.map((node) => node.id));
      const group = makeNode(groupId, "group", { x: minX - 26, y: minY - 26 }, zIndex, {
        memberIds: Array.from(selectedIds),
        selected: true,
        title: "Group",
        width: maxX - minX + 52,
        height: maxY - minY + 52
      } as Partial<CanvasNodeData>);
      return {
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: [
          group,
          ...state.nodes.map((node) => ({ ...node, selected: false }))
        ],
        globalZIndex: state.globalZIndex
      };
    });
  },
  ungroupSelected: () => {
    set((state) => {
      const selectedGroups = state.nodes.filter((node) => node.selected && node.data.kind === "group");
      if (!selectedGroups.length) return state;
      const groupById = new Map(selectedGroups.map((node) => [node.id, node]));
      return {
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: state.nodes.filter((node) => !groupById.has(node.id)).map((node) => ({ ...node, selected: false }))
      };
    });
  },
  autoArrangeSelected: () => {
    set((state) => {
      const selectedNodes = state.nodes.filter((node) => node.selected && node.data.kind !== "group");
      if (selectedNodes.length < 2) return state;
      if (selectedNodes.some((node) => (node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director") && node.data.runState === "running")) return state;

      const useWorkflowLayout = selectedNodes.some((node) => node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "visual_director" || node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix");
      const positions = useWorkflowLayout
        ? layoutColumns(selectedNodes, getWorkflowColumns(selectedNodes, state.edges))
        : layoutGrid(selectedNodes);
      if (!positions.size) return state;

      return {
        activeEdgeId: null,
        historyPast: pushHistory(state),
        historyFuture: [],
        nodes: state.nodes.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position } : node;
        })
      };
    });
  },
  resetCanvas: (options) => {
    set((state) => ({
      projectTitle: options?.title ?? "未命名项目",
      nodes: options?.blank ? [] : createInitialNodes(),
      edges: options?.blank ? [] : createInitialEdges(),
      viewport: { x: 0, y: 0, zoom: 1 },
      zoom: 1,
      addMenuOpen: false,
      addMenuPosition: { x: 110, y: 170 },
      globalZIndex: 5,
      activeEdgeId: null,
      historyPast: options?.record ? pushHistory(state) : state.historyPast,
      historyFuture: []
    }));
  }
}));
