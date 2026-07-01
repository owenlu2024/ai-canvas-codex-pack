export interface ClientGeneratedImageBackup {
  createdAt?: string;
  id: string;
  imageUrl: string;
  modelId?: string;
  prompt?: string;
  sourceNodeId?: string;
}

const generatedImagesStorageKey = "ai-canvas-generated-images-v1";
const deletedGeneratedImagesStorageKey = "ai-canvas-generated-images-deleted-v1";

function getImageKey(imageUrl: string) {
  let hash = 0;
  for (let index = 0; index < imageUrl.length; index += 1) {
    hash = ((hash << 5) - hash + imageUrl.charCodeAt(index)) | 0;
  }
  return `${imageUrl.length}:${hash}`;
}

function normalizeImages(value: unknown): ClientGeneratedImageBackup[] {
  if (!Array.isArray(value)) return [];
  return value.filter((image): image is ClientGeneratedImageBackup => (
    typeof image === "object" &&
    image !== null &&
    typeof (image as ClientGeneratedImageBackup).id === "string" &&
    typeof (image as ClientGeneratedImageBackup).imageUrl === "string"
  ));
}

function readDeletedImageKeys() {
  try {
    const saved = window.localStorage.getItem(deletedGeneratedImagesStorageKey);
    const parsed = saved ? JSON.parse(saved) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function writeDeletedImageKeys(keys: Set<string>) {
  window.localStorage.setItem(deletedGeneratedImagesStorageKey, JSON.stringify(Array.from(keys)));
}

export function readClientGeneratedImages() {
  try {
    const saved = window.localStorage.getItem(generatedImagesStorageKey);
    return normalizeImages(saved ? JSON.parse(saved) as unknown : []);
  } catch {
    window.localStorage.removeItem(generatedImagesStorageKey);
    return [];
  }
}

export function writeClientGeneratedImages(images: ClientGeneratedImageBackup[]) {
  window.localStorage.setItem(generatedImagesStorageKey, JSON.stringify(normalizeImages(images)));
}

export function addClientGeneratedImages(images: Array<Partial<ClientGeneratedImageBackup> & { imageUrl: string }>) {
  const current = readClientGeneratedImages();
  const deletedKeys = readDeletedImageKeys();
  const existingUrls = new Set(current.map((image) => image.imageUrl));
  const createdAt = new Date().toISOString();
  const incoming = images
    .filter((image) => image.imageUrl)
    .filter((image) => !existingUrls.has(image.imageUrl))
    .filter((image) => !deletedKeys.has(getImageKey(image.imageUrl)))
    .map((image, index) => ({
      createdAt: image.createdAt ?? createdAt,
      id: image.id ?? `generated-backup-${Date.now()}-${index}-${Math.round(Math.random() * 1000)}`,
      imageUrl: image.imageUrl,
      modelId: image.modelId,
      prompt: image.prompt,
      sourceNodeId: image.sourceNodeId
    }));
  if (!incoming.length) return current;
  const next = [...current, ...incoming];
  writeClientGeneratedImages(next);
  window.dispatchEvent(new CustomEvent("ai-canvas-generated-images-updated"));
  return next;
}

export function removeClientGeneratedImages(ids: string[]) {
  const idSet = new Set(ids);
  const current = readClientGeneratedImages();
  const removed = idSet.size ? current.filter((image) => idSet.has(image.id)) : current;
  const deletedKeys = readDeletedImageKeys();
  removed.forEach((image) => deletedKeys.add(getImageKey(image.imageUrl)));
  const next = idSet.size ? current.filter((image) => !idSet.has(image.id)) : [];
  writeClientGeneratedImages(next);
  writeDeletedImageKeys(deletedKeys);
  window.dispatchEvent(new CustomEvent("ai-canvas-generated-images-updated"));
  return next;
}

