import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { readApiSettings, type ApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface TaobaoPageDirectorRequest {
  images?: Array<{ imageNumber?: number; title?: string; url?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
  sourceNodeId?: string;
}

interface TaobaoPageScheme {
  prompt: string;
  title: string;
}

interface TaobaoPagePlanItem {
  aspectRatio: string;
  goal: string;
  height: number;
  title: string;
  type: string;
  typeLabel: string;
  usage: string;
  width: number;
}

type ImageRoleDirective = "detail" | "function" | "main" | "package" | "scene" | "size" | "structure" | "support";

const settingsPath = getCanvasDataPath("api-settings.local.json");
const defaultModel = "gemini-2.5-flash";
const maxPlannerImages = 10;
const maxPromptReferenceLabels = 5;
const plannerPreviewMaxEdge = 1024;

const imageTypes = [
  { countKey: "heroCount", defaultCount: 1, defaultSize: "800x800", goal: "提升点击率，第一眼清晰识别商品主体。", label: "主图", name: "Hero", order: "01", sizeKey: "heroSize", type: "hero", usage: "淘宝商品页主图" },
  { countKey: "sellingPointCount", defaultCount: 2, defaultSize: "800x800", goal: "把核心卖点转化成直观画面，帮助用户快速理解购买理由。", label: "卖点图", name: "SellingPoint", order: "02", sizeKey: "sellingPointSize", type: "sellingPoint", usage: "淘宝商品页卖点模块" },
  { countKey: "lifestyleCount", defaultCount: 2, defaultSize: "750x1000", goal: "展示真实使用场景和人群代入感。", label: "场景图", name: "Lifestyle", order: "03", sizeKey: "lifestyleSize", type: "lifestyle", usage: "淘宝商品页场景模块" },
  { countKey: "detailCount", defaultCount: 2, defaultSize: "800x800", goal: "展示材质、结构、工艺和局部细节，建立信任。", label: "细节图", name: "Detail", order: "04", sizeKey: "detailSize", type: "detail", usage: "淘宝商品页细节模块" },
  { countKey: "sizeCount", defaultCount: 1, defaultSize: "750x1000", goal: "说明尺寸、比例、容量、适配关系和空间占用。", label: "尺寸规格图", name: "Size", order: "05", sizeKey: "sizeSize", type: "size", usage: "淘宝商品页规格尺寸模块" },
  { countKey: "functionCount", defaultCount: 1, defaultSize: "750x1200", goal: "拆解功能结构、使用方式和关键体验。", label: "功能拆解图", name: "Function", order: "06", sizeKey: "functionSize", type: "function", usage: "淘宝商品页功能说明模块" },
  { countKey: "painPointCount", defaultCount: 1, defaultSize: "750x1200", goal: "表达用户痛点、对比优势或使用前后变化。", label: "对比痛点图", name: "Compare", order: "07", sizeKey: "painPointSize", type: "compare", usage: "淘宝商品页对比痛点模块" },
  { countKey: "moodCount", defaultCount: 1, defaultSize: "750x1000", goal: "用品牌氛围和生活方式完成页面情绪收束。", label: "氛围收尾图", name: "BrandMood", order: "08", sizeKey: "moodSize", type: "brandMood", usage: "淘宝商品页氛围收尾模块" }
] as const;

function normalizeBaseRoot(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "root");
}

function isAgnesTextModel(model?: string) {
  return Boolean(model?.startsWith("agnes-") && !model.includes("image"));
}

async function readSettings(model?: string): Promise<ApiSettings> {
  return readApiSettings(settingsPath, {
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

function dataUrlToBuffer(value: string) {
  const dataUrl = value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!dataUrl) return null;
  return {
    buffer: Buffer.from(dataUrl[2].replace(/\s/g, ""), "base64"),
    mimeType: dataUrl[1]
  };
}

async function imageSourceToBuffer(imageUrl: string) {
  const source = await imageSourceForTask(imageUrl);
  const dataUrl = dataUrlToBuffer(source);
  if (dataUrl) return dataUrl;

  const response = await fetch(assertSafeRemoteFetchUrl(source), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`参考图读取失败：${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType
  };
}

async function toPlannerInlineData(imageUrl: string) {
  const source = await imageSourceToBuffer(imageUrl);
  let previewBuffer: Buffer;
  let mimeType = "image/jpeg";
  try {
    const sharp = (await import("sharp")).default;
    previewBuffer = await sharp(source.buffer)
      .rotate()
      .resize({ fit: "inside", height: plannerPreviewMaxEdge, width: plannerPreviewMaxEdge, withoutEnlargement: true })
      .jpeg({ mozjpeg: true, quality: 85 })
      .toBuffer();
  } catch {
    previewBuffer = source.buffer;
    mimeType = source.mimeType;
  }
  return {
    data: previewBuffer.toString("base64"),
    mimeType
  };
}

async function toPlannerChatImageUrl(imageUrl: string) {
  const inlineData = await toPlannerInlineData(imageUrl);
  return `data:${inlineData.mimeType};base64,${inlineData.data}`;
}

function normalizeCount(value: unknown, fallback: number) {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(8, Math.max(0, parsed));
}

function normalizeSize(value: unknown, fallback: string) {
  const raw = typeof value === "string" && value.trim() ? value.trim().replace("×", "x") : fallback;
  const match = raw.match(/^(\d{3,4})x(\d{3,4})$/i);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
  return `${width}x${height}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectRatio(width: number, height: number) {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function buildPlan(params: Record<string, string> = {}) {
  const plan: TaobaoPagePlanItem[] = [];
  const selectedType = typeof params.targetImageType === "string" && imageTypes.some((type) => type.type === params.targetImageType)
    ? params.targetImageType
    : imageTypes[0].type;
  imageTypes.filter((type) => type.type === selectedType).forEach((type) => {
    const count = Math.max(1, normalizeCount(params[type.countKey], type.defaultCount));
    const [width, height] = normalizeSize(params[type.sizeKey], type.defaultSize).split("x").map(Number);
    for (let index = 1; index <= count; index += 1) {
      const title = `${type.order}_${type.label}_${type.name}_${String(index).padStart(2, "0")}_${width}x${height}`;
      plan.push({
        aspectRatio: aspectRatio(width, height),
        goal: type.goal,
        height,
        title,
        type: type.type,
        typeLabel: type.label,
        usage: type.usage,
        width
      });
    }
  });
  return plan;
}

function normalizeLanguage(value?: string) {
  if (value === "中文") return "Chinese";
  if (value === "英文") return "English";
  if (value === "中英双语") return "Bilingual";
  if (value === "English" || value === "Bilingual") return value;
  return "Chinese";
}

function getRetryInstruction(outputLanguage: string, count: number) {
  if (outputLanguage === "Chinese") {
    return [
      `上一次输出无效。只返回合法 JSON，必须正好包含 ${count} 个 schemes。`,
      "每个 prompt 必须中文为主，字段名和说明文字优先使用中文。",
      "每个 prompt 必须包含红色标注段可识别的：画面文字清单（VISIBLE_TEXT_TO_RENDER）和 文字渲染规则（TEXT_RENDERING_RULE）。",
      "画面文字清单必须逐条列出最终画面会出现的所有文字，包括主标题、副标题、卖点短句、图标标签、角标、底部小字、参数、单位和辅助说明；没有文字也要写：- \"无文字\"。"
    ].join("\n");
  }
  if (outputLanguage === "English") {
    return [
      `Previous output was invalid. Return only valid JSON with exactly ${count} schemes.`,
      "Every prompt must be English-first.",
      "Every prompt must include VISIBLE_TEXT_TO_RENDER and TEXT_RENDERING_RULE.",
      "VISIBLE_TEXT_TO_RENDER must list every exact visible text string in the final image, including title, subtitle, selling-point copy, icon labels, badges, footer notes, parameters, units, and auxiliary labels; if there is no visible text, write: - \"No visible text\"."
    ].join("\n");
  }
  return [
    `Previous output was invalid. Return only valid JSON with exactly ${count} schemes.`,
    "Every prompt must be bilingual where appropriate.",
    "Every prompt must include VISIBLE_TEXT_TO_RENDER and TEXT_RENDERING_RULE with every exact visible text string."
  ].join("\n");
}

function normalizeOption(value: string | undefined, fallback: string, translations: Record<string, string> = {}) {
  if (!value?.trim()) return fallback;
  return translations[value] ?? value;
}

function extractStyleReferenceLabels(instruction: string, images: Array<{ imageNumber?: number }>) {
  const availableLabels = new Set(images.map((image, index) => `<Image${String(Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1).padStart(3, "0")}>`));
  const labels = new Set<string>();
  const styleWords = String.raw`(?:风格参考图?|设计规范图?|视觉规范图?|设计风格参考|品牌规范图?|style\s*reference|design\s*(?:spec|system|guideline|standard)\s*reference|visual\s*(?:guideline|standard)\s*reference|brand\s*(?:guideline|system)\s*reference)`;
  const mention = String.raw`(?:<\s*Image\s*(\d{1,3})\s*>|@\s*(?:Image\s*)?0*(\d{1,3})\b)`;
  const patterns = [
    new RegExp(`${mention}\\s*(?:是|为|作为|用作|只是|仅作为|only\\s+as|as)?\\s*${styleWords}`, "gi"),
    new RegExp(`${styleWords}\\s*(?:是|为|指定为|使用|用|[:：])?\\s*${mention}`, "gi")
  ];
  patterns.forEach((pattern) => {
    for (const match of instruction.slice(0, 20000).matchAll(pattern)) {
      const number = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
      if (!Number.isInteger(number) || number < 1) continue;
      const label = `<Image${String(number).padStart(3, "0")}>`;
      if (availableLabels.has(label)) labels.add(label);
    }
  });
  return [...labels];
}

function getAvailableImageLabels(images: Array<{ imageNumber?: number }>) {
  return new Set(images.map((image, index) => `<Image${String(Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1).padStart(3, "0")}>`));
}

function getImageMentionNumbers(line: string) {
  const numbers: number[] = [];
  for (const match of line.matchAll(/(?:<\s*Image\s*(\d{1,3})\s*>|@\s*(?:Image\s*)?0*(\d{1,3})\b)/gi)) {
    const number = Number(match[1] ?? match[2]);
    if (Number.isInteger(number) && number > 0 && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function inferRoleFromInstructionLine(line: string): ImageRoleDirective | null {
  if (/风格参考|设计规范|视觉规范|品牌规范|style\s*reference|design\s*(?:spec|system|guideline|standard)|visual\s*(?:guideline|standard)/i.test(line)) return null;
  if (/主产品|产品主体|商品主体|产品图|产品图片|商品图|商品图片|产品照片|商品照片|白底图|主图|primary\s*product|main\s*product|product\s*(?:identity|source|photo|image)/i.test(line)) return "main";
  if (/尺寸|规格|比例|大小|尺度|dimension|size|scale|spec/i.test(line)) return "size";
  if (/结构|拆解|构造|部件|剖面|structure|assembly|component|exploded/i.test(line)) return "structure";
  if (/功能|说明|操作|使用|function|feature|usage|operation/i.test(line)) return "function";
  if (/细节|局部|材质|质感|detail|material|texture|finish/i.test(line)) return "detail";
  if (/场景|环境|使用场景|氛围|scene|environment|lifestyle|mood/i.test(line)) return "scene";
  if (/包装|盒|包材|package|packaging/i.test(line)) return "package";
  return null;
}

function extractImageRoleDirectives(instruction: string, images: Array<{ imageNumber?: number }>) {
  const availableLabels = getAvailableImageLabels(images);
  const roleByLabel = new Map<string, ImageRoleDirective>();
  instruction.slice(0, 20000).split(/\r?\n|。|；|;/).forEach((line) => {
    const role = inferRoleFromInstructionLine(line);
    if (!role) return;
    getImageMentionNumbers(line).forEach((number) => {
      const label = `<Image${String(number).padStart(3, "0")}>`;
      if (availableLabels.has(label)) roleByLabel.set(label, role);
    });
  });
  return roleByLabel;
}

function orderContentLabelsByRole(labels: string[], roleByLabel: Map<string, ImageRoleDirective>) {
  const priority: Record<ImageRoleDirective, number> = {
    main: 0,
    size: 1,
    structure: 2,
    function: 3,
    detail: 4,
    package: 5,
    scene: 6,
    support: 7
  };
  return [...labels].sort((a, b) => {
    const aRole = roleByLabel.get(a) ?? "support";
    const bRole = roleByLabel.get(b) ?? "support";
    return priority[aRole] - priority[bRole];
  });
}

function displayImageLabel(label: string) {
  const imageNumber = Number(label.match(/\d{1,3}/)?.[0] ?? 0);
  return imageNumber ? `@Image ${String(imageNumber).padStart(3, "0")} / ${label}` : label;
}

function getRolePriorityForImageType(imageType: string): ImageRoleDirective[] {
  const priorityByType: Record<string, ImageRoleDirective[]> = {
    brandMood: ["main", "scene", "detail", "support"],
    compare: ["main", "function", "detail", "scene", "support"],
    detail: ["detail", "structure", "main", "size", "support"],
    function: ["function", "structure", "main", "detail", "size", "support"],
    hero: ["main", "detail", "size", "support"],
    lifestyle: ["main", "scene", "detail", "function", "support"],
    sellingPoint: ["main", "function", "detail", "structure", "size", "support"],
    size: ["size", "main", "structure", "detail", "support"]
  };
  return priorityByType[imageType] ?? ["main", "size", "structure", "function", "detail", "scene", "package", "support"];
}

function selectPromptReferenceLabels(contentLabels: string[], styleLabels: string[], roleByLabel: Map<string, ImageRoleDirective>, imageType: string) {
  const selected: string[] = [];
  const add = (label?: string) => {
    if (!label || selected.includes(label)) return;
    if (selected.length >= maxPromptReferenceLabels) return;
    selected.push(label);
  };

  const rolePriority = getRolePriorityForImageType(imageType);
  rolePriority.forEach((role) => {
    contentLabels.filter((label) => (roleByLabel.get(label) ?? "support") === role).forEach(add);
  });

  if (!selected.some((label) => contentLabels.includes(label))) add(contentLabels[0]);
  if (imageType !== "size") add(contentLabels.find((label) => roleByLabel.get(label) === "size"));
  styleLabels.forEach(add);

  return {
    content: selected.filter((label) => contentLabels.includes(label)),
    style: selected.filter((label) => styleLabels.includes(label))
  };
}

function countUniqueAtImageReferences(prompt: string) {
  return new Set(Array.from(prompt.matchAll(/@Image\s*0*(\d{1,3})\b/gi)).map((match) => Number(match[1]))).size;
}

function getCandidateText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  return candidates.map((candidate) => {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts.map((part) => typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
  }).join("\n").trim();
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

function stripCodeFence(value: string) {
  return value
    .replace(/```(?:json|JSON|[a-zA-Z]*)?\s*/g, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonObjectWithKey(value: string, key: string) {
  const trimmed = stripCodeFence(value);
  const starts: number[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    for (let end = trimmed.length - 1; end > start; end -= 1) {
      if (trimmed[end] !== "}") continue;
      const candidate = trimmed.slice(start, end + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && key in parsed) return candidate;
      } catch {
        // Keep looking for valid JSON.
      }
    }
  }
  return trimmed;
}

function getProviderError(payload: unknown, status: number) {
  if (!payload || typeof payload !== "object") return `AI 服务返回错误：${status}`;
  const record = payload as { error?: { message?: string } | string; message?: string };
  if (typeof record.error === "string") return record.error;
  return record.error?.message ?? record.message ?? `AI 服务返回错误：${status}`;
}

function shouldRetryWithGeminiNative(model: string, payload: unknown) {
  const providerError = getProviderError(payload, 502).toLowerCase();
  return model.toLowerCase().startsWith("gemini-") && /openai_error|invalid.*image|vision|multimodal|content/i.test(providerError);
}

async function runGeminiNativePlanning({
  attempt,
  imageParts,
  instructionText,
  model,
  outputLanguage,
  plan,
  settings
}: {
  attempt: number;
  imageParts: Array<{ inlineData: { data: string; mimeType: string }; text: string }>;
  instructionText: string;
  model: string;
  outputLanguage: string;
  plan: TaobaoPagePlanItem[];
  settings: ApiSettings;
}) {
  const retryText = `${instructionText}\n\n${getRetryInstruction(outputLanguage, plan.length)}\nUse the exact titles from the output plan.`;
  const parts = [
    {
      text: attempt === 0 ? instructionText : retryText
    },
    ...imageParts.flatMap((part) => [
      { text: part.text },
      { inlineData: part.inlineData }
    ])
  ];

  const response = await fetch(`${settings.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: attempt === 0 ? 0.45 : 0.25
      }
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST",
    signal: AbortSignal.timeout(180000)
  });
  const payload = await response.json().catch(() => null) as unknown;
  return {
    ok: response.ok,
    payload,
    status: response.status,
    text: getCandidateText(payload)
  };
}

function buildInstruction(body: TaobaoPageDirectorRequest, images: Array<{ imageNumber?: number; title?: string; url: string }>, plan: TaobaoPagePlanItem[]) {
  const params = body.params ?? {};
  const outputLanguage = normalizeLanguage(params.outputLanguage);
  const categoryMode = normalizeOption(params.categoryMode, "Auto");
  const productLock = normalizeOption(params.productLock, "Strict", { 严格: "Strict", 灵活: "Flexible" });
  const styleReferenceMode = normalizeOption(params.styleReferenceMode, "Auto", { 自动识别: "Auto", 手动指定: "Manual", 不使用: "Disabled" });
  const marketingIntensity = normalizeOption(params.marketingIntensity, "Standard", { 克制: "Restrained", 标准: "Standard", 强转化: "High Conversion" });
  const visualStyle = normalizeOption(params.visualStyle, "Auto");
  const infoDensity = normalizeOption(params.infoDensity, "Standard", { 干净: "Clean", 标准: "Standard", 高信息量: "High Information Density" });
  const imageLabels = images.map((image, index) => {
    const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
    return `<Image${String(number).padStart(3, "0")}>`;
  });
  const styleReferenceLabels = extractStyleReferenceLabels(body.instruction ?? "", images);
  const outputPlan = plan.map((item, index) => ({
    aspectRatio: item.aspectRatio,
    goal: item.goal,
    height: item.height,
    index: index + 1,
    title: item.title,
    type: item.type,
    typeLabel: item.typeLabel,
    usage: item.usage,
    width: item.width
  }));

  return [
    "You are Taobao Page Director, a senior e-commerce image-page prompt planner.",
    "You only write prompt packs for downstream image generation. You never generate images.",
    `Generate exactly ${plan.length} prompts, one for each item in Output Plan, in the same order.`,
    `Output Language: ${outputLanguage}.`,
    `Category Mode: ${categoryMode}.`,
    `Product Lock: ${productLock}. Strict means preserve the main product's appearance, structure, silhouette, proportions, color, material layout, and key details. Flexible means mild commercial beautification is allowed, but the product must not become a different item.`,
    `Style Reference Image Mode: ${styleReferenceMode}.`,
    `Marketing Intensity: ${marketingIntensity}.`,
    `Visual Style: ${visualStyle}.`,
    `Information Density: ${infoDensity}.`,
    "Available image references:",
    imageLabels.join(", "),
    "Important: each connected image is attached immediately after its exact <Image###> label in this request. You must inspect those attached images before planning.",
    "Use the attached images to identify the real product category, silhouette, structure, proportions, materials, color layout, functional parts, scene evidence, size evidence, and style/design-spec role.",
    "User @Image Role Rule:",
    "If User direction says an image is product image, product photo, main product, 商品图, 产品图, 产品图片, 主产品, 尺寸图, 细节图, 功能说明, 场景图, or 风格参考, you must obey that role exactly.",
    "The final generated prompt must repeat those @Image role assignments in the Image Role References / 参考图用途 section. Do not silently change which @Image is the product. Do not make a style reference or scene reference become the primary product.",
    "Do not invent product details that conflict with the attached product images. If Product Lock is Strict, every generated downstream prompt must preserve the real product from the attached Primary Product Identity Source.",
    styleReferenceLabels.length
      ? `Detected style/design-spec reference images from User direction: ${styleReferenceLabels.join(", ")}. These labels must be repeated explicitly in every generated prompt.`
      : "Detected style/design-spec reference images from User direction: none. If the user direction marks one, infer it from the exact image label and repeat it explicitly in every generated prompt.",
    body.instruction?.trim() ? `User direction:\n${body.instruction.trim()}` : "User direction: none.",
    "Style Reference Isolation Rule:",
    "If the user marks any image as a style reference, or Style Reference Image Mode is Auto/Manual and an image is described as style/design/visual-system reference, that image must be used only for visual style and design-system extraction.",
    "Extract only the overall design system, color palette, layout rhythm, spacing, lighting mood, typography feeling, hierarchy, e-commerce visual standard, and composition density from style reference images.",
    "Do not OCR style reference images. Do not copy, quote, extract, rewrite, or reproduce any text, logo, brand name, product, person, image asset, promotion, price, parameter, or specific content from a style reference image.",
    "Style reference images must never be used as product evidence, page-copy source, logo source, brand source, or model/person source.",
    "Taobao Image Rules:",
    "Every prompt must specify the intended Taobao usage, exact resolution, aspect ratio, and native composition fit. The image should be designed for that size, not dependent on later cropping.",
    "Do not request platform logos, real third-party brand marks, copied ad text, unverifiable claims, fake certificates, or misleading comparison content.",
    "For lifestyle / scene images, the environment may change, but the product subject must still be the exact product from the Primary Product Identity Source. Never replace it with a generic lamp, lantern, bottle, appliance, or visually similar substitute.",
    "Every visible text string that may appear in the final generated image must be explicitly listed inside the prompt. The downstream image node is not allowed to invent any extra visible text.",
    "Visible Text Inventory Rule:",
    "Before writing any layout or final prompt, decide the complete typography inventory for that image. Every text-bearing element must be listed first in VISIBLE_TEXT_TO_RENDER / 画面文字清单.",
    "This includes all hero headlines, subheadlines, selling-point phrases, feature labels, icon captions, badge text, corner labels, comparison labels, footer notes, tiny explanatory copy, numbers, units, parameters, callout labels, and any text inside product UI or packaging that you intentionally want visible.",
    "If a word, number, label, caption, or text-like mark is not listed in VISIBLE_TEXT_TO_RENDER / 画面文字清单, the downstream image must not render it. Do not describe icon cards, data labels, badges, parameter rows, comparison tables, or footer notes unless their exact visible text has already been listed.",
    "Visible Text Layout Rule:",
    "After the visible-text inventory, every prompt must include a VISIBLE_TEXT_LAYOUT / 画面文字布局表 section. It must map each listed visible text string to its exact role and approximate placement, such as main headline, subtitle, corner badge, icon caption, feature card title, feature card body, parameter row, callout label, footer note, or comparison label.",
    "The VISIBLE_TEXT_LAYOUT / 画面文字布局表 must use the exact same strings as VISIBLE_TEXT_TO_RENDER / 画面文字清单. Do not add layout rows for text that is not in the inventory. Do not describe any text area without naming the exact text string.",
    "The final downstream prompt must explicitly say: render only the strings listed in the visible-text inventory, in the placements described by the visible-text layout table.",
    outputLanguage === "Chinese"
      ? "Because Output Language is Chinese, every generated downstream prompt must be Chinese-first: Chinese section names, Chinese planning descriptions, Chinese goal/composition wording, and Chinese final prompt wording. English is allowed only when it is part of the product name, model, functional term, button label, brand-approved phrase, visual style, or user-provided copy, but every English string must still be explicitly listed in the visible-text list."
      : outputLanguage === "English"
        ? "Because Output Language is English, every generated downstream prompt must be English-first. Chinese is allowed when it is part of the product name, model, brand-approved phrase, legal/source copy, or user-provided copy, but every Chinese string must still be explicitly listed in VISIBLE_TEXT_TO_RENDER."
        : "Because Output Language is Bilingual, every visible final-image text item must explicitly list the Chinese and English text pair to render.",
    outputLanguage === "Chinese"
      ? "Every Chinese prompt must include this exact visible-text section near the top, and it must be a complete inventory of all on-image text:\n画面文字清单（VISIBLE_TEXT_TO_RENDER）：\n- \"精确画面文字 1\"\n- \"精确画面文字 2\"\n- \"精确画面文字 3\"\n文字渲染规则（TEXT_RENDERING_RULE）：只渲染画面文字清单中逐条列出的精确文字。不得新增任何其他文字、英文标题、英文标签、水印、logo 文字、占位文字、OCR 文字、参数文字、内部说明文字或参考图中的文字。\n画面文字布局表（VISIBLE_TEXT_LAYOUT）：\n- \"精确画面文字 1\"：主标题，放在画面顶部/左上/右侧信息卡等明确位置。\n- \"精确画面文字 2\"：副标题/卖点标签/图标说明，放在明确位置。\n- \"精确画面文字 3\"：辅助说明/底部小字/参数，放在明确位置。"
      : "Every prompt must include this exact section name and format near the top, and it must be a complete inventory of all on-image text:\nVISIBLE_TEXT_TO_RENDER:\n- \"exact visible text 1\"\n- \"exact visible text 2\"\n- \"exact visible text 3\"\nTEXT_RENDERING_RULE: Render only the exact strings listed in VISIBLE_TEXT_TO_RENDER. Do not render any other text, labels, UI text, watermark, logo text, placeholder text, OCR text, parameter text, internal instruction text, or copied text from reference images.\nVISIBLE_TEXT_LAYOUT:\n- \"exact visible text 1\": main headline, placed in a specific area.\n- \"exact visible text 2\": subtitle / selling-point label / icon caption, placed in a specific area.\n- \"exact visible text 3\": auxiliary note / footer note / parameter text, placed in a specific area.",
    outputLanguage === "Chinese"
      ? "如果某张图不需要画面文字，也必须写：画面文字清单（VISIBLE_TEXT_TO_RENDER）：\n- \"无文字\"，并在文字渲染规则中明确不渲染任何画面文字。"
      : "If a prompt needs no visible text, still include VISIBLE_TEXT_TO_RENDER with one bullet: \"No visible text\", and explicitly say no visible text should be rendered.",
    "If text overlays are needed, list the exact final text in VISIBLE_TEXT_TO_RENDER first, then describe text areas and hierarchy using only those listed strings.",
    outputLanguage === "Chinese"
      ? "For Chinese output, do not leave section labels such as Goal, Composition, Usage, Resolution, Final Prompt as English-only labels. Use Chinese labels such as 目标、构图、用途、分辨率、最终生图提示."
      : "",
    "Every prompt must include: image role references, product lock rule, style reference rule when applicable, Taobao usage, output resolution, aspect ratio, page goal, visual composition, lighting/rendering direction, and final downstream prompt.",
    "Mandatory image role output:",
    outputLanguage === "Chinese"
      ? "Every Chinese prompt must contain a separate section named exactly: 参考图用途（不渲染为画面文字）. This section must define what every referenced <Image###> is for, and none of this section is visible image text."
      : "Every prompt must contain a separate section named exactly: Image Role References (not visible text). This section must define what every referenced <Image###> is for, and none of this section is visible image text.",
    "Image role references must list only image references that may affect final picture content, such as product, scene, size, structure, package, or material references.",
    "When Product Lock is Strict, at least one non-style image reference must be explicitly labeled as Primary Product Identity Source / 主产品身份来源. A size, structure, dimension, white-background, or specification image can still be the primary product identity source if it is the clearest product evidence.",
    "For Primary Product Identity Source references, tell the downstream image node to preserve the exact product category, silhouette, geometry, proportions, color/material layout, transparent/base parts, openings, caps, connectors, and distinctive details. Do not allow a similar replacement product.",
    "Do not include style/design-spec reference images in the product/content image role list.",
    "If style/design-spec reference images are detected or named by the user, every prompt must include an exact separate line like: Design Style Reference: <Image###>.",
    "That line must identify the exact image label. Do not say only 'style reference image' without the <Image###> label.",
    "For this Design Style Reference line, also include a Downstream Generation Rule explaining exactly how the image-generation node must use it.",
    "The Downstream Generation Rule must say the style reference image is only for abstract design guidance: color palette, spacing, typography mood, layout rhythm, information hierarchy, icon/card/table style, border/radius language, and e-commerce visual quality.",
    "The Downstream Generation Rule must say the image-generation node must not render, recreate, crop, place, copy, OCR, quote, or use any product, text, logo, brand, person, picture asset, background, section layout, or concrete content from the style reference image.",
    "In scene/composition/final prompt wording, never write phrases like 'match <Image###>', 'according to <Image###>', or '符合<Image###>'. Instead write 'follow the hidden design-style reference tokens' or '符合隐形风格规范'.",
    "Output Plan:",
    JSON.stringify(outputPlan, null, 2),
    "Return only valid JSON. No Markdown. JSON shape: {\"schemes\":[{\"title\":\"exact title from Output Plan\",\"prompt\":\"complete downstream image prompt\"}]}."
  ].join("\n");
}

function parseSchemes(rawText: string, plan: TaobaoPagePlanItem[]) {
  const jsonText = extractJsonObjectWithKey(rawText, "schemes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const schemes = (parsed as { schemes?: unknown }).schemes;
  if (!Array.isArray(schemes)) return [];
  const parsedSchemes = schemes.map((scheme): { prompt: string; title: string } | null => {
    if (!scheme || typeof scheme !== "object") return null;
    const record = scheme as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) return null;
    return {
      prompt,
      title: typeof record.title === "string" ? record.title.trim() : ""
    };
  }).filter((scheme): scheme is TaobaoPageScheme => scheme !== null);
  const used = new Set<number>();
  return plan.map((item, index): TaobaoPageScheme | null => {
    const exactIndex = parsedSchemes.findIndex((scheme, schemeIndex) => !used.has(schemeIndex) && scheme.title === item.title);
    const schemeIndex = exactIndex >= 0 ? exactIndex : parsedSchemes.findIndex((_, schemeIndex) => !used.has(schemeIndex));
    if (schemeIndex < 0) return null;
    used.add(schemeIndex);
    return {
      prompt: parsedSchemes[schemeIndex].prompt,
      title: item.title
    };
  }).filter((scheme): scheme is TaobaoPageScheme => scheme !== null);
}

function removeStyleReferenceSegments(prompt: string) {
  const boundary = "Image References|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Bilingual Text|Final Prompt|输出规格|用途|分辨率|画幅比例|目标|构图|文案";
  const pattern = new RegExp(`(?:Design\\s+Style(?:\\s*\\/\\s*Design\\s*Spec)?\\s*Reference|Style\\s*Reference|Style\\s*Reference\\s*Rule|Design\\s*Spec\\s*Reference|Downstream\\s+Generation\\s+Rule|设计规范图|风格参考图|风格参考规则|视觉规范|品牌视觉规范)\\s*[:：]\\s*[\\s\\S]*?(?=\\s*(?:${boundary})\\s*[:：]|$)`, "gi");
  return prompt
    .replace(pattern, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*(?:Design Style|Style Reference|Design Spec|Downstream Generation Rule|设计规范图|风格参考图|风格参考规则|视觉规范|品牌视觉规范)\s*[:：]/i.test(line))
    .join("\n")
    .trim();
}

function uniqueVisibleTexts(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim().replace(/^["“”']|["“”']$/g, "").trim())
    .filter((value) => Boolean(value) && !isForbiddenVisibleText(value))
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 40);
}

function isForbiddenVisibleText(value: string) {
  return [
    /<\s*Image\s*\d{1,3}\s*>/i,
    /\bImage\s*References?\b|\bImage\s+Role\s+References?\b/i,
    /\bPrimary\s+Product\s+Identity\s+Source\b/i,
    /\bProduct\s+Lock\b/i,
    /\bDesign\s+Style\s+Reference\b/i,
    /\bDownstream\s+Generation\s+Rule\b/i,
    /\bTEXT_RENDERING_RULE\b/i,
    /\bVISIBLE_TEXT_TO_RENDER\b/i,
    /\bResolution\b|\bAspect\s+Ratio\b|\bUsage\b|\bGoal\b|\bComposition\b|\bFinal\s+Prompt\b/i,
    /主产品身份来源|参考图用途|商品锁定|风格参考|设计规范|下游生成规则|文字渲染规则|画面文字清单|分辨率|画幅比例|用途|目标|构图/,
    /^[-–—]+$/
  ].some((pattern) => pattern.test(value));
}

function extractVisibleTextCandidates(prompt: string) {
  const lines = prompt.split(/\r?\n/);
  const values: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:画面文字清单|VISIBLE_TEXT_TO_RENDER|ON[-_\s]*IMAGE\s*TEXT)\s*[:：]?/i.test(trimmed)) {
      collecting = true;
      const inline = trimmed.split(/[:：]/).slice(1).join(":").trim();
      if (inline) values.push(...inline.split(/[、,，/|；;]/));
      continue;
    }
    if (collecting) {
      if (/^(?:文字渲染规则|TEXT_RENDERING_RULE|输出规格|用途|分辨率|画幅比例|目标|构图|最终生图提示|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Final Prompt)\s*[:：]/i.test(trimmed)) {
        collecting = false;
      } else {
        const bullet = trimmed.match(/^\s*[-*•]\s*["“]?(.+?)["”]?\s*$/);
        if (bullet?.[1]) values.push(bullet[1]);
        continue;
      }
    }
    const field = trimmed.match(/^(?:Bilingual Text|Visible Text|On-image Text|画面文案|文案|主标题|副标题|按钮文字)\s*[:：]\s*(.+)$/i);
    if (field?.[1]) values.push(...field[1].split(/[、,，/|；;]/));
  }
  return uniqueVisibleTexts(values);
}

function getVisibleTextRole(text: string, index: number, total: number) {
  if (total <= 1) return "主视觉文字";
  if (index === 0) return "主标题";
  if (index === 1) return "副标题或核心卖点";
  if (/^\d+(?:\.\d+)?\s*(?:cm|mm|m|L|ml|W|V|K|%|小时|分钟|天|米|厘米|毫米|升|毫升|瓦|伏)$/i.test(text)) return "参数或单位";
  if (text.length <= 6) return "卖点标签或图标说明";
  return "辅助说明文字";
}

function getVisibleTextPlacement(index: number, total: number) {
  if (index === 0) return "画面顶部主视觉标题区";
  if (index === 1) return "主标题附近的副标题区";
  if (total >= 4 && index >= total - 2) return "画面底部或信息卡辅助说明区";
  return "产品周围的信息卡、图标标签或卖点模块中";
}

function buildVisibleTextLayoutLines(texts: string[], outputLanguage: string) {
  if (outputLanguage !== "Chinese") {
    return [
      "VISIBLE_TEXT_LAYOUT:",
      ...texts.map((text, index) => `- "${text}": ${getVisibleTextRole(text, index, texts.length)}, placed in ${getVisibleTextPlacement(index, texts.length)}.`)
    ];
  }
  return [
    "画面文字布局表（VISIBLE_TEXT_LAYOUT）：",
    ...texts.map((text, index) => `- "${text}"：${getVisibleTextRole(text, index, texts.length)}，放在${getVisibleTextPlacement(index, texts.length)}。`)
  ];
}

function removeVisibleTextLayoutSection(lines: string[]) {
  const result: string[] = [];
  let removing = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:画面文字布局表|VISIBLE_TEXT_LAYOUT)\s*(?:（[^）]*）)?\s*[:：]?/i.test(trimmed)) {
      removing = true;
      continue;
    }
    if (removing) {
      if (
        trimmed &&
        !/^\s*[-*•]/.test(trimmed) &&
        /^(?:参考图用途|Image Role References|Image References|Product Lock|输出规格|用途|分辨率|画幅比例|目标|构图|最终生图提示|Usage|Resolution|Aspect Ratio|Goal|Composition|Final Prompt|Design Style Reference|Downstream Generation Rule)\s*[:：]/i.test(trimmed)
      ) {
        removing = false;
      } else {
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

function rebuildVisibleTextSection(prompt: string, item: TaobaoPagePlanItem, outputLanguage: string) {
  const lines = prompt.split(/\r?\n/);
  const values: string[] = [];
  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (start < 0 && /^(?:画面文字清单|VISIBLE_TEXT_TO_RENDER|ON[-_\s]*IMAGE\s*TEXT)\s*[:：]?/i.test(trimmed)) {
      start = index;
      end = lines.length;
      continue;
    }
    if (start >= 0) {
      if (/^(?:文字渲染规则|TEXT_RENDERING_RULE|输出规格|用途|分辨率|画幅比例|目标|构图|最终生图提示|参考图用途|Image Role References|Image References|Product Lock|Usage|Resolution|Aspect Ratio|Goal|Composition|Final Prompt|Design Style Reference|Downstream Generation Rule)\s*[:：]/i.test(trimmed)) {
        end = /^(?:文字渲染规则|TEXT_RENDERING_RULE)\s*[:：]/i.test(trimmed) ? index + 1 : index;
        break;
      }
      const bullet = trimmed.match(/^\s*[-*•]\s*["“]?(.+?)["”]?\s*$/);
      if (bullet?.[1]) values.push(bullet[1]);
    }
  }

  const visibleTexts = uniqueVisibleTexts(values.length ? values : extractVisibleTextCandidates(prompt));
  const finalTexts = visibleTexts.length ? visibleTexts : fallbackVisibleTexts(item, outputLanguage);
  const bulletLines = finalTexts.map((text) => `- "${text}"`);
  const blockLines = outputLanguage === "Chinese"
    ? [
        "画面文字清单（VISIBLE_TEXT_TO_RENDER）：",
        ...bulletLines,
        "文字渲染规则（TEXT_RENDERING_RULE）：只渲染画面文字清单中逐条列出的精确文字。不得新增任何其他文字、英文标题、英文标签、水印、logo 文字、占位文字、OCR 文字、参数文字、内部说明文字或参考图中的文字。",
        ...buildVisibleTextLayoutLines(finalTexts, outputLanguage)
      ]
    : [
        "VISIBLE_TEXT_TO_RENDER:",
        ...bulletLines,
        "TEXT_RENDERING_RULE: Render only the exact strings listed in VISIBLE_TEXT_TO_RENDER. Do not render any other text, labels, UI text, watermark, logo text, placeholder text, OCR text, parameter text, internal instruction text, or copied text from reference images.",
        ...buildVisibleTextLayoutLines(finalTexts, outputLanguage)
      ];

  if (start < 0) return ensureImageRoleReferenceSectionFromPrompt(`${blockLines.join("\n")}\n\n${prompt.trim()}`, outputLanguage);
  const before = lines.slice(0, start);
  const after = removeVisibleTextLayoutSection(lines.slice(Math.max(start + 1, end)));
  return ensureImageRoleReferenceSectionFromPrompt([...before, ...blockLines, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trim(), outputLanguage);
}

function fallbackVisibleTexts(item: TaobaoPagePlanItem, outputLanguage: string) {
  if (outputLanguage === "English") return [item.typeLabel === "对比痛点图" ? "Before vs After" : item.type];
  if (outputLanguage === "Bilingual") return [`${item.typeLabel} / ${item.type}`];
  const byType: Record<string, string[]> = {
    brandMood: ["安心生活"],
    compare: ["告别繁琐", "轻松使用"],
    detail: ["细节质感"],
    function: ["功能清晰"],
    hero: ["核心卖点"],
    lifestyle: ["居家场景"],
    sellingPoint: ["核心卖点"],
    size: ["尺寸规格"]
  };
  return byType[item.type] ?? [item.typeLabel];
}

function countVisibleTextItems(prompt: string) {
  return extractVisibleTextCandidates(prompt).filter((text) => !/^(?:无文字|No visible text)$/i.test(text)).length;
}

function minimumVisibleTextCount(item: TaobaoPagePlanItem) {
  const minimumByType: Record<string, number> = {
    brandMood: 2,
    compare: 4,
    detail: 3,
    function: 5,
    hero: 2,
    lifestyle: 2,
    sellingPoint: 5,
    size: 5
  };
  return minimumByType[item.type] ?? 2;
}

function hasWeakVisibleTextInventory(prompt: string, item: TaobaoPagePlanItem) {
  return !/["“](?:无文字|No visible text)["”]/i.test(prompt) && countVisibleTextItems(prompt) < minimumVisibleTextCount(item);
}

function ensureVisibleTextSection(prompt: string, item: TaobaoPagePlanItem, outputLanguage: string) {
  const hasVisibleTextSection = /(?:画面文字清单|VISIBLE_TEXT_TO_RENDER|ON[-_\s]*IMAGE\s*TEXT)\s*[:：]/i.test(prompt);
  const hasTextRule = /(?:文字渲染规则|TEXT_RENDERING_RULE)\s*[:：]/i.test(prompt);
  if (hasVisibleTextSection && hasTextRule) return rebuildVisibleTextSection(prompt, item, outputLanguage);

  const visibleTexts = extractVisibleTextCandidates(prompt);
  const finalTexts = visibleTexts.length ? visibleTexts : fallbackVisibleTexts(item, outputLanguage);
  const bulletLines = finalTexts.map((text) => `- "${text}"`).join("\n");
  const block = outputLanguage === "Chinese"
    ? [
        "画面文字清单（VISIBLE_TEXT_TO_RENDER）：",
        bulletLines,
        "文字渲染规则（TEXT_RENDERING_RULE）：只渲染画面文字清单中逐条列出的精确文字。不得新增任何其他文字、标签、水印、logo 文字、占位文字、OCR 文字、参数文字或参考图中的文字。"
      ].join("\n")
    : [
        "VISIBLE_TEXT_TO_RENDER:",
        bulletLines,
        "TEXT_RENDERING_RULE: Render only the exact strings listed in VISIBLE_TEXT_TO_RENDER. Do not render any other text, labels, UI text, watermark, logo text, placeholder text, OCR text, parameter text, or copied text from reference images."
      ].join("\n");
  return rebuildVisibleTextSection(`${block}\n\n${prompt.trim()}`, item, outputLanguage);
}

function getChineseRoleText(role: ImageRoleDirective, isPrimary: boolean) {
  if (role === "main") return "主产品身份来源，也是最终画面的商品主体依据。必须引用这张产品图锁定商品真实类别、外形轮廓、结构比例、颜色材质分区、透明/底座部件、开口/盖帽/连接件和关键识别细节；不得替换成相似但不同的商品。";
  if (isPrimary) return "该类别的首要参考图。按当前输出类别优先使用这张图的信息，但不得把它误当成画面文字渲染。";
  if (role === "size") return "尺寸规格参考。用于补充商品尺寸、比例、尺度关系和规格信息；不得作为画面文字渲染。";
  if (role === "structure") return "结构拆解参考。用于补充商品结构、部件、开口、盖帽、连接件和构造细节；不得替换主产品。";
  if (role === "function") return "功能说明参考。用于理解商品功能点、使用方式和操作关系；不得替换主产品。";
  if (role === "detail") return "细节材质参考。用于补充局部细节、材质质感、工艺和表面处理；不得替换主产品。";
  if (role === "scene") return "场景环境参考。只用于理解使用环境或氛围，不得覆盖主产品身份来源。";
  if (role === "package") return "包装参考。只用于包装或配件信息，不得替换主产品。";
  return "产品/结构/内容参考。用于补充商品外观、结构、尺寸、材质、局部细节或使用内容证据；不得作为画面文字渲染。";
}

function getEnglishRoleText(role: ImageRoleDirective, isPrimary: boolean) {
  if (role === "main") return "Primary Product Identity Source and product-subject evidence for the final image. Use it to lock the real product category, silhouette, geometry, proportions, color/material layout, transparent/base parts, openings, caps, connectors, and distinctive details. Do not generate a similar replacement product.";
  if (isPrimary) return "Primary reference for this output category. Prioritize this image for the current image type, but never render this role text as visible image text.";
  if (role === "size") return "Product size/spec reference. Use it to preserve dimensions, proportions, scale relationships, and specification evidence. Do not render this role text as visible image text.";
  if (role === "structure") return "Product structure reference. Use it for components, openings, caps, connectors, construction, and structure details. Do not replace the primary product.";
  if (role === "function") return "Function/usage reference. Use it to understand functional points, operation, and usage relationships. Do not replace the primary product.";
  if (role === "detail") return "Detail/material reference. Use it for close-up details, material feel, process, and surface finish. Do not replace the primary product.";
  if (role === "scene") return "Scene/environment reference. Use it only for usage environment or mood. It must not override the Primary Product Identity Source.";
  if (role === "package") return "Package reference. Use it only for packaging or accessory evidence. Do not replace the primary product.";
  return "Product / structure / content reference. Use it only as supporting visual evidence for appearance, structure, size, material, detail, or usage content. Do not render this role text as visible image text.";
}

function buildImageRoleReferenceSection(labels: string[], outputLanguage: string, roleByLabel = new Map<string, ImageRoleDirective>()) {
  if (!labels.length) return "";
  return outputLanguage === "Chinese"
    ? [
        "参考图用途（不渲染为画面文字）：",
        ...labels.map((label, labelIndex) => `${displayImageLabel(label)}：${getChineseRoleText(roleByLabel.get(label) ?? "support", labelIndex === 0)}`),
        "以上参考图用途说明只给下游生图节点理解图片角色，绝对不渲染到最终画面。"
      ].join("\n")
    : [
        "Image Role References (not visible text):",
        ...labels.map((label, labelIndex) => `${displayImageLabel(label)}: ${getEnglishRoleText(roleByLabel.get(label) ?? "support", labelIndex === 0)}`),
        "This image-role section is for downstream generation understanding only and must never be rendered as final on-image text."
      ].join("\n");
}

function ensureImageRoleReferenceSection(prompt: string, labels: string[], outputLanguage: string, roleByLabel = new Map<string, ImageRoleDirective>()) {
  if (!labels.length) return prompt;
  const hasSection = outputLanguage === "Chinese"
    ? /参考图用途/i.test(prompt)
    : /Image Role References/i.test(prompt);
  if (hasSection) return prompt;
  return `${buildImageRoleReferenceSection(labels, outputLanguage, roleByLabel)}\n\n${prompt.trim()}`;
}

function removeImageRoleReferenceSection(prompt: string) {
  const boundary = [
    "画面文字清单",
    "VISIBLE_TEXT_TO_RENDER",
    "ON[-_\\s]*IMAGE\\s*TEXT",
    "文字渲染规则",
    "TEXT_RENDERING_RULE",
    "画面文字布局表",
    "VISIBLE_TEXT_LAYOUT",
    "商品锁定",
    "Product Lock",
    "输出规格",
    "用途",
    "分辨率",
    "画幅比例",
    "目标",
    "构图",
    "最终生图提示",
    "Usage",
    "Resolution",
    "Aspect Ratio",
    "Goal",
    "Composition",
    "Final Prompt",
    "Design Style Reference",
    "Downstream Generation Rule"
  ].join("|");
  return prompt
    .replace(new RegExp(`(?:参考图用途|Image Role References|Image References)(?:（[^）]*）|\\([^)]*\\))?\\s*[:：][\\s\\S]*?(?=\\n\\s*(?:${boundary})(?:（[^）]*）|\\([^)]*\\))?\\s*[:：]|$)`, "gi"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function forceImageRoleReferenceSection(prompt: string, labels: string[], outputLanguage: string, roleByLabel = new Map<string, ImageRoleDirective>()) {
  if (!labels.length) return prompt;
  const roleSection = buildImageRoleReferenceSection(labels, outputLanguage, roleByLabel);
  return `${roleSection}\n\n${removeImageRoleReferenceSection(prompt)}`.trim();
}

function inferContentReferenceLabelsFromPrompt(prompt: string) {
  const labels: string[] = [];
  prompt.split(/\r?\n/).forEach((line) => {
    if (/Design Style Reference|Downstream Generation Rule|风格参考|设计规范|视觉规范/i.test(line)) return;
    for (const match of line.matchAll(/<\s*Image\s*(\d{1,3})\s*>/gi)) {
      const label = `<Image${String(Number(match[1])).padStart(3, "0")}>`;
      if (!labels.includes(label)) labels.push(label);
    }
  });
  return labels;
}

function ensureImageRoleReferenceSectionFromPrompt(prompt: string, outputLanguage: string) {
  if (/参考图用途|Image Role References/i.test(prompt)) return prompt;
  return ensureImageRoleReferenceSection(prompt, inferContentReferenceLabelsFromPrompt(prompt), outputLanguage);
}

function applyPlanFacts(
  schemes: TaobaoPageScheme[],
  plan: TaobaoPagePlanItem[],
  styleReferenceLabels: string[] = [],
  contentReferenceLabels: string[] = [],
  outputLanguage = "Chinese",
  roleByLabel = new Map<string, ImageRoleDirective>()
) {
  return schemes.map((scheme, index) => {
    const item = plan[index];
    const promptLabels = Array.from(scheme.prompt.matchAll(/<\s*Image\s*(\d{1,3})\s*>/gi))
      .map((match) => `<Image${String(Number(match[1])).padStart(3, "0")}>`)
      .filter((label, labelIndex, labels) => labels.indexOf(label) === labelIndex && !styleReferenceLabels.includes(label));
    const effectiveContentReferenceLabels = orderContentLabelsByRole(contentReferenceLabels.length ? contentReferenceLabels : promptLabels, roleByLabel);
    const requiredBlock = [
      "输出规格：",
      `用途：${item.usage}`,
      `分辨率：${item.width}×${item.height} px`,
      `画幅比例：${item.aspectRatio}`,
      "构图必须原生适配该尺寸，不依赖后期裁切。"
    ].join("\n");
    const styleReferenceBlock = styleReferenceLabels.length
      ? [
          `Design Style Reference: ${styleReferenceLabels.map(displayImageLabel).join(", ")}`,
          `Downstream Generation Rule: ${styleReferenceLabels.map(displayImageLabel).join(", ")} is a hidden design-style/design-standard reference for the image-generation node. Use it only to extract abstract design guidance: color palette, spacing, typography mood, layout rhythm, information hierarchy, icon/card/table style, border/radius language, and e-commerce visual quality. Do not render, recreate, crop, place, copy, OCR, quote, or use any product, text, logo, brand, person, picture asset, background, section layout, or concrete content from ${styleReferenceLabels.map(displayImageLabel).join(", ")}.`
        ].join("\n")
      : "";
    const productReferenceBlock = buildImageRoleReferenceSection(effectiveContentReferenceLabels, outputLanguage, roleByLabel);
    const productLockBlock = outputLanguage === "Chinese"
      ? "商品锁定：严格。必须以参考图用途中的主产品身份来源为唯一商品主体，保留同一产品类别、外形轮廓、结构比例、颜色材质分区、透明/底座部件、开口/盖帽/连接件和关键识别细节；不得生成相似替代品或其它灯具。"
      : "Product Lock: Strict. Use the Primary Product Identity Source in Image Role References as the only allowed product subject. Preserve the same product category, silhouette, geometry, proportions, color/material layout, transparent/base parts, openings, caps, connectors, and distinctive details. Do not generate a similar replacement product or another lamp.";
    const hasSize = scheme.prompt.includes(`${item.width}×${item.height}`) || scheme.prompt.includes(`${item.width}x${item.height}`);
    const cleanedPrompt = styleReferenceLabels.length ? removeStyleReferenceSegments(scheme.prompt) : scheme.prompt.trim();
    const prefix = [
      hasSize ? "" : requiredBlock,
      /(?:商品锁定|Product Lock)\s*[:：]/i.test(cleanedPrompt) ? "" : productLockBlock,
      productReferenceBlock,
      styleReferenceBlock
    ].filter(Boolean).join("\n\n");
    const promptWithFacts = forceImageRoleReferenceSection(prefix ? `${prefix}\n\n${cleanedPrompt}` : cleanedPrompt, effectiveContentReferenceLabels, outputLanguage, roleByLabel);
    const promptWithVisibleText = ensureVisibleTextSection(promptWithFacts, item, outputLanguage);
    return {
      ...scheme,
      prompt: forceImageRoleReferenceSection(promptWithVisibleText, effectiveContentReferenceLabels, outputLanguage, roleByLabel)
    };
  });
}

function isBadPrompt(prompt: string, item: TaobaoPagePlanItem) {
  if (prompt.length < 120) return true;
  if (!/<Image\d{3}>/.test(prompt)) return true;
  if (!/@Image\s*\d{3}/i.test(prompt)) return true;
  if (countUniqueAtImageReferences(prompt) > maxPromptReferenceLabels) return true;
  if (!prompt.includes(`${item.width}×${item.height}`) && !prompt.includes(`${item.width}x${item.height}`)) return true;
  if (!/VISIBLE_TEXT_TO_RENDER|画面文字清单|ON[-_\s]*IMAGE\s*TEXT/i.test(prompt)) return true;
  return [
    /淘宝|Taobao|电商|e-commerce|商品页|主图|详情页/i,
    /分辨率|resolution|尺寸|size|aspect ratio|画幅/i,
    /商品|product|主体|main item/i,
    /构图|composition|layout|版式/i
  ].some((pattern) => !pattern.test(prompt));
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TaobaoPageDirectorRequest;
    const images = (body.images ?? [])
      .filter((image): image is { imageNumber?: number; title?: string; url: string } => typeof image.url === "string" && Boolean(image.url))
      .slice(0, maxPlannerImages);
    const instruction = body.instruction?.trim() ?? "";
    if (!images.length) {
      return NextResponse.json({ error: "请先连接商品 Image 图框。" }, { status: 400 });
    }
    if (!instruction) {
      return NextResponse.json({ error: "请先连接淘宝图片页说明 Prompt。" }, { status: 400 });
    }

    const plan = buildPlan(body.params);
    if (!plan.length) {
      return NextResponse.json({ error: "8 类图张数不能全部为 0。" }, { status: 400 });
    }
    if (plan.length > 40) {
      return NextResponse.json({ error: "单次输出图片页 Prompt 不能超过 40 个，请降低部分类型张数。" }, { status: 400 });
    }

    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const settings = await readSettings(model);
    if (!settings.apiKey || !settings.baseUrl) {
      return NextResponse.json({ error: isAgnesTextModel(model) ? "请先在设置里保存 Agnes 服务地址和 API Key。" : "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });
    }
    const outputLanguage = normalizeLanguage(body.params?.outputLanguage);
    const instructionText = buildInstruction(body, images, plan);
    const allStyleReferenceLabels = extractStyleReferenceLabels(instruction, images);
    const imageRoleDirectives = extractImageRoleDirectives(instruction, images);
    const allContentReferenceLabels = orderContentLabelsByRole(images
      .map((image, index) => `<Image${String(Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1).padStart(3, "0")}>`)
      .filter((label) => !allStyleReferenceLabels.includes(label)), imageRoleDirectives);
    const selectedReferenceLabels = selectPromptReferenceLabels(allContentReferenceLabels, allStyleReferenceLabels, imageRoleDirectives, plan[0]?.type ?? "hero");
    const contentReferenceLabels = selectedReferenceLabels.content;
    const styleReferenceLabels = selectedReferenceLabels.style;
    const imageParts = await Promise.all(images.map(async (image, index) => {
      const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
      const text = `<Image${String(number).padStart(3, "0")}>`;
      return [
        {
          type: "text",
          text
        },
        {
          type: "image_url",
          image_url: {
            url: await toPlannerChatImageUrl(image.url)
          }
        }
      ];
    }));
    let nativeImageParts: Array<{ inlineData: { data: string; mimeType: string }; text: string }> | null = null;

    let lastPayload: unknown = null;
    let lastStatus = 200;
    let lastResponseOk = false;
    let schemes: TaobaoPageScheme[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: attempt === 0
                    ? instructionText
                    : `${instructionText}\n\n${getRetryInstruction(outputLanguage, plan.length)}\nUse the exact titles from the Output Plan and include each exact resolution.`
                },
                ...imageParts.flat()
              ]
            }
          ],
          temperature: attempt === 0 ? 0.45 : 0.25
        }),
        headers: {
          "Authorization": `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json"
        },
        method: "POST",
        signal: AbortSignal.timeout(180000)
      });

      lastPayload = await response.json().catch(() => null) as unknown;
      lastStatus = response.status;
      lastResponseOk = response.ok;
      let candidateText = "";
      if (!response.ok && shouldRetryWithGeminiNative(model, lastPayload)) {
        nativeImageParts ??= await Promise.all(images.map(async (image, index) => {
          const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
          return {
            inlineData: await toPlannerInlineData(image.url),
            text: `<Image${String(number).padStart(3, "0")}>`
          };
        }));
        const native = await runGeminiNativePlanning({
          attempt,
          imageParts: nativeImageParts,
          instructionText,
          model,
          outputLanguage,
          plan,
          settings
        });
        lastPayload = native.payload;
        lastStatus = native.status;
        lastResponseOk = native.ok;
        candidateText = native.text;
      }
      if (!lastResponseOk) break;

      const outputText = candidateText || getChatCompletionText(lastPayload) || getCandidateText(lastPayload);
      schemes = applyPlanFacts(parseSchemes(outputText, plan), plan, styleReferenceLabels, contentReferenceLabels, outputLanguage, imageRoleDirectives);
      const hasCriticalFailure = schemes.length !== plan.length || schemes.some((scheme, index) => isBadPrompt(scheme.prompt, plan[index]));
      const hasWeakVisibleText = schemes.some((scheme, index) => hasWeakVisibleTextInventory(scheme.prompt, plan[index]));
      if (!hasCriticalFailure && (!hasWeakVisibleText || attempt >= 1)) break;
    }

    if (!lastResponseOk) {
      return NextResponse.json({ error: getProviderError(lastPayload, lastStatus) }, { status: lastStatus });
    }
    schemes = applyPlanFacts(schemes, plan, styleReferenceLabels, contentReferenceLabels, outputLanguage, imageRoleDirectives);
    if (schemes.length !== plan.length || schemes.some((scheme, index) => isBadPrompt(scheme.prompt, plan[index]))) {
      return NextResponse.json({ error: `Taobao Page Director 输出没有满足 ${plan.length} 个图片页 Prompt 要求，请重试。` }, { status: 502 });
    }

    return NextResponse.json({
      prompt: schemes.map((scheme) => `${scheme.title}：${scheme.prompt}`).join("\n\n"),
      schemes,
      debug: {
        imageCount: images.length,
        model,
        outputCount: plan.length
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Taobao Page Director 生成失败。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
