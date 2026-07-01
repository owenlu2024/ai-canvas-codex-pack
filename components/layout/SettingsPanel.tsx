"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save, Settings, TestTube2, X } from "lucide-react";
import { clientAiSettingsStorageKey as storageKey, legacyClientAiSettingsStorageKey as legacyStorageKey, normalizeClientStoredSettings } from "@/lib/clientAiSettings";
import { useCanvasStore } from "@/store/canvasStore";

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

interface ModelResponse {
  imageModels: string[];
  source?: string;
  textModels: string[];
  error?: string;
}

interface StoredApiSettings {
  version: 1;
  settings: ApiSettings;
  agnesSettings: ApiSettings;
  imageModels: string[];
  textModels: string[];
  savedAt: string;
}

const emptySettings: ApiSettings = {
  apiKey: "",
  baseUrl: "https://cdn.12ai.org"
};

const defaultAgnesSettings: ApiSettings = {
  apiKey: "",
  baseUrl: "https://apihub.agnes-ai.com"
};

function readStoredSettings(): StoredApiSettings | null {
  const saved = window.localStorage.getItem(storageKey);
  if (saved) {
    return normalizeClientStoredSettings(JSON.parse(saved) as Partial<StoredApiSettings>) as StoredApiSettings;
  }

  const legacySaved = window.localStorage.getItem(legacyStorageKey);
  if (!legacySaved) return null;
  const legacySettings = JSON.parse(legacySaved) as Partial<ApiSettings>;
  return {
    agnesSettings: defaultAgnesSettings,
    imageModels: [],
    savedAt: new Date().toISOString(),
    settings: { ...emptySettings, ...legacySettings },
    textModels: [],
    version: 1
  };
}

function formatSavedAt(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="grid gap-1.5 text-xs font-bold text-primary">
      {label}
      {children}
    </label>
  );
}

function inputClassName() {
  return "h-9 rounded-[10px] border border-line bg-[#FBFCFE] px-3 text-sm font-semibold text-primary outline-none transition focus:border-selected";
}

export function SettingsPanel() {
  const open = useCanvasStore((state) => state.settingsPanelOpen);
  const setOpen = useCanvasStore((state) => state.setSettingsPanelOpen);
  const [settings, setSettings] = useState<ApiSettings>(emptySettings);
  const [agnesSettings, setAgnesSettings] = useState<ApiSettings>(defaultAgnesSettings);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [textModels, setTextModels] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");
  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelDragRef = useRef<{ left: number; top: number; x: number; y: number } | null>(null);

  const clampPanelPosition = useCallback((position: { x: number; y: number }) => {
    const rect = panelRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 380;
    const height = rect?.height ?? 360;
    return {
      x: Math.min(Math.max(88, position.x), Math.max(88, window.innerWidth - width - 16)),
      y: Math.min(Math.max(84, position.y), Math.max(84, window.innerHeight - height - 16))
    };
  }, []);

  useEffect(() => {
    if (!open || hydrated) return;
    let active = true;
    const hydrateSettings = async () => {
      try {
        const saved = readStoredSettings();
        if (saved) {
          if (!active) return;
          setSettings({ ...emptySettings, ...saved.settings });
          setAgnesSettings({ ...defaultAgnesSettings, ...(saved.agnesSettings ?? {}) });
          setImageModels(saved.imageModels ?? []);
          setTextModels(saved.textModels ?? []);
          setSavedAt(saved.savedAt);
          setHydrated(true);
          return;
        }
      } catch {
        window.localStorage.removeItem(storageKey);
        window.localStorage.removeItem(legacyStorageKey);
      }

      try {
        const response = await fetch("/api/ai/settings", { cache: "no-store" });
        if (response.ok) {
          const saved = (await response.json()) as StoredApiSettings;
          if (!active) return;
          setSettings({ ...emptySettings, ...saved.settings });
          setAgnesSettings({ ...defaultAgnesSettings, ...(saved.agnesSettings ?? {}) });
          setImageModels(saved.imageModels ?? []);
          setTextModels(saved.textModels ?? []);
          setSavedAt(saved.savedAt);
          setHydrated(true);
          return;
        }
      } catch {
        // Server settings are optional for the hosted version.
      }

      if (active) setHydrated(true);
    };

    void hydrateSettings();
    return () => {
      active = false;
    };
  }, [hydrated, open]);

  const persistSettings = useCallback(async (
    nextSettings = settings,
    nextImageModels = imageModels,
    nextTextModels = textModels,
    nextAgnesSettings = agnesSettings
  ) => {
    const nextSavedAt = new Date().toISOString();
    const storedSettings: StoredApiSettings = {
      agnesSettings: nextAgnesSettings,
      imageModels: nextImageModels,
      savedAt: nextSavedAt,
      settings: nextSettings,
      textModels: nextTextModels,
      version: 1
    };

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(storedSettings));
      window.localStorage.removeItem(legacyStorageKey);
    } catch {
      // localStorage can be unavailable in private or restricted browser contexts.
    }

    setSavedAt(nextSavedAt);
    setSaveError("");
  }, [agnesSettings, imageModels, settings, textModels]);

  useEffect(() => {
    if (!hydrated || !open) return undefined;
    const saveTimer = window.setTimeout(() => {
      void persistSettings();
    }, 350);
    return () => window.clearTimeout(saveTimer);
  }, [hydrated, open, persistSettings]);

  useEffect(() => {
    if (!panelDragging) return undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (!panelDragRef.current) return;
      setPanelPosition(clampPanelPosition({
        x: panelDragRef.current.left + event.clientX - panelDragRef.current.x,
        y: panelDragRef.current.top + event.clientY - panelDragRef.current.y
      }));
    };
    const onPointerUp = () => {
      panelDragRef.current = null;
      setPanelDragging(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [clampPanelPosition, panelDragging]);

  const canLoadModels = useMemo(() => Boolean(settings.baseUrl.trim() && settings.apiKey.trim()), [settings.apiKey, settings.baseUrl]);
  const canLoadAgnesModels = useMemo(() => Boolean(agnesSettings.baseUrl.trim() && agnesSettings.apiKey.trim()), [agnesSettings.apiKey, agnesSettings.baseUrl]);

  const updateSettings = (patch: Partial<ApiSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const updateAgnesSettings = (patch: Partial<ApiSettings>) => {
    setAgnesSettings((current) => ({ ...current, ...patch }));
  };

  const loadModels = async () => {
    if (!canLoadModels) {
      setStatus("请先填写服务地址和 API Key。");
      return;
    }
    setLoading(true);
    setStatus("正在读取模型列表...");
    try {
      const response = await fetch("/api/ai/models", {
        body: JSON.stringify({ apiKey: settings.apiKey, baseUrl: settings.baseUrl }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const data = (await response.json()) as ModelResponse;
      if (!response.ok) throw new Error(data.error || "连接失败");

      setImageModels(data.imageModels);
      setTextModels(data.textModels);
      setStatus(`已读取并保存 ${data.imageModels.length + data.textModels.length} 个模型。`);
      void persistSettings(settings, data.imageModels, data.textModels, agnesSettings);
    } catch (error) {
      setImageModels([]);
      setTextModels([]);
      setStatus(error instanceof Error ? error.message : "连接失败，请检查配置。");
    } finally {
      setLoading(false);
    }
  };

  const loadAgnesModels = async () => {
    if (!canLoadAgnesModels) {
      setStatus("请先填写 002 AI 服务地址和 API Key。");
      return;
    }
    setLoading(true);
    setStatus("正在测试 002 AI 连接...");
    try {
      const response = await fetch("/api/ai/models", {
        body: JSON.stringify({ apiKey: agnesSettings.apiKey, baseUrl: agnesSettings.baseUrl, provider: "agnes" }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const data = (await response.json()) as ModelResponse;
      if (!response.ok) throw new Error(data.error || "连接失败");

      const nextImageModels = Array.from(new Set([...imageModels, ...data.imageModels])).sort();
      const nextTextModels = Array.from(new Set([...textModels, ...data.textModels])).sort();
      setImageModels(nextImageModels);
      setTextModels(nextTextModels);
      setStatus(`002 AI 连接成功，已加入 ${data.imageModels.length + data.textModels.length} 个模型。`);
      void persistSettings(settings, nextImageModels, nextTextModels, agnesSettings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "002 AI 连接失败，请检查配置。");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="设置"
      className="pointer-events-auto absolute z-50 flex min-w-[320px] max-w-[520px] flex-col rounded-[18px] border border-line bg-white/95 shadow-[0_20px_56px_rgba(15,23,42,0.14)] backdrop-blur"
      ref={panelRef}
      style={{
        left: panelPosition ? panelPosition.x : undefined,
        right: panelPosition ? undefined : 24,
        maxHeight: "calc(100vh - 120px)",
        top: panelPosition ? panelPosition.y : 96,
        width: "clamp(360px, 30vw, 520px)"
      }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-2.5 border-b border-line px-4 py-3 active:cursor-grabbing"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button, input")) return;
          const rect = panelRef.current?.getBoundingClientRect();
          if (!rect) return;
          event.preventDefault();
          event.stopPropagation();
          panelDragRef.current = { left: rect.left, top: rect.top, x: event.clientX, y: event.clientY };
          setPanelPosition({ x: rect.left, y: rect.top });
          setPanelDragging(true);
        }}
      >
        <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[#EEF1FF] text-selected">
          <Settings size={17} strokeWidth={1.95} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold leading-5 text-primary">设置</h2>
          <p className="truncate text-xs font-semibold text-secondary">配置保存在当前浏览器</p>
        </div>
        <button
          aria-label="关闭设置"
          className="grid h-8 w-8 place-items-center rounded-full text-primary transition hover:bg-[#F4F6FA] active:scale-95"
          onClick={() => setOpen(false)}
          title="关闭"
          type="button"
        >
          <X size={17} strokeWidth={2} />
        </button>
      </div>
      <div className="grid gap-3 overflow-y-auto px-4 py-4">
        <div className="rounded-[12px] border border-line bg-white p-3">
          <p className="mb-2 text-xs font-bold text-secondary">001 AI</p>
          <div className="grid gap-3">
            <Field label="001 AI 服务地址">
              <input
                className={inputClassName()}
                onChange={(event) => updateSettings({ baseUrl: event.currentTarget.value })}
                placeholder="输入服务地址"
                value={settings.baseUrl}
              />
            </Field>
            <Field label="001 AI Key">
              <input
                className={inputClassName()}
                onChange={(event) => updateSettings({ apiKey: event.currentTarget.value })}
                placeholder="输入 API Key"
                type="password"
                value={settings.apiKey}
              />
            </Field>
            <div className="flex items-center gap-2 pt-1">
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
                disabled={loading}
                onClick={loadModels}
                type="button"
              >
                <TestTube2 size={14} strokeWidth={1.9} />
                {loading ? "读取中" : "连接测试"}
              </button>
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB]"
                onClick={() => {
                  void persistSettings();
                  setStatus("已保存到当前浏览器。");
                }}
                type="button"
              >
                <Save size={14} strokeWidth={1.9} />
                保存
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-secondary">
                {saveError || status || (savedAt ? `上次保存 ${formatSavedAt(savedAt)}` : "")}
              </span>
            </div>
          </div>
        </div>
        <div className="rounded-[12px] border border-line bg-[#FFFCF1] p-3">
          <p className="mb-2 text-xs font-bold text-[#8A6A12]">002 AI</p>
          <div className="grid gap-3">
            <Field label="002 AI 服务地址">
              <input
                className={inputClassName()}
                onChange={(event) => updateAgnesSettings({ baseUrl: event.currentTarget.value })}
                placeholder="https://apihub.agnes-ai.com"
                value={agnesSettings.baseUrl}
              />
            </Field>
            <Field label="002 AI Key">
              <input
                className={inputClassName()}
                onChange={(event) => updateAgnesSettings({ apiKey: event.currentTarget.value })}
                placeholder="输入 002 AI Key"
                type="password"
                value={agnesSettings.apiKey}
              />
            </Field>
            <div className="flex items-center gap-2 pt-1">
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
                disabled={loading}
                onClick={loadAgnesModels}
                type="button"
              >
                <TestTube2 size={14} strokeWidth={1.9} />
                {loading ? "测试中" : "连接测试"}
              </button>
              <button
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB]"
                onClick={() => {
                  void persistSettings();
                  setStatus("已保存到当前浏览器。");
                }}
                type="button"
              >
                <Save size={14} strokeWidth={1.9} />
                保存
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-secondary">
                {saveError || status || (savedAt ? `上次保存 ${formatSavedAt(savedAt)}` : "")}
              </span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-[12px] border border-line bg-[#FBFCFE] p-2.5">
          <div>
            <p className="text-[11px] font-bold text-secondary">图像模型</p>
            <p className="mt-1 text-lg font-bold text-primary">{imageModels.length}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-secondary">文本模型</p>
            <p className="mt-1 text-lg font-bold text-primary">{textModels.length}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
