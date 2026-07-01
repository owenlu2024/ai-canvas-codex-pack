import { NextRequest, NextResponse } from "next/server";
import { normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface ProviderModel {
  id?: string;
  name?: string;
  object?: string;
  supportedGenerationMethods?: string[];
  [key: string]: unknown;
}

interface ModelListResult {
  ids: string[];
  source: string;
}

function normalizeBaseUrl(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "v1");
}

function classifyModel(id: string) {
  const normalized = id.toLowerCase();
  const imageHints = ["image", "img", "dall", "flux", "stable", "sd", "midjourney", "mj", "imagen", "kling"];
  if (imageHints.some((hint) => normalized.includes(hint))) return "image";
  return "text";
}

const requiredTextModels = ["gemini-2.5-flash", "gemini-3.1-flash-lite-preview"];
const requiredImageModels = ["gpt-image-2", "gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"];
const requiredAgnesImageModels = ["agnes-image-2.1-flash"];
const requiredAgnesTextModels = ["agnes-2.0-flash"];

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter((value) => Boolean(value.trim())))).sort();
}

function getErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readProviderError(response: Response) {
  try {
    const text = await response.text();
    return text.trim().slice(0, 500);
  } catch {
    return "";
  }
}

function normalizeGeminiModelName(value: string) {
  return value.replace(/^models\//, "");
}

function looksLikeGeminiBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.includes("generativelanguage.googleapis.com") || url.pathname.includes("v1beta");
  } catch {
    return false;
  }
}

function looksLike12AiBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname === "cdn.12ai.org" || url.hostname.endsWith(".12ai.org");
  } catch {
    return false;
  }
}

function getGeminiRoot(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/models\/?$/, "")
    .replace(/\/v1\/?$/, "")
    .replace(/\/v1beta\/?$/, "");
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(url: string, apiKey: string, mode: "bearer" | "gemini-key") {
  const response = await fetch(mode === "gemini-key" ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}` : url, {
    headers: mode === "bearer"
      ? {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      : { "Content-Type": "application/json" },
    method: "GET",
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const details = await readProviderError(response);
    throw new Error(`HTTP ${response.status}${details ? `：${details}` : ""}`);
  }

  return response.json() as Promise<{ data?: ProviderModel[]; models?: ProviderModel[] }>;
}

async function loadOpenAiCompatibleModels(baseUrl: string, apiKey: string): Promise<ModelListResult> {
  const payload = await fetchJson(`${baseUrl}/models`, apiKey, "bearer");
  const ids = uniqueSorted((payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim())));
  return { ids, source: `${baseUrl}/models` };
}

async function loadGeminiModels(rawBaseUrl: string, apiKey: string): Promise<ModelListResult> {
  const root = getGeminiRoot(rawBaseUrl);
  const url = `${root}/v1beta/models`;
  const payload = await fetchJson(url, apiKey, "gemini-key");
  const ids = uniqueSorted((payload.models ?? [])
    .map((model) => typeof model.name === "string" ? normalizeGeminiModelName(model.name) : model.id)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim())));
  return { ids, source: url };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { baseUrl?: string; apiKey?: string; provider?: string };
    const rawBaseUrl = body.baseUrl?.trim() ?? "";
    let baseUrl = "";
    try {
      baseUrl = normalizeBaseUrl(rawBaseUrl);
    } catch {
      return NextResponse.json({ error: "AI 服务地址必须是有效的 http/https 地址，且不能包含用户名或密码。" }, { status: 400 });
    }
    const apiKey = body.apiKey?.trim();

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: "缺少 AI 服务地址或 API Key。" }, { status: 400 });
    }

    if (body.provider === "agnes") {
      return NextResponse.json({
        imageModels: requiredAgnesImageModels,
        textModels: requiredAgnesTextModels
      });
    }

    if (looksLike12AiBaseUrl(rawBaseUrl)) {
      return NextResponse.json({
        imageModels: requiredImageModels,
        source: "12AI 文档推荐模型",
        textModels: requiredTextModels
      });
    }

    const errors: string[] = [];
    let result: ModelListResult | null = null;

    const loaders = looksLikeGeminiBaseUrl(rawBaseUrl)
      ? [
          () => loadGeminiModels(rawBaseUrl, apiKey),
          () => loadOpenAiCompatibleModels(baseUrl, apiKey)
        ]
      : [
          () => loadOpenAiCompatibleModels(baseUrl, apiKey),
          () => loadGeminiModels(rawBaseUrl, apiKey)
        ];

    for (const load of loaders) {
      try {
        result = await load();
        if (result.ids.length) break;
      } catch (error) {
        errors.push(getErrorText(error));
      }
    }

    if (!result || !result.ids.length) {
      console.error("[ai/models] model list failed", {
        baseUrl: rawBaseUrl,
        errors
      });
      return NextResponse.json({
        error: errors.length
          ? `无法读取模型列表：${errors.join("；")}`
          : "无法读取模型列表：服务商返回了空模型列表。"
      }, { status: 502 });
    }

    const ids = result.ids;
    const imageModels = uniqueSorted([
      ...ids.filter((id) => classifyModel(id) === "image"),
      ...requiredImageModels
    ]);
    const textModels = Array.from(new Set([
      ...ids.filter((id) => classifyModel(id) === "text"),
      ...requiredTextModels
    ])).sort();

    return NextResponse.json({
      imageModels,
      source: result.source,
      textModels
    });
  } catch (error) {
    console.error("[ai/models] unexpected error", error);
    return NextResponse.json({ error: `无法读取模型列表，请检查服务地址和 Key：${getErrorText(error)}` }, { status: 500 });
  }
}
