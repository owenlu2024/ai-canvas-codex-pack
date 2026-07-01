import path from "path";

export function getCanvasDataDir() {
  return process.env.AI_CANVAS_DATA_DIR || (process.env.VERCEL ? path.join("/tmp", ".ai-canvas") : path.join(process.cwd(), ".ai-canvas"));
}

export function getCanvasDataPath(filename: string) {
  return path.join(getCanvasDataDir(), filename);
}

export function getPublicAssetPath(value: string) {
  const publicDir = path.resolve(process.env.AI_CANVAS_PUBLIC_DIR || path.join(process.cwd(), "public"));
  const resolved = path.resolve(publicDir, value.replace(/^\/+/, ""));
  if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error("Public asset path escapes the public directory.");
  }
  return resolved;
}
