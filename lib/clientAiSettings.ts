export interface ClientApiSettings {
  apiKey: string;
  baseUrl: string;
  id?: string;
}

export interface ClientStoredApiSettings {
  agnesSettings?: ClientApiSettings;
  apiConfigs?: ClientApiSettings[];
  imageModels?: string[];
  savedAt?: string;
  settings?: ClientApiSettings;
  textModels?: string[];
  version?: 1;
}

export const clientAiSettingsStorageKey = "ai-canvas-api-settings-v1";
export const legacyClientAiSettingsStorageKey = "ai-canvas-api-settings";

const emptySettings: ClientApiSettings = {
  apiKey: "",
  baseUrl: "https://cdn.12ai.org"
};

const defaultAgnesSettings: ClientApiSettings = {
  apiKey: "",
  baseUrl: "https://apihub.agnes-ai.com"
};

export function formatApiConfigId(index: number) {
  return String(index + 1).padStart(3, "0");
}

function normalizeApiConfig(config: Partial<ClientApiSettings> | undefined, index: number): ClientApiSettings {
  const fallback = index === 0 ? emptySettings : index === 1 ? defaultAgnesSettings : { apiKey: "", baseUrl: "" };
  return {
    ...fallback,
    ...(config ?? {}),
    id: typeof config?.id === "string" && /^\d{3}$/.test(config.id) ? config.id : formatApiConfigId(index)
  };
}

function buildApiConfigs(value: Partial<ClientStoredApiSettings>): ClientApiSettings[] {
  if (Array.isArray(value.apiConfigs) && value.apiConfigs.length) {
    return value.apiConfigs.map((config, index) => normalizeApiConfig(config, index));
  }
  return [normalizeApiConfig(value.settings, 0)];
}

export function parseConfiguredModelId(modelId?: string) {
  const match = typeof modelId === "string" ? modelId.match(/^(\d{3})-(.+)$/) : null;
  return {
    apiId: match?.[1],
    modelId: match?.[2] ?? modelId
  };
}

export function getBaseModelId(modelId?: string) {
  return parseConfiguredModelId(modelId).modelId;
}

export function getApiSettingsForModel(settings: ClientStoredApiSettings | undefined | null, modelId?: string) {
  const parsed = parseConfiguredModelId(modelId);
  const configs = settings?.apiConfigs ?? [];
  if (parsed.apiId) {
    return configs.find((config) => config.id === parsed.apiId) ?? settings?.settings;
  }
  return settings?.settings;
}

export function normalizeClientStoredSettings(value: Partial<ClientStoredApiSettings>): ClientStoredApiSettings {
  const apiConfigs = buildApiConfigs(value);
  const settings = apiConfigs[0] ?? normalizeApiConfig(value.settings, 0);
  const agnesSettings = apiConfigs[1] ?? normalizeApiConfig(value.agnesSettings, 1);
  return {
    agnesSettings,
    apiConfigs,
    imageModels: Array.isArray(value.imageModels) ? value.imageModels.filter((model): model is string => typeof model === "string") : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString(),
    settings,
    textModels: Array.isArray(value.textModels) ? value.textModels.filter((model): model is string => typeof model === "string") : [],
    version: 1
  };
}

export function readClientAiSettings(): ClientStoredApiSettings | null {
  if (typeof window === "undefined") return null;

  const saved = window.localStorage.getItem(clientAiSettingsStorageKey);
  if (saved) {
    return normalizeClientStoredSettings(JSON.parse(saved) as Partial<ClientStoredApiSettings>);
  }

  const legacySaved = window.localStorage.getItem(legacyClientAiSettingsStorageKey);
  if (!legacySaved) return null;
  const legacySettings = JSON.parse(legacySaved) as Partial<ClientApiSettings>;
  return normalizeClientStoredSettings({
    settings: { ...emptySettings, ...legacySettings }
  });
}

export function getClientAiSettingsPayload() {
  try {
    const saved = readClientAiSettings();
    const hasApiConfig = saved?.apiConfigs?.some((config) => config.apiKey?.trim());
    if (!saved?.settings?.apiKey?.trim() && !saved?.agnesSettings?.apiKey?.trim() && !hasApiConfig) return undefined;
    return saved;
  } catch {
    return undefined;
  }
}
