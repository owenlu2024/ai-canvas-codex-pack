import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl } from "@/lib/urlSafety";

interface CacheGeneratedImagesRequest {
  images?: Array<{ url?: string }>;
  sourceNodeId?: string;
}

function extensionForContentType(contentType: string) {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";
  return normalized === "image/png" ? "png" : "";
}

const imageReadyRetryCount = 20;
const imageReadyRetryDelayMs = 3000;

async function waitForCompleteRemoteImage(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < imageReadyRetryCount; attempt += 1) {
    try {
      const response = await fetch(assertSafeRemoteFetchUrl(url), {
        cache: "no-store",
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*" },
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error("返回内容不是图片。");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 80 * 1024 * 1024) throw new Error("图片大小不受支持。");
      const metadata = await sharp(buffer, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("图片文件尚未完整生成。");
      return { buffer, contentType };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < imageReadyRetryCount) {
        await new Promise((resolve) => setTimeout(resolve, imageReadyRetryDelayMs));
      }
    }
  }
  throw new Error(lastError instanceof Error ? `图片文件未准备完成：${lastError.message}` : "图片文件未准备完成。");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as CacheGeneratedImagesRequest;
    const images = (body.images ?? []).slice(0, 8);
    if (!images.length) return NextResponse.json({ error: "没有需要保存的图片。" }, { status: 400 });
    const directory = getCanvasDataPath("generated-images");
    const sourceTag = (body.sourceNodeId ?? "generated").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "generated";
    const createdAt = Date.now();
    const cached = await Promise.all(images.map(async (image, index) => {
      const url = image.url?.trim() ?? "";
      let buffer: Buffer;
      let contentType = "";
      if (url.startsWith("data:image/")) {
        const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (!match) throw new Error("图片数据格式无效。");
        contentType = match[1];
        buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      } else {
        ({ buffer, contentType } = await waitForCompleteRemoteImage(url));
      }
      const extension = extensionForContentType(contentType);
      if (!extension || !buffer.length || buffer.length > 80 * 1024 * 1024) throw new Error("图片格式或大小不受支持。");
      const metadata = await sharp(buffer, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("图片文件不完整。");
      const filename = `${sourceTag}-${createdAt}-${index + 1}.${extension}`;
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, filename), buffer);
      return { url: `/api/canvas/generated-image/${encodeURIComponent(filename)}` };
    }));
    return NextResponse.json({ cached: cached.length, images: cached });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const message = /Vips|corrupt|premature end|invalid|unsupported image/i.test(detail)
      ? "12AI 返回的图片文件尚未完整生成，请稍后重新运行。"
      : detail || "图片保存失败。";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
