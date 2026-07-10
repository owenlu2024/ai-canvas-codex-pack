import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type ApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface ProductPosterRequest {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number; url?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
  sourceNodeId?: string;
}

interface PosterScheme {
  prompt: string;
  title: string;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");

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

function normalizeCount(value: unknown) {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(9, Math.max(1, parsed)) : 4;
}

async function imageSource(value: string) {
  if (!value.startsWith("/")) return /^https?:\/\//i.test(value) ? assertSafeRemoteFetchUrl(value) : value;
  const filePath = getPublicAssetPath(value);
  const body = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mimeType};base64,${body.toString("base64")}`;
}

async function toInlineData(value: string) {
  const source = await imageSource(value);
  const dataUrl = source.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrl) return { data: dataUrl[2].replace(/\s/g, ""), mimeType: dataUrl[1] };
  const response = await fetch(assertSafeRemoteFetchUrl(source), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`参考图读取失败：${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return { data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType };
}

function buildInstruction(body: ProductPosterRequest, imageLabels: string[]) {
  const params = body.params ?? {};
  const schemes = normalizeCount(params.schemes);
  const copyLevels = params.copyLevels?.split(",").filter(Boolean).join("、") || "产品名、主标题、副标题、核心卖点、行动文案";
  return [
    "你是产品海报导演，只负责规划海报并输出可直接交给 Text Image Layout 生图节点的中文或英文 Prompt，不生成图片。",
    `必须生成恰好 ${schemes} 个彼此独立的产品海报 Prompt 方案。`,
    `输出语言：${params.outputLanguage || "中文"}。`,
    `方案差异：${params.schemeDiversity || "高"}。`,
    `海报用途：${params.posterPurpose || "产品主视觉"}。`,
    `产品锁定：${params.productLock || "严格"}。`,
    `产品位置：${params.productPosition || "自动"}。`,
    `产品占比：${params.productScale || "大"}。`,
    `版式结构：${params.layoutStructure || "自动"}。`,
    `信息密度：${params.infoDensity || "标准"}。`,
    `留白程度：${params.whitespace || "标准"}。`,
    `风格参考强度：${params.styleReferenceStrength || "中"}。`,
    `色彩策略：${params.colorStrategy || "自动提取"}。`,
    `背景类型：${params.backgroundType || "自动"}。`,
    `文案来源：${params.copySource || "AI 补全文案"}。`,
    `允许的画面文案层级：${copyLevels}。`,
    `已连接图片：${imageLabels.join(", ")}。`,
    "前置 Prompt 负责定义哪张图是主产品、哪张图是海报风格参考、细节参考或其他角色。必须逐张遵守，不得自行调换角色。",
    body.instruction?.trim() ? `前置 Prompt：\n${body.instruction.trim()}` : "前置 Prompt：未提供。",
    "每个方案必须包含以下固定区块，区块标题必须完全一致：",
    "【图片角色】逐张写清 <Image###> 的用途。",
    "【产品锁定】说明主产品必须保留的外形、结构、比例、颜色、材质、标签与品牌识别。",
    "【海报目标】说明海报用途、受众和视觉目标。",
    "【版式设计】明确产品、主标题、副标题、卖点、装饰元素的相对位置、阅读顺序、对齐、层级和留白。",
    "【视觉风格】说明背景、色彩、字体气质、装饰图形、光影与风格参考图的使用方式。",
    "【画面文案】逐行列出最终海报上需要真实出现的全部文字。这里必须是最终可用的具体中文、英文或双语文案，禁止写占位符、说明句或‘待补充’。无文字海报时只写‘无’。",
    "【文字要求】要求下游模型只能渲染【画面文案】内的文字，不得增加乱码、无关文字、重复文字、方案编号、参数或区块标题。",
    "硬性限制：绝对不要输出画面比例、宽高比、横版、竖版、像素尺寸、分辨率、1K、2K、4K。这些全部由后续 Text Image Layout 节点控制。版式必须写成能自适应任意最终画布。",
    "每个方案都必须完整包含最终海报上的所有文字信息；不能只说‘添加标题’或‘放三个卖点’。",
    "不同方案必须具有真实的创意和排版差异，不能只替换方案标题。",
    "只返回合法 JSON，不要 Markdown。格式：{\"schemes\":[{\"title\":\"产品海报 Prompt 01：方向名\",\"prompt\":\"完整 Prompt\"}]}"
  ].join("\n\n");
}

function candidateText(payload: unknown) {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null)?.candidates ?? [];
  return candidates.flatMap((item) => item.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
}

function chatText(payload: unknown) {
  const choices = (payload as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> } | null)?.choices ?? [];
  return choices.map((choice) => {
    const content = choice.message?.content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
  }).join("\n").trim();
}

function stripFence(value: string) {
  return value.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function parseSchemes(raw: string, expected: number): PosterScheme[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  }
  const items = (parsed as { schemes?: unknown[] } | null)?.schemes;
  if (!Array.isArray(items)) return [];
  return items.slice(0, expected).map((item, index) => {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `产品海报 Prompt ${String(index + 1).padStart(2, "0")}`;
    if (!prompt || !/【画面文案】/.test(prompt)) return null;
    if (/(?:\b(?:1\s*[:：]\s*1|2\s*[:：]\s*3|3\s*[:：]\s*2|3\s*[:：]\s*4|4\s*[:：]\s*3|4\s*[:：]\s*5|5\s*[:：]\s*4|9\s*[:：]\s*16|16\s*[:：]\s*9|21\s*[:：]\s*9)\b|\d{3,5}\s*[x×]\s*\d{3,5}|\b[124]K\b|分辨率|画幅比例|宽高比|横版|竖版)/i.test(prompt)) return null;
    return { prompt, title };
  }).filter((item): item is PosterScheme => item !== null);
}

async function runGemini(settings: ApiSettings, model: string, instruction: string, images: Array<{ label: string; data: string; mimeType: string }>) {
  const response = await fetch(`${settings.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instruction }, ...images.flatMap((image) => [{ text: image.label }, { inlineData: { data: image.data, mimeType: image.mimeType } }])] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(180000)
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message || `AI 服务返回错误：${response.status}`);
  return candidateText(payload);
}

async function runChat(settings: ApiSettings, model: string, instruction: string, images: Array<{ label: string; source: string }>) {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: instruction }];
  images.forEach((image) => {
    content.push({ type: "text", text: image.label });
    content.push({ type: "image_url", image_url: { url: image.source } });
  });
  const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    body: JSON.stringify({ model, messages: [{ role: "user", content }], response_format: { type: "json_object" }, temperature: 0.7 }),
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(180000)
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message || `AI 服务返回错误：${response.status}`);
  return chatText(payload);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ProductPosterRequest;
    const rawModel = body.model?.trim() || "gemini-2.5-flash";
    const model = getBaseModelId(rawModel) || rawModel;
    const settings = await readSettings(rawModel, body.aiSettings);
    if (!settings.baseUrl || !settings.apiKey) return NextResponse.json({ error: "请先在设置中保存 AI 服务地址和 API Key。" }, { status: 400 });
    const validImages = (body.images ?? []).filter((image): image is { imageNumber?: number; url: string } => typeof image.url === "string" && Boolean(image.url));
    if (!validImages.length) return NextResponse.json({ error: "请至少连接一张产品图片。" }, { status: 400 });
    if (!body.instruction?.trim()) return NextResponse.json({ error: "请连接前置 Prompt，并定义主产品图和风格参考图的角色。" }, { status: 400 });
    const labels = validImages.map((image, index) => `<Image${String(image.imageNumber ?? index + 1).padStart(3, "0")}>`);
    const instruction = buildInstruction(body, labels);
    const expected = normalizeCount(body.params?.schemes);
    let raw = "";
    if (model.startsWith("gemini-")) {
      const parts = await Promise.all(validImages.map(async (image, index) => ({ label: labels[index], ...(await toInlineData(image.url)) })));
      raw = await runGemini(settings, model, instruction, parts);
    } else {
      const sources = await Promise.all(validImages.map(async (image, index) => ({ label: labels[index], source: await imageSource(image.url) })));
      raw = await runChat(settings, model, instruction, sources);
    }
    const schemes = parseSchemes(raw, expected);
    if (schemes.length !== expected) return NextResponse.json({ error: `AI 返回的海报 Prompt 不完整：需要 ${expected} 个有效方案，实际得到 ${schemes.length} 个。请重新运行。` }, { status: 502 });
    return NextResponse.json({ prompt: schemes.map((scheme) => scheme.prompt).join("\n\n"), schemes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "产品海报导演生成失败。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
