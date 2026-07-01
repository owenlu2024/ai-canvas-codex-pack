import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getCanvasDataDir, getCanvasDataPath } from "@/lib/serverPaths";
import { parseHttpUrl } from "@/lib/urlSafety";

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

interface StoredApiSettings {
  version: 1;
  settings: ApiSettings;
  agnesSettings: ApiSettings;
  imageModels: string[];
  textModels: string[];
  savedAt: string;
}

const settingsDir = getCanvasDataDir();
const settingsPath = getCanvasDataPath("api-settings.local.json");

const emptySettings: ApiSettings = {
  apiKey: "",
  baseUrl: ""
};

const defaultAgnesSettings: ApiSettings = {
  apiKey: "",
  baseUrl: "https://apihub.agnes-ai.com"
};

const requiredImageModels = ["gpt-image-2", "gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "agnes-image-2.1-flash"];
const requiredTextModels = ["gemini-2.5-flash", "gemini-3.1-flash-lite-preview", "agnes-2.0-flash"];

function uniqueStrings(values: unknown[] | undefined, required: string[] = []) {
  return Array.from(new Set([
    ...((Array.isArray(values) ? values : []).filter((model): model is string => typeof model === "string" && Boolean(model.trim()))),
    ...required
  ])).sort();
}

function normalizeStoredSettings(value: Partial<StoredApiSettings>): StoredApiSettings {
  return {
    version: 1,
    settings: { ...emptySettings, ...(value.settings ?? {}) },
    agnesSettings: { ...defaultAgnesSettings, ...(value.agnesSettings ?? {}) },
    imageModels: uniqueStrings(value.imageModels, requiredImageModels),
    textModels: uniqueStrings(value.textModels, requiredTextModels),
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString()
  };
}

export async function GET() {
  try {
    const saved = await fs.readFile(settingsPath, "utf8");
    return NextResponse.json(normalizeStoredSettings(JSON.parse(saved) as Partial<StoredApiSettings>));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
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
    if (storedSettings.settings.baseUrl.trim()) {
      try {
        parseHttpUrl(storedSettings.settings.baseUrl);
      } catch {
        return NextResponse.json({ error: "AI 服务地址必须是有效的 http/https 地址，且不能包含用户名或密码。" }, { status: 400 });
      }
    }
    if (storedSettings.agnesSettings.baseUrl.trim()) {
      try {
        parseHttpUrl(storedSettings.agnesSettings.baseUrl);
      } catch {
        return NextResponse.json({ error: "Agnes 服务地址必须是有效的 http/https 地址，且不能包含用户名或密码。" }, { status: 400 });
      }
    }

    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(storedSettings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(settingsPath, 0o600).catch(() => undefined);

    return NextResponse.json(storedSettings);
  } catch {
    return NextResponse.json({ error: "无法保存本机设置。" }, { status: 500 });
  }
}
