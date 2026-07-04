import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type ApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface StyleReferenceSummaryRequest {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number; url?: string }>;
  instruction?: string;
  model?: string;
  sourceNodeId?: string;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");
const defaultModel = "gemini-2.5-flash";

function normalizeBaseRoot(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "root");
}

function isAgnesTextModel(model?: string) {
  return Boolean(model?.startsWith("agnes-") && !model.includes("image"));
}

async function readSettings(model?: string, clientSettings?: StoredApiSettings): Promise<ApiSettings> {
  return readApiSettings(settingsPath, {
    clientSettings,
    defaultAgnesBaseUrl: "https://apihub.agnes-ai.com",
    isAgnesModel: isAgnesTextModel,
    model,
    normalizeBaseUrl: normalizeBaseRoot
  });
}

async function imageSourceForTask(value: string) {
  if (!value.startsWith("/")) return /^https?:\/\//i.test(value) ? assertSafeRemoteFetchUrl(value) : value;
  const filePath = getPublicAssetPath(value);
  const body = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${type};base64,${body.toString("base64")}`;
}

function getChatCompletionText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  return choices.map((choice) => {
    const message = (choice as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }).join("");
  }).join("\n").trim();
}

function getProviderError(payload: unknown, status: number) {
  if (!payload || typeof payload !== "object") return `AI 服务返回错误：${status}`;
  const record = payload as { error?: { message?: string } | string; message?: string };
  if (typeof record.error === "string") return record.error;
  return record.error?.message ?? record.message ?? `AI 服务返回错误：${status}`;
}

function buildInstruction(body: StyleReferenceSummaryRequest, labels: string[]) {
  return [
    "You are a design-system analyst for e-commerce image generation.",
    "Analyze the attached style/design-spec reference images and return only abstract design rules.",
    "These images are invisible references for a later image-generation step. They must not become visual content.",
    "Do NOT OCR, quote, copy, paraphrase, or reuse any exact visible text, logo, brand name, product, person, photo, illustration, price, claim, parameter, section title, or concrete page module from the images.",
    "Extract only reusable design standards: color palette relationships, background tone, spacing, grid rhythm, image-to-text ratio, typography feeling, information hierarchy, border/radius language, shadow softness, chip/table/icon treatment, composition density, and overall e-commerce art direction.",
    `Attached design-spec references: ${labels.join(", ")}.`,
    body.instruction?.trim() ? `Connected downstream prompt context:\n${body.instruction.trim()}` : "",
    "Return concise Chinese design rules, 8-14 bullet lines maximum. No markdown table. Do not mention copied text from the image."
  ].filter(Boolean).join("\n\n");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as StyleReferenceSummaryRequest;
    const images = (body.images ?? []).filter((image): image is { imageNumber?: number; url: string } => typeof image.url === "string" && Boolean(image.url));
    if (!images.length) return NextResponse.json({ error: "缺少设计规范参考图。" }, { status: 400 });

    const labels = images.map((image, index) => `<Image${String(Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1).padStart(3, "0")}>`);
    const rawModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const model = getBaseModelId(rawModel) ?? defaultModel;
    const settings = await readSettings(rawModel, body.aiSettings);
    if (!settings.apiKey || !settings.baseUrl) {
      return NextResponse.json({ error: isAgnesTextModel(model) ? "请先在设置里保存 Agnes 服务地址和 API Key。" : "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });
    }
    const imageParts = await Promise.all(images.map(async (image, index) => {
      const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
      return [
        {
          type: "text",
          text: `<Image${String(number).padStart(3, "0")}>`
        },
        {
          type: "image_url",
          image_url: {
            url: await imageSourceForTask(image.url)
          }
        }
      ];
    }));

    const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildInstruction(body, labels)
              },
              ...imageParts.flat()
            ]
          }
        ],
        temperature: 0.25
      }),
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) return NextResponse.json({ error: getProviderError(payload, response.status) }, { status: response.status });
    const summary = getChatCompletionText(payload).trim();
    if (!summary) return NextResponse.json({ error: "设计规范图没有返回可用摘要。" }, { status: 502 });
    return NextResponse.json({
      summary,
      debug: { imageCount: images.length, labels, model, sourceNodeId: body.sourceNodeId }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "设计规范图解析失败。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
