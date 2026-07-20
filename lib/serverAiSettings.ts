import { promises as fs } from "fs";

export interface ApiSettings {
  baseUrl: string;
  apiKey: string;
  id?: string;
}

export interface StoredApiSettings {
  settings?: Partial<ApiSettings>;
  agnesSettings?: Partial<ApiSettings>;
  apiConfigs?: Partial<ApiSettings>[];
}

interface ReadSettingsOptions {
  clientSettings?: StoredApiSettings;
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

function parseConfiguredModelId(model?: string) {
  const match = typeof model === "string" ? model.match(/^(\d{3})-(.+)$/) : null;
  return {
    apiId: match?.[1],
    modelId: match?.[2] ?? model
  };
}

export function readEnvApiSettings(options: ReadSettingsOptions): ApiSettings {
  const parsed = parseConfiguredModelId(options.model);
  const isAgnes = Boolean(options.isAgnesModel?.(parsed.modelId));
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

  const parsed = parseConfiguredModelId(options.model);
  const isAgnes = Boolean(options.isAgnesModel?.(parsed.modelId));
  const selectedClientSource = parsed.apiId
    ? options.clientSettings?.apiConfigs?.find((config) => config.id === parsed.apiId)
      ?? (parsed.apiId === "001" ? options.clientSettings?.settings : parsed.apiId === "002" ? options.clientSettings?.agnesSettings : undefined)
    : undefined;
  const selectedSource = parsed.apiId
    ? saved.apiConfigs?.find((config) => config.id === parsed.apiId)
      ?? (parsed.apiId === "001" ? saved.settings : parsed.apiId === "002" ? saved.agnesSettings : undefined)
    : undefined;
  const clientSource = selectedClientSource ?? (isAgnes ? options.clientSettings?.agnesSettings : options.clientSettings?.settings);
  const source = selectedSource ?? (isAgnes ? saved.agnesSettings : saved.settings);
  const envSettings = readEnvApiSettings(options);
  const fallbackBaseUrl = isAgnes ? options.defaultAgnesBaseUrl || "https://apihub.agnes-ai.com" : "";

  return {
    apiKey: clientSource?.apiKey?.trim() || source?.apiKey?.trim() || envSettings.apiKey,
    baseUrl: options.normalizeBaseUrl(clientSource?.baseUrl ?? source?.baseUrl ?? (envSettings.baseUrl || fallbackBaseUrl))
  };
}
