export interface ClientApiSettings {
  apiKey: string;
  baseUrl: string;
}

export interface ClientStoredApiSettings {
  agnesSettings?: ClientApiSettings;
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

export function normalizeClientStoredSettings(value: Partial<ClientStoredApiSettings>): ClientStoredApiSettings {
  return {
    agnesSettings: { ...defaultAgnesSettings, ...(value.agnesSettings ?? {}) },
    imageModels: Array.isArray(value.imageModels) ? value.imageModels.filter((model): model is string => typeof model === "string") : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString(),
    settings: { ...emptySettings, ...(value.settings ?? {}) },
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
    if (!saved?.settings?.apiKey?.trim() && !saved?.agnesSettings?.apiKey?.trim()) return undefined;
    return saved;
  } catch {
    return undefined;
  }
}
