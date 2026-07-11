import { create } from "zustand";
import type { Edge, Node, Viewport, XYPosition } from "@xyflow/react";
import { getApiSettingsForModel, getBaseModelId, getClientAiSettingsPayload } from "@/lib/clientAiSettings";
import { addClientGeneratedImages } from "@/lib/clientGeneratedImages";
import { defaultIndustrialDesignImageModelId, defaultProductRemixModelId, defaultSceneImageModelId, getDefaultIndustrialDesignImageParams, getDefaultProductRemixParams, getDefaultSceneImageParams, getReferenceImageLimit } from "@/lib/generateImageModels";
import { nodeLabels, type CanvasNodeData, type NodeKind } from "@/lib/nodeTypes";
import { buildVisibleTextPromptRichHtml } from "@/lib/promptHighlight";
import { nextZIndex } from "@/lib/zIndex";

const historyLimit = 10;
const outputNodeGap = 32;
const outputNodeColumnGap = 36;
const outputNodeInitialGap = 56;
const outputNodeWidth = 320;
const outputNodeNearbyColumns = 2;
const imageNodeHeight = 260;
const promptNodeHeight = 260;
const generatedOutputRows = 2;
const maxImageNumber = 100;
const maxReferenceImageInputs = 12;
const maxTaobaoPlannerImageInputs = 10;
const generationClientPreviewMaxEdge = 2200;
const generationClientTotalDataUrlLength = 4_000_000;
const generationClientMaxSingleDataUrlLength = 3_600_000;
const generationClientMinSingleDataUrlLength = 260_000;
const taobaoClientPreviewMaxEdge = 1400;
const generationControllers = new Map<string, AbortController>();
const deleteAnimationTimers = new Set<ReturnType<typeof setTimeout>>();
const hostedImageGenerationMaxWaitMs = 30 * 60 * 1000;
const hostedImageGenerationPollMs = 5000;
const defaultAiPromptModel = "gemini-2.5-flash";
const defaultSceneDirectorModel = "gemini-2.5-flash";
const defaultTaobaoPageDirectorModel = "gemini-2.5-flash";
const defaultIndustrialDesignerModel = "gemini-2.5-flash";
const defaultProductPosterModel = "gemini-2.5-flash";
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
  return (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" || node.data.kind === "visual_director") && node.data.runState === "running";
}

function edgeTouchesRunningLockingNode(edge: Pick<Edge, "source" | "target">, nodes: Node<CanvasNodeData>[]) {
  return nodes.some((node) => (node.id === edge.source || node.id === edge.target) && isRunningLockingNode(node));
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function getRequestedImageCount(params?: Record<string, string>) {
  const count = Number(params?.imageCount);
  return Number.isFinite(count) ? Math.min(6, Math.max(1, Math.round(count))) : 1;
}

function normalizeDirect12AiBaseUrl(value?: string) {
  const baseUrl = (value || "https://cdn.12ai.org").trim().replace(/\/+$/, "");
  if (!baseUrl) return "";
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function is12AiDirectBaseUrl(value?: string) {
  try {
    const hostname = new URL(value || "https://cdn.12ai.org").hostname;
    return hostname === "cdn.12ai.org" || hostname === "api.12ai.org" || hostname.endsWith(".12ai.org");
  } catch {
    return false;
  }
}

function isDirectGeminiImageModel(model?: unknown) {
  return model === "gemini-3.1-flash-image" || model === "gemini-3.1-flash-image-preview" || model === "gemini-3.1-flash-lite-image" || model === "gemini-3-pro-image" || model === "gemini-3-pro-image-preview";
}

function isDirectGptImageModel(model?: unknown) {
  return model === "gpt-image-2";
}

function getDirectImageCount(value?: string) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(6, Math.max(1, Math.round(count))) : 1;
}

function getDirectGeminiImageSize(params?: Record<string, string>) {
  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    const longEdge = Math.max(targetWidth, targetHeight);
    if (longEdge <= 768) return "512";
    if (longEdge <= 1536) return "1K";
    if (longEdge <= 2560) return "2K";
    return "4K";
  }
  const value = params?.resolution ?? "1K";
  return ["512", "1K", "2K", "4K"].includes(value) ? value : "1K";
}

function getDirectQuality(value?: string) {
  const normalized = (value ?? "Auto").toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "auto";
}

function getDirectGptSize(params?: Record<string, string>) {
  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    const maxEdge = 3840;
    const maxPixels = 8294400;
    const edgeScale = Math.min(1, maxEdge / Math.max(targetWidth, targetHeight));
    const pixelScale = Math.min(1, Math.sqrt(maxPixels / (targetWidth * targetHeight)));
    const scale = Math.min(edgeScale, pixelScale);
    const toMultipleOf16 = (value: number) => Math.max(64, Math.floor(value * scale / 16) * 16);
    return `${toMultipleOf16(targetWidth)}x${toMultipleOf16(targetHeight)}`;
  }
  const resolution = params?.resolution ?? "1K";
  const ratioLabel = getDirectGeminiAspectRatio(params);
  const [ratioWidth, ratioHeight] = ratioLabel.split(":").map(Number);
  const ratioValue = ratioWidth / ratioHeight;
  const isSquare = ratioWidth === ratioHeight;
  const longEdge = resolution === "4K" ? 3840 : resolution === "2K" ? 2048 : isSquare ? 1024 : 1536;
  const width = ratioValue >= 1 ? longEdge : Math.round(longEdge * ratioValue);
  const height = ratioValue >= 1 ? Math.round(longEdge / ratioValue) : longEdge;
  const toMultipleOf16 = (value: number) => Math.max(64, Math.floor(value / 16) * 16);
  return `${toMultipleOf16(width)}x${toMultipleOf16(height)}`;
}

function getDirectGeminiAspectRatio(params?: Record<string, string>) {
  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  const rawValue = Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0
    ? targetWidth / targetHeight
    : (() => {
        const match = (params?.aspectRatio ?? "Auto").match(/(\d+):(\d+)/);
        if (!match) return 1;
        const width = Number(match[1]);
        const height = Number(match[2]);
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 1;
      })();
  const ratios = [
    { label: "1:1", value: 1 },
    { label: "2:3", value: 2 / 3 },
    { label: "3:2", value: 3 / 2 },
    { label: "3:4", value: 3 / 4 },
    { label: "4:3", value: 4 / 3 },
    { label: "4:5", value: 4 / 5 },
    { label: "5:4", value: 5 / 4 },
    { label: "9:16", value: 9 / 16 },
    { label: "16:9", value: 16 / 9 },
    { label: "21:9", value: 21 / 9 }
  ];
  return ratios.reduce((best, ratio) => Math.abs(ratio.value - rawValue) < Math.abs(best.value - rawValue) ? ratio : best, ratios[0]).label;
}

function getDirectTaskId(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const candidates = [record.task_id, record.id, record.request_id, data.task_id, data.id];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate)) ?? "";
}

function getDirectTaskStatus(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const status = record.status ?? record.state ?? data.status ?? data.state;
  return typeof status === "string" ? status.toLowerCase() : "";
}

function getDirectTaskError(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const error = record.error ?? record.message ?? data.error ?? data.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return "";
}

function collectDirectImages(value: unknown, images: Array<{ url: string }>, keyHint = "", depth = 0, visited = new WeakSet<object>()) {
  if (!value || depth > 20 || images.length > 32) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("data:image/")) {
      images.push({ url: trimmed });
      return;
    }
    if (/^https?:\/\//.test(trimmed) && ["url", "uri", "image_url", "imageUrl", "file_url", "signed_url", "output_url", "download_url", "output", "outputs", "image", "images", "result", "results"].includes(keyHint)) {
      images.push({ url: trimmed });
      return;
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDirectImages(item, images, keyHint, depth + 1, visited));
    return;
  }
  if (typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string") images.push({ url: record.url });
  if (typeof record.b64_json === "string") images.push({ url: `data:image/png;base64,${record.b64_json.replace(/\s/g, "")}` });
  const inlineData = (record.inline_data ?? record.inlineData) as Record<string, unknown> | undefined;
  if (inlineData && typeof inlineData.data === "string") {
    images.push({ url: `data:${typeof inlineData.mime_type === "string" ? inlineData.mime_type : typeof inlineData.mimeType === "string" ? inlineData.mimeType : "image/png"};base64,${inlineData.data.replace(/\s/g, "")}` });
  }
  Object.entries(record).forEach(([key, child]) => collectDirectImages(child, images, key, depth + 1, visited));
}

function normalizeDirectImages(payload: unknown, expectedCount: number) {
  const images: Array<{ url: string }> = [];
  collectDirectImages(payload, images);
  return Array.from(new Map(images.map((image) => [image.url, image])).values()).slice(0, expectedCount);
}

async function readDirect12AiPayload(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readDirect12AiError(response: Response) {
  const payload = await readDirect12AiPayload(response);
  const error = getDirectTaskError(payload);
  return error || `12AI 请求失败：${response.status}`;
}

async function requestDirect12AiGeneratedImages(body: Record<string, unknown>, controller: AbortController) {
  const model = getBaseModelId(typeof body.model === "string" ? body.model : "") ?? "";
  const aiSettings = body.aiSettings as ReturnType<typeof getClientAiSettingsPayload>;
  const settings = getApiSettingsForModel(aiSettings, typeof body.model === "string" ? body.model : "");
  const apiKey = settings?.apiKey?.trim() ?? "";
  const baseUrl = settings?.baseUrl?.trim() || "https://cdn.12ai.org";
  if (body.mode !== "submit" || (!isDirectGeminiImageModel(model) && !isDirectGptImageModel(model)) || !apiKey || !is12AiDirectBaseUrl(baseUrl)) return null;

  const params = body.params as Record<string, string> | undefined;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const images = Array.isArray(body.images) ? body.images.filter((image): image is string => typeof image === "string" && Boolean(image)) : [];
  const expectedCount = getDirectImageCount(params?.imageCount);
  const v1BaseUrl = normalizeDirect12AiBaseUrl(baseUrl);

  if (isDirectGptImageModel(model)) {
    const input: Record<string, unknown> = {
      prompt,
      quality: getDirectQuality(params?.quality),
      response_format: "url",
      size: getDirectGptSize(params)
    };
    if (images.length) input.images = images;
    if (expectedCount > 1) input.n = expectedCount;
    const response = await fetch(`${v1BaseUrl}/task/submit`, {
      body: JSON.stringify({ input, model }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(await readDirect12AiError(response));
    let taskPayload = await readDirect12AiPayload(response);
    const submitImages = normalizeDirectImages(taskPayload, expectedCount);
    if (submitImages.length) return submitImages;
    const taskId = getDirectTaskId(taskPayload);
    if (!taskId) throw new Error("12AI 没有返回任务 ID。");

    const startedAt = Date.now();
    while (Date.now() - startedAt < hostedImageGenerationMaxWaitMs) {
      await delay(hostedImageGenerationPollMs, controller.signal);
      const taskResponse = await fetch(`${v1BaseUrl}/task/${encodeURIComponent(taskId)}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        method: "GET",
        signal: controller.signal
      });
      if (!taskResponse.ok) throw new Error(await readDirect12AiError(taskResponse));
      taskPayload = await readDirect12AiPayload(taskResponse);
      const status = getDirectTaskStatus(taskPayload);
      const taskImages = normalizeDirectImages(taskPayload, expectedCount);
      if (taskImages.length && ["", "success", "succeeded", "completed", "done", "partial_completed"].includes(status)) return taskImages;
      if (["success", "succeeded", "completed", "done"].includes(status) && !taskImages.length) throw new Error("12AI 任务已完成，但没有返回图片。");
      if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new Error(getDirectTaskError(taskPayload) || "12AI 任务失败。");
    }
    throw new Error("12AI 生成超过 30 分钟仍未返回图片。");
  }

  const submitEndpoint = `${v1BaseUrl}/task/submit`;
  const input: Record<string, unknown> = {
    aspect_ratio: getDirectGeminiAspectRatio(params),
    image_size: getDirectGeminiImageSize(params),
    prompt
  };
  if (images.length) input.images = images;
  const submitResponse = await fetch(submitEndpoint, {
    body: JSON.stringify({ input, model }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    method: "POST",
    signal: controller.signal
  });
  if (!submitResponse.ok) throw new Error(await readDirect12AiError(submitResponse));
  let taskPayload = await readDirect12AiPayload(submitResponse);
  const taskId = getDirectTaskId(taskPayload);
  const submitImages = normalizeDirectImages(taskPayload, expectedCount);
  if (submitImages.length) return submitImages;
  if (!taskId) throw new Error("12AI 没有返回任务 ID。");

  const startedAt = Date.now();
  while (Date.now() - startedAt < hostedImageGenerationMaxWaitMs) {
    await delay(hostedImageGenerationPollMs, controller.signal);
    const taskResponse = await fetch(`${v1BaseUrl}/task/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      method: "GET",
      signal: controller.signal
    });
    if (!taskResponse.ok) throw new Error(await readDirect12AiError(taskResponse));
    taskPayload = await readDirect12AiPayload(taskResponse);
    const status = getDirectTaskStatus(taskPayload);
    const taskImages = normalizeDirectImages(taskPayload, expectedCount);
    if (taskImages.length && ["", "success", "succeeded", "completed", "done", "partial_completed"].includes(status)) return taskImages;
    if (["success", "succeeded", "completed", "done"].includes(status) && !taskImages.length) throw new Error("12AI 任务已完成，但没有返回图片。");
    if (["failed", "error", "cancelled", "canceled"].includes(status)) throw new Error(getDirectTaskError(taskPayload) || "12AI 任务失败。");
  }
  throw new Error("12AI 生成超过 30 分钟仍未返回图片。");
}

async function prepareProxyGeneratedImagesBody(body: Record<string, unknown>) {
  if (!Array.isArray(body.images)) return body;
  const images = body.images.filter((image): image is string => typeof image === "string" && Boolean(image));
  if (!images.length) return body;
  return {
    ...body,
    images: await prepareGenerationReferenceImageUrls(images)
  };
}

async function requestGeneratedImages(body: Record<string, unknown>, controller: AbortController) {
  const aiSettings = body.aiSettings as ReturnType<typeof getClientAiSettingsPayload>;
  const rawModel = typeof body.model === "string" ? body.model : "";
  const requestBody = {
    ...body,
    aiSettings: aiSettings ? { ...aiSettings, settings: getApiSettingsForModel(aiSettings, rawModel) ?? aiSettings.settings } : aiSettings,
    model: getBaseModelId(rawModel)
  };
  try {
    const directImages = await requestDirect12AiGeneratedImages(requestBody, controller);
    if (directImages) return directImages;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }

  const proxyBody = await prepareProxyGeneratedImagesBody(requestBody);
  const directResponse = await fetch("/api/ai/generate-image", {
    body: JSON.stringify(proxyBody),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: controller.signal
  });
  const directText = await directResponse.text();
  let directPayload: { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string; expectedCount?: number; status?: string; taskIds?: string[] };
  try {
    directPayload = JSON.parse(directText) as { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string; expectedCount?: number; status?: string; taskIds?: string[] };
  } catch {
    const fallback = directText.trim().replace(/\s+/g, " ").slice(0, 160);
    throw new Error(directResponse.ok ? "AI 服务返回格式异常。" : `AI 生成失败：${directResponse.status}${fallback ? ` ${fallback}` : ""}`);
  }
  if (!directResponse.ok && directResponse.status !== 202) throw new Error(directPayload.error || `AI 生成失败：${directResponse.status}`);
  const directImages = (directPayload.images ?? []).map((image) => ({ url: image.url ?? "" })).filter((image) => Boolean(image.url));
  if (directImages.length) return directImages;

  const taskIds = directPayload.taskIds ?? [];
  if (!taskIds.length) throw new Error(directPayload.error || "AI 服务没有返回图片。");

  const expectedCount = Math.max(1, Number(directPayload.expectedCount ?? getRequestedImageCount(body.params as Record<string, string> | undefined)) || taskIds.length);
  const startedAt = Date.now();
  while (Date.now() - startedAt < hostedImageGenerationMaxWaitMs) {
    await delay(hostedImageGenerationPollMs, controller.signal);
    const pollResponse = await fetch("/api/ai/generate-image", {
      body: JSON.stringify({
        aiSettings: body.aiSettings,
        expectedCount,
        mode: "poll",
        model: body.model,
        prompt: body.prompt,
        sourceNodeId: body.sourceNodeId,
        taskIds
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
    const pollText = await pollResponse.text();
    let pollPayload: { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string; status?: string };
    try {
      pollPayload = JSON.parse(pollText) as { debug?: { mode?: string; size?: string }; images?: Array<{ url?: string }>; error?: string; status?: string };
    } catch {
      const fallback = pollText.trim().replace(/\s+/g, " ").slice(0, 160);
      throw new Error(pollResponse.ok ? "AI 服务返回格式异常。" : `AI 生成失败：${pollResponse.status}${fallback ? ` ${fallback}` : ""}`);
    }
    if (!pollResponse.ok && pollResponse.status !== 202) throw new Error(pollPayload.error || `AI 生成失败：${pollResponse.status}`);
    const images = (pollPayload.images ?? []).map((image) => ({ url: image.url ?? "" })).filter((image) => Boolean(image.url));
    if (images.length >= expectedCount || (pollResponse.ok && images.length)) return images;
  }
  throw new Error("AI 生成超过 30 分钟仍未返回图片，请稍后重试或检查后台任务状态。");
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

function replaceImageMentionNumbers(text: string, imageNumberMap: Map<number, number>) {
  if (!imageNumberMap.size) return text;
  return text.replace(/(@(?:image\s*)?|<\s*image\s*)(\d{1,3})(\s*>)?/gi, (match, prefix: string, rawNumber: string, suffix = "") => {
    const nextNumber = imageNumberMap.get(Number(rawNumber));
    if (!nextNumber) return match;
    return `${prefix}${String(nextNumber).padStart(rawNumber.length, "0")}${suffix}`;
  });
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
  const imageNumberMap = new Map<number, number>();
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
      const previousImageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined;
      const imageNumber = getNextImageNumber([...baseNodes, ...copiedNodes], reservedImageNumbers);
      if (imageNumber) {
        reservedImageNumbers.add(imageNumber);
        nextData.imageNumber = imageNumber;
        if (previousImageNumber) imageNumberMap.set(previousImageNumber, imageNumber);
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

  copiedNodes.forEach((node) => {
    if (typeof node.data.prompt !== "string") return;
    node.data = {
      ...node.data,
      prompt: replaceImageMentionNumbers(node.data.prompt, imageNumberMap)
    };
    if (typeof node.data.promptRichHtml === "string") delete node.data.promptRichHtml;
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
    height: Number(node.data.height ?? (node.data.kind === "product_poster" ? 720 : node.data.kind === "taobaoPageDirector" ? 560 : node.data.kind === "sceneDirector" ? 760 : node.data.kind === "industrial_designer" ? 620 : node.data.kind === "visual_director" ? 400 : node.data.kind === "productRemix" ? 500 : node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" ? 430 : node.data.kind === "rhinoTest" ? 420 : node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" ? 390 : node.data.kind === "generateImage" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "imageChat" ? isIndustrialAiPrompt ? 420 : 360 : 260)),
    width: Number(node.data.width ?? (node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" ? 620 : node.data.kind === "visual_director" || node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" ? 420 : 320))
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
  const startX = source.position.x + sourceSize.width + outputNodeInitialGap;
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

  for (let columnOffset = 0; columnOffset < outputNodeNearbyColumns; columnOffset += 1) {
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
  const ids = new Set<string>();
  edges
      .filter((edge) => edge.source === sourceId)
      .map((edge) => nodeById.get(edge.target))
      .filter((node): node is Node<CanvasNodeData> => Boolean(node && node.data.generatedBy === sourceId))
      .forEach((node) => ids.add(node.id));
  return ids;
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

  for (let columnOffset = 0; columnOffset < outputNodeNearbyColumns; columnOffset += 1) {
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

function getMissingMentionImageNumbers(nodes: Node<CanvasNodeData>[], promptNodes: Node<CanvasNodeData>[]) {
  const existingNumbers = new Set<number>();
  nodes.forEach((node) => {
    if (node.data.kind === "image" && typeof node.data.imageNumber === "number") existingNumbers.add(node.data.imageNumber);
  });
  const missingNumbers: number[] = [];
  const seenMissing = new Set<number>();
  promptNodes.forEach((node) => {
    const prompt = typeof node.data.prompt === "string" ? node.data.prompt : "";
    parseImageMentionNumbers(prompt).forEach((imageNumber) => {
      if (existingNumbers.has(imageNumber) || seenMissing.has(imageNumber)) return;
      seenMissing.add(imageNumber);
      missingNumbers.push(imageNumber);
    });
  });
  return missingNumbers;
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

function getConnectedReferenceImageNodes(
  allNodes: Node<CanvasNodeData>[],
  inputEdges: Edge[],
  limit = maxReferenceImageInputs
) {
  const imageById = new Map(
    allNodes
      .filter((node) => node.data.kind === "image" && node.data.imageUrl)
      .map((node) => [node.id, node])
  );
  return sortNodesVisually(uniqueNodesById(
    inputEdges
      .filter((edge) => edge.targetHandle === "image-in")
      .map((edge) => imageById.get(edge.source))
      .filter((node): node is Node<CanvasNodeData> => Boolean(node))
  )).slice(0, limit);
}

function getPromptScopedReferenceImageNodes(
  allNodes: Node<CanvasNodeData>[],
  promptNodes: Node<CanvasNodeData>[],
  limit = maxReferenceImageInputs
) {
  return getPromptMentionedImageNodes(allNodes, promptNodes)
    .filter((node) => node.data.kind === "image" && node.data.imageUrl)
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
  if (!referenceImages.some((node) => node.id === primaryImage.id)) return referenceImages;
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

function getGenerationReferenceImageTargetLength(imageCount: number) {
  const safeCount = Math.max(1, imageCount);
  return Math.max(
    generationClientMinSingleDataUrlLength,
    Math.min(generationClientMaxSingleDataUrlLength, Math.floor(generationClientTotalDataUrlLength / safeCount))
  );
}

async function prepareGenerationReferenceImageUrl(imageUrl: string, targetDataUrlLength = generationClientMaxSingleDataUrlLength) {
  if (typeof window === "undefined" || !imageUrl.startsWith("data:image/")) return imageUrl;
  try {
    if (imageUrl.length <= targetDataUrlLength) return imageUrl;
    const image = await loadBrowserImage(imageUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return imageUrl;
    const variants = [
      { maxEdge: generationClientPreviewMaxEdge, quality: 0.9 },
      { maxEdge: 1800, quality: 0.86 },
      { maxEdge: 1500, quality: 0.82 },
      { maxEdge: 1280, quality: 0.78 },
      { maxEdge: 1024, quality: 0.74 },
      { maxEdge: 800, quality: 0.7 },
      { maxEdge: 640, quality: 0.66 }
    ];

    let best = imageUrl;
    for (const variant of variants) {
      const scale = Math.min(1, variant.maxEdge / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const next = canvas.toDataURL("image/jpeg", variant.quality);
      if (next.length < best.length) best = next;
      if (next.length <= targetDataUrlLength) return next;
    }
    return best;
  } catch {
    return imageUrl;
  }
}

async function prepareGenerationReferencePayloads<T extends { url: string }>(images: T[]) {
  const targetLength = getGenerationReferenceImageTargetLength(images.length);
  return Promise.all(images.map(async (image) => ({
    ...image,
    url: await prepareGenerationReferenceImageUrl(image.url, targetLength)
  })));
}

async function prepareGenerationReferenceImageUrls(imageUrls: string[]) {
  const targetLength = getGenerationReferenceImageTargetLength(imageUrls.length);
  return Promise.all(imageUrls.map((imageUrl) => prepareGenerationReferenceImageUrl(imageUrl, targetLength)));
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

const hdRedrawMergePrompt = [
  "任务：只基于输入的原图 A 生成一张中间结构参考图 B，用于后续高清重绘。B 图必须仍然是 A 图中的同一主体、同一背景、同一构图、同一角度、同一比例和同一可见细节。",
  "严格禁止：不要生成任何新场景、新街道、新建筑、新招牌、新文字、新道具、新人物、新产品或 A 图中不存在的元素。不要把画面改成插画场景、海报、漫画分镜、城市街景或其他题材。",
  "结构参考要求：用清晰边界表达 A 图中真实存在的物体轮廓、分区、材质边界和主要细节；边界必须与 A 图逐项对应，不能重新设计、不能改透视、不能改姿态、不能改主体关系。",
  "固有色参考要求：保留 A 图各区域的真实固有颜色关系，把复杂光影简化为清楚的色块参考；不要改变颜色归属，不要添加新的图案、文字或装饰。",
  "人物安全要求：如果 A 图包含人物，必须保持人物身份特征、姿态、服装、身体覆盖关系、发型和可见配饰不变；不要进行身体编辑、服饰编辑、暴露程度变化或任何敏感化处理。",
  "最终只输出一张 B 图：结构边界 + 固有色色块的参考合图。它是 A 图的结构化版本，不是重新创作。"
].join("\n\n");

function buildHdRedrawReversePromptInstruction(extraPrompt: string) {
  return [
    "请反推这张图片用于高清重绘的中文生图 Prompt。",
    "必须准确描述主体、结构、颜色、材质、细节、镜头角度、透视、构图、光线和画面风格。",
    "重点锁定原图角度、透视、主体比例、构图位置和所有可见结构，不能要求改变角度或重新设计。",
    "只输出一段自然中文 Prompt，不要字段模板，不要解释。",
    extraPrompt ? `用户补充要求：${extraPrompt}` : ""
  ].filter(Boolean).join("\n");
}

function buildHdRedrawFinalPrompt(reversePrompt: string, extraPrompt: string) {
  return [
    "请基于输入的原图 A 和结构色稿合图 B，生成高清重绘图 C。",
    "必须严格保持原图 A 的主体角度、透视关系、构图位置、物体比例、轮廓结构、边缘形态和可见细节，不得改变镜头角度，不得重新设计，不得增删主体元素。",
    "使用 B 图只作为内部结构、色块边界和固有色参考，不要把 B 图新增的黑色线稿、描边、轮廓线、草图线、漫画线、CAD 线框或分割线直接渲染到最终 C 图里。",
    "最终 C 图的线条风格必须严格参考原图 A：如果 A 图是自然照片、真实渲染、无黑色线稿、无描边、无漫画线、无 CAD 线框，那么 C 图也必须无这些线条效果，物体边缘只能由真实光影、材质和焦点清晰度形成。",
    "只有当 A 图本身明确存在手绘描边、黑边、线稿覆盖、toon outline、ink outline、sketch outline、technical drawing outline、CAD 线框或类似线条风格时，C 图才可以保留同类型、同强度、同位置逻辑的线条效果；不得因为 B 图有线稿而额外增加 A 图没有的线条。",
    "如果 B 图中有明显黑色结构线，但 A 图没有同类线条风格，最终必须将这些线条融合为真实材质边缘和自然阴影，不能保留可见线条痕迹。",
    "在不改变画面内容的前提下提升清晰度、边缘干净度、材质质感、细节锐度和整体高清真实感。",
    reversePrompt ? `原图反推 Prompt：${reversePrompt}` : "",
    extraPrompt ? `用户补充要求：${extraPrompt}` : "",
    "最终只输出一张高清重绘成图。"
  ].filter(Boolean).join("\n\n");
}

function getImageToken(node: Node<CanvasNodeData>) {
  return typeof node.data.imageNumber === "number" ? `<Image${String(node.data.imageNumber).padStart(3, "0")}>` : "<Image未编号>";
}

function stripFinalTags(value: string) {
  return value
    .replace(/<\/?final>/gi, "")
    .replace(/^\s*(?:Prompt|中文\s*Prompt|生图\s*Prompt)[:：]\s*/i, "")
    .trim();
}

function buildHdRedrawStep2Prompt(aImage: Node<CanvasNodeData>, bImage: Node<CanvasNodeData>, aPrompt: string, extraPrompt = "") {
  const aToken = getImageToken(aImage);
  const bToken = getImageToken(bImage);
  const cleanPrompt = stripFinalTags(aPrompt);
  return [
    `A 图：${aToken}。这是需要高清重绘的原始参考图，必须作为最终 C 图的主参考。`,
    `B 图：${bToken}。这是由 A 图生成的结构边界 + 固有色色块参考图，只用于辅助理解结构、轮廓、区域边界和颜色归属。`,
    `A 图内容描述：${cleanPrompt}`,
    "生成 C 图要求：以 A 图为最终画面标准，严格保持 A 图的主体身份、构图、镜头角度、透视关系、姿态、比例、物体数量、背景关系和所有可见细节，不得新增或删除画面元素。",
    "使用 B 图时只参考结构边界、色块分区和固有色关系，不要把 B 图新增的线稿、描边、黑边、CAD 线框、漫画线或分割线直接渲染到 C 图里。",
    "C 图的线条风格必须跟随 A 图：A 图没有线稿描边时，C 图也不能有；只有 A 图本身有线稿/描边/CAD 线框时，C 图才可以保留同类型线条。",
    "最终输出一张高清重绘 C 图：更清晰、更干净、更高质感，但画面内容和 A 图一致。",
    extraPrompt ? `用户补充要求：${extraPrompt}` : ""
  ].filter(Boolean).join("\n\n");
}

async function requestHdRedrawReversePrompt(sourceNodeId: string, imageNode: Node<CanvasNodeData>, instruction: string, controller: AbortController) {
  const compressedImages = await prepareGenerationReferencePayloads([{
    imageNumber: typeof imageNode.data.imageNumber === "number" ? imageNode.data.imageNumber : undefined,
    url: imageNode.data.imageUrl as string
  }]);
  const response = await fetch("/api/ai/prompt-image", {
    body: JSON.stringify({
      aiSettings: getClientAiSettingsPayload(),
      images: compressedImages,
      instruction,
      model: defaultAiPromptModel,
      output: "自然语言",
      sourceNodeId
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: controller.signal
  });
  const text = await response.text();
  let payload: { error?: string; prompt?: string };
  try {
    payload = JSON.parse(text) as { error?: string; prompt?: string };
  } catch {
    throw new Error(response.ok ? "高清重绘反推 Prompt 返回格式异常。" : `高清重绘反推 Prompt 失败：${response.status}`);
  }
  if (!response.ok) throw new Error(payload.error || `高清重绘反推 Prompt 失败：${response.status}`);
  const prompt = payload.prompt?.trim();
  if (!prompt) throw new Error("高清重绘没有反推出可用 Prompt。");
  return prompt;
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

function buildGenerateImageReferenceManifest(referenceImages: Node<CanvasNodeData>[]) {
  if (!referenceImages.length) return "";
  const rows = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    return `- Attached image ${index + 1} = <Image${String(imageNumber).padStart(3, "0")}>: this is a connected reference image input. Use its subject, composition, camera angle, perspective, silhouette, structure, materials, colors, and key details as the primary visual reference unless the user explicitly says otherwise.`;
  });
  return [
    "REFERENCE ATTACHMENT MAP - mandatory:",
    ...rows,
    "The prompt may mention @Image or <Image###>; those labels refer to the attached images above.",
    "Do not ignore connected reference images. Do not replace them with unrelated scenes, products, people, or subjects.",
    "When the prompt asks for redraw, high resolution, enhancement, or preservation, keep the referenced image composition and subject identity."
  ].join("\n");
}

function getGridLayoutHint(count: number) {
  if (count <= 1) return "one full-frame panel";
  if (count === 2) return "a regular 2 by 1 or 1 by 2 equal-cell grid, whichever best fits the selected aspect ratio";
  if (count === 3) return "a regular 3 by 1 or 1 by 3 equal-cell grid, whichever best fits the selected aspect ratio";
  if (count === 4) return "a regular 2 by 2 equal-cell grid";
  if (count === 5) return "a regular 3 by 2 or 2 by 3 equal-cell grid template with one unused cell, whichever best fits the selected aspect ratio";
  if (count === 6) return "a regular 3 by 2 or 2 by 3 equal-cell grid, whichever best fits the selected aspect ratio";
  if (count <= 9) return "a regular 3 by 3 equal-cell grid template with unused cells kept neutral when needed";
  return "a regular 5 by 2 or 2 by 5 equal-cell grid, whichever best fits the selected aspect ratio";
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

function getProductRemixInfluenceDescription(value: number) {
  if (value <= 0) return "follow the main product almost completely";
  if (value < 25) return "keep the main product overwhelmingly dominant with only subtle reference-product influence";
  if (value < 40) return "keep the main product strongly dominant while introducing a restrained amount of reference-product design language";
  if (value < 50) return "keep the main product moderately dominant while visibly borrowing selected reference-product traits";
  if (value === 50) return "balance the main product and reference product evenly";
  if (value <= 60) return "make the reference product moderately dominant while retaining clear main-product identity";
  if (value <= 75) return "make the reference product strongly dominant while preserving essential main-product identity cues";
  if (value < 100) return "follow the reference product overwhelmingly while retaining only subtle main-product identity cues";
  return "follow the reference product direction almost completely";
}

function buildProductRemixPrompt(referenceImages: Node<CanvasNodeData>[], rolePrompt: string, params: Record<string, unknown>) {
  const remixValues = getProductRemixValues(params);
  const labels = (nodes: Node<CanvasNodeData>[]) => nodes
    .map((node, index) => `<Image${String(typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1).padStart(3, "0")}>`)
    .join(", ");
  const remixDirection = remixValues.length === 1
    ? `Internal fusion direction: ${getProductRemixInfluenceDescription(remixValues[0])}.`
    : [
        `Internal fusion progression: the first panel should ${getProductRemixInfluenceDescription(remixValues[0])}.`,
        "Move through the panels in normal visual reading order. Each successive panel must shift one even visual step away from the main product and toward the reference product, creating a smooth and clearly perceptible progression.",
        `The final panel should ${getProductRemixInfluenceDescription(remixValues[remixValues.length - 1])}.`
      ].join(" ");

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
    remixDirection,
    "The fusion progression above is a hidden generation control only. Never render it as visible content. Do not place the word Remix, blend strength, percentages, fractions, digits, panel numbers, captions, headers, legends, or any other control metadata anywhere in the image, especially in the top-left corner of any panel.",
    "Every panel must begin directly with the product artwork and its clean background, without a title strip, label area, annotation margin, or text overlay.",
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
  const hasMainProduct = referenceImages.some((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    return getImageRoleFromPrompt(prompt, imageNumber) === "main";
  });
  const productLockActive = strictProductLock || hasMainProduct;
  const rows = referenceImages.map((node, index) => {
    const imageNumber = typeof node.data.imageNumber === "number" ? node.data.imageNumber : index + 1;
    const label = `<Image${String(imageNumber).padStart(3, "0")}>`;
    const role = getImageRoleFromPrompt(prompt, imageNumber);
    const roleText = role === "main" || strictProductLock && role !== "scene"
      ? "PRIMARY PRODUCT IDENTITY SOURCE - PIXEL-FAITHFUL PRODUCT LOCK. This is the only allowed product. Preserve its exact visible category, silhouette, outer contour, geometry, dimensions and proportions, camera viewpoint, perspective, visible face ratio, color/material separation, transparent/base parts, nozzle/cap/openings, buttons, seams, connector details, markings, and every distinctive structural feature. Do not redesign, restyle, simplify, beautify into another form, change the viewpoint, invent parts, remove parts, or replace it with a similar generic product or any other object."
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
    productLockActive && referenceImages.length
      ? "STRICT PRODUCT LOCK IS AUTOMATICALLY ACTIVE: the declared Main Product image is the immutable source of truth. Reproduce the same physical product, not a redesigned, simplified, abstracted, stylized, improved, beautified, or category-similar item. Product fidelity has higher priority than composition, style, lighting, typography, scene, and marketing aesthetics."
      : "",
    productLockActive && referenceImages.length
      ? "Allowed changes: background, surrounding layout, typography placement, shadows, and conservative scene integration only. Forbidden changes: camera angle/viewpoint of the product, silhouette, proportions, geometry, product type, attachments, transparent/base parts, openings, buttons, seams, color/material layout, markings, or any recognizable detail. If the requested layout conflicts with product fidelity, change the layout around the product; never change the product."
      : "",
    productLockActive && referenceImages.length
      ? "FINAL SELF-CHECK BEFORE OUTPUT: compare the generated product against the Main Product reference. If a viewer could identify any changed shape, part, proportion, material boundary, opening, control, or detail, reject that draft and regenerate with the original product preserved."
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
    "AUTOMATIC PRODUCT IDENTITY LOCK: whenever an attached image is declared as Main Product / 主产品 / 海报主产品, strict product lock is mandatory even if the connected prompt does not explicitly say Product Lock: Strict. The Main Product image is immutable visual truth. Preserve the exact product type, silhouette, outer contour, structure, proportions, camera viewpoint, perspective, visible faces, color/material layout, transparent parts, openings, caps, buttons, seams, connectors, markings, and distinctive details. Do not redesign, restyle, simplify, beautify into a different form, rotate to a different viewpoint, invent or remove parts, or generate a similar replacement product.",
    "PRODUCT-OVER-LAYOUT PRIORITY: composition, typography, scene, lighting, aspect ratio, and style must adapt around the locked product. They are never permission to alter the product. If any instruction conflicts with product fidelity, preserve the product and revise only the surrounding layout.",
    "PROMPT ADHERENCE LOCK: the output must directly depict the Goal and Composition from the connected prompt. For a comparison/pain-point image, create the requested comparison layout and use only the locked product as the improved/solution product. Any pain-point side may use abstract/contextual clutter only; it must not replace the locked product.",
    "FAIL CONDITIONS: any changed product shape, viewpoint, proportion, material boundary, opening, button, seam, attachment, marking, missing part, invented part, wrong product, different silhouette, unrelated object as the product, missing requested comparison/scene/goal, copied style board, extra unlisted text, or using a style reference as visual content.",
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
    if (edge.target !== targetId || edge.targetHandle !== "image-in") return true;
    if (!isAutoMentionImageEdge(edge)) return true;
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
    if (sourceKind === "generateImage" || sourceKind === "hdRedraw" || sourceKind === "hdRedraw2" || sourceKind === "rhinoTest" || sourceKind === "textImageLayout" || sourceKind === "gridImage" || sourceKind === "sceneImage" || sourceKind === "industrialDesignImage" || sourceKind === "productRemix") return true;
  }
  return edges.some((edge) => {
    const sourceKind = selectedById.get(edge.source)?.data.kind;
    return edge.target === node.id && (sourceKind === "generateImage" || sourceKind === "hdRedraw" || sourceKind === "hdRedraw2" || sourceKind === "rhinoTest" || sourceKind === "textImageLayout" || sourceKind === "gridImage" || sourceKind === "sceneImage" || sourceKind === "industrialDesignImage" || sourceKind === "productRemix" || sourceKind === "visual_director");
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
    if (node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster") {
      aiPrompts.push(node);
      return;
    }
    if (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "visual_director") {
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
        return sourceKind === "imageChat" || sourceKind === "sceneDirector" || sourceKind === "taobaoPageDirector" || sourceKind === "industrial_designer" || sourceKind === "product_poster";
      }) ||
        [...outgoingIds].some((id) => {
          const targetKind = selectedById.get(id)?.data.kind;
          return targetKind === "generateImage" || targetKind === "hdRedraw" || targetKind === "hdRedraw2" || targetKind === "rhinoTest" || targetKind === "textImageLayout" || targetKind === "gridImage" || targetKind === "sceneImage" || targetKind === "industrialDesignImage" || targetKind === "productRemix";
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
        errorMessage: nodeWithCurrentTitle.data.kind === "generateImage" || nodeWithCurrentTitle.data.kind === "hdRedraw" || nodeWithCurrentTitle.data.kind === "hdRedraw2" || nodeWithCurrentTitle.data.kind === "rhinoTest" || nodeWithCurrentTitle.data.kind === "textImageLayout" || nodeWithCurrentTitle.data.kind === "gridImage" || nodeWithCurrentTitle.data.kind === "sceneImage" || nodeWithCurrentTitle.data.kind === "industrialDesignImage" || nodeWithCurrentTitle.data.kind === "productRemix" || nodeWithCurrentTitle.data.kind === "imageChat" || nodeWithCurrentTitle.data.kind === "sceneDirector" || nodeWithCurrentTitle.data.kind === "taobaoPageDirector" || nodeWithCurrentTitle.data.kind === "industrial_designer" || nodeWithCurrentTitle.data.kind === "product_poster" || nodeWithCurrentTitle.data.kind === "visual_director" ? "上次生成请求已中断，请重新 Run。" : nodeWithCurrentTitle.data.errorMessage,
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
  runProductPosterNode: (id: string, generationId: string) => Promise<void>;
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
        : kind === "product_poster"
          ? {
              modelId: defaultProductPosterModel,
              modelParams: {
                backgroundType: "自动",
                colorStrategy: "自动提取",
                copyLevels: "产品名,主标题,副标题,核心卖点,行动文案",
                copySource: "AI 补全文案",
                infoDensity: "标准",
                layoutStructure: "自动",
                outputLanguage: "中文",
                posterPurpose: "产品主视觉",
                productLock: "严格",
                productPosition: "自动",
                productScale: "大",
                schemeDiversity: "高",
                schemes: "4",
                styleReferenceStrength: "中",
                whitespace: "标准"
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
        : kind === "hdRedraw" || kind === "hdRedraw2"
          ? { modelId: defaultGridImageModel, modelParams: { aspectRatio: "Auto", gridEnabled: "false", imageCount: "1", resolution: "2K", quality: "Auto" }, ...data }
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
    const isHdRedrawNode = source.data.kind === "hdRedraw";
    const isHdRedraw2Node = source.data.kind === "hdRedraw2";
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
      : isHdRedrawNode
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

    if (!isProductRemixNode && !isHdRedrawNode && (!prompt || (gridOutputEnabled && gridPromptCount < 1))) {
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
    const missingMentionNumbers = isProductRemixNode ? [] : getMissingMentionImageNumbers(snapshot.nodes, promptNodes);
    if (missingMentionNumbers.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (
          node.id === id && node.data.generationId === generationId
            ? {
                ...node,
                data: {
                  ...node.data,
                  errorMessage: `Prompt 里引用了不存在的 ${missingMentionNumbers.map((number) => `@Image ${String(number).padStart(3, "0")}`).join("、")}，请改成当前图片编号或用绿色线重新连接。`,
                  generationId: undefined,
                  runState: "failed" as const
                }
              }
            : node
        ))
      }));
      return;
    }

    if (isHdRedrawNode) {
      const sourceImage = sortNodesVisually(
        inputEdges
          .filter((edge) => edge.targetHandle === "image-in")
          .map((edge) => snapshot.nodes.find((node) => node.id === edge.source))
          .filter((node): node is Node<CanvasNodeData> => Boolean(node?.data.kind === "image" && node.data.imageUrl))
      )[0];
      if (!sourceImage) {
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请先用绿色端口连接 1 张需要高清重绘的 Image 图框。", generationId: undefined, runState: "failed" as const } } : node))
        }));
        return;
      }

      const modelId = typeof source.data.modelId === "string" ? source.data.modelId : defaultGridImageModel;
      const params = { ...(source.data.modelParams ?? {}), gridEnabled: "false", imageCount: "1" };
      const extraPrompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
      const controller = new AbortController();
      const previousController = generationControllers.get(id);
      previousController?.abort();
      generationControllers.set(id, controller);
      let mergeImageUrl = "";
      let reversePrompt = "";
      try {
        const sourceImageUrls = await prepareGenerationReferenceImageUrls([sourceImage.data.imageUrl as string]);
        const mergeImages = await requestGeneratedImages({
          aiSettings: getClientAiSettingsPayload(),
          images: sourceImageUrls,
          mode: "submit",
          model: modelId,
          params,
          prompt: extraPrompt ? `${hdRedrawMergePrompt}\n\n用户补充要求：${extraPrompt}` : hdRedrawMergePrompt,
          sourceNodeId: id
        }, controller);
        mergeImageUrl = mergeImages[0]?.url ?? "";
        if (!mergeImageUrl) throw new Error("高清重绘第一步没有返回 B 合图。");

        const currentAfterMerge = get().nodes.find((node) => node.id === id);
        if (currentAfterMerge?.data.generationId !== generationId || currentAfterMerge.data.runState !== "running") return;

        reversePrompt = await requestHdRedrawReversePrompt(id, sourceImage, buildHdRedrawReversePromptInstruction(extraPrompt), controller);
        addClientGeneratedImages([{ imageUrl: mergeImageUrl, modelId, prompt: hdRedrawMergePrompt, sourceNodeId: id }]);
        generationControllers.delete(id);
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
        const currentSource = cleaned.nodes.find((node) => node.id === id);
        if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return state;
        let currentZIndex = state.globalZIndex;
        const reservedImageNumbers = new Set<number>();
        const bImageNumber = getNextImageNumber(cleaned.nodes, reservedImageNumbers);
        if (bImageNumber) reservedImageNumbers.add(bImageNumber);
        if (!bImageNumber) {
          return {
            nodes: state.nodes.map((node) => (
              node.id === id
                ? { ...node, data: { ...node.data, errorMessage: "Image 图框已达到 100 个上限，请删除后再生成。", generationId: undefined, runState: "failed" as const } }
                : node
            ))
          };
        }
        const generatedAt = Date.now();
        const bPosition = findSingleOutputPosition(currentSource, cleaned.nodes, { height: imageNodeHeight, width: outputNodeWidth });
        currentZIndex = nextZIndex(currentZIndex);
        const bNode = makeNode(
          `image-hd-redraw-b-${generatedAt}-${Math.round(Math.random() * 1000)}`,
          "image",
          bPosition,
          currentZIndex,
          {
            generatedBy: id,
            imageNumber: bImageNumber,
            imageUrl: mergeImageUrl,
            prompt: hdRedrawMergePrompt,
            runState: "completed",
            title: "高清重绘 B 合图"
          }
        );
        const step2Prompt = buildHdRedrawStep2Prompt(sourceImage, bNode, reversePrompt, extraPrompt);
        currentZIndex = nextZIndex(currentZIndex);
        const promptNode = makeNode(
          `prompt-hd-redraw-a-${generatedAt}-${Math.round(Math.random() * 1000)}`,
          "prompt",
          { x: bPosition.x, y: bPosition.y + imageNodeHeight + outputNodeGap },
          currentZIndex,
          {
            generatedBy: id,
            prompt: step2Prompt,
            promptRichHtml: buildVisibleTextPromptRichHtml(step2Prompt),
            runState: "completed",
            title: "A 图 Prompt"
          }
        );
        currentZIndex = nextZIndex(currentZIndex);
        const step2Node = makeNode(
          `hdRedraw2-${generatedAt}-${Math.round(Math.random() * 1000)}`,
          "hdRedraw2",
          { x: bPosition.x + outputNodeWidth + outputNodeColumnGap, y: bPosition.y },
          currentZIndex,
          {
            generatedBy: id,
            modelId,
            modelParams: params,
            runState: "idle",
            title: "高清重绘2"
          }
        );
        return {
          globalZIndex: currentZIndex,
          activeEdgeId: null,
          historyPast: pushHistory(state),
          historyFuture: [],
          nodes: [
            ...cleaned.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt: "高清重绘1：已生成 B 图和 A 图 Prompt", runState: "completed" as const } } : node),
            bNode,
            promptNode,
            step2Node
          ],
          edges: [
            ...cleaned.edges,
            {
              id: `edge-hd-redraw-b-${generatedAt}`,
              source: id,
              target: bNode.id,
              sourceHandle: "image-out",
              targetHandle: "image-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "image" }
            },
            {
              id: `edge-hd-redraw-a-to-step2-${generatedAt}`,
              source: sourceImage.id,
              target: step2Node.id,
              sourceHandle: "image-out",
              targetHandle: "image-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "image" }
            },
            {
              id: `edge-hd-redraw-b-to-step2-${generatedAt}`,
              source: bNode.id,
              target: step2Node.id,
              sourceHandle: "image-out",
              targetHandle: "image-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "image" }
            },
            {
              id: `edge-hd-redraw-prompt-${generatedAt}`,
              source: id,
              target: promptNode.id,
              sourceHandle: "text-out",
              targetHandle: "text-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "text" }
            },
            {
              id: `edge-hd-redraw-prompt-to-step2-${generatedAt}`,
              source: promptNode.id,
              target: step2Node.id,
              sourceHandle: "text-out",
              targetHandle: "text-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "text" }
            }
          ]
        };
      });
      return;
    }

    if (isHdRedraw2Node) {
      const referenceImages = sortNodesVisually(
        inputEdges
          .filter((edge) => edge.targetHandle === "image-in")
          .map((edge) => snapshot.nodes.find((node) => node.id === edge.source))
          .filter((node): node is Node<CanvasNodeData> => Boolean(node?.data.kind === "image" && node.data.imageUrl))
      ).slice(0, 2);
      const step2Prompt = promptNodes.map((node) => node.data.prompt).join("\n\n").trim();
      if (referenceImages.length < 2 || !step2Prompt) {
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "高清重绘2 需要连接 A 图、B 图和 A 图 Prompt。", generationId: undefined, runState: "failed" as const } } : node))
        }));
        return;
      }

      const modelId = typeof source.data.modelId === "string" ? source.data.modelId : defaultGridImageModel;
      const params = { ...(source.data.modelParams ?? {}), gridEnabled: "false", imageCount: "1" };
      const controller = new AbortController();
      generationControllers.get(id)?.abort();
      generationControllers.set(id, controller);
      let finalImageUrl = "";
      const finalPrompt = step2Prompt;
      try {
        const finalReferenceImages = await prepareGenerationReferenceImageUrls(referenceImages.map((node) => node.data.imageUrl as string));
        const finalImages = await requestGeneratedImages({
          aiSettings: getClientAiSettingsPayload(),
          images: finalReferenceImages,
          mode: "submit",
          model: modelId,
          params,
          prompt: finalPrompt,
          sourceNodeId: id
        }, controller);
        finalImageUrl = finalImages[0]?.url ?? "";
        if (!finalImageUrl) throw new Error("高清重绘第二步没有返回 C 高清图。");
        addClientGeneratedImages([{ imageUrl: finalImageUrl, modelId, prompt: finalPrompt, sourceNodeId: id }]);
        generationControllers.delete(id);
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
        const currentSource = cleaned.nodes.find((node) => node.id === id);
        if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return state;
        const imageNumber = getNextImageNumber(cleaned.nodes);
        if (!imageNumber) {
          return {
            nodes: state.nodes.map((node) => (
              node.id === id
                ? { ...node, data: { ...node.data, errorMessage: "Image 图框已达到 100 个上限，请删除后再生成。", generationId: undefined, runState: "failed" as const } }
                : node
            ))
          };
        }
        let currentZIndex = state.globalZIndex;
        currentZIndex = nextZIndex(currentZIndex);
        const generatedAt = Date.now();
        const outputNode = makeNode(
          `image-hd-redraw-c-${generatedAt}-${Math.round(Math.random() * 1000)}`,
          "image",
          findSingleOutputPosition(currentSource, cleaned.nodes, { height: imageNodeHeight, width: outputNodeWidth }),
          currentZIndex,
          {
            generatedBy: id,
            imageNumber,
            imageUrl: finalImageUrl,
            prompt: finalPrompt,
            runState: "completed",
            title: "高清重绘 C 高清图"
          }
        );
        return {
          globalZIndex: currentZIndex,
          activeEdgeId: null,
          historyPast: pushHistory(state),
          historyFuture: [],
          nodes: [
            ...cleaned.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt: "高清重绘2：已生成 C 高清图", runState: "completed" as const } } : node),
            outputNode
          ],
          edges: [
            ...cleaned.edges,
            {
              id: `edge-hd-redraw-c-${generatedAt}`,
              source: id,
              target: outputNode.id,
              sourceHandle: "image-out",
              targetHandle: "image-in",
              type: "deletable",
              selected: false,
              data: { generatedBy: id, portType: "image" }
            }
          ]
        };
      });
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
    const promptReferenceImages = getPromptScopedReferenceImageNodes(snapshot.nodes, promptNodes, Number.POSITIVE_INFINITY);
    const connectedReferenceImages = getConnectedReferenceImageNodes(snapshot.nodes, inputEdges, Number.POSITIVE_INFINITY);
    const allReferenceImages = isRhinoTestNode
      ? orderRhinoReferenceImages(uniqueNodesById([...connectedReferenceImages, ...promptReferenceImages]), rhinoPrimaryReferenceImage)
      : uniqueNodesById([...connectedReferenceImages, ...promptReferenceImages]);
    if (isRhinoTestNode && !allReferenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请在 Prompt 里用 @Image 010 这类编号明确指定 Rhino 产品截图。", generationId: undefined, runState: "failed" as const } } : node))
      }));
      return;
    }
    if (isProductRemixNode && !allReferenceImages.length) {
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id && node.data.generationId === generationId ? { ...node, data: { ...node.data, errorMessage: "请在 Prompt 里用 @Image 010 这类编号明确指定产品图片。", generationId: undefined, runState: "failed" as const } } : node))
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
      const compressedStyleReferenceImages = await prepareGenerationReferencePayloads(textLayoutStyleReferenceImages.map((node) => ({
        imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
        url: node.data.imageUrl as string
      })));
      const response = await fetch("/api/ai/style-reference-summary", {
        body: JSON.stringify({
            aiSettings: getClientAiSettingsPayload(),
            images: compressedStyleReferenceImages,
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
            : isGenerateImageNode
              ? buildGenerateImageReferenceManifest(referenceImages)
          : "";
    const requestPrompt = referenceManifest ? `${referenceManifest}\n\n${prompt}` : prompt;
    const promptResolution = isTextImageLayoutNode ? parsePromptResolution(rolePrompt) : null;
    const baseRequestParams = isProductRemixNode
      ? { ...(source.data.modelParams ?? {}), imageCount: "1" }
      : gridOutputEnabled
      ? { ...(source.data.modelParams ?? {}), imageCount: "1" }
      : source.data.modelParams ?? {};
    const equalGridPanelCount = isProductRemixNode
      ? getProductRemixValues(source.data.modelParams ?? {}).length
      : gridOutputEnabled
        ? gridPromptCount
        : 0;
    const requestParamsWithGridConstraint = equalGridPanelCount > 1
      ? {
          ...baseRequestParams,
          equalGridPanels: "true",
          gridPanelCount: String(equalGridPanelCount)
        }
      : baseRequestParams;
    const requestParams = isTextImageLayoutNode && promptResolution
      ? {
          ...requestParamsWithGridConstraint,
          aspectRatio: requestParamsWithGridConstraint.aspectRatio === "Auto" || requestParamsWithGridConstraint.aspectRatio === "自动" || !requestParamsWithGridConstraint.aspectRatio ? getAspectRatioLabelFromSize(promptResolution.width, promptResolution.height) : requestParamsWithGridConstraint.aspectRatio,
          targetHeight: String(promptResolution.height),
          targetWidth: String(promptResolution.width)
        }
      : requestParamsWithGridConstraint;

    let images: Array<{ url: string }>;
    const controller = new AbortController();
    const previousController = generationControllers.get(id);
    previousController?.abort();
    generationControllers.set(id, controller);
    try {
      const requestImageUrls = await prepareGenerationReferenceImageUrls(
        referenceImages
          .map((node) => node.data.imageUrl)
          .filter((imageUrl): imageUrl is string => Boolean(imageUrl))
      );
      console.info("[generate-image] sending request", {
        imageCount: referenceImages.length,
        imagePayloadBytes: requestImageUrls.reduce((total, imageUrl) => total + imageUrl.length, 0),
        model: modelId,
        sourceNodeId: id
      });
      const requestBody = {
        aiSettings: getClientAiSettingsPayload(),
        images: requestImageUrls,
        mode: "submit",
        model: modelId,
        params: requestParams,
        prompt: requestPrompt,
        sourceNodeId: id
      };
      images = await requestGeneratedImages(requestBody, controller);
      generationControllers.delete(id);
      const current = get().nodes.find((node) => node.id === id);
      if (current?.data.generationId !== generationId || current.data.runState !== "running") return;
      if (!images.length) throw new Error("AI 服务没有返回图片。");
      addClientGeneratedImages(images.map((image) => ({
        imageUrl: image.url,
        modelId,
        prompt: requestPrompt,
        sourceNodeId: id
      })));
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
      const outputReferenceImageLimit = getReferenceImageLimit(typeof source.data.modelId === "string" ? source.data.modelId : undefined);
      const outputPromptReferenceImages = getPromptScopedReferenceImageNodes(cleaned.nodes, promptNodes, Number.POSITIVE_INFINITY);
      const outputConnectedReferenceImages = getConnectedReferenceImageNodes(cleaned.nodes, inputEdges, Number.POSITIVE_INFINITY);
      const referenceImages = (source.data.kind === "rhinoTest"
        ? orderRhinoReferenceImages(uniqueNodesById([...outputConnectedReferenceImages, ...outputPromptReferenceImages]), outputRhinoPrimaryReferenceImage)
        : uniqueNodesById([...outputConnectedReferenceImages, ...outputPromptReferenceImages]))
        .slice(0, outputReferenceImageLimit);
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
      const compressedReferenceImages = await prepareGenerationReferencePayloads(referenceImages.map((node) => ({
        imageNumber: typeof node.data.imageNumber === "number" ? node.data.imageNumber : undefined,
        title: node.data.title,
        url: node.data.imageUrl as string
      })));
      const analysisResponse = await fetch("/api/ai/visual-director", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: compressedReferenceImages,
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
      const visualRequestImageUrls = await prepareGenerationReferenceImageUrls(
        referenceImages
          .map((node) => node.data.imageUrl)
          .filter((url): url is string => Boolean(url))
      );
      const visualImages = await requestGeneratedImages({
        aiSettings: getClientAiSettingsPayload(),
        images: visualRequestImageUrls,
        mode: "submit",
        model: visualModel,
        params: {
          aspectRatio: params.aspectRatio ?? "9:16",
          imageCount: source.data.modelParams?.imageCount ?? "1",
          resolution: params.resolution ?? "2K"
        },
        prompt: boardPrompt,
        sourceNodeId: id
      }, controller);
      const imageUrls = visualImages
        .map((image) => image.url)
        .filter(Boolean)
        .slice(0, Math.min(6, Math.max(1, Number.parseInt(source.data.modelParams?.imageCount ?? "1", 10) || 1)));
      if (!imageUrls.length) throw new Error("AI 服务没有返回视觉规范图。");
      addClientGeneratedImages(imageUrls.map((imageUrl) => ({
        imageUrl,
        modelId: visualModel,
        prompt: boardPrompt,
        sourceNodeId: id
      })));
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
      const compressedReferenceImages = await prepareGenerationReferencePayloads(referenceImages);
      const response = await fetch("/api/ai/prompt-image", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: compressedReferenceImages,
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
      const compressedReferenceImages = await prepareGenerationReferencePayloads(referenceImages);
      const response = await fetch("/api/ai/scene-director", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: compressedReferenceImages,
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
  runProductPosterNode: async (id, generationId) => {
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

    const fail = (message: string) => set((state) => ({
      nodes: state.nodes.map((node) => node.id === id && node.data.generationId === generationId
        ? { ...node, data: { ...node.data, errorMessage: message, generationId: undefined, runState: "failed" as const } }
        : node)
    }));
    if (!referenceImages.length) {
      fail("请至少连接一张产品图片。");
      return;
    }
    if (!instruction) {
      fail("请连接前置 Prompt，并明确主产品图和风格参考图的角色。");
      return;
    }

    let prompt = "";
    let generatedSchemes: Array<{ prompt: string; title?: string }> = [];
    const controller = new AbortController();
    generationControllers.get(id)?.abort();
    generationControllers.set(id, controller);
    try {
      const compressedImages = await prepareGenerationReferencePayloads(referenceImages);
      const response = await fetch("/api/ai/product-poster", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: compressedImages,
          instruction,
          model: typeof source.data.modelId === "string" ? source.data.modelId : defaultProductPosterModel,
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
        payload = JSON.parse(responseText) as typeof payload;
      } catch {
        const fallback = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(response.ok ? "AI 服务返回格式异常。" : `产品海报导演失败：${response.status}${fallback ? ` ${fallback}` : ""}`);
      }
      if (!response.ok) throw new Error(payload.error || `产品海报导演失败：${response.status}`);
      generatedSchemes = (payload.schemes ?? []).map((scheme) => ({
        prompt: typeof scheme.prompt === "string" ? scheme.prompt.trim() : "",
        title: typeof scheme.title === "string" ? scheme.title.trim() : undefined
      })).filter((scheme) => scheme.prompt);
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt && generatedSchemes.length) prompt = generatedSchemes.map((scheme) => scheme.prompt).join("\n\n");
      if (!generatedSchemes.length || !prompt) throw new Error("产品海报导演没有返回可用 Prompt。");
    } catch (error) {
      generationControllers.delete(id);
      fail(error instanceof Error && error.name === "AbortError" ? "产品海报导演已停止。" : error instanceof Error ? error.message : "产品海报导演失败。");
      return;
    }

    set((state) => {
      const cleaned = removeConnectedGeneratedOutputs(state, id);
      const currentSource = cleaned.nodes.find((node) => node.id === id);
      if (!currentSource || currentSource.data.generationId !== generationId || currentSource.data.runState !== "running") return state;
      let currentZIndex = state.globalZIndex;
      const generatedAt = Date.now();
      const positions = generatedSchemes.length > 1 ? findGeneratedOutputPositions(currentSource, cleaned.nodes, generatedSchemes.length) : [findSingleOutputPosition(currentSource, cleaned.nodes)];
      const promptNodes = generatedSchemes.map((scheme, index) => {
        currentZIndex = nextZIndex(currentZIndex);
        return makeNode(`prompt-product-poster-${generatedAt}-${index + 1}-${Math.round(Math.random() * 1000)}`, "prompt", positions[index], currentZIndex, {
          generatedBy: id,
          prompt: scheme.prompt,
          promptRichHtml: buildVisibleTextPromptRichHtml(scheme.prompt),
          runState: "completed",
          title: scheme.title || `产品海报 Prompt ${String(index + 1).padStart(2, "0")}`
        });
      });
      const promptEdges: Edge[] = promptNodes.map((promptNode, index) => ({
        id: `edge-product-poster-${generatedAt}-${index + 1}`,
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
          ...cleaned.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, errorMessage: undefined, generationId: undefined, prompt, runState: "completed" as const } } : node),
          ...promptNodes
        ],
        edges: [...cleaned.edges, ...promptEdges]
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
      const compressedReferenceImages = await prepareGenerationReferencePayloads(referenceImages);
      const response = await fetch("/api/ai/industrial-designer", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          images: compressedReferenceImages,
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
      if (selectedNodes.some((node) => (node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix" || node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" || node.data.kind === "visual_director") && node.data.runState === "running")) return state;

      const useWorkflowLayout = selectedNodes.some((node) => node.data.kind === "imageChat" || node.data.kind === "sceneDirector" || node.data.kind === "taobaoPageDirector" || node.data.kind === "industrial_designer" || node.data.kind === "product_poster" || node.data.kind === "visual_director" || node.data.kind === "generateImage" || node.data.kind === "hdRedraw" || node.data.kind === "hdRedraw2" || node.data.kind === "rhinoTest" || node.data.kind === "textImageLayout" || node.data.kind === "gridImage" || node.data.kind === "sceneImage" || node.data.kind === "industrialDesignImage" || node.data.kind === "productRemix");
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
