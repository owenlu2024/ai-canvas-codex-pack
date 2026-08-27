import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCanvasDataPath } from "@/lib/serverPaths";

const contentTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function GET(_request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!/^[a-zA-Z0-9_-]+\.(?:avif|gif|jpe?g|png|webp)$/i.test(filename)) {
    return NextResponse.json({ error: "无效的图片文件名。" }, { status: 400 });
  }
  try {
    const filePath = path.join(getCanvasDataPath("generated-images"), filename);
    const body = await fs.readFile(filePath);
    return new NextResponse(body, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": contentTypes[path.extname(filename).toLowerCase()] ?? "application/octet-stream"
      }
    });
  } catch {
    return NextResponse.json({ error: "图片文件不存在。" }, { status: 404 });
  }
}
