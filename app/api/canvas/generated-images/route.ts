import { promises as fs } from "fs";
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCanvasDataDir, getCanvasDataPath } from "@/lib/serverPaths";

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

const outputDir = getCanvasDataDir();
const outputPath = getCanvasDataPath("generated-images.local.json");
const deletedOutputPath = getCanvasDataPath("generated-images-deleted.local.json");

function getImageKey(imageUrl: string) {
  return createHash("sha256").update(imageUrl).digest("hex");
}

function normalizeFile(value: Partial<GeneratedImagesFile>): GeneratedImagesFile {
  return {
    format: "ai-canvas-generated-images",
    version: 1,
    images: Array.isArray(value.images)
      ? value.images.filter((image): image is GeneratedImageBackup => typeof image.id === "string" && typeof image.imageUrl === "string")
      : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

function normalizeDeletedFile(value: Partial<DeletedGeneratedImagesFile>): DeletedGeneratedImagesFile {
  return {
    format: "ai-canvas-deleted-generated-images",
    version: 1,
    imageKeys: Array.isArray(value.imageKeys) ? value.imageKeys.filter((key): key is string => typeof key === "string") : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

async function readFile() {
  try {
    return normalizeFile(JSON.parse(await fs.readFile(outputPath, "utf8")) as Partial<GeneratedImagesFile>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return normalizeFile({ images: [] });
    }
    throw error;
  }
}

async function readDeletedFile() {
  try {
    return normalizeDeletedFile(JSON.parse(await fs.readFile(deletedOutputPath, "utf8")) as Partial<DeletedGeneratedImagesFile>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return normalizeDeletedFile({ imageKeys: [] });
    }
    throw error;
  }
}

async function writeFile(file: GeneratedImagesFile) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify({ ...file, savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function writeDeletedFile(file: DeletedGeneratedImagesFile) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(deletedOutputPath, `${JSON.stringify({ ...file, savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export async function GET() {
  try {
    return NextResponse.json(await readFile());
  } catch {
    return NextResponse.json({ error: "无法读取 AI 返图备份。" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { images?: Partial<GeneratedImageBackup>[] };
    const current = await readFile();
    const deleted = await readDeletedFile();
    const existingUrls = new Set(current.images.map((image) => image.imageUrl));
    const deletedKeys = new Set(deleted.imageKeys);
    const incoming = (body.images ?? [])
      .filter((image): image is Partial<GeneratedImageBackup> & { imageUrl: string } => typeof image.imageUrl === "string" && Boolean(image.imageUrl))
      .filter((image) => !existingUrls.has(image.imageUrl))
      .filter((image) => !deletedKeys.has(getImageKey(image.imageUrl)))
      .map((image) => ({
        createdAt: typeof image.createdAt === "string" ? image.createdAt : new Date().toISOString(),
        id: typeof image.id === "string" ? image.id : `generated-backup-${Date.now()}-${Math.round(Math.random() * 1000)}`,
        imageUrl: image.imageUrl,
        modelId: typeof image.modelId === "string" ? image.modelId : undefined,
        prompt: typeof image.prompt === "string" ? image.prompt : undefined,
        sourceNodeId: typeof image.sourceNodeId === "string" ? image.sourceNodeId : undefined
      }));
    const next = normalizeFile({ images: [...current.images, ...incoming] });
    await writeFile(next);
    return NextResponse.json(next);
  } catch {
    return NextResponse.json({ error: "无法保存 AI 返图备份。" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { ids?: string[] };
    const ids = new Set((body.ids ?? []).filter((id): id is string => typeof id === "string"));
    const current = await readFile();
    const deleted = await readDeletedFile();
    const removedImages = ids.size ? current.images.filter((image) => ids.has(image.id)) : current.images;
    const deletedKeys = new Set(deleted.imageKeys);
    removedImages.forEach((image) => deletedKeys.add(getImageKey(image.imageUrl)));
    const next = normalizeFile({ images: ids.size ? current.images.filter((image) => !ids.has(image.id)) : [] });
    await writeFile(next);
    await writeDeletedFile(normalizeDeletedFile({ imageKeys: Array.from(deletedKeys) }));
    return NextResponse.json(next);
  } catch {
    return NextResponse.json({ error: "无法清理 AI 返图备份。" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { images?: Partial<GeneratedImageBackup>[] };
    const images = (body.images ?? [])
      .filter((image): image is Partial<GeneratedImageBackup> & { imageUrl: string } => typeof image.imageUrl === "string" && Boolean(image.imageUrl))
      .map((image, index) => ({
        createdAt: typeof image.createdAt === "string" ? image.createdAt : new Date().toISOString(),
        id: typeof image.id === "string" ? image.id : `generated-backup-${Date.now()}-${index}`,
        imageUrl: image.imageUrl,
        modelId: typeof image.modelId === "string" ? image.modelId : undefined,
        prompt: typeof image.prompt === "string" ? image.prompt : undefined,
        sourceNodeId: typeof image.sourceNodeId === "string" ? image.sourceNodeId : undefined
      }));
    const next = normalizeFile({ images });
    await writeFile(next);
    await writeDeletedFile(normalizeDeletedFile({ imageKeys: [] }));
    return NextResponse.json(next);
  } catch {
    return NextResponse.json({ error: "无法替换 AI 返图备份。" }, { status: 500 });
  }
}
