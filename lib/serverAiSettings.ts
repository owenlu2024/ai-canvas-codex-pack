import { promises as fs } from "fs";

export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

export interface StoredApiSettings {
  settings?: Partial<ApiSettings>;
  agnesSettings?: Partial<ApiSettings>;
}

interface ReadSettingsOptions {
  defaultAgnesBaseUrl?: string;
  isAgnesModel?: (model?: string) => boolean;
  model?: string;
  normalizeBaseUrl: (value: string) => string;
}

function firstEnvValue(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function readEnvApiSettings(options: ReadSettingsOptions): ApiSettings {
  const isAgnes = Boolean(options.isAgnesModel?.(options.model));
  const rawBaseUrl = isAgnes
    ? firstEnvValue(["AI_AGNES_API_BASE_URL", "AGNES_API_BASE_URL"]) || options.defaultAgnesBaseUrl || "https://apihub.agnes-ai.com"
    : firstEnvValue(["AI_API_BASE_URL", "AI_API_DIRECT_URL"]);
  const apiKey = isAgnes
    ? firstEnvValue(["AI_AGNES_API_KEY", "AGNES_API_KEY"])
    : firstEnvValue(["AI_API_KEY"]);

  return {
    apiKey,
    baseUrl: options.normalizeBaseUrl(rawBaseUrl)
  };
}

export async function readApiSettings(settingsPath: string, options: ReadSettingsOptions): Promise<ApiSettings> {
  let saved: StoredApiSettings = {};
  try {
    saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as StoredApiSettings;
  } catch {
    saved = {};
  }

  const isAgnes = Boolean(options.isAgnesModel?.(options.model));
  const source = isAgnes ? saved.agnesSettings : saved.settings;
  const envSettings = readEnvApiSettings(options);
  const fallbackBaseUrl = isAgnes ? options.defaultAgnesBaseUrl || "https://apihub.agnes-ai.com" : "";

  return {
    apiKey: source?.apiKey?.trim() || envSettings.apiKey,
    baseUrl: options.normalizeBaseUrl(source?.baseUrl ?? (envSettings.baseUrl || fallbackBaseUrl))
  };
}
