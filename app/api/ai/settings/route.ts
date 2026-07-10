import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { readEnvApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataDir, getCanvasDataPath } from "@/lib/serverPaths";
import { parseHttpUrl } from "@/lib/urlSafety";
import { isVideoModel } from "@/lib/modelClassification";

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  id?: string;
}

interface StoredApiSettings {
  version: 1;
  settings: ApiSettings;
  agnesSettings: ApiSettings;
  apiConfigs: ApiSettings[];
  imageModels: string[];
  textModels: string[];
  videoModels: string[];
  savedAt: string;
}

const settingsDir = getCanvasDataDir();
const settingsPath = getCanvasDataPath("api-settings.local.json");

const emptySettings: ApiSettings = {
  apiKey: "",
  id: "001",
  baseUrl: ""
};

const defaultAgnesSettings: ApiSettings = {
  apiKey: "",
  id: "002",
  baseUrl: "https://apihub.agnes-ai.com"
};

function formatApiConfigId(index: number) {
  return String(index + 1).padStart(3, "0");
}

function normalizeApiConfig(config: Partial<ApiSettings> | undefined, index: number): ApiSettings {
  const fallback = index === 0 ? emptySettings : index === 1 ? defaultAgnesSettings : { apiKey: "", baseUrl: "" };
  return {
    ...fallback,
    ...(config ?? {}),
    id: typeof config?.id === "string" && /^\d{3}$/.test(config.id) ? config.id : formatApiConfigId(index)
  };
}

function normalizeApiConfigs(value: Partial<StoredApiSettings>) {
  if (Array.isArray(value.apiConfigs) && value.apiConfigs.length) {
    return value.apiConfigs.map((config, index) => normalizeApiConfig(config, index));
  }
  return [normalizeApiConfig(value.settings, 0)];
}

function uniqueStrings(values: unknown[] | undefined) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : []).filter((model): model is string => typeof model === "string" && Boolean(model.trim()))
  )).sort();
}

function normalizeStoredSettings(value: Partial<StoredApiSettings>): StoredApiSettings {
  const apiConfigs = normalizeApiConfigs(value);
  const storedTextModels = uniqueStrings(value.textModels);
  return {
    version: 1,
    settings: apiConfigs[0] ?? emptySettings,
    agnesSettings: apiConfigs[1] ?? defaultAgnesSettings,
    apiConfigs,
    imageModels: uniqueStrings(value.imageModels),
    textModels: storedTextModels.filter((model) => !isVideoModel(model)),
    videoModels: uniqueStrings([...(value.videoModels ?? []), ...storedTextModels.filter(isVideoModel)]),
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

function validateApiConfig(config: ApiSettings, label: string) {
  if (!config.baseUrl.trim()) return null;
  try {
    parseHttpUrl(config.baseUrl);
    return null;
  } catch {
    return `${label} 服务地址必须是有效的 http/https 地址，且不能包含用户名或密码。`;
  }
}

export async function GET() {
  try {
    const saved = await fs.readFile(settingsPath, "utf8");
    return NextResponse.json(normalizeStoredSettings(JSON.parse(saved) as Partial<StoredApiSettings>));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const envSettings = readEnvApiSettings({ normalizeBaseUrl: (value) => value.trim() });
      const envAgnesSettings = readEnvApiSettings({
        isAgnesModel: () => true,
        normalizeBaseUrl: (value) => value.trim()
      });
      if (envSettings.apiKey || envSettings.baseUrl || envAgnesSettings.apiKey || envAgnesSettings.baseUrl) {
        return NextResponse.json(normalizeStoredSettings({
          agnesSettings: { apiKey: "", baseUrl: envAgnesSettings.baseUrl },
          settings: { apiKey: "", baseUrl: envSettings.baseUrl }
        }));
      }
      return NextResponse.json({ error: "还没有保存设置。" }, { status: 404 });
    }
    return NextResponse.json({ error: "无法读取本机设置。" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<StoredApiSettings>;
    const storedSettings = normalizeStoredSettings({
      ...body,
      savedAt: new Date().toISOString()
    });
    for (const config of storedSettings.apiConfigs) {
      const error = validateApiConfig(config, `${config.id ?? "AI"} AI`);
      if (error) return NextResponse.json({ error }, { status: 400 });
    }

    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(storedSettings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(settingsPath, 0o600).catch(() => undefined);

    return NextResponse.json(storedSettings);
  } catch {
    return NextResponse.json({ error: "无法保存本机设置。" }, { status: 500 });
  }
}
