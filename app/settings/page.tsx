"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Save } from "lucide-react";
import Link from "next/link";

const storageKey = "ai-canvas-api-settings-v1";
const legacyStorageKey = "ai-canvas-api-settings";

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

interface ModelResponse {
  imageModels: string[];
  textModels: string[];
  error?: string;
}

interface StoredApiSettings {
  version: 1;
  settings: ApiSettings;
  imageModels: string[];
  textModels: string[];
  savedAt: string;
}

const emptySettings: ApiSettings = {
  baseUrl: "https://cdn.12ai.org",
  apiKey: ""
};

function readStoredSettings(): StoredApiSettings | null {
  const saved = window.localStorage.getItem(storageKey);
  if (saved) {
    return JSON.parse(saved) as StoredApiSettings;
  }

  const legacySaved = window.localStorage.getItem(legacyStorageKey);
  if (!legacySaved) return null;

  const legacySettings = JSON.parse(legacySaved) as Partial<ApiSettings>;
  return {
    version: 1,
    settings: { ...emptySettings, ...legacySettings },
    imageModels: [],
    textModels: [],
    savedAt: new Date().toISOString()
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
    <label className="grid gap-2 text-sm font-semibold text-primary">
      {label}
      {children}
    </label>
  );
}

function inputStyle() {
  return {
    height: 44,
    borderRadius: 12,
    border: "1px solid var(--node-border)",
    background: "#FBFCFE",
    padding: "0 16px",
    color: "var(--primary-text)",
    fontSize: 14,
    outline: "none",
    transition: "border-color 140ms ease, box-shadow 140ms ease"
  };
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<ApiSettings>(emptySettings);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [textModels, setTextModels] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let active = true;
    const hydrateSettings = async () => {
      try {
        const response = await fetch("/api/ai/settings", { cache: "no-store" });
        if (response.ok) {
          const saved = (await response.json()) as StoredApiSettings;
          if (!active) return;
          setSettings({ ...emptySettings, ...saved.settings });
          setImageModels(saved.imageModels ?? []);
          setTextModels(saved.textModels ?? []);
          setSavedAt(saved.savedAt);
          setHydrated(true);
          return;
        }
      } catch {
        // Browser storage below is the fallback when the local settings file is unavailable.
      }

      if (!active) return;
      try {
        const saved = readStoredSettings();
        if (saved) {
          setSettings({ ...emptySettings, ...saved.settings });
          setImageModels(saved.imageModels ?? []);
          setTextModels(saved.textModels ?? []);
          setSavedAt(saved.savedAt);
        }
      } catch {
        window.localStorage.removeItem(storageKey);
        window.localStorage.removeItem(legacyStorageKey);
      } finally {
        if (active) setHydrated(true);
      }
    };

    hydrateSettings();
    return () => {
      active = false;
    };
  }, []);

  const persistSettings = useCallback(async (nextSettings = settings, nextImageModels = imageModels, nextTextModels = textModels) => {
    const nextSavedAt = new Date().toISOString();
    const storedSettings: StoredApiSettings = {
      version: 1,
      settings: nextSettings,
      imageModels: nextImageModels,
      textModels: nextTextModels,
      savedAt: nextSavedAt
    };

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(storedSettings));
      window.localStorage.removeItem(legacyStorageKey);
    } catch {
      // localStorage can be unavailable in private or restricted browser contexts.
    }

    setSavedAt(nextSavedAt);
    setSaveError("");
  }, [imageModels, settings, textModels]);

  const saveSettings = () => {
    void persistSettings();
    setStatus("已保存到当前浏览器。");
  };

  useEffect(() => {
    if (!hydrated) return;
    const saveTimer = window.setTimeout(() => {
      void persistSettings();
    }, 350);
    return () => window.clearTimeout(saveTimer);
  }, [hydrated, persistSettings]);

  const canLoadModels = useMemo(() => Boolean(settings.baseUrl.trim() && settings.apiKey.trim()), [settings.apiKey, settings.baseUrl]);

  const updateSettings = (patch: Partial<ApiSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const loadModels = async () => {
    if (!canLoadModels) {
      setStatus("请先填写 AI 服务地址和 API Key。");
      return;
    }
    setLoading(true);
    setStatus("正在读取模型列表...");
    try {
      const response = await fetch("/api/ai/models", {
        body: JSON.stringify({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const data = (await response.json()) as ModelResponse;
      if (!response.ok) throw new Error(data.error || "连接失败");

      setImageModels(data.imageModels);
      setTextModels(data.textModels);
      setStatus(`已读取并保存 ${data.imageModels.length + data.textModels.length} 个模型。`);
    } catch (error) {
      setImageModels([]);
      setTextModels([]);
      setStatus(error instanceof Error ? error.message : "连接失败，请检查配置。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#F7F8FB] px-8 py-7 text-primary">
      <div className="mx-auto max-w-3xl">
        <Link className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-secondary" href="/">
          <ChevronLeft size={18} strokeWidth={1.8} />
          返回画布
        </Link>
        <section className="rounded-[18px] border border-line bg-white p-7 shadow-soft">
          <h1 className="text-2xl font-bold">设置</h1>
          <p className="mt-2 text-sm text-secondary">配置会保存在当前浏览器，重新打开后自动恢复。</p>
          <div className="mt-8 grid gap-5">
            <Field label="AI 服务地址">
              <input
                className="focus:border-selected"
                onChange={(event) => updateSettings({ baseUrl: event.currentTarget.value })}
                placeholder="输入服务地址"
                style={inputStyle()}
                value={settings.baseUrl}
              />
            </Field>
            <Field label="API Key">
              <input
                className="focus:border-selected"
                onChange={(event) => updateSettings({ apiKey: event.currentTarget.value })}
                placeholder="输入 API Key"
                style={inputStyle()}
                type="password"
                value={settings.apiKey}
              />
            </Field>
            <div className="mt-2 flex items-center gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <button
                  className="h-11 min-w-28 rounded-xl border border-line bg-white px-5 text-sm font-semibold text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
                  disabled={loading}
                  onClick={loadModels}
                  type="button"
                >
                  {loading ? "读取中" : "连接测试"}
                </button>
                <span className="truncate text-sm font-medium text-secondary">
                  {saveError || status || (savedAt ? `上次保存 ${formatSavedAt(savedAt)}` : "")}
                </span>
              </div>
              <button
                className="inline-flex h-11 min-w-32 items-center justify-center gap-2 rounded-xl border border-line bg-white px-5 text-sm font-semibold text-primary shadow-sm transition hover:bg-[#F7F8FB]"
                onClick={saveSettings}
                type="button"
              >
                <Save size={17} strokeWidth={1.9} />
                保存设置
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
