export type ImageSpaceMode = "browser" | "folder";

export interface StoredImageSpaceSettings {
  mode: ImageSpaceMode;
  folderName?: string;
  savedAt: string;
}

interface FileSystemPermissionHandle {
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

type WritableFileStream = {
  close: () => Promise<void>;
  write: (data: Blob) => Promise<void>;
};

export type BrowserDirectoryHandle = FileSystemPermissionHandle & {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandle>;
  name?: string;
};

type FileSystemFileHandle = {
  createWritable: () => Promise<WritableFileStream>;
  getFile?: () => Promise<File>;
};

const imageSpaceStorageKey = "ai-canvas-image-space-v1";
const imageSpaceDbName = "ai-canvas-image-space";
const imageSpaceStoreName = "handles";
const imageSpaceDirectoryHandleKey = "directory";

export function readImageSpaceSettings(): StoredImageSpaceSettings {
  try {
    const saved = window.localStorage.getItem(imageSpaceStorageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<StoredImageSpaceSettings>;
      return {
        folderName: typeof parsed.folderName === "string" ? parsed.folderName : undefined,
        mode: parsed.mode === "folder" ? "folder" : "browser",
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString()
      };
    }
  } catch {
    window.localStorage.removeItem(imageSpaceStorageKey);
  }
  return { mode: "browser", savedAt: new Date().toISOString() };
}

export function saveImageSpaceSettings(settings: StoredImageSpaceSettings) {
  try {
    window.localStorage.setItem(imageSpaceStorageKey, JSON.stringify(settings));
  } catch {
    // localStorage can be unavailable in private or restricted browser contexts.
  }
}

export async function pickImageSpaceFolder() {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<BrowserDirectoryHandle> }).showDirectoryPicker;
  if (!picker) {
    throw new Error("当前浏览器不支持选择文件夹，请使用 Chrome 或 Edge。");
  }
  return picker();
}

function openImageSpaceDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(imageSpaceDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(imageSpaceStoreName);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function writeDbValue<T>(key: string, value: T) {
  const db = await openImageSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(imageSpaceStoreName, "readwrite");
    transaction.objectStore(imageSpaceStoreName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readDbValue<T>(key: string) {
  const db = await openImageSpaceDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(imageSpaceStoreName, "readonly");
    const request = transaction.objectStore(imageSpaceStoreName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function saveImageSpaceDirectoryHandle(handle: BrowserDirectoryHandle) {
  await writeDbValue(imageSpaceDirectoryHandleKey, handle);
}

async function getImageSpaceDirectoryHandle() {
  return readDbValue<BrowserDirectoryHandle>(imageSpaceDirectoryHandleKey);
}

async function ensureReadWritePermission(handle: BrowserDirectoryHandle) {
  const options = { mode: "readwrite" as const };
  if (handle.queryPermission) {
    const current = await handle.queryPermission(options);
    if (current === "granted") return true;
  }
  if (handle.requestPermission) {
    return await handle.requestPermission(options) === "granted";
  }
  return true;
}

function sanitizeFilename(filename: string) {
  return filename
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 96) || "image.png";
}

function extensionFromMimeType(type: string) {
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  return "png";
}

function filenameWithTimestamp(prefix: string, type: string) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${Math.round(Math.random() * 10000)}.${extensionFromMimeType(type)}`;
}

async function imageSourceToBlob(imageSource: Blob | string, preferredName?: string) {
  if (imageSource instanceof Blob) {
    return {
      blob: imageSource,
      filename: sanitizeFilename(preferredName || filenameWithTimestamp("image", imageSource.type))
    };
  }

  const response = await fetch(
    /^https?:\/\//.test(imageSource)
      ? `/api/canvas/image-download?url=${encodeURIComponent(imageSource)}&filename=${encodeURIComponent(preferredName || "image.png")}`
      : imageSource
  );
  if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
  const blob = await response.blob();
  return {
    blob,
    filename: sanitizeFilename(preferredName || filenameWithTimestamp("image", blob.type))
  };
}

export async function writeImageToConfiguredImageSpace(
  imageSource: Blob | string,
  options: { kind: "generated" | "imports"; preferredName?: string }
) {
  if (typeof window === "undefined") return { saved: false as const, reason: "server" };
  const settings = readImageSpaceSettings();
  if (settings.mode !== "folder") return { saved: false as const, reason: "browser" };

  const rootHandle = await getImageSpaceDirectoryHandle();
  if (!rootHandle) return { saved: false as const, reason: "missing-folder" };
  if (!await ensureReadWritePermission(rootHandle)) return { saved: false as const, reason: "permission-denied" };

  const folder = await rootHandle.getDirectoryHandle(options.kind, { create: true });
  const { blob, filename } = await imageSourceToBlob(imageSource, options.preferredName);
  const fileHandle = await folder.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  const ref = `${options.kind}/${filename}`;
  return { filename, ref, saved: true as const, url: imageSpaceUrl(ref) };
}

export function imageSpaceUrl(ref: string) {
  return `image-space://${ref.replace(/^\/+/, "")}`;
}

export function getImageSpaceRef(value?: string) {
  if (!value?.startsWith("image-space://")) return "";
  return value.replace("image-space://", "").replace(/^\/+/, "");
}

async function getFileHandleFromRef(ref: string) {
  const rootHandle = await getImageSpaceDirectoryHandle();
  if (!rootHandle) throw new Error("未找到图片空间文件夹，请在设置里重新选择。");
  if (!await ensureReadWritePermission(rootHandle)) throw new Error("图片空间没有读取权限，请在设置里重新授权。");
  const parts = ref.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("图片空间引用无效。");
  const filename = parts.at(-1);
  if (!filename) throw new Error("图片空间文件名无效。");
  let directory = rootHandle;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory.getFileHandle(filename);
}

export async function readImageSpaceBlob(refOrUrl: string) {
  const ref = getImageSpaceRef(refOrUrl) || refOrUrl;
  const fileHandle = await getFileHandleFromRef(ref);
  const readableHandle = fileHandle as FileSystemFileHandle & { getFile?: () => Promise<File> };
  if (!readableHandle.getFile) throw new Error("当前浏览器无法读取图片空间文件。");
  return readableHandle.getFile();
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function resolveImageSpaceUrlForDisplay(imageUrl?: string) {
  if (!imageUrl?.startsWith("image-space://")) return imageUrl;
  const blob = await readImageSpaceBlob(imageUrl);
  return URL.createObjectURL(blob);
}

export async function resolveImageUrlForAi(imageUrl: string) {
  if (imageUrl.startsWith("image-space://")) {
    return blobToDataUrl(await readImageSpaceBlob(imageUrl));
  }
  if (imageUrl.startsWith("blob:")) {
    const response = await fetch(imageUrl);
    if (!response.ok) return imageUrl;
    return blobToDataUrl(await response.blob());
  }
  return imageUrl;
}
