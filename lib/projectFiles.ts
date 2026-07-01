import type { CanvasWorkspaceSnapshot } from "@/store/canvasStore";

export interface GeneratedImageBackup {
  id: string;
  imageUrl: string;
  modelId?: string;
  prompt?: string;
  sourceNodeId?: string;
  createdAt?: string;
}

export interface AiCanvasProjectFile {
  format: "ai-canvas-project";
  version: 1;
  workspace: CanvasWorkspaceSnapshot;
  generatedImages: GeneratedImageBackup[];
  savedAt: string;
}

export interface RecentProject {
  id: string;
  name: string;
  savedAt: string;
}

type WritableProjectFile = {
  close: () => Promise<void>;
  write: (data: Blob | string) => Promise<void>;
};

export type ProjectFileHandle = {
  createWritable: () => Promise<WritableProjectFile>;
  getFile: () => Promise<File>;
  name: string;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<ProjectFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<ProjectFileHandle>;
};

const recentProjectsKey = "ai-canvas-recent-projects-v1";
const recentProjectLimit = 5;
const handlesDbName = "ai-canvas-project-handles";
const handlesStoreName = "handles";

function getPickerWindow() {
  return window as FilePickerWindow;
}

export function supportsProjectFilePicker() {
  const pickerWindow = getPickerWindow();
  return Boolean(pickerWindow.showSaveFilePicker && pickerWindow.showOpenFilePicker && window.indexedDB);
}

export function makeProjectFile(workspace: CanvasWorkspaceSnapshot, generatedImages: GeneratedImageBackup[]): AiCanvasProjectFile {
  const savedAt = new Date().toISOString();
  return {
    format: "ai-canvas-project",
    version: 1,
    workspace: { ...workspace, savedAt },
    generatedImages,
    savedAt
  };
}

export function getProjectFilename(title: string) {
  const safeTitle = title.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 64) || "未命名项目";
  return safeTitle.endsWith(".aicanvas") ? safeTitle : `${safeTitle}.aicanvas`;
}

export function getProjectTitleFromFilename(filename: string) {
  const title = filename.replace(/\.aicanvas$/i, "").trim();
  return title || "未命名项目";
}

export async function readGeneratedImages() {
  const response = await fetch("/api/canvas/generated-images", { cache: "no-store" });
  if (!response.ok) return [];
  const payload = (await response.json()) as { images?: GeneratedImageBackup[] };
  return Array.isArray(payload.images) ? payload.images : [];
}

export async function replaceGeneratedImages(images: GeneratedImageBackup[]) {
  const response = await fetch("/api/canvas/generated-images", {
    body: JSON.stringify({ images }),
    headers: { "Content-Type": "application/json" },
    method: "PUT"
  });
  if (!response.ok) throw new Error("AI 返图同步失败。");
  window.dispatchEvent(new CustomEvent("ai-canvas-generated-images-updated"));
}

export async function clearGeneratedImages() {
  const response = await fetch("/api/canvas/generated-images", {
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
    method: "DELETE"
  });
  if (!response.ok) throw new Error("AI 返图清理失败。");
  window.dispatchEvent(new CustomEvent("ai-canvas-generated-images-updated"));
}

export async function persistWorkspace(workspace: CanvasWorkspaceSnapshot) {
  const serializedWorkspace = JSON.stringify(workspace);
  try {
    window.localStorage.setItem("ai-canvas-workspace-v1", serializedWorkspace);
  } catch {
    try {
      window.localStorage.removeItem("ai-canvas-workspace-v1");
    } catch {
      // Browser storage is optional; the server-side workspace file is still written below.
    }
  }
  const response = await fetch("/api/canvas/workspace", {
    body: serializedWorkspace,
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error("本机工作区同步失败。");
}

export async function pickProjectSaveFile(suggestedName: string) {
  const savePicker = getPickerWindow().showSaveFilePicker;
  if (!savePicker) return null;
  return savePicker({
    suggestedName,
    types: [
      {
        accept: { "application/json": [".aicanvas"] },
        description: "AI Canvas Project"
      }
    ]
  });
}

export async function pickProjectOpenFile() {
  const openPicker = getPickerWindow().showOpenFilePicker;
  if (!openPicker) return null;
  const handles = await openPicker({
    multiple: false,
    types: [
      {
        accept: { "application/json": [".aicanvas"] },
        description: "AI Canvas Project"
      }
    ]
  });
  return handles[0] ?? null;
}

export async function writeProjectFile(handle: ProjectFileHandle, project: AiCanvasProjectFile) {
  const writable = await handle.createWritable();
  await writable.write(`${JSON.stringify(project, null, 2)}\n`);
  await writable.close();
}

export async function downloadProjectFile(filename: string, project: AiCanvasProjectFile) {
  const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readProjectFile(handle: ProjectFileHandle) {
  const file = await handle.getFile();
  return parseProjectFile(await file.text());
}

export function parseProjectFile(text: string): AiCanvasProjectFile {
  const project = JSON.parse(text) as Partial<AiCanvasProjectFile>;
  if (project.format !== "ai-canvas-project" || project.version !== 1 || !project.workspace) {
    throw new Error("项目文件格式不正确。");
  }
  return {
    format: "ai-canvas-project",
    version: 1,
    workspace: project.workspace,
    generatedImages: Array.isArray(project.generatedImages) ? project.generatedImages.filter((image): image is GeneratedImageBackup => (
      typeof image?.id === "string" && typeof image.imageUrl === "string"
    )) : [],
    savedAt: typeof project.savedAt === "string" ? project.savedAt : new Date().toISOString()
  };
}

export function readRecentProjects() {
  try {
    const value = JSON.parse(window.localStorage.getItem(recentProjectsKey) || "[]") as RecentProject[];
    return Array.isArray(value)
      ? value.filter((item): item is RecentProject => typeof item.id === "string" && typeof item.name === "string").slice(0, recentProjectLimit)
      : [];
  } catch {
    return [];
  }
}

export function writeRecentProject(project: RecentProject) {
  const next = [
    project,
    ...readRecentProjects().filter((item) => item.id !== project.id)
  ].slice(0, recentProjectLimit);
  window.localStorage.setItem(recentProjectsKey, JSON.stringify(next));
  return next;
}

function openHandlesDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(handlesDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(handlesStoreName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function storeProjectHandle(id: string, handle: ProjectFileHandle) {
  if (!window.indexedDB) return;
  const db = await openHandlesDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(handlesStoreName, "readwrite");
    transaction.objectStore(handlesStoreName).put(handle, id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readProjectHandle(id: string) {
  if (!window.indexedDB) return null;
  const db = await openHandlesDb();
  const handle = await new Promise<ProjectFileHandle | null>((resolve, reject) => {
    const transaction = db.transaction(handlesStoreName, "readonly");
    const request = transaction.objectStore(handlesStoreName).get(id);
    request.onsuccess = () => resolve((request.result as ProjectFileHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

export async function ensureProjectHandlePermission(handle: ProjectFileHandle, mode: "read" | "readwrite") {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if (await handle.queryPermission({ mode }) === "granted") return true;
  return await handle.requestPermission({ mode }) === "granted";
}
