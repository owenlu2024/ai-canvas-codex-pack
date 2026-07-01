import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import { NextResponse } from "next/server";
import { readApiSettings, type ApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { normalizeHttpBaseUrl } from "@/lib/urlSafety";

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

interface GeneratedImageBackup {
  id: string;
  imageUrl: string;
  modelId?: string;
  prompt?: string;
  sourceNodeId?: string;
  createdAt: string;
}

interface GeneratedImagesFile {
  format: "ai-canvas-generated-images";
  version: 1;
  images: GeneratedImageBackup[];
  savedAt: string;
}

interface DeletedGeneratedImagesFile {
  format: "ai-canvas-deleted-generated-images";
  version: 1;
  imageKeys: string[];
  savedAt: string;
}

interface SafeDebugRecord {
  debug?: Record<string, unknown>;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");
const debugPath = getCanvasDataPath("ai-generate-debug.local.json");
const generatedImagesPath = getCanvasDataPath("generated-images.local.json");
const deletedGeneratedImagesPath = getCanvasDataPath("generated-images-deleted.local.json");
const taskRecoveryPath = getCanvasDataPath("ai-task-recovery.local.json");

function getImageKey(imageUrl: string) {
  return createHash("sha256").update(imageUrl).digest("hex");
}

function normalizeBaseUrl(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "v1");
}

async function readSettings(): Promise<ApiSettings> {
  return readApiSettings(settingsPath, {
    normalizeBaseUrl
  });
}

function normalizeGeneratedImagesFile(value: Partial<GeneratedImagesFile>): GeneratedImagesFile {
  return {
    format: "ai-canvas-generated-images",
    version: 1,
    images: Array.isArray(value.images)
      ? value.images.filter((image): image is GeneratedImageBackup => typeof image.id === "string" && typeof image.imageUrl === "string")
      : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

function normalizeDeletedGeneratedImagesFile(value: Partial<DeletedGeneratedImagesFile>): DeletedGeneratedImagesFile {
  return {
    format: "ai-canvas-deleted-generated-images",
    version: 1,
    imageKeys: Array.isArray(value.imageKeys) ? value.imageKeys.filter((key): key is string => typeof key === "string") : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

async function readGeneratedImagesFile() {
  try {
    return normalizeGeneratedImagesFile(JSON.parse(await fs.readFile(generatedImagesPath, "utf8")) as Partial<GeneratedImagesFile>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeGeneratedImagesFile({ images: [] });
    throw error;
  }
}

async function readDeletedGeneratedImagesFile() {
  try {
    return normalizeDeletedGeneratedImagesFile(JSON.parse(await fs.readFile(deletedGeneratedImagesPath, "utf8")) as Partial<DeletedGeneratedImagesFile>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeDeletedGeneratedImagesFile({ imageKeys: [] });
    throw error;
  }
}

async function appendGeneratedImageBackups(images: Array<{ url: string }>, details: { model: string; prompt?: string; sourceNodeId?: string }) {
  if (!images.length) return 0;
  const current = await readGeneratedImagesFile();
  const deleted = await readDeletedGeneratedImagesFile();
  const existingUrls = new Set(current.images.map((image) => image.imageUrl));
  const deletedKeys = new Set(deleted.imageKeys);
  const createdAt = new Date().toISOString();
  const incoming = images
    .filter((image) => !existingUrls.has(image.url))
    .filter((image) => !deletedKeys.has(getImageKey(image.url)))
    .map((image, index) => ({
      createdAt,
      id: `generated-backup-${Date.now()}-${index}-${Math.round(Math.random() * 1000)}`,
      imageUrl: image.url,
      modelId: details.model,
      prompt: details.prompt,
      sourceNodeId: details.sourceNodeId
    }));
  if (!incoming.length) return 0;
  await fs.mkdir(path.dirname(generatedImagesPath), { recursive: true });
  await fs.writeFile(generatedImagesPath, `${JSON.stringify({ ...current, images: [...current.images, ...incoming], savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return incoming.length;
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

async function readProviderPayload(response: Response) {
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getNestedRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
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

function looksLikeBase64Image(value: string) {
  return value.length > 800 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 800));
}

function extractImageLikeStrings(value: string) {
  const matches: string[] = [];
  const dataUrlMatches = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g);
  if (dataUrlMatches) matches.push(...dataUrlMatches.map((match) => match.replace(/\s/g, "")));
  const urlMatches = value.match(/https?:\/\/[^\s"'<>\\)]+/g);
  if (urlMatches) matches.push(...urlMatches.map((match) => match.replace(/[.,;:!?]+$/, "")));
  return matches;
}

function collectImages(value: unknown, images: Array<{ url: string }>, keyHint = "") {
  if (!value) return;
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
    if ((keyHint === "b64_json" || keyHint === "base64" || keyHint === "image_base64" || keyHint === "data") && looksLikeBase64Image(trimmed)) {
      images.push({ url: `data:image/png;base64,${trimmed.replace(/\s/g, "")}` });
      return;
    }
    if (["url", "uri", "output", "outputs", "image", "images", "result", "results", "text", "content"].includes(keyHint)) {
      extractImageLikeStrings(trimmed).forEach((url) => images.push({ url }));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImages(item, images, keyHint));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string") images.push({ url: record.url });
  if (typeof record.b64_json === "string") images.push({ url: `data:image/png;base64,${record.b64_json.replace(/\s/g, "")}` });
  const inlineData = getNestedRecord(record, "inline_data") ?? getNestedRecord(record, "inlineData");
  const inlineMimeType = inlineData?.mime_type ?? inlineData?.mimeType;
  const inlineDataValue = inlineData?.data;
  if (typeof inlineDataValue === "string" && looksLikeBase64Image(inlineDataValue)) {
    images.push({ url: `data:${typeof inlineMimeType === "string" ? inlineMimeType : "image/png"};base64,${inlineDataValue.replace(/\s/g, "")}` });
  }
  Object.entries(record).forEach(([key, child]) => collectImages(child, images, key));
}

function normalizeImages(payload: unknown, expectedCount?: number) {
  const images: Array<{ url: string }> = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const data = getNestedRecord(record, "data");
    [
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
    ].filter((candidate) => candidate.value !== undefined).forEach((candidate) => collectImages(candidate.value, images, candidate.key));
  } else {
    collectImages(payload, images);
  }
  const uniqueImages = Array.from(new Map(images.map((image) => [image.url, image])).values());
  return expectedCount ? uniqueImages.slice(0, expectedCount) : uniqueImages;
}

function isSuccessStatus(status: string) {
  return ["", "success", "succeeded", "completed", "done", "partial_completed"].includes(status);
}

async function orphanTasksFromDebug(existingTaskIds: Set<string>): Promise<AiTaskRecoveryRecord[]> {
  try {
    const records = JSON.parse(await fs.readFile(debugPath, "utf8")) as SafeDebugRecord[];
    if (!Array.isArray(records)) return [];
    return records.reduce<AiTaskRecoveryRecord[]>((tasks, record) => {
      const debug = record.debug ?? {};
      const taskId = debug.taskId;
      const model = debug.model;
      if (typeof taskId !== "string" || existingTaskIds.has(taskId) || typeof model !== "string") return tasks;
      const now = new Date().toISOString();
      tasks.push({
          expectedCount: typeof debug.n === "number" ? debug.n : 1,
          model,
          status: "running",
          submittedAt: now,
          taskId,
          updatedAt: now
      });
      existingTaskIds.add(taskId);
      return tasks;
    }, []);
  } catch {
    return [];
  }
}

async function recoverOnce() {
  const settings = await readSettings();
  if (!settings.baseUrl || !settings.apiKey) return { recovered: 0, checked: 0 };

  const current = await readTaskRecoveryFile();
  const existingTaskIds = new Set(current.tasks.map((task) => task.taskId));
  const tasks = [...current.tasks, ...(await orphanTasksFromDebug(existingTaskIds))];
  let recovered = 0;
  let checked = 0;
  const nextTasks: AiTaskRecoveryRecord[] = [];

  for (const task of tasks) {
    if (task.status === "backed_up" || task.status === "failed") {
      nextTasks.push(task);
      continue;
    }
    checked += 1;
    try {
      const response = await fetch(`${settings.baseUrl}/task/${encodeURIComponent(task.taskId)}`, {
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json"
        },
        method: "GET",
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        nextTasks.push({ ...task, error: `查询失败：${response.status}`, status: "running", updatedAt: new Date().toISOString() });
        continue;
      }
      const payload = await readProviderPayload(response);
      const status = getTaskStatus(payload);
      const images = normalizeImages(payload, task.expectedCount);
      if (images.length && isSuccessStatus(status)) {
        const saved = await appendGeneratedImageBackups(images, { model: task.model, prompt: task.prompt, sourceNodeId: task.sourceNodeId });
        recovered += saved;
        nextTasks.push({ ...task, completedAt: new Date().toISOString(), images, status: "backed_up", updatedAt: new Date().toISOString() });
        continue;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        nextTasks.push({ ...task, completedAt: new Date().toISOString(), error: getTaskError(payload) || "AI 任务失败。", status: "failed", updatedAt: new Date().toISOString() });
        continue;
      }
      nextTasks.push({ ...task, status: "running", updatedAt: new Date().toISOString() });
    } catch (error) {
      nextTasks.push({ ...task, error: error instanceof Error ? error.message : "恢复查询失败。", status: "running", updatedAt: new Date().toISOString() });
    }
  }

  await writeTaskRecoveryFile({ ...current, tasks: nextTasks.slice(-200) });
  return { checked, recovered };
}

export async function GET() {
  try {
    return NextResponse.json(await recoverOnce());
  } catch {
    return NextResponse.json({ error: "无法恢复后台生图任务。" }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
