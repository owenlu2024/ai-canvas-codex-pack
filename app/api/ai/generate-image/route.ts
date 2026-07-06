import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { getReferenceImageLimit, isAgnesImageModel } from "@/lib/generateImageModels";
import { readApiSettings, type ApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface GenerateImageRequest {
  aiSettings?: StoredApiSettings;
  expectedCount?: number;
  model?: string;
  mode?: "submit" | "poll";
  prompt?: string;
  params?: Record<string, string>;
  images?: string[];
  sourceNodeId?: string;
  taskIds?: string[];
}

interface ProviderImage {
  url?: string;
  b64_json?: string;
}

interface SafeDebugRecord {
  at: string;
  backupSaved?: number;
  debug?: Record<string, unknown>;
  error?: string;
  imageCount?: number;
  responseKeys?: string[];
  responseStatus?: number;
  responseContentType?: string | null;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");
const debugPath = getCanvasDataPath("ai-generate-debug.local.json");
const taskRecoveryPath = getCanvasDataPath("ai-task-recovery.local.json");
const generationTimeoutMs = 30 * 60 * 1000;
const agnesDirectTimeoutMs = 3 * 60 * 1000;

export const maxDuration = 60;

function normalizeBaseUrl(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "root");
}

function withV1BaseUrl(value: string) {
  return normalizeHttpBaseUrl(value, "v1");
}

function withRootBaseUrl(value: string) {
  return normalizeHttpBaseUrl(value, "root");
}

function is12AiBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname === "cdn.12ai.org" || url.hostname.endsWith(".12ai.org");
  } catch {
    return false;
  }
}

async function readSettings(model?: string, clientSettings?: StoredApiSettings): Promise<ApiSettings> {
  return readApiSettings(settingsPath, {
    clientSettings,
    defaultAgnesBaseUrl: "https://apihub.agnes-ai.com",
    isAgnesModel: isAgnesImageModel,
    model,
    normalizeBaseUrl
  });
}

function getImageCount(value?: string) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(6, Math.max(1, Math.round(count))) : 1;
}

function getQuality(value?: string) {
  const normalized = (value ?? "Auto").toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return "auto";
}

interface AspectRatio {
  height: number;
  label: string;
  width: number;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function parseAspectRatio(params?: Record<string, string>): AspectRatio {
  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    const divisor = gcd(targetWidth, targetHeight);
    return { height: targetHeight / divisor, label: `${targetWidth / divisor}:${targetHeight / divisor}`, width: targetWidth / divisor };
  }
  const value = params?.aspectRatio ?? "Auto";
  const match = value.match(/(\d+):(\d+)/);
  if (!match) return { height: 1, label: "1:1", width: 1 };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { height: 1, label: "1:1", width: 1 };
  }
  return { height, label: `${width}:${height}`, width };
}

function nearestAspectRatio(target: AspectRatio, ratios: AspectRatio[]) {
  const targetValue = target.width / target.height;
  return ratios.reduce((best, ratio) => {
    const bestDistance = Math.abs(best.width / best.height - targetValue);
    const distance = Math.abs(ratio.width / ratio.height - targetValue);
    return distance < bestDistance ? ratio : best;
  }, ratios[0]);
}

const geminiAspectRatios: AspectRatio[] = [
  { width: 1, height: 1, label: "1:1" },
  { width: 2, height: 3, label: "2:3" },
  { width: 3, height: 2, label: "3:2" },
  { width: 3, height: 4, label: "3:4" },
  { width: 4, height: 3, label: "4:3" },
  { width: 4, height: 5, label: "4:5" },
  { width: 5, height: 4, label: "5:4" },
  { width: 9, height: 16, label: "9:16" },
  { width: 16, height: 9, label: "16:9" },
  { width: 21, height: 9, label: "21:9" }
];

function getModelAspectRatio(model: string, params?: Record<string, string>) {
  const ratio = parseAspectRatio(params);
  if (model !== "gpt-image-2") return nearestAspectRatio(ratio, geminiAspectRatios);

  const value = ratio.width / ratio.height;
  if (value > 3) return { width: 3, height: 1, label: "3:1" };
  if (value < 1 / 3) return { width: 1, height: 3, label: "1:3" };
  return ratio;
}

function clampGptSizeToProviderLimit(width: number, height: number) {
  const maxEdge = 3840;
  const maxPixels = 8294400;
  const minPixels = 655360;
  const minScale = Math.max(1, Math.sqrt(minPixels / (width * height)));
  const scaledWidth = width * minScale;
  const scaledHeight = height * minScale;
  const edgeScale = Math.min(1, maxEdge / Math.max(width, height));
  const pixelScale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const scale = Math.min(edgeScale, pixelScale);
  const multipleOf16Down = (value: number) => Math.max(64, Math.floor(value / 16) * 16);
  const multipleOf16Up = (value: number) => Math.max(64, Math.ceil(value / 16) * 16);
  if (minScale > 1) {
    return {
      height: multipleOf16Up(scaledHeight),
      width: multipleOf16Up(scaledWidth)
    };
  }
  return {
    height: multipleOf16Down(height * scale),
    width: multipleOf16Down(width * scale)
  };
}

function getGptSize(params?: Record<string, string>) {
  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    const { width, height } = clampGptSizeToProviderLimit(targetWidth, targetHeight);
    return `${width}x${height}`;
  }
  const resolution = params?.resolution ?? "1K";
  const ratio = getModelAspectRatio("gpt-image-2", params);
  const ratioValue = ratio.width / ratio.height;
  const isSquare = ratio.width === ratio.height;
  const longEdge = resolution === "4K" ? 3840 : resolution === "2K" ? 2048 : isSquare ? 1024 : 1536;
  const rawWidth = ratioValue >= 1 ? longEdge : Math.round(longEdge * ratioValue);
  const rawHeight = ratioValue >= 1 ? Math.round(longEdge / ratioValue) : longEdge;
  const { width, height } = clampGptSizeToProviderLimit(rawWidth, rawHeight);
  return `${width}x${height}`;
}

function looksLikeBase64Image(value: string) {
  return value.length > 800 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 800));
}

function extractImageLikeStrings(value: string) {
  const matches: string[] = [];
  const dataUrlMatches = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g);
  if (dataUrlMatches) matches.push(...dataUrlMatches.map((match) => match.replace(/\s/g, "")));

  const urlMatches = value.match(/https?:\/\/[^\s"'<>\\)]+/g);
  if (urlMatches) {
    matches.push(...urlMatches.map((match) => match.replace(/[.,;:!?]+$/, "")));
  }

  return matches;
}

function getGeminiImageSize(params?: Record<string, string>) {
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

function getAgnesImageSize(params?: Record<string, string>) {
  const explicitSize = params?.size?.trim();
  if (explicitSize && /^\d{3,5}x\d{3,5}$/.test(explicitSize)) return explicitSize;

  const targetWidth = Number.parseInt(params?.targetWidth ?? "", 10);
  const targetHeight = Number.parseInt(params?.targetHeight ?? "", 10);
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    const clampEdge = (value: number) => Math.min(4096, Math.max(256, Math.round(value / 8) * 8));
    return `${clampEdge(targetWidth)}x${clampEdge(targetHeight)}`;
  }
  return "2048x2048";
}

function isGeminiImageModel(model: string) {
  return model.startsWith("gemini-");
}

function getAdapterName(model: string) {
  if (model === "gpt-image-2") return "gpt-image-2";
  if (model === "gemini-3.1-flash-image-preview") return "gemini-3.1-flash-image-preview";
  if (model === "gemini-3-pro-image-preview") return "gemini-3-pro-image-preview";
  return "";
}

function getTaskId(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const candidates = [record.task_id, record.id, record.request_id, (record.data as Record<string, unknown> | undefined)?.task_id, (record.data as Record<string, unknown> | undefined)?.id];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate)) ?? "";
}

function getTaskStatus(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const status = record.status ?? record.state ?? (record.data as Record<string, unknown> | undefined)?.status ?? (record.data as Record<string, unknown> | undefined)?.state;
  return typeof status === "string" ? status.toLowerCase() : "";
}

function getTaskError(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const error = record.error ?? record.message ?? (record.data as Record<string, unknown> | undefined)?.error ?? (record.data as Record<string, unknown> | undefined)?.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectImages(value: unknown, images: Array<{ url: string }>, keyHint = "", depth = 0, visited = new WeakSet<object>()) {
  if (!value) return;
  if (depth > 24 || images.length > 32) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        collectImages(JSON.parse(trimmed) as unknown, images, keyHint);
        return;
      } catch {
        // Some providers return plain text that happens to include braces.
      }
    }
    if (trimmed.startsWith("data:image/")) {
      images.push({ url: trimmed });
      return;
    }
    if (/^https?:\/\//.test(trimmed) && ["url", "uri", "image_url", "imageUrl", "imageURL", "file_url", "signed_url", "output_url", "download_url", "output", "outputs", "image", "images", "result", "results"].includes(keyHint)) {
      images.push({ url: trimmed });
      return;
    }
    if ((keyHint === "b64_json" || keyHint === "base64" || keyHint === "image_base64" || keyHint === "imageBase64" || keyHint === "data") && looksLikeBase64Image(trimmed)) {
      images.push({ url: `data:image/png;base64,${trimmed.replace(/\s/g, "")}` });
      return;
    }

    if (["url", "uri", "image_url", "imageUrl", "imageURL", "file_url", "signed_url", "output_url", "download_url", "output", "outputs", "image", "images", "result", "results", "text", "content"].includes(keyHint)) {
      extractImageLikeStrings(trimmed).forEach((url) => images.push({ url }));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item) => collectImages(item, images, keyHint, depth + 1, visited));
    return;
  }
  if (typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);

  const record = value as Record<string, unknown>;
  const direct = record as ProviderImage;
  if (typeof direct.url === "string") images.push({ url: direct.url });
  if (typeof direct.b64_json === "string") images.push({ url: `data:image/png;base64,${direct.b64_json.replace(/\s/g, "")}` });

  const inlineData = getNestedRecord(record, "inline_data") ?? getNestedRecord(record, "inlineData");
  const inlineMimeType = inlineData?.mime_type ?? inlineData?.mimeType;
  const inlineDataValue = inlineData?.data;
  if (typeof inlineDataValue === "string" && looksLikeBase64Image(inlineDataValue)) {
    images.push({ url: `data:${typeof inlineMimeType === "string" ? inlineMimeType : "image/png"};base64,${inlineDataValue.replace(/\s/g, "")}` });
  }

  for (const [key, child] of Object.entries(record)) {
    collectImages(child, images, key, depth + 1, visited);
  }
}

function getNestedRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
}

async function imageSourceForTask(value: string) {
  if (!value.startsWith("/")) return /^https?:\/\//i.test(value) ? assertSafeRemoteFetchUrl(value) : value;
  const filePath = getPublicAssetPath(value);
  const body = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${type};base64,${body.toString("base64")}`;
}

function dataUrlToImageData(value: string) {
  if (!value.startsWith("data:")) return null;
  const marker = ";base64,";
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const mimeType = value.slice(5, markerIndex);
  const data = value.slice(markerIndex + marker.length);
  if (!mimeType || !data) return null;
  return {
    data: data.replace(/\s/g, ""),
    mimeType
  };
}

async function imageSourceForGeminiPart(value: string) {
  const dataUrl = await imageSourceForTask(value);
  const dataPart = dataUrlToImageData(dataUrl);
  if (dataPart) {
    return {
      inlineData: {
        data: dataPart.data,
        mimeType: dataPart.mimeType
      }
    };
  }

  const response = await fetch(assertSafeRemoteFetchUrl(dataUrl), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`参考图读取失败：${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType: contentType
    }
  };
}

interface AsyncSubmit {
  body: BodyInit;
  debug: Record<string, unknown>;
  headers: Record<string, string>;
  taskSubmitEndpoint?: string;
}

interface SubmitContext {
  imageSources: string[];
  model: string;
  n: number;
  params?: Record<string, string>;
  prompt: string;
  sourceNodeId?: string;
}

function buildEqualGridPanelConstraint(params?: Record<string, string>) {
  if (params?.equalGridPanels !== "true") return "";
  const count = Math.max(2, Math.min(10, Number.parseInt(params.gridPanelCount ?? "", 10) || 2));
  const layout = getEqualGridLayout(count, params);
  const emptyCellText = layout.capacity > count
    ? ` The grid has ${layout.capacity - count} unused cell${layout.capacity - count === 1 ? "" : "s"}; keep unused cells neutral/blank or crop them away without resizing any visible panel.`
    : "";
  return [
    "AUTOMATIC GRID CONSTRAINT - mandatory:",
    `Because grid mode is enabled, first divide the final canvas into an automatic regular grid based on the selected aspect ratio and panel count.`,
    `For this request, use exactly ${layout.columns} column${layout.columns === 1 ? "" : "s"} by ${layout.rows} row${layout.rows === 1 ? "" : "s"} for ${count} visible panel${count === 1 ? "" : "s"}.${emptyCellText}`,
    "Every grid cell in that chosen row/column layout must be the same size. Columns share one consistent column width; rows share one consistent row height.",
    "Each visible panel must occupy exactly one grid cell. Do not let any panel span multiple rows or columns, and do not enlarge a hero panel.",
    "Do not create masonry, collage, magazine, hero-plus-thumbnails, unequal panels, overlapping panels, uneven gutters, or freeform slicing.",
    "Keep gutters/dividers consistent in thickness and keep outer margins even. The grid must look like a precise table layout.",
    "Panel artwork may crop internally to fit its assigned cell, but the cell frame and grid division must stay unchanged."
  ].join("\n");
}

function getEqualGridLayout(count: number, params?: Record<string, string>) {
  const aspectRatio = getRequestedAspectRatio(params);
  let best = { capacity: Number.POSITIVE_INFINITY, columns: count, rows: 1, score: Number.POSITIVE_INFINITY };
  for (let rows = 1; rows <= count; rows += 1) {
    const columns = Math.ceil(count / rows);
    const capacity = rows * columns;
    const layoutRatio = columns / rows;
    const unusedCells = capacity - count;
    const ratioScore = Math.abs(Math.log(layoutRatio / aspectRatio));
    const emptyPenalty = unusedCells * 0.28;
    const skinnyPenalty = Math.max(columns / rows, rows / columns) > 4 ? 0.65 : 0;
    const score = ratioScore + emptyPenalty + skinnyPenalty;
    if (
      score < best.score ||
      (score === best.score && capacity < best.capacity) ||
      (score === best.score && capacity === best.capacity && columns > best.columns)
    ) {
      best = { capacity, columns, rows, score };
    }
  }
  return { capacity: best.capacity, columns: best.columns, rows: best.rows };
}

function getRequestedAspectRatio(params?: Record<string, string>) {
  const targetWidth = Number.parseFloat(params?.targetWidth ?? "");
  const targetHeight = Number.parseFloat(params?.targetHeight ?? "");
  if (Number.isFinite(targetWidth) && targetWidth > 0 && Number.isFinite(targetHeight) && targetHeight > 0) {
    return targetWidth / targetHeight;
  }

  const aspectRatio = params?.aspectRatio ?? "";
  const match = aspectRatio.match(/(\d+(?:\.\d+)?)\s*[:xX：]\s*(\d+(?:\.\d+)?)/);
  if (match) {
    const width = Number.parseFloat(match[1]);
    const height = Number.parseFloat(match[2]);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return width / height;
  }

  return 1;
}

interface AsyncGenerationResult {
  debug: Record<string, unknown>;
  imageCount: number;
  images: Array<{ url: string }>;
  responseContentType: string | null;
  responseKeys: string[];
  responseStatus: number;
}

class AiProviderError extends Error {
  debug: Record<string, unknown>;
  responseContentType?: string | null;
  responseKeys?: string[];
  responseStatus: number;

  constructor(message: string, responseStatus: number, debug: Record<string, unknown>, options?: { responseContentType?: string | null; responseKeys?: string[] }) {
    super(message);
    this.debug = debug;
    this.responseContentType = options?.responseContentType;
    this.responseKeys = options?.responseKeys;
    this.responseStatus = responseStatus;
  }
}

async function buildGptImage2Submit(context: SubmitContext): Promise<AsyncSubmit> {
  const size = getGptSize(context.params);
  const quality = getQuality(context.params?.quality);
  const images = await Promise.all(context.imageSources.map((image) => imageSourceForTask(image)));
  const input: Record<string, unknown> = {
    prompt: context.prompt,
    quality,
    response_format: "url",
    size
  };
  if (images.length) input.images = images;
  if (context.n > 1) input.n = context.n;
  const requestBody = {
    input,
    model: context.model
  };
  return {
    body: JSON.stringify(requestBody),
    debug: {
      imageCount: images.length,
      payload: "gpt-image-2-input-json",
      quality,
      size
    },
    headers: { "Content-Type": "application/json" },
    taskSubmitEndpoint: "/task/submit"
  };
}

async function buildGeminiImageSubmit(context: SubmitContext): Promise<AsyncSubmit> {
  const aspectRatio = getModelAspectRatio(context.model, context.params).label;
  const imageSize = getGeminiImageSize(context.params);
  const images = await Promise.all(context.imageSources.map((image) => imageSourceForTask(image)));
  const input: Record<string, unknown> = {
    aspect_ratio: aspectRatio,
    image_size: imageSize,
    prompt: context.prompt
  };
  if (images.length) input.images = images;
  if (context.n > 1) input.n = context.n;
  const requestBody = {
    input,
    model: context.model
  };
  return {
    body: JSON.stringify(requestBody),
    debug: {
      aspectRatio,
      imageCount: images.length,
      imageSize,
      payload: `${context.model}-input-json`
    },
    headers: { "Content-Type": "application/json" },
    taskSubmitEndpoint: "/task/submit"
  };
}

async function buildGemini31FlashImageSubmit(context: SubmitContext): Promise<AsyncSubmit> {
  return buildGeminiImageSubmit(context);
}

async function buildGemini3ProImageSubmit(context: SubmitContext): Promise<AsyncSubmit> {
  return buildGeminiImageSubmit(context);
}

async function executeAgnesGeneration(settings: ApiSettings, context: SubmitContext, expectedCount: number): Promise<AsyncGenerationResult> {
  const endpoint = `${settings.baseUrl}/images/generations`;
  const images = await Promise.all(context.imageSources.map((image) => imageSourceForTask(image)));
  const size = getAgnesImageSize(context.params);
  const requestBody: Record<string, unknown> = {
    extra_body: {
      response_format: "url",
      ...(images.length ? { image: images } : {})
    },
    model: context.model,
    prompt: context.prompt,
    size
  };
  if (context.n > 1) requestBody.n = context.n;

  const debug = {
    endpoint,
    imageCount: images.length,
    mode: "agnes-direct",
    model: context.model,
    n: context.n,
    size
  };

  let lastError = "";
  let lastStatus = 502;
  let lastContentType: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(endpoint, {
      body: JSON.stringify(requestBody),
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: AbortSignal.timeout(agnesDirectTimeoutMs)
    });

    if (!response.ok) {
      const error = await readProviderError(response);
      lastError = error;
      lastStatus = response.status;
      lastContentType = response.headers.get("content-type");
      if (response.status === 429 && /No deployments available|Try again/i.test(error) && attempt < 3) {
        await sleep(5000);
        continue;
      }
      throw new AiProviderError(error, response.status, { ...debug, attempt }, { responseContentType: lastContentType });
    }

    const { payload, contentType } = await readProviderPayload(response);
    const imagesResult = normalizeImages(payload, expectedCount);
    if (!imagesResult.length) {
      throw new AiProviderError("Agnes API 没有返回图片。", 502, { ...debug, attempt }, { responseContentType: contentType, responseKeys: getResponseKeys(payload) });
    }

    return {
      debug: { ...debug, attempt },
      imageCount: imagesResult.length,
      images: imagesResult,
      responseContentType: contentType,
      responseKeys: getResponseKeys(payload),
      responseStatus: response.status
    };
  }

  throw new AiProviderError(lastError || "Agnes API 暂时没有可用部署，请稍后重试。", lastStatus, { ...debug, attempts: 3 }, { responseContentType: lastContentType });
}

async function executeGeminiNativeGeneration(settings: ApiSettings, context: SubmitContext, expectedCount: number): Promise<AsyncGenerationResult> {
  const aspectRatio = getModelAspectRatio(context.model, context.params).label;
  const imageSize = getGeminiImageSize(context.params);
  const imageParts = await Promise.all(context.imageSources.map((image) => imageSourceForGeminiPart(image)));
  const endpoint = `${withRootBaseUrl(settings.baseUrl)}/v1beta/models/${encodeURIComponent(context.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const requestBody = {
    contents: [{
      parts: [
        ...imageParts,
        { text: context.prompt }
      ]
    }],
    generationConfig: {
      imageConfig: {
        aspectRatio,
        imageSize
      },
      responseModalities: ["IMAGE"]
    }
  };
  const debug = {
    aspectRatio,
    endpoint: endpoint.replace(settings.apiKey, "[redacted]"),
    imageCount: imageParts.length,
    imageSize,
    mode: "gemini-native",
    model: context.model,
    n: context.n
  };

  const response = await fetch(endpoint, {
    body: JSON.stringify(requestBody),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(generationTimeoutMs)
  });

  if (!response.ok) {
    const error = await readProviderError(response);
    throw new AiProviderError(error, response.status, debug, { responseContentType: response.headers.get("content-type") });
  }

  const { payload, contentType } = await readProviderPayload(response);
  const images = normalizeImages(payload, expectedCount);
  if (!images.length) {
    throw new AiProviderError("Gemini 图片接口没有返回图片。", 502, debug, { responseContentType: contentType, responseKeys: getResponseKeys(payload) });
  }

  return {
    debug,
    imageCount: images.length,
    images,
    responseContentType: contentType,
    responseKeys: getResponseKeys(payload),
    responseStatus: response.status
  };
}

async function buildAsyncSubmit(context: SubmitContext): Promise<AsyncSubmit> {
  switch (getAdapterName(context.model)) {
    case "gpt-image-2":
      return buildGptImage2Submit(context);
    case "gemini-3.1-flash-image-preview":
      return buildGemini31FlashImageSubmit(context);
    case "gemini-3-pro-image-preview":
      return buildGemini3ProImageSubmit(context);
    default:
      throw new Error("当前图片模型暂未配置接口适配器。");
  }
}

function normalizeImages(payload: unknown, expectedCount?: number) {
  const images: Array<{ url: string }> = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const data = getNestedRecord(record, "data");
    const candidates = [
      { key: "data", value: record.data },
      { key: "outputs", value: record.outputs },
      { key: "output", value: record.output },
      { key: "images", value: record.images },
      { key: "result", value: record.result },
      { key: "results", value: record.results },
      { key: "outputs", value: data?.outputs },
      { key: "output", value: data?.output },
      { key: "images", value: data?.images },
      { key: "result", value: data?.result },
      { key: "results", value: data?.results }
    ].filter((candidate): candidate is { key: string; value: unknown } => candidate.value !== undefined);
    candidates.forEach((candidate) => collectImages(candidate.value, images, candidate.key));
  } else {
    collectImages(payload, images);
  }
  const uniqueImages = Array.from(new Map(images.map((image) => [image.url, image])).values());
  return expectedCount ? uniqueImages.slice(0, expectedCount) : uniqueImages;
}

function getResponseKeys(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>).slice(0, 20);
}

function isSuccessStatus(status: string) {
  return ["", "success", "succeeded", "completed", "done", "partial_completed"].includes(status);
}

function isTerminalSuccessStatus(status: string) {
  return ["success", "succeeded", "completed", "done"].includes(status);
}

async function writeDebug(record: SafeDebugRecord) {
  try {
    await fs.mkdir(path.dirname(debugPath), { recursive: true });
    let records: SafeDebugRecord[] = [];
    try {
      records = JSON.parse(await fs.readFile(debugPath, "utf8")) as SafeDebugRecord[];
      if (!Array.isArray(records)) records = [];
    } catch {
      records = [];
    }
    records.push(record);
    await fs.writeFile(debugPath, `${JSON.stringify(records.slice(-20), null, 2)}\n`, "utf8");
  } catch {
    // Debug logging must never break image generation.
  }
}

interface AiTaskRecoveryRecord {
  taskId: string;
  model: string;
  prompt?: string;
  sourceNodeId?: string;
  expectedCount: number;
  status: "submitted" | "running" | "completed" | "failed" | "backed_up";
  submittedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  images?: Array<{ url: string }>;
}

interface AiTaskRecoveryFile {
  format: "ai-canvas-task-recovery";
  version: 1;
  tasks: AiTaskRecoveryRecord[];
  savedAt: string;
}

function normalizeTaskRecoveryFile(value: Partial<AiTaskRecoveryFile>): AiTaskRecoveryFile {
  return {
    format: "ai-canvas-task-recovery",
    version: 1,
    tasks: Array.isArray(value.tasks)
      ? value.tasks.filter((task): task is AiTaskRecoveryRecord => typeof task.taskId === "string" && typeof task.model === "string")
      : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

async function readTaskRecoveryFile() {
  try {
    return normalizeTaskRecoveryFile(JSON.parse(await fs.readFile(taskRecoveryPath, "utf8")) as Partial<AiTaskRecoveryFile>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeTaskRecoveryFile({ tasks: [] });
    throw error;
  }
}

async function writeTaskRecoveryFile(file: AiTaskRecoveryFile) {
  await fs.mkdir(path.dirname(taskRecoveryPath), { recursive: true });
  await fs.writeFile(taskRecoveryPath, `${JSON.stringify({ ...file, savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function upsertRecoveryTask(task: Omit<AiTaskRecoveryRecord, "submittedAt" | "updatedAt" | "status"> & { status?: AiTaskRecoveryRecord["status"] }) {
  try {
    const current = await readTaskRecoveryFile();
    const now = new Date().toISOString();
    const existing = current.tasks.find((item) => item.taskId === task.taskId);
    const nextTask: AiTaskRecoveryRecord = {
      ...existing,
      ...task,
      expectedCount: task.expectedCount,
      model: task.model,
      status: task.status ?? existing?.status ?? "submitted",
      submittedAt: existing?.submittedAt ?? now,
      updatedAt: now
    };
    const nextTasks = existing
      ? current.tasks.map((item) => (item.taskId === task.taskId ? nextTask : item))
      : [...current.tasks, nextTask];
    await writeTaskRecoveryFile({ ...current, tasks: nextTasks.slice(-200) });
  } catch (error) {
    console.warn("[generate-image] recovery task write skipped", error);
  }
}

async function updateRecoveryTask(taskId: string, patch: Partial<Omit<AiTaskRecoveryRecord, "taskId" | "submittedAt">>) {
  try {
    const current = await readTaskRecoveryFile();
    const now = new Date().toISOString();
    const nextTasks = current.tasks.map((task) => (
      task.taskId === taskId
        ? { ...task, ...patch, updatedAt: now }
        : task
    ));
    await writeTaskRecoveryFile({ ...current, tasks: nextTasks });
  } catch (error) {
    console.warn("[generate-image] recovery task update skipped", error);
  }
}

async function readProviderPayload(response: Response) {
  const contentType = response.headers.get("content-type");
  if (contentType?.startsWith("image/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { contentType, payload: { data: [{ b64_json: buffer.toString("base64") }] } };
  }

  const text = await response.text();
  if (!text.trim()) return { contentType, payload: null };
  try {
    return { contentType, payload: JSON.parse(text) as unknown };
  } catch {
    return { contentType, payload: text };
  }
}

async function readProviderError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message ?? payload.message ?? `AI 服务返回错误：${response.status}`;
  } catch {
    return `AI 服务返回错误：${response.status}`;
  }
}

async function submitAsyncTask(settings: ApiSettings, context: SubmitContext, expectedCount: number) {
  const submit = await buildAsyncSubmit(context);
  const v1BaseUrl = withV1BaseUrl(settings.baseUrl);
  const endpoint = submit.taskSubmitEndpoint ? `${v1BaseUrl}${submit.taskSubmitEndpoint}` : `${v1BaseUrl}/task/submit`;
  const debug = {
    endpoint,
    ...submit.debug,
    mode: "task",
    model: context.model,
    n: context.n
  };
  const submitResponse = await fetch(endpoint, {
    body: submit.body,
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      ...submit.headers
    },
    method: "POST",
    signal: AbortSignal.timeout(60000)
  });

  if (!submitResponse.ok) {
    const error = await readProviderError(submitResponse);
    throw new AiProviderError(error, submitResponse.status, debug, { responseContentType: submitResponse.headers.get("content-type") });
  }

  const { payload: submitResult, contentType: submitContentType } = await readProviderPayload(submitResponse);
  const taskId = getTaskId(submitResult);
  if (!taskId) {
    throw new AiProviderError("AI 服务没有返回任务 ID。", 502, debug, { responseContentType: submitContentType, responseKeys: getResponseKeys(submitResult) });
  }

  const taskEndpoint = `${v1BaseUrl}/task/${encodeURIComponent(taskId)}`;
  await upsertRecoveryTask({
    expectedCount,
    model: context.model,
    prompt: context.prompt,
    sourceNodeId: context.sourceNodeId,
    status: "submitted",
    taskId
  });
  return {
    contentType: submitContentType,
    debug: { ...debug, taskEndpoint, taskId },
    payload: submitResult,
    taskEndpoint,
    taskId
  };
}

async function pollAsyncTask(settings: ApiSettings, task: { expectedCount: number; model: string; prompt?: string; sourceNodeId?: string; taskId: string }) {
  const v1BaseUrl = withV1BaseUrl(settings.baseUrl);
  const taskEndpoint = `${v1BaseUrl}/task/${encodeURIComponent(task.taskId)}`;
  const taskResponse = await fetch(taskEndpoint, {
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json"
    },
    method: "GET",
    signal: AbortSignal.timeout(60000)
  });
  if (!taskResponse.ok) {
    const error = await readProviderError(taskResponse);
    throw new AiProviderError(error, taskResponse.status, { mode: "task-poll", taskEndpoint, taskId: task.taskId }, { responseContentType: taskResponse.headers.get("content-type") });
  }

  const taskResult = await readProviderPayload(taskResponse);
  const status = getTaskStatus(taskResult.payload);
  const images = normalizeImages(taskResult.payload, task.expectedCount);
  const debug = {
    mode: "task-poll",
    status,
    taskEndpoint,
    taskId: task.taskId
  };
  if (images.length && isSuccessStatus(status)) {
    await updateRecoveryTask(task.taskId, { completedAt: new Date().toISOString(), images, status: "completed" });
    return {
      completed: true,
      debug,
      images,
      responseContentType: taskResult.contentType,
      responseKeys: getResponseKeys(taskResult.payload)
    };
  }
  if (!images.length && isTerminalSuccessStatus(status)) {
    await updateRecoveryTask(task.taskId, { completedAt: new Date().toISOString(), error: "AI 任务已完成，但返回内容里没有可用图片。", status: "failed" });
    throw new AiProviderError("AI 任务已完成，但返回内容里没有可用图片。", 502, debug, { responseContentType: taskResult.contentType, responseKeys: getResponseKeys(taskResult.payload) });
  }
  if (["failed", "error", "cancelled", "canceled"].includes(status)) {
    const error = getTaskError(taskResult.payload) || "AI 任务失败。";
    await updateRecoveryTask(task.taskId, { completedAt: new Date().toISOString(), error, status: "failed" });
    throw new AiProviderError(error, 502, debug, { responseContentType: taskResult.contentType, responseKeys: getResponseKeys(taskResult.payload) });
  }
  await updateRecoveryTask(task.taskId, { status: "running" });
  return {
    completed: false,
    debug,
    images: [],
    responseContentType: taskResult.contentType,
    responseKeys: getResponseKeys(taskResult.payload)
  };
}

async function executeAsyncGeneration(settings: ApiSettings, context: SubmitContext, expectedCount: number): Promise<AsyncGenerationResult> {
  const submitted = await submitAsyncTask(settings, context, expectedCount);
  const taskId = submitted.taskId;
  const taskDebug = submitted.debug;
  const taskEndpoint = submitted.taskEndpoint;
  const startedAt = Date.now();
  let taskPayload: unknown = submitted.payload;
  let taskContentType: string | null = submitted.contentType;
  while (Date.now() - startedAt < generationTimeoutMs) {
    const status = getTaskStatus(taskPayload);
    const images = normalizeImages(taskPayload, expectedCount);
    if (images.length && isSuccessStatus(status)) {
      await updateRecoveryTask(taskId, { completedAt: new Date().toISOString(), images, status: "completed" });
      return {
        debug: { ...taskDebug, status },
        imageCount: images.length,
        images,
        responseContentType: taskContentType,
        responseKeys: getResponseKeys(taskPayload),
        responseStatus: 200
      };
    }
    if (!images.length && isTerminalSuccessStatus(status)) {
      await updateRecoveryTask(taskId, { completedAt: new Date().toISOString(), error: "AI 任务已完成，但返回内容里没有可用图片。", status: "failed" });
      throw new AiProviderError("AI 任务已完成，但返回内容里没有可用图片。", 502, { ...taskDebug, status }, { responseContentType: taskContentType, responseKeys: getResponseKeys(taskPayload) });
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      const error = getTaskError(taskPayload) || "AI 任务失败。";
      await updateRecoveryTask(taskId, { completedAt: new Date().toISOString(), error, status: "failed" });
      throw new AiProviderError(error, 502, { ...taskDebug, status }, { responseContentType: taskContentType, responseKeys: getResponseKeys(taskPayload) });
    }

    await sleep(3000);
    const taskResponse = await fetch(taskEndpoint, {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "GET",
      signal: AbortSignal.timeout(60000)
    });
    if (!taskResponse.ok) {
      const error = await readProviderError(taskResponse);
      throw new AiProviderError(error, taskResponse.status, { ...taskDebug, status }, { responseContentType: taskResponse.headers.get("content-type") });
    }
    const taskResult = await readProviderPayload(taskResponse);
    taskPayload = taskResult.payload;
    taskContentType = taskResult.contentType;
    await updateRecoveryTask(taskId, { status: "running" });
  }

  const images = normalizeImages(taskPayload, expectedCount);
  if (!images.length) {
    await updateRecoveryTask(taskId, { error: "AI 服务没有返回图片。", status: "running" });
    throw new AiProviderError("AI 服务没有返回图片。", 502, { ...taskDebug, status: getTaskStatus(taskPayload) }, { responseContentType: taskContentType, responseKeys: getResponseKeys(taskPayload) });
  }
  await updateRecoveryTask(taskId, { completedAt: new Date().toISOString(), images, status: "completed" });
  return {
    debug: { ...taskDebug, status: getTaskStatus(taskPayload) },
    imageCount: images.length,
    images,
    responseContentType: taskContentType,
    responseKeys: getResponseKeys(taskPayload),
    responseStatus: 200
  };
}

async function executeGeminiBatchGeneration(settings: ApiSettings, context: SubmitContext): Promise<AsyncGenerationResult> {
  const results: AsyncGenerationResult[] = [];
  for (let index = 0; index < context.n; index += 1) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await executeAsyncGeneration(settings, { ...context, n: 1 }, 1);
        results.push(result);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }

  const images = results.flatMap((result) => result.images).slice(0, context.n);
  const last = results[results.length - 1];
  return {
    debug: {
      ...(last?.debug ?? {}),
      batchMode: "single-task-per-image",
      requestedCount: context.n,
      taskIds: results.map((result) => result.debug.taskId).filter(Boolean)
    },
    imageCount: images.length,
    images,
    responseContentType: last?.responseContentType ?? "application/json",
    responseKeys: last?.responseKeys ?? [],
    responseStatus: 200
  };
}

async function executeGeminiNativeBatchGeneration(settings: ApiSettings, context: SubmitContext): Promise<AsyncGenerationResult> {
  if (context.n <= 1) return executeGeminiNativeGeneration(settings, context, 1);
  const results: AsyncGenerationResult[] = [];
  for (let index = 0; index < context.n; index += 1) {
    results.push(await executeGeminiNativeGeneration(settings, { ...context, n: 1 }, 1));
  }
  const images = results.flatMap((result) => result.images).slice(0, context.n);
  const last = results[results.length - 1];
  return {
    debug: {
      ...(last?.debug ?? {}),
      batchMode: "gemini-native-single-call-per-image",
      requestedCount: context.n
    },
    imageCount: images.length,
    images,
    responseContentType: last?.responseContentType ?? "application/json",
    responseKeys: last?.responseKeys ?? [],
    responseStatus: 200
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as GenerateImageRequest;
    const rawModel = body.model?.trim();
    const model = getBaseModelId(rawModel)?.trim();
    const prompt = body.prompt?.trim();
    const settings = await readSettings(rawModel, body.aiSettings);
    console.log("[generate-image] request received", {
      imageCount: body.images?.length ?? 0,
      model,
      outputCount: body.params?.imageCount ?? "1",
      sourceNodeId: body.sourceNodeId
    });

    if (!settings.baseUrl || !settings.apiKey) {
      return NextResponse.json({ error: isAgnesImageModel(model) ? "请先在设置页保存 Agnes 服务地址和 API Key。" : "请先在设置页保存 AI 服务地址和 API Key。" }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: "缺少图片模型。" }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ error: "请先连接或填写提示词。" }, { status: 400 });
    }
    const imageSources = body.images ?? [];
    const referenceImageLimit = getReferenceImageLimit(model);
    if (imageSources.length > referenceImageLimit) {
      return NextResponse.json({ error: `当前模型最多支持 ${referenceImageLimit} 张参考图。` }, { status: 400 });
    }

    const n = getImageCount(body.params?.imageCount);
    const equalGridPanelConstraint = buildEqualGridPanelConstraint(body.params);
    const requestPrompt = equalGridPanelConstraint ? `${prompt}\n\n${equalGridPanelConstraint}` : prompt;
    const context: SubmitContext = {
      imageSources,
      model,
      n,
      params: body.params,
      prompt: requestPrompt,
      sourceNodeId: body.sourceNodeId
    };

    if (body.mode === "submit") {
      if (isAgnesImageModel(model) || (isGeminiImageModel(model) && !is12AiBaseUrl(settings.baseUrl))) {
        return NextResponse.json({ error: "当前模型暂不支持异步任务模式。" }, { status: 400 });
      }
      const submissions = await Promise.all(Array.from({ length: n }, () => submitAsyncTask(settings, { ...context, n: 1 }, 1)));
      return NextResponse.json({
        debug: {
          mode: "task-submit",
          taskIds: submissions.map((item) => item.taskId)
        },
        expectedCount: n,
        status: "submitted",
        taskIds: submissions.map((item) => item.taskId)
      });
    }

    if (body.mode === "poll") {
      const taskIds = (body.taskIds ?? []).filter((taskId): taskId is string => typeof taskId === "string" && Boolean(taskId.trim()));
      if (!taskIds.length) return NextResponse.json({ error: "缺少任务 ID。" }, { status: 400 });
      const expectedCount = Math.max(1, Number(body.expectedCount ?? taskIds.length) || taskIds.length);
      const results = await Promise.all(taskIds.map((taskId) => pollAsyncTask(settings, { expectedCount: 1, model, prompt, sourceNodeId: body.sourceNodeId, taskId })));
      const images = results.flatMap((result) => result.images).slice(0, expectedCount);
      const allCompleted = results.every((result) => result.completed);
      if (!allCompleted || images.length < expectedCount) {
        return NextResponse.json({
          debug: {
            mode: "task-poll",
            taskIds,
            statuses: results.map((result) => result.debug.status)
          },
          images,
          status: "running"
        }, { status: 202 });
      }
      await Promise.all(taskIds.map((taskId) => updateRecoveryTask(taskId, { status: "backed_up" })));
      await writeDebug({
        at: new Date().toISOString(),
        backupSaved: 0,
        debug: {
          mode: "task-poll",
          taskIds
        },
        imageCount: images.length,
        responseContentType: results[0]?.responseContentType,
        responseKeys: results[0]?.responseKeys,
        responseStatus: 200
      });
      return NextResponse.json({ debug: { backupSaved: 0, mode: "task-poll", taskIds }, images, status: "completed" });
    }

    const result = isAgnesImageModel(model)
      ? await executeAgnesGeneration(settings, context, n)
      : isGeminiImageModel(model) && is12AiBaseUrl(settings.baseUrl)
      ? await executeGeminiBatchGeneration(settings, context)
      : isGeminiImageModel(model)
      ? await executeGeminiNativeBatchGeneration(settings, context)
      : await executeAsyncGeneration(settings, context, n);
    const taskIds = [result.debug.taskId, ...(Array.isArray(result.debug.taskIds) ? result.debug.taskIds : [])]
      .filter((taskId): taskId is string => typeof taskId === "string");
    await Promise.all(taskIds.map((taskId) => updateRecoveryTask(taskId, { status: "backed_up" })));
    await writeDebug({
      at: new Date().toISOString(),
      backupSaved: 0,
      debug: result.debug,
      imageCount: result.imageCount,
      responseContentType: result.responseContentType,
      responseKeys: result.responseKeys,
      responseStatus: result.responseStatus
    });
    return NextResponse.json({ debug: { ...result.debug, backupSaved: 0 }, images: result.images });
  } catch (error) {
    if (error instanceof AiProviderError) {
      await writeDebug({
        at: new Date().toISOString(),
        debug: error.debug,
        error: error.message,
        responseContentType: error.responseContentType,
        responseKeys: error.responseKeys,
        responseStatus: error.responseStatus
      });
      return NextResponse.json({ debug: error.debug, error: error.message }, { status: error.responseStatus });
    }
    const message =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "AI 生成超时，请稍后重试，或切换到更稳定的模型。"
        : error instanceof TypeError && /fetch failed|network|terminated|socket|connection/i.test(error.message)
        ? "上游 AI 服务连接失败或响应中断，请稍后重试，或切换到更稳定的模型。"
        : "AI 生成失败，请检查设置和模型参数。";
    await writeDebug({
      at: new Date().toISOString(),
      error: error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}` : message
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
