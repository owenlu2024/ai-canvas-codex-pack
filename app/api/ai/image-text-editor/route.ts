import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface ExtractRequest {
  aiSettings?: StoredApiSettings;
  image?: string;
  model?: string;
  sourceNodeId?: string;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");

async function imageSource(value: string) {
  if (!value.startsWith("/")) return /^https?:\/\//i.test(value) ? assertSafeRemoteFetchUrl(value) : value;
  const filePath = getPublicAssetPath(value);
  const body = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${type};base64,${body.toString("base64")}`;
}

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  return choices.map((choice) => {
    const content = (choice as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
  }).join("\n").trim();
}

function parseResult(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { text?: unknown; sensitiveDocument?: unknown; sampleMarkerVisible?: unknown; reason?: unknown };
  return {
    text: typeof parsed.text === "string" ? parsed.text.trim() : "",
    sensitiveDocument: parsed.sensitiveDocument === true,
    sampleMarkerVisible: parsed.sampleMarkerVisible === true,
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : ""
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ExtractRequest;
    if (!body.image) return NextResponse.json({ error: "请先连接一张需要提取文字的图片。" }, { status: 400 });
    const rawModel = body.model?.trim() || "gemini-2.5-flash";
    const model = getBaseModelId(rawModel) ?? "gemini-2.5-flash";
    const settings = await readApiSettings(settingsPath, {
      clientSettings: body.aiSettings,
      defaultAgnesBaseUrl: "https://apihub.agnes-ai.com",
      isAgnesModel: (value) => Boolean(value?.startsWith("agnes-") && !value.includes("image")),
      model: rawModel,
      normalizeBaseUrl: (value) => value.trim() ? normalizeHttpBaseUrl(value, "root") : ""
    });
    if (!settings.apiKey || !settings.baseUrl) return NextResponse.json({ error: "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });

    const instruction = [
      "你是图片文字提取器。逐行提取图片中所有清晰可见的文字，保持原来的阅读顺序、标点、大小写和换行，不要翻译、解释或改写。",
      "同时判断图片是否疑似发票、账单、银行流水、收据、证件或其他正式凭证，并判断图片是否已经明显显示‘测试样品’、‘测试样本’或‘SAMPLE’标识。",
      "只返回严格 JSON，不要 Markdown：",
      '{"text":"逐行文字","sensitiveDocument":false,"sampleMarkerVisible":false,"reason":"简短判断依据"}'
    ].join("\n");
    const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: await imageSource(body.image) } }
        ] }],
        temperature: 0
      }),
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) return NextResponse.json({ error: `文字提取失败：${response.status}` }, { status: response.status });
    const text = responseText(payload);
    if (!text) return NextResponse.json({ error: "模型没有返回文字提取结果。" }, { status: 502 });
    const result = parseResult(text);
    return NextResponse.json({ ...result, debug: { model, sourceNodeId: body.sourceNodeId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "文字提取失败。" }, { status: 500 });
  }
}
