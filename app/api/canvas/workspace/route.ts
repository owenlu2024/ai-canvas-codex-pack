import { promises as fs } from "fs";
import path from "path";
import { getCanvasDataDir, getCanvasDataPath } from "@/lib/serverPaths";
import { NextRequest, NextResponse } from "next/server";
import type { Edge, Node, Viewport } from "@xyflow/react";
import type { CanvasNodeData } from "@/lib/nodeTypes";

interface CanvasWorkspaceSnapshot {
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

const workspaceDir = getCanvasDataDir();
const workspacePath = getCanvasDataPath("workspace.local.aicanvas");

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getWorkspaceSavedTime(workspace?: CanvasWorkspaceSnapshot | null) {
  if (!workspace || typeof workspace.savedAt !== "string") return 0;
  const time = Date.parse(workspace.savedAt);
  if (!Number.isFinite(time)) return 0;
  return time > Date.now() + 5 * 60 * 1000 ? 0 : time;
}

function normalizeSavedAt(value: unknown) {
  if (typeof value !== "string") return new Date().toISOString();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > Date.now() + 5 * 60 * 1000) return new Date().toISOString();
  return value;
}

function normalizeWorkspace(value: Partial<CanvasWorkspaceSnapshot>): CanvasWorkspaceSnapshot {
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const edges = Array.isArray(value.edges) ? value.edges : [];
  const viewport = value.viewport ?? { x: 0, y: 0, zoom: 1 };
  const fallbackZIndex = Math.max(5, ...nodes.map((node) => finiteNumber(node.zIndex, finiteNumber(node.data?.zIndex, 0))));

  return {
    format: "ai-canvas-workspace",
    version: 1,
    projectTitle: typeof value.projectTitle === "string" && value.projectTitle.trim() ? value.projectTitle : "未命名项目",
    nodes,
    edges,
    viewport: {
      x: finiteNumber(viewport.x, 0),
      y: finiteNumber(viewport.y, 0),
      zoom: finiteNumber(viewport.zoom, 1)
    },
    gridEnabled: typeof value.gridEnabled === "boolean" ? value.gridEnabled : true,
    showAutoImageLinks: typeof value.showAutoImageLinks === "boolean" ? value.showAutoImageLinks : true,
    globalZIndex: finiteNumber(value.globalZIndex, fallbackZIndex),
    activeEdgeId: typeof value.activeEdgeId === "string" ? value.activeEdgeId : null,
    savedAt: normalizeSavedAt(value.savedAt)
  };
}

function isInitialExampleWorkspace(workspace: CanvasWorkspaceSnapshot) {
  const nodeIds = workspace.nodes.map((node) => node.id);
  const expectedIds = ["image-1", "prompt-1", "image-2", "prompt-2", "image-3"];
  return (
    workspace.nodes.length === 5 &&
    workspace.edges.length === 1 &&
    expectedIds.every((id, index) => nodeIds[index] === id) &&
    workspace.nodes.every((node) => !node.data.prompt) &&
    workspace.nodes.filter((node) => node.data.kind === "image").every((node) => typeof node.data.imageUrl === "string" && node.data.imageUrl.startsWith("/reference-assets/chair-"))
  );
}

async function readExistingWorkspace() {
  try {
    const saved = await fs.readFile(workspacePath, "utf8");
    return normalizeWorkspace(JSON.parse(saved) as Partial<CanvasWorkspaceSnapshot>);
  } catch {
    return null;
  }
}

async function backupWorkspaceBeforeShrink(existingWorkspace: CanvasWorkspaceSnapshot, nextWorkspace: CanvasWorkspaceSnapshot) {
  if (nextWorkspace.nodes.length >= existingWorkspace.nodes.length) return;
  const backupPath = path.join(workspaceDir, `workspace.recovery.${Date.now()}.aicanvas`);
  await fs.writeFile(backupPath, `${JSON.stringify(existingWorkspace, null, 2)}\n`, "utf8");

  const recoveryFiles = (await fs.readdir(workspaceDir))
    .filter((name) => /^workspace\.recovery\.\d+\.aicanvas$/.test(name))
    .sort()
    .reverse();
  await Promise.all(recoveryFiles.slice(10).map((name) => fs.unlink(path.join(workspaceDir, name)).catch(() => undefined)));
}

export async function GET() {
  try {
    const saved = await fs.readFile(workspacePath, "utf8");
    return NextResponse.json(normalizeWorkspace(JSON.parse(saved) as Partial<CanvasWorkspaceSnapshot>));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "还没有保存工作区。" }, { status: 404 });
    }
    return NextResponse.json({ error: "无法读取本机工作区。" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<CanvasWorkspaceSnapshot>;
    const workspace = normalizeWorkspace(body);
    const existingWorkspace = await readExistingWorkspace();
    if (existingWorkspace && getWorkspaceSavedTime(workspace) < getWorkspaceSavedTime(existingWorkspace)) {
      return NextResponse.json(existingWorkspace);
    }
    if (
      existingWorkspace &&
      !isInitialExampleWorkspace(existingWorkspace) &&
      existingWorkspace.nodes.length > workspace.nodes.length &&
      isInitialExampleWorkspace(workspace)
    ) {
      return NextResponse.json(existingWorkspace);
    }

    await fs.mkdir(workspaceDir, { recursive: true });
    if (existingWorkspace) await backupWorkspaceBeforeShrink(existingWorkspace, workspace);
    const tempPath = path.join(workspaceDir, `workspace.local.${Date.now()}.${Math.round(Math.random() * 1000)}.tmp`);
    await fs.writeFile(tempPath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, workspacePath);

    return NextResponse.json(workspace);
  } catch {
    return NextResponse.json({ error: "无法保存本机工作区。" }, { status: 500 });
  }
}
