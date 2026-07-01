"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, FilePlus2, FolderOpen, Redo2, RefreshCw, Save, Undo2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import {
  clearGeneratedImages,
  downloadProjectFile,
  ensureProjectHandlePermission,
  getProjectFilename,
  getProjectTitleFromFilename,
  makeProjectFile,
  persistWorkspace,
  pickProjectOpenFile,
  pickProjectSaveFile,
  readGeneratedImages,
  readProjectFile,
  readProjectHandle,
  readRecentProjects,
  replaceGeneratedImages,
  storeProjectHandle,
  supportsProjectFilePicker,
  type ProjectFileHandle,
  type RecentProject,
  writeProjectFile,
  writeRecentProject
} from "@/lib/projectFiles";

function IconButton({ children, disabled, label, onClick }: { children: React.ReactNode; disabled?: boolean; label?: string; onClick?: () => void }) {
  return (
    <button
      aria-label={label}
      className="grid h-[34px] w-[34px] place-items-center rounded-full border border-line bg-white text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
      disabled={disabled}
      style={{
        display: "grid",
        width: 34,
        height: 34,
        placeItems: "center",
        borderRadius: 999,
        border: "1px solid var(--node-border)",
        background: "#fff",
        color: disabled ? "#B8C0CC" : "var(--primary-text)",
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)"
      }}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function MenuButton({ children, icon, onClick }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-semibold text-primary transition hover:bg-[#F7F8FB]"
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        height: 36,
        alignItems: "center",
        gap: 10,
        border: 0,
        borderRadius: 8,
        background: "transparent",
        padding: "0 10px",
        color: "var(--primary-text)",
        fontSize: 14,
        fontWeight: 600,
        textAlign: "left"
      }}
      type="button"
    >
      <span className="grid h-5 w-5 place-items-center text-secondary">{icon}</span>
      {children}
    </button>
  );
}

function formatRecentTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  }).format(new Date(time));
}

function makeProjectId(handle: ProjectFileHandle) {
  return `${handle.name}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function getProjectErrorMessage(error: unknown, fallback: string) {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return "";
    if (error.name === "NotAllowedError") return "没有文件权限";
    if (error.name === "QuotaExceededError") return "文件写入失败";
    if (error.name === "DataCloneError") return "最近项目不可用";
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function TopBar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [currentHandle, setCurrentHandle] = useState<ProjectFileHandle | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const projectTitle = useCanvasStore((state) => state.projectTitle);
  const setProjectTitle = useCanvasStore((state) => state.setProjectTitle);
  const createWorkspaceSnapshot = useCanvasStore((state) => state.createWorkspaceSnapshot);
  const hydrateWorkspace = useCanvasStore((state) => state.hydrateWorkspace);
  const resetCanvas = useCanvasStore((state) => state.resetCanvas);
  const canUndo = useCanvasStore((state) => state.historyPast.length > 0);
  const canRedo = useCanvasStore((state) => state.historyFuture.length > 0);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);

  useEffect(() => {
    setRecentProjects(readRecentProjects());
  }, []);

  useEffect(() => {
    if (!editingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingTitle]);

  const updateRecent = async (handle: ProjectFileHandle, savedAt: string, existingId?: string | null) => {
    if (!supportsProjectFilePicker()) return;
    const id = existingId || makeProjectId(handle);
    setCurrentHandle(handle);
    setCurrentProjectId(id);
    try {
      await storeProjectHandle(id, handle);
      setRecentProjects(writeRecentProject({ id, name: handle.name, savedAt }));
    } catch {
      // Saving the project file is the important part; some browser shells cannot persist file handles.
    }
  };

  const buildProject = async () => makeProjectFile(createWorkspaceSnapshot(), await readGeneratedImages());

  const saveWorkspaceOnly = async () => {
    const workspace = createWorkspaceSnapshot();
    await persistWorkspace(workspace);
  };

  const saveAsProject = async () => {
    setMenuOpen(false);
    setSaveStatus("保存中...");
    try {
      const project = await buildProject();
      const filename = getProjectFilename(project.workspace.projectTitle);
      const handle = await pickProjectSaveFile(filename);
      if (handle) {
        const nextTitle = getProjectTitleFromFilename(handle.name);
        if (nextTitle !== project.workspace.projectTitle) {
          setProjectTitle(nextTitle);
          project.workspace.projectTitle = nextTitle;
        }
        await writeProjectFile(handle, project);
        await updateRecent(handle, project.savedAt);
      } else {
        await downloadProjectFile(filename, project);
      }
      await saveWorkspaceOnly();
      setSaveStatus("已保存");
      window.setTimeout(() => setSaveStatus(""), 1800);
    } catch (error) {
      setSaveStatus(getProjectErrorMessage(error, "保存失败"));
    }
  };

  const saveProject = async () => {
    setMenuOpen(false);
    if (!currentHandle) {
      await saveAsProject();
      return;
    }
    setSaveStatus("保存中...");
    try {
      if (!(await ensureProjectHandlePermission(currentHandle, "readwrite"))) {
        setSaveStatus("没有文件权限");
        return;
      }
      const project = await buildProject();
      const nextTitle = getProjectTitleFromFilename(currentHandle.name);
      if (nextTitle !== project.workspace.projectTitle) {
        setProjectTitle(nextTitle);
        project.workspace.projectTitle = nextTitle;
      }
      await writeProjectFile(currentHandle, project);
      await updateRecent(currentHandle, project.savedAt, currentProjectId);
      await saveWorkspaceOnly();
      setSaveStatus("已保存");
      window.setTimeout(() => setSaveStatus(""), 1800);
    } catch (error) {
      setSaveStatus(getProjectErrorMessage(error, "保存失败"));
    }
  };

  const openProject = async () => {
    setMenuOpen(false);
    setSaveStatus("打开中...");
    try {
      const handle = await pickProjectOpenFile();
      if (!handle) {
        setSaveStatus("当前浏览器不支持打开项目文件");
        return;
      }
      const file = await readProjectFile(handle);
      const workspace = { ...file.workspace, projectTitle: getProjectTitleFromFilename(handle.name), savedAt: new Date().toISOString() };
      hydrateWorkspace(workspace);
      await replaceGeneratedImages(file.generatedImages);
      await persistWorkspace(workspace);
      await updateRecent(handle, file.savedAt);
      setSaveStatus("已打开");
      window.setTimeout(() => setSaveStatus(""), 1800);
    } catch (error) {
      setSaveStatus(getProjectErrorMessage(error, "打开失败"));
    }
  };

  const openRecentProject = async (project: RecentProject) => {
    setMenuOpen(false);
    setSaveStatus("打开中...");
    try {
      const handle = await readProjectHandle(project.id);
      if (!handle) {
        setSaveStatus("项目位置不可用");
        return;
      }
      if (!(await ensureProjectHandlePermission(handle, "read"))) {
        setSaveStatus("没有文件权限");
        return;
      }
      const file = await readProjectFile(handle);
      const workspace = { ...file.workspace, projectTitle: getProjectTitleFromFilename(handle.name), savedAt: new Date().toISOString() };
      hydrateWorkspace(workspace);
      await replaceGeneratedImages(file.generatedImages);
      await persistWorkspace(workspace);
      await updateRecent(handle, file.savedAt, project.id);
      setSaveStatus("已打开");
      window.setTimeout(() => setSaveStatus(""), 1800);
    } catch (error) {
      setSaveStatus(getProjectErrorMessage(error, "打开失败"));
    }
  };

  const createBlankProject = async () => {
    setMenuOpen(false);
    resetCanvas({ blank: true, record: false, title: "未命名项目" });
    setCurrentHandle(null);
    setCurrentProjectId(null);
    try {
      await clearGeneratedImages();
      window.localStorage.removeItem("ai-canvas-workspace-v1");
      setSaveStatus("已新建空白画布");
    } catch {
      setSaveStatus("画布已清空，返图清理失败");
    }
    window.setTimeout(() => setSaveStatus(""), 1800);
  };

  const startTitleEdit = () => {
    setDraftTitle(projectTitle);
    setEditingTitle(true);
    setMenuOpen(false);
  };

  const commitTitleEdit = () => {
    setProjectTitle(draftTitle);
    setEditingTitle(false);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <header
      className="pointer-events-auto fixed left-0 right-0 top-0 z-[2147483001] flex h-[52px] items-center border-b border-line bg-white px-4"
      style={{
        position: "fixed",
        left: 0,
        right: "auto",
        top: 0,
        zIndex: 2147483001,
        display: "flex",
        width: "calc(100% / var(--ui-scale, 1))",
        height: 52,
        alignItems: "center",
        borderBottom: "1px solid var(--node-border)",
        background: "#fff",
        padding: "0 16px",
        transform: "scale(var(--ui-scale, 1))",
        transformOrigin: "top left"
      }}
    >
      <div
        className="grid h-9 w-9 place-items-center rounded-[9px] bg-selected text-white shadow-[0_6px_14px_rgba(108,99,255,0.24)]"
        style={{
          display: "grid",
          width: 36,
          height: 36,
          placeItems: "center",
          borderRadius: 9,
          background: "var(--selected)",
          color: "#fff",
          boxShadow: "0 6px 14px rgba(108, 99, 255, 0.24)"
        }}
      >
        <span
          aria-hidden="true"
          className="select-none text-[25px] font-black uppercase leading-none"
          style={{
            fontFamily: "Impact, Haettenschweiler, 'Arial Black', sans-serif",
            letterSpacing: 0,
            transform: "translateY(1px) skew(-3deg)",
            textShadow: [
              "1px 0 0 #2B247C",
              "-1px 0 0 #2B247C",
              "0 1px 0 #2B247C",
              "0 -1px 0 #2B247C",
              "1px 1px 0 #2B247C",
              "2px 2px 0 rgba(31, 27, 98, 0.55)",
              "0 3px 5px rgba(31, 27, 98, 0.28)"
            ].join(", ")
          }}
        >
          B
        </span>
      </div>
      <div className="relative ml-[18px] flex min-w-0 items-center gap-1.5" ref={menuRef} style={{ position: "relative", minWidth: 0, marginLeft: 18 }}>
        {editingTitle ? (
          <input
            className="h-8 max-w-[42vw] rounded-[8px] border border-line bg-[#FBFCFE] px-2 text-lg font-semibold text-primary outline-none focus:border-selected"
            onBlur={commitTitleEdit}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitTitleEdit();
              if (event.key === "Escape") setEditingTitle(false);
            }}
            ref={titleInputRef}
            style={{ width: "min(42vw, 320px)" }}
            value={draftTitle}
          />
        ) : (
          <button
            className="flex max-w-[42vw] items-center truncate text-lg font-semibold text-primary"
            onDoubleClick={startTitleEdit}
            style={{
              display: "flex",
              alignItems: "center",
              maxWidth: "42vw",
              border: 0,
              background: "transparent",
              color: "var(--primary-text)",
              fontSize: 18,
              fontWeight: 600
            }}
            title="双击修改项目名"
            type="button"
          >
            <span className="truncate">{projectTitle}</span>
          </button>
        )}
        <button
          aria-expanded={menuOpen}
          aria-label="项目菜单"
          className="grid h-8 w-8 place-items-center rounded-full text-primary transition hover:bg-[#F7F8FB]"
          onClick={() => {
            setEditingTitle(false);
            setMenuOpen((current) => !current);
          }}
          type="button"
        >
          <ChevronDown size={18} strokeWidth={1.8} />
        </button>
        {menuOpen ? (
          <div
            className="absolute left-0 top-9 w-[248px] rounded-xl border border-line bg-white p-2 shadow-soft"
            style={{
              position: "absolute",
              left: 0,
              top: 36,
              width: 248,
              borderRadius: 12,
              border: "1px solid var(--node-border)",
              background: "#fff",
              padding: 8,
              boxShadow: "0 12px 32px rgba(15, 23, 42, 0.12)"
            }}
          >
            <MenuButton icon={<FilePlus2 size={16} strokeWidth={1.9} />} onClick={() => void createBlankProject()}>
              新建项目
            </MenuButton>
            <MenuButton icon={<FolderOpen size={16} strokeWidth={1.9} />} onClick={() => void openProject()}>
              打开
            </MenuButton>
            <MenuButton icon={<Save size={16} strokeWidth={1.9} />} onClick={() => void saveProject()}>
              保存
            </MenuButton>
            <MenuButton icon={<Copy size={16} strokeWidth={1.9} />} onClick={() => void saveAsProject()}>
              另存为
            </MenuButton>
            <div className="my-2 h-px bg-line" />
            {recentProjects.length ? (
              <>
                <div className="px-2 pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-secondary">最近项目</div>
                {recentProjects.map((project) => (
                  <button
                    className="flex w-full min-w-0 flex-col rounded-lg px-2.5 py-2 text-left transition hover:bg-[#F7F8FB]"
                    key={project.id}
                    onClick={() => void openRecentProject(project)}
                    type="button"
                  >
                    <span className="w-full truncate text-sm font-semibold text-primary">{project.name}</span>
                    <span className="mt-0.5 text-[11px] font-semibold text-secondary">{formatRecentTime(project.savedAt)}</span>
                  </button>
                ))}
              </>
            ) : (
              <div className="px-2 pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-secondary">暂无最近项目</div>
            )}
          </div>
        ) : null}
      </div>
      {saveStatus ? (
        <span
          className="ml-4 inline-flex items-center gap-1.5 text-sm font-medium text-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 16, color: "var(--secondary-text)", fontSize: 14, fontWeight: 500 }}
        >
          {saveStatus === "已保存" || saveStatus === "已打开" ? <Check size={16} strokeWidth={2} /> : null}
          {saveStatus}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-3" style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
        <IconButton label="刷新页面" onClick={() => window.location.reload()}>
          <RefreshCw size={18} strokeWidth={1.85} />
        </IconButton>
        <IconButton disabled={!canUndo} onClick={undo}>
          <Undo2 size={18} strokeWidth={1.85} />
        </IconButton>
        <IconButton disabled={!canRedo} onClick={redo}>
          <Redo2 size={18} strokeWidth={1.85} />
        </IconButton>
      </div>
    </header>
  );
}
