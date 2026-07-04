import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type ApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface SceneDirectorRequest {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number; url?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
  sourceNodeId?: string;
}

interface SceneDirectorScheme {
  prompt: string;
  title?: string;
}

interface DimensionFact {
  normalized: string;
  source: string;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");
const defaultModel = "gemini-2.5-flash";

function normalizeBaseRoot(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "root");
}

function normalizeSchemeCount(value: unknown) {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(10, Math.max(1, parsed));
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

async function toInlineData(imageUrl: string) {
  const source = await imageSourceForTask(imageUrl);
  const dataUrl = source.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrl) {
    return {
      data: dataUrl[2].replace(/\s/g, ""),
      mimeType: dataUrl[1]
    };
  }

  const response = await fetch(assertSafeRemoteFetchUrl(source), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`参考图读取失败：${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    data: buffer.toString("base64"),
    mimeType
  };
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

function getSceneDirectorPlanningModel(model: string) {
  return model;
}

async function toChatImageUrl(imageUrl: string) {
  return imageSourceForTask(imageUrl);
}

async function runGeminiNativePlanning({
  attempt,
  imageParts,
  instructionText,
  model,
  schemeCount,
  settings
}: {
  attempt: number;
  imageParts: Array<{ inlineData: { data: string; mimeType: string }; text: string }>;
  instructionText: string;
  model: string;
  schemeCount: number;
  settings: ApiSettings;
}) {
  const retryText = `${instructionText}\n\nPrevious output was invalid. Return only valid JSON with exactly ${schemeCount} schemes. Every prompt must keep <Image001>-style references and include scene, lighting, camera language, creative direction, rendering requirements, and final prompt.`;
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
        temperature: attempt === 0 ? 0.55 : 0.3
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

function formatProviderError(model: string, payload: unknown, status: number) {
  const message = getProviderError(payload, status);
  if (message === "openai_error") {
    return `${model} 当前在 12AI 服务返回 openai_error。已测试该模型纯文本/图片请求均失败，请先切换 gemini-2.5-flash，或检查 12AI 模型是否已开放。`;
  }
  return message;
}

function shouldRetryWithGeminiNative(model: string, payload: unknown) {
  const providerError = getProviderError(payload, 502).toLowerCase();
  return model.toLowerCase().startsWith("gemini-") && /openai_error|invalid.*image|vision|multimodal|content/i.test(providerError);
}

function readCaughtError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof Error && error.name === "AbortError") {
    return "Scene Director 生成超时，请稍后重试。";
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timeout/i.test(message)) {
    return "AI 服务连接失败，请检查设置里的服务地址、API Key 或网络后重试。";
  }
  return message || "Scene Director 生成失败。";
}

function normalizeLanguage(value?: string) {
  if (value === "中文") return "Chinese";
  if (value === "英文") return "English";
  if (value === "中英双语") return "Bilingual";
  if (value === "English" || value === "Bilingual") return value;
  return "Chinese";
}

function normalizeOption(value: string | undefined, fallback: string, translations: Record<string, string>) {
  if (!value?.trim()) return fallback;
  return translations[value] ?? value;
}

function normalizeWeight(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, parsed));
}

function extractDimensionFacts(instruction: string): DimensionFact[] {
  const facts: DimensionFact[] = [];
  const seen = new Set<string>();
  const clauses = instruction
    .slice(0, 20000)
    .split(/[。\n\r；;]/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, 300);
  const compactSizePattern = /\d+(?:\.\d+)?\s*(?:x|×|\*)\s*\d+(?:\.\d+)?\s*(?:x|×|\*)\s*\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米|in|inch|inches|英寸)\b/gi;
  const pairedSizePattern = /(?:长|宽|高|高度|直径|厚度|depth|width|height|diameter|length)\s*[:：为是约大概approximately approx.]*\s*\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米|in|inch|inches|英寸)\b/gi;
  clauses.forEach((clause) => {
    const hasDimensionContext = /尺寸|大小|长宽高|比例|scale|dimension|size|height|width|depth|diameter|length|mm|毫米|cm|厘米|英寸|inch/i.test(clause);
    if (!hasDimensionContext) return;
    const matches = [
      ...(clause.match(compactSizePattern) ?? []),
      ...(clause.match(pairedSizePattern) ?? [])
    ];
    matches.forEach((match) => {
      const normalized = match
        .replace(/\s+/g, "")
        .replace(/[×*]/g, "x")
        .replace(/毫米/gi, "mm")
        .replace(/厘米/gi, "cm")
        .replace(/英寸/gi, "in");
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      facts.push({
        normalized,
        source: clause
      });
    });
  });
  return facts.slice(0, 8);
}

function formatDimensionFacts(facts: DimensionFact[]) {
  if (!facts.length) return "";
  return facts.map((fact) => fact.normalized).join(", ");
}

function getUserDefinedRoleFromContext(context: string) {
  if (/主图|主产品|main\s*product|hero\s*product|product\s*source/i.test(context)) return "Main Product";
  if (/结构|structure|造型|形体|geometry/i.test(context)) return "Structure Reference";
  if (/尺寸|size|scale|比例|dimension/i.test(context)) return "Size Reference";
  if (/场景|scene|environment|setting|background|背景|空间/i.test(context)) return "Scene Reference";
  if (/风格|style|mood|氛围|cmf/i.test(context)) return "Style Reference";
  return "";
}

function extractUserImageRoles(instruction: string) {
  const roles = new Map<string, string>();
  const mentionPattern = /(?:<\s*Image\s*(\d{1,3})\s*>|@\s*(?:Image\s*)?0*(\d{1,3})\b)/gi;
  const clauses = instruction
    .slice(0, 20000)
    .split(/[。\n\r；;]/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, 300);

  clauses.forEach((clause) => {
    const role = getUserDefinedRoleFromContext(clause.slice(0, 240));
    if (!role) return;
    for (const match of clause.matchAll(mentionPattern)) {
      const number = Number(match[1] ?? match[2]);
      if (!Number.isInteger(number) || number < 1) continue;
      const imageLabel = `<Image${String(number).padStart(3, "0")}>`;
      const current = roles.get(imageLabel);
      if (current === "Main Product") continue;
      roles.set(imageLabel, role);
    }
  });
  return roles;
}

function buildSceneDirectorInstruction(body: SceneDirectorRequest, images: Array<{ imageNumber?: number; url: string }>) {
  const params = body.params ?? {};
  const schemes = normalizeSchemeCount(params.schemes);
  const outputLanguage = normalizeLanguage(params.outputLanguage);
  const productLock = normalizeOption(params.productLock, "Strict", { 严格: "Strict", 灵活: "Flexible" });
  const cameraLock = normalizeOption(params.cameraLock, "Strict", { 严格: "Strict", 灵活: "Flexible" });
  const promptStyle = normalizeOption(params.promptStyle, "Director Mode", { 导演模式: "Director Mode", 精简: "Compact", 详细: "Detailed" });
  const photographyStyle = normalizeOption(params.photographyStyle, "Lifestyle", { 奢华: "Luxury", 户外: "Outdoor", 电商: "E-commerce", 编辑大片: "Editorial", 酒店空间: "Hospitality", 生活方式: "Lifestyle" });
  const lensDirection = normalizeOption(params.lensDirection, "Auto", { 微距: "Macro", 自动: "Auto" });
  const lightingPreset = normalizeOption(params.lightingPreset, "Natural Daylight", { 奢华酒店: "Luxury Hotel", 夜间氛围: "Night Ambience", 柔光棚拍: "Studio Softbox", 自然日光: "Natural Daylight", 黄金时刻: "Golden Hour" });
  const schemeDiversity = normalizeOption(params.schemeDiversity, "High", { 中: "Medium", 低: "Low", 高: "High" });
  const structureWeight = normalizeWeight(params.structureWeight, 70);
  const sizeWeight = normalizeWeight(params.sizeWeight, 80);
  const styleWeight = normalizeWeight(params.styleWeight, 90);
  const sceneWeight = normalizeWeight(params.sceneWeight, 90);
  const dimensionFacts = extractDimensionFacts(body.instruction ?? "");
  const dimensionFactsText = formatDimensionFacts(dimensionFacts);
  const imageLabels = images.map((image, index) => {
    const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
    return `<Image${String(number).padStart(3, "0")}>`;
  });
  const userImageRoles = extractUserImageRoles(body.instruction ?? "");
  const userRoleRows = imageLabels
    .map((label) => ({ label, role: userImageRoles.get(label) }))
    .filter((item): item is { label: string; role: string } => Boolean(item.role));
  const userMainImage = userRoleRows.find((item) => item.role === "Main Product")?.label;
  const mainImageLabel = userMainImage ?? imageLabels[0] ?? "<Main Product>";
  const sceneAdaptationRules = cameraLock === "Strict"
    ? [
        `Scene perspective lock: every scene must adapt to ${mainImageLabel} / <Main Product>, not the other way around.`,
        "The background, support surface, horizon line, props, shadows, reflections, and environmental perspective must be built around the main product's original angle and perspective.",
        "If the target scene conflicts with the main product perspective, rewrite the scene so the environment matches the product perspective. The scene is flexible; the main product camera angle is fixed."
      ]
    : [
        "Flexible scene perspective: the scene may use a mildly optimized composition and camera relationship when it improves realism, as long as the product remains clearly derived from the main reference."
      ];
  const productIntegrityRules = productLock === "Strict"
    ? [
        "Strict product integrity: never modify the main product to fit a scene. Never redraw it, simplify it, replace parts, change proportions, change silhouette, change material layout, or alter product details.",
        "The generated prompt must tell the image model to keep the source product unchanged and compose the scene around the existing product."
      ]
    : [
        "Flexible product integrity: subtle refinements are allowed for lighting integration, material realism, cleanliness, and scene fit, but the product must remain recognizable as the same design and must not become a different product."
      ];
  const strictProductCameraLock = productLock === "Strict" && cameraLock === "Strict";
  const strictProductCameraRules = strictProductCameraLock
    ? [
        "Highest-priority double strict lock: Product Lock = Strict and Camera Lock = Strict.",
        `Use ${mainImageLabel} / <Main Product> as the exact product geometry, angle, and perspective source. This rule overrides scene creativity, photography presets, and composition optimization.`,
        "The generated prompt must instruct the image model to preserve the main product's exact camera angle and exact perspective from the source image, not an approximate similar angle.",
        "Do not rotate, straighten, front-face, side-face, tilt, re-pose, re-scale disproportionately, re-crop, or reinterpret the product. Do not change the visible top/side/front face proportions.",
        "Only the surrounding environment, support surface, lighting integration, and background may change. The product must read as the same object photographed from the same viewpoint."
      ]
    : [];
  const strictCameraRules = cameraLock === "Strict"
    ? [
        `Strict main-product view lock: treat ${mainImageLabel} / <Main Product> as the unrotatable camera-angle anchor.`,
        "The product in the final scene must keep the same yaw, pitch, roll, viewing angle, perspective, visible faces, top ellipse/visible top surface ratio, front/side visibility ratio, vertical axis, silhouette, and crop relationship as the main product image.",
        "Do not turn the product to a frontal view, do not lower or raise the camera angle, do not recompose the product as a new render, and do not infer a different hero angle from the target scene.",
        "When placing the product into a lifestyle scene, change the environment only. Re-light and integrate the object, but preserve the original product camera orientation exactly."
      ]
    : [
        "Flexible camera lock: preserve the main product identity and general viewing language, while allowing mild composition optimization."
      ];
  return [
    "You are Scene Director, a senior commercial photography and product-scene prompt planner.",
    "You only write prompt packs. You never generate images.",
    `Generate exactly ${schemes} different scene prompts for downstream image generation.`,
    `Output Language: ${outputLanguage}.`,
    "Image Role Rule: user-defined image roles in the connected Prompt are authoritative. Do not reinterpret them. Only infer missing roles when the connected Prompt does not define them.",
    `Product Lock: ${productLock}. Strict means preserve product structure, appearance, color, and proportions. Flexible means subtle product-adjacent optimization is allowed.`,
    `Camera Lock: ${cameraLock}. Strict means preserve main product viewing angle, perspective, and lens language. Flexible means composition may be optimized.`,
    `Prompt Style: ${promptStyle}.`,
    `Photography Style: ${photographyStyle}.`,
    `Lens Direction: ${lensDirection}. If Auto, infer focal length tendency, camera height, perspective, and depth of field from the main product image.`,
    `Lighting Preset: ${lightingPreset}.`,
    `Scheme Diversity: ${schemeDiversity}.`,
    `Reference Weights (0-100): Structure Ref ${structureWeight}, Size Ref ${sizeWeight}, Style Ref ${styleWeight}, Scene Ref ${sceneWeight}.`,
    dimensionFactsText
      ? `Explicit user product dimensions / scale facts that must be preserved verbatim in every output prompt: ${dimensionFactsText}.`
      : "Explicit user product dimensions / scale facts: none detected.",
    "Scene Perspective Adaptation Rule:",
    ...sceneAdaptationRules,
    "Product Integrity Rule:",
    ...productIntegrityRules,
    strictProductCameraLock ? "Double Strict Product + Camera Lock:" : "",
    ...strictProductCameraRules,
    "Main Product View Lock:",
    ...strictCameraRules,
    "Available image references:",
    imageLabels.join(", "),
    userRoleRows.length
      ? ["User-defined image roles from the connected Prompt. These are authoritative and must override auto role detection:", ...userRoleRows.map((item) => `${item.role}: ${item.label}`)].join("\n")
      : "User-defined image roles: none detected. If Role Detection is Auto, infer roles carefully; if Manual, follow only the user's text.",
    body.instruction?.trim() ? `User direction:\n${body.instruction.trim()}` : "User direction: none.",
    "Each generated prompt must preserve image references exactly in angle brackets, such as <Image001>, plus role aliases when helpful, such as <Main Product>, <Style Ref>, <Scene Ref>.",
    "Every prompt must include an Image References section with an explicit one-image-per-line role mapping. Do not put multiple references on one line.",
    "Use this exact style when roles are known: Main Product: <Image###>; Structure Reference: <Image###>; Size Reference: <Image###>; Style Reference: <Image###>; Scene Reference: <Image###>.",
    "If a user says one image is the main image, never list any other image as Main Product. If a user says one image is a scene reference, mark it as Scene Reference only.",
    productLock === "Strict" || cameraLock === "Strict"
      ? "When Product Lock or Camera Lock is Strict, final downstream image prompts must treat Structure Reference and Size Reference as planning-only information, not final visual product sources. The Main Product image is the only visual source for the product."
      : "When locks are Flexible, structure and size references may guide mild product refinement, but they still must not replace a user-defined Main Product.",
    "Every prompt must include: image references, product lock, scene description, lighting description, camera language, creative direction, rendering requirements, and final prompt.",
    "Every prompt must include a Reference Weight section that explicitly states and applies Structure Ref, Size Ref, Style Ref, and Scene Ref weights.",
    dimensionFactsText
      ? "Every prompt must include a Product Dimensions / Scale section. It must copy the explicit user dimensions exactly and use them to adapt scene scale, surface size, tabletop footprint, object clearance, camera distance, contact shadow size, and surrounding prop proportions."
      : "If the user provides product dimensions, every prompt must include a Product Dimensions / Scale section and apply it to scene scale, tabletop footprint, camera distance, and prop proportions.",
    dimensionFactsText
      ? `Every final prompt must state this exact dimension fact without omission or conversion: ${dimensionFactsText}.`
      : "",
    cameraLock === "Strict" ? "Every prompt must include a Scene Adaptation section that explicitly says: the scene, props, ground plane, shadows, and background perspective must adapt to the main product angle and perspective." : "Every prompt may allow flexible scene perspective when useful, but must explain any camera/composition flexibility clearly.",
    productLock === "Strict" ? "Every prompt must explicitly say the main product is unchanged: no redraw, no replacement, no proportion changes, no silhouette changes, and no material-layout changes." : "Every prompt may allow subtle product refinements for realism and scene fit, while preserving the same product identity.",
    strictProductCameraLock ? "Every prompt must include a Double Strict Lock section that explicitly says: preserve the exact main product angle and exact perspective from <Main Product>; do not rotate, front-face, side-face, tilt, or reinterpret the product." : "",
    "Every prompt must include a Product View Lock section that explicitly says to maintain the exact original product viewing angle, yaw, pitch, roll, perspective, silhouette, visible faces, and top/front/side proportions from <Main Product>.",
    "Every prompt must include a Scene Integration section: the product must look physically present in the scene, not pasted onto the background.",
    "Scene Integration must require matching scene lighting direction, color temperature, contrast, exposure, shadow softness, contact shadows, ambient occlusion, surface reflections, bounce light, local color spill, correct grounding, correct scale, and natural occlusion.",
    "Scene Integration must explicitly forbid cutout edges, halo, flat studio lighting, isolated white-background look, and product/background mismatch.",
    "Each prompt must contain clear camera language, for example focal length, perspective, depth of field, and an explicit instruction to maintain the exact original viewing angle.",
    "Each prompt must contain clear lighting language and a scene concept.",
    "Never remove image references. Never replace references with vague phrases like 'the first image'.",
    "Do not add negative prompts. Do not add image-generation parameters. Do not mention internal API or provider names.",
    "Return only valid JSON. No Markdown. JSON shape: {\"schemes\":[{\"title\":\"short title\",\"prompt\":\"complete downstream image prompt\"}]}."
  ].join("\n");
}

function parseSchemes(rawText: string, expectedCount: number): SceneDirectorScheme[] {
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
  return schemes.slice(0, expectedCount).map((scheme, index): SceneDirectorScheme | null => {
    if (!scheme || typeof scheme !== "object") return null;
    const record = scheme as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) return null;
    return {
      prompt,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : `Scene ${String(index + 1).padStart(2, "0")}`
    };
  }).filter((scheme): scheme is SceneDirectorScheme => scheme !== null);
}

function applyDimensionFactsToSchemes(schemes: SceneDirectorScheme[], facts: DimensionFact[]) {
  const factsText = formatDimensionFacts(facts);
  if (!factsText) return schemes;
  const factTokens = facts.map((fact) => fact.normalized.toLowerCase());
  return schemes.map((scheme) => {
    const promptLower = scheme.prompt.toLowerCase().replace(/[×*]/g, "x").replace(/\s+/g, "");
    const hasEveryFact = factTokens.every((fact) => promptLower.includes(fact.replace(/\s+/g, "")));
    if (hasEveryFact && /Product Dimensions|产品尺寸|尺寸|scale|比例/i.test(scheme.prompt)) return scheme;
    const dimensionSection = [
      "Product Dimensions / Scale:",
      `The main product dimensions are ${factsText}.`,
      "Use these exact dimensions to set realistic scene scale: tabletop footprint, clearance around props, camera distance, contact-shadow size, support-surface size, surrounding object proportions, and product-to-environment ratio must all adapt to this real product size."
    ].join("\n");
    return {
      ...scheme,
      prompt: `${scheme.prompt.trim()}\n\n${dimensionSection}`
    };
  });
}

function isBadScenePrompt(prompt: string, params?: Record<string, string>, dimensionFacts: DimensionFact[] = []) {
  if (prompt.length < 100) return true;
  if (!/<Image\d{3}>/.test(prompt)) return true;
  const productLock = normalizeOption(params?.productLock, "Strict", { 严格: "Strict", 灵活: "Flexible" });
  const cameraLock = normalizeOption(params?.cameraLock, "Strict", { 严格: "Strict", 灵活: "Flexible" });
  const requiredSignals = [
    /scene|场景|environment|空间|室内|户外|living|hotel|office|terrace|studio/i,
    /light|lighting|光|shadow|daylight|softbox|golden/i,
    /camera|lens|mm|perspective|depth of field|镜头|焦段|透视|景深/i,
    /product|产品|structure|appearance|color|proportion|外观|比例/i
  ];
  if (cameraLock === "Strict") {
    requiredSignals.push(/view lock|viewing angle|original angle|perspective|yaw|pitch|roll|visible faces|silhouette|视角锁定|原始视角|透视|可见面|轮廓|scene adaptation|场景适配/i);
  }
  if (productLock === "Strict") {
    requiredSignals.push(/unchanged|do not modify|no redraw|no replacement|same product|preserve|保持不变|不得修改|不重绘|不替换|同一产品|保持/i);
  }
  if (dimensionFacts.length) {
    const normalizedPrompt = prompt.toLowerCase().replace(/[×*]/g, "x").replace(/\s+/g, "");
    if (dimensionFacts.some((fact) => !normalizedPrompt.includes(fact.normalized.toLowerCase().replace(/\s+/g, "")))) return true;
  }
  return requiredSignals.some((pattern) => !pattern.test(prompt));
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SceneDirectorRequest;
    const images = (body.images ?? []).filter((image): image is { imageNumber?: number; url: string } => typeof image.url === "string" && Boolean(image.url));
    const instruction = body.instruction?.trim() ?? "";
    if (!images.length) {
      return NextResponse.json({ error: "请先连接 Image 图框。" }, { status: 400 });
    }
    if (!instruction) {
      return NextResponse.json({ error: "请先连接导演说明 Prompt。" }, { status: 400 });
    }

    const rawModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const model = getBaseModelId(rawModel) ?? defaultModel;
    const settings = await readSettings(rawModel, body.aiSettings);
    if (!settings.apiKey || !settings.baseUrl) {
      return NextResponse.json({ error: isAgnesTextModel(model) ? "请先在设置里保存 Agnes 服务地址和 API Key。" : "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });
    }
    const planningModel = getSceneDirectorPlanningModel(model);
    const schemeCount = normalizeSchemeCount(body.params?.schemes);
    const dimensionFacts = extractDimensionFacts(instruction);
    const instructionText = buildSceneDirectorInstruction(body, images);
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
            url: await toChatImageUrl(image.url)
          }
        }
      ];
    }));
    const nativeImageParts = await Promise.all(images.map(async (image, index) => {
      const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
      return {
        inlineData: await toInlineData(image.url),
        text: `<Image${String(number).padStart(3, "0")}>`
      };
    }));

    let lastPayload: unknown = null;
    let lastStatus = 200;
    let lastResponseOk = false;
    let schemes: SceneDirectorScheme[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          model: planningModel,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: attempt === 0
                    ? instructionText
                    : `${instructionText}\n\nPrevious output was invalid. Return only valid JSON with exactly ${schemeCount} schemes. Every prompt must keep <Image001>-style references and include scene, lighting, camera language, creative direction, rendering requirements, and final prompt.`
                },
                ...imageParts.flat()
              ]
            }
          ],
          temperature: attempt === 0 ? 0.55 : 0.3
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
      if (!response.ok && shouldRetryWithGeminiNative(planningModel, lastPayload)) {
        const native = await runGeminiNativePlanning({
          attempt,
          imageParts: nativeImageParts,
          instructionText,
          model: planningModel,
          schemeCount,
          settings
        });
        lastPayload = native.payload;
        lastStatus = native.status;
        lastResponseOk = native.ok;
        candidateText = native.text;
      }
      if (!lastResponseOk) break;

      const outputText = candidateText || getChatCompletionText(lastPayload) || getCandidateText(lastPayload);
      schemes = applyDimensionFactsToSchemes(parseSchemes(outputText, schemeCount), dimensionFacts);
      if (schemes.length === schemeCount && schemes.every((scheme) => !isBadScenePrompt(scheme.prompt, body.params, dimensionFacts))) break;
    }

    if (!lastResponseOk) {
      return NextResponse.json({ error: formatProviderError(planningModel, lastPayload, lastStatus) }, { status: lastStatus });
    }
    schemes = applyDimensionFactsToSchemes(schemes, dimensionFacts);
    if (schemes.length !== schemeCount || schemes.some((scheme) => isBadScenePrompt(scheme.prompt, body.params, dimensionFacts))) {
      return NextResponse.json({ error: `Scene Director 输出没有满足 Schemes=${schemeCount} 要求，请重试。` }, { status: 502 });
    }

    return NextResponse.json({
      prompt: schemes.map((scheme) => `${scheme.title ?? "Scene"}：${scheme.prompt}`).join("\n\n"),
      schemes,
      debug: {
        imageCount: images.length,
        model,
        planningModel,
        schemeCount,
        sourceNodeId: body.sourceNodeId
      }
    });
  } catch (error) {
    return NextResponse.json({ error: readCaughtError(error) }, { status: 500 });
  }
}
