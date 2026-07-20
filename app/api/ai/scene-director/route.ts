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
  if (/结构|structure|造型|形体|geometry|灯板|粘板|部件|零件|组件|位置关系/i.test(context)) return "Structure Reference";
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

function extractUserImageDefinitions(instruction: string) {
  const definitions = new Map<string, string[]>();
  const mentionPattern = /(?:<\s*Image\s*(\d{1,3})\s*>|@\s*(?:Image\s*)?0*(\d{1,3})\b)/gi;
  const clauses = instruction
    .slice(0, 20000)
    .split(/[。\n\r；;]/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .slice(0, 300);

  clauses.forEach((clause) => {
    const matches = [...clause.matchAll(mentionPattern)];
    matches.forEach((match) => {
      const number = Number(match[1] ?? match[2]);
      if (!Number.isInteger(number) || number < 1) return;
      const label = `<Image${String(number).padStart(3, "0")}>`;
      const normalizedClause = clause.replace(mentionPattern, (token) => {
        const tokenNumber = Number(token.match(/\d+/)?.[0]);
        return Number.isInteger(tokenNumber) ? `<Image${String(tokenNumber).padStart(3, "0")}>` : token;
      });
      const current = definitions.get(label) ?? [];
      if (!current.includes(normalizedClause)) current.push(normalizedClause);
      definitions.set(label, current);
    });
  });
  return definitions;
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
  const mosquitoSceneMode = params.mosquitoSceneMode === "true";
  const mosquitoMethod = normalizeOption(params.mosquitoMethod, "Auto", { 自动判断: "Auto", 电击灭蚊: "Electric Grid", 风扇吸入: "Fan Suction", 粘板粘捕: "Glue Board" });
  const mosquitoSceneType = normalizeOption(params.sceneType, "Auto", { 自动: "Auto", 卧室: "Bedroom", 客厅: "Living Room", 庭院: "Patio", 露营: "Camping", 餐厅: "Dining", 商业空间: "Commercial Space" });
  const mosquitoTimeMood = normalizeOption(params.timeMood, "Night", { 夜晚: "Night", 傍晚: "Dusk", 暗光室内: "Dark Environment", 暗光环境: "Dark Environment", 白天环境: "Daytime Environment", 自动: "Auto" });
  const attractionLight = normalizeOption(params.attractionLight, "Soft Visible", { 关闭: "Off", 克制: "Subtle", 柔和可见: "Soft Visible", 明显可见: "Clearly Visible" });
  const backgroundPresence = normalizeOption(params.backgroundPresence, "Auto", { 自动: "Auto", 无人物和宠物: "No People or Pets", 仅人物: "People Only", 仅宠物: "Pets Only", 人物和宠物: "People and Pets" });
  const peopleInteraction = normalizeOption(params.peopleInteraction, "Auto", { 自动: "Auto", 无人物互动: "No Human Interaction", 仅作背景: "Background Only", 手持产品: "Handheld Product Demonstration", 操作使用: "Operating the Product", 拆卸清理: "Disassembly and Cleaning", 被蚊虫困扰: "Bothered by Mosquitoes", 被蚊虫惊扰特效: "Startled by Mosquitoes Advertising Effect" });
  const insectAmount = normalizeOption(params.insectAmount, "Few", { 无: "None", 极少: "Very Few", 少量: "Few", 适量: "Moderate", 大量: "Large Amount" });
  const noMosquitoes = insectAmount === "None";
  const insectScale = normalizeOption(params.insectScale, "Auto Appropriate", { 自动合理: "Auto Appropriate", 真实微小: "Realistic Tiny", 细节适度放大: "Moderately Enlarged Detail", 原理示意放大: "Enlarged Mechanism Illustration" });
  const mosquitoEffectStyle = normalizeOption(params.effectStyle, "Comfortable Commercial", { 舒适商业: "Comfortable Commercial", 科技演示: "Technology Demonstration", 原理可视化: "Mechanism Visualization" });
  const mosquitoEffectPreset = normalizeOption(params.effectPreset, "Auto Match", {
    自动匹配: "Auto Match",
    无特效: "No Mechanism Effect",
    轻微吸入: "Subtle Suction",
    明显吸入: "Clearly Visible Suction",
    强力吸入: "Strong Advertising Suction",
    微小亮点: "Tiny Spark Points",
    轻微电弧: "Subtle Electric Arc",
    明显电击: "Clearly Visible Electric Effect",
    轻度展示: "Subtle Demonstration",
    清晰粘捕: "Clearly Visible Glue Capture",
    过程演示: "Capture Process Demonstration",
    明显展示: "Clearly Visible Demonstration",
    强力广告: "Strong Advertising Demonstration",
    原理剖析: "Clean Mechanism Cutaway"
  });
  const mosquitoWavelength = normalizeOption(params.mosquitoWavelength, "395 nm | Standard Violet | #6F00FF", {
    "无｜灯光关闭": "None | Product attraction light OFF",
    "365 nm｜近紫外深紫": "365 nm | Near-UV Deep Violet | visual simulation color #4B1D8F",
    "395 nm｜标准紫光": "395 nm | Standard Violet | visual simulation color #6F00FF",
    "410 nm｜蓝紫光": "410 nm | Blue-Violet | visual simulation color #5B3CFF"
  });
  const mosquitoLightOff = params.mosquitoWavelength === "无｜灯光关闭";
  const allowFallenDeadMosquitoes = !noMosquitoes && params.mosquitoMethod === "电击灭蚊" && params.effectPreset === "明显电击";
  const mosquitoLightingPriority = mosquitoTimeMood === "Night"
    ? mosquitoLightOff
      ? "Night lighting hierarchy: the product light is OFF. Use restrained moonlight, a dim practical lamp, or low ambient room light as the necessary main illumination while keeping a convincing nighttime exposure."
      : "Night lighting hierarchy: other believable sources such as moonlight, a bedside lamp, or low ambient room light are allowed, but they must remain secondary. The product attraction light is the primary localized colored light source and strongest visual lighting emphasis."
    : mosquitoTimeMood === "Dusk"
      ? mosquitoLightOff
        ? "Dusk lighting hierarchy: the product light is OFF. Use remaining natural dusk light or restrained indoor practical light as the main illumination."
        : "Dusk lighting hierarchy: natural dusk light or indoor practical light may be the main illumination. The product attraction light is a visible localized functional accent and does not need to be the main light source."
      : mosquitoTimeMood === "Dark Environment"
        ? mosquitoLightOff
          ? "Dark-environment lighting hierarchy: the product light is OFF. Keep the environment very dark, using only the minimum faint ambient fill required to identify the product without creating violet or blue-violet light."
          : "DARK-ENVIRONMENT ABSOLUTE KEY-LIGHT LOCK: use almost no other environmental light source. Across Electric Grid, Fan Suction, Glue Board, and Auto methods alike, the enabled product attraction light MUST be the scene's primary illumination source and primary exposure anchor. Its real light chamber illuminates the product, nearby mounting/support surface, immediately adjacent objects, and close subjects with physically plausible violet or blue-violet falloff, reflections, colored bounce, and directional shadows. Mechanism-effect intensity is independent from scene-light hierarchy: a Clearly Visible Electric Effect may contain very bright dramatic local arcs and impact flashes, Strong Advertising Suction may remain visually powerful, and glue capture may remain highly readable. These effects do not replace the attraction lamp as the source that illuminates the overall scene. Keep moonlight, room ambience, practical lamps, screens, windows, and neutral fill secondary; keep the wider surroundings dark and do not substitute generic blue room lighting for light emitted by the product."
        : mosquitoTimeMood === "Daytime Environment"
          ? mosquitoLightOff
            ? "Daytime lighting hierarchy: the product light is OFF. Natural daylight is the main illumination."
            : "Daytime lighting hierarchy: natural daylight is the main illumination. The product attraction light may be visibly ON as a restrained local functional glow, but it must not become the scene's main light or cast an implausibly strong room-wide color wash."
          : mosquitoLightOff
            ? "Automatic lighting hierarchy: choose a believable scene time and environmental main light. The product attraction light remains OFF."
            : "Automatic lighting hierarchy: choose the light hierarchy according to the selected or inferred scene time. Night and dark environments prioritize the product light; dusk and daytime prioritize believable environmental illumination.";
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
  const mosquitoSceneRules = mosquitoSceneMode
    ? [
        "Mosquito-control product scene mode is active. The scene must clearly communicate how the product attracts and eliminates mosquitoes while remaining comfortable, premium, believable, and suitable for advertising.",
        `Mosquito control method: ${mosquitoMethod}. If Auto, infer the real mechanism only from the product image and user direction; never invent an electric grid, fan inlet, or glue board that the product does not have.`,
        `Target scene: ${mosquitoSceneType}. Time and ambience: ${mosquitoTimeMood}.`,
        mosquitoLightingPriority,
        "TIME-ATMOSPHERE LIGHTING IS METHOD-INDEPENDENT: Electric Grid, Fan Suction, Glue Board, and Auto must obey the exact same selected time-mood hierarchy. The mosquito-control mechanism may change the functional effect, but it must never silently change the scene time, ambient exposure, or primary-light assignment.",
        "MECHANISM EFFECT AND SCENE LIGHTING ARE INDEPENDENT CONTROLS: the selected functional effect must keep its full requested visual strength. Electric arcs and impact flashes may be locally intense and dramatic, suction distortion may be bold without becoming a light source, and glue-board capture may be clearly emphasized. Separately, the selected time mood decides what illuminates the overall environment; in Dark Environment with the attraction light enabled, that product light remains the scene's primary illumination source.",
        `Background presence: ${backgroundPresence}. Follow this selection exactly. Auto means choose only when it makes the scene more natural; No People or Pets means no human or animal may appear anywhere in frame.`,
        `People interaction mode: ${peopleInteraction}. Follow the selected interaction instead of forcing every person to remain passive in the background.`,
        "No Human Interaction means no person, hand, arm, human silhouette, reflection, or human action may appear anywhere in the frame.",
        "Background Only keeps people calm and secondary. Handheld Product Demonstration allows a hand or person to hold the product naturally when the real product is designed to be handheld. Operating the Product allows realistic button presses, placement, charging, switching, or normal use without changing the product structure.",
        "Disassembly and Cleaning allows hands to remove, empty, wipe, replace, or clean only the product's real removable collection tray, glue board, insect chamber, cover, or filter. Show the product powered off and make the safe maintenance state visually clear. Never touch an energized electric grid or operating fan.",
        "Bothered by Mosquitoes may show mild annoyance, waving, scratching, or disturbed rest before the product takes effect. Startled by Mosquitoes Advertising Effect may show a readable surprised reaction and stylized motion cues, but it must remain playful, family-friendly, commercially acceptable, and non-horror.",
        "People may look at or interact with the product when the selected mode requires it. They must not conceal critical product features for the shot, misuse the device, touch hazardous operating parts, or make the product's operation physically implausible.",
        "Pets remain secondary and safe. Do not place pets in contact with an operating capture area or depict distress unless the user explicitly requests a gentle mosquito-annoyance story; never depict animal harm.",
        "When a reaction or maintenance shot is selected, the person may become an important narrative subject, but the product function and mosquito-control result must remain clearly readable.",
        mosquitoLightOff
          ? "Attraction-light wavelength: None. The product attraction light must be visibly OFF. Do not illuminate LEDs, the light chamber, internal surfaces, openings, or nearby objects with violet or blue-violet light. Do not add purple/blue colored spill, glow, bloom, rays, or reflections from the product."
          : `Attraction-light wavelength and visual target: ${mosquitoWavelength}. Use this wavelength selection consistently for the product's real light source, its restrained localized glow, and nearby color spill. 365 nm must remain dim near-UV deep violet, 395 nm is the default saturated violet, and 410 nm reads as a clearer blue-violet. Hex values are visual simulation targets for image generation, not claims that a display can reproduce ultraviolet radiation physically.`,
        mosquitoLightOff
          ? "WAVELENGTH COLOR LOCK: None / Light OFF overrides every time mood and effect style. The scene may use environmental lighting required by the selected time, but the product emits no colored light and creates no product-originated colored reflection or spill."
          : `WAVELENGTH COLOR LOCK ACROSS ALL TIME MOODS AND METHODS: the selected wavelength ${mosquitoWavelength} is the sole authority for the attraction-light hue. Night, Dusk, Dark Environment, Daytime, Auto, Electric Grid, Fan Suction, Glue Board, effect style, and mechanism preset may change exposure or effect intensity but must never change this hue. Apply the same wavelength-consistent color to the real emitter, illuminated chamber, glow, bloom, nearby wall/table/support light patch, product-surface reflection, colored bounce, and person/pet edge light caused by the product. Do not substitute generic blue, magenta, pink, cyan, or another violet shade.`,
        mosquitoLightOff
          ? "Ignore the attraction-light visibility setting because the selected wavelength is None / light OFF."
          : `Blue-violet attraction light visibility: ${attractionLight}. Show a physically plausible soft localized glow only at the product's real light source, never a laser beam, neon explosion, fantasy energy field, or room-filling purple wash.`,
        noMosquitoes
          ? "MOSQUITO AMOUNT NONE - ABSOLUTE ZERO-MOSQUITO LOCK: show zero mosquitoes anywhere in the image. No flying, approaching, captured, stuck, electrocuted, dead, fallen, blurred, silhouetted, reflected, background, decorative, or diagrammatic mosquito is allowed. This setting overrides the mosquito-control method, mechanism-effect preset, attraction behavior, glue-capture instructions, electric-effect instructions, and every other rule that would normally add an insect. The product light and non-insect mechanism cues may still follow their selected settings, but the image must contain no mosquito body or mosquito-like shape."
          : `Mosquito amount: ${insectAmount}. Mosquito scale mode: ${insectScale}. Very Few, Few, and Moderate must remain restrained and separated. Large Amount must be visibly more numerous but still distributed across the relevant scene area with readable spacing and visual hierarchy; never turn it into a compact swarm, dense cloud, face-level mass, or frightening macro view.`,
        "Mosquito scale rules: Auto Appropriate uses realistic tiny scale in wide lifestyle scenes and permits restrained enlargement only in mechanism detail views. Realistic Tiny keeps true-to-life scale. Moderately Enlarged Detail may enlarge mosquitoes only enough to explain attraction or capture action. Enlarged Mechanism Illustration may use a clearly readable technical-diagram scale, but must look clean, neutral, simplified, and non-photorealistic rather than like a giant real insect.",
        "Even when enlarged for a detail or mechanism view, mosquitoes must never look monstrous, aggressive, anatomically grotesque, hairy, wet, sharp, threatening, or larger than necessary. Do not show disturbing body anatomy or horror-style macro detail.",
        `Effect presentation style: ${mosquitoEffectStyle}. The image must feel hygienic, calm, safe, family-friendly, and commercially acceptable.`,
        `Functional mechanism effect preset: ${mosquitoEffectPreset}. Follow this preset as the requested visibility and intensity of the mosquito-control mechanism. No Mechanism Effect disables suction, electric, and glue-capture action cues but does not turn off an enabled attraction light. Auto Match selects an appropriate restrained level for the scene. Clean Mechanism Cutaway uses a clean simplified technical visualization without changing the real product exterior.`,
        "Effect-style compatibility: Comfortable Commercial should remain subtle or clearly readable rather than dramatic. Technology Demonstration may use a clearly visible or strong advertising effect. Mechanism Visualization may prioritize a clean mechanism cutaway. Even the strongest preset must obey all safety, realism, inlet/outlet, no-trajectory, and product-structure locks.",
        allowFallenDeadMosquitoes
          ? "FALLEN DEAD-MOSQUITO EXCEPTION IS ACTIVE because and only because the user explicitly selected Electric Grid plus Clearly Visible Electric Effect. A visibly increased, irregularly scattered group of dry intact dead mosquitoes may appear on the external support surface immediately around the product base. This permission applies to this exact combination only."
          : "ABSOLUTE NO-FALLEN-CORPSES LOCK: do not show any fallen, loose, or detached mosquito corpse on a table, counter, platform, floor, ground, furniture, product base, inside the product, or any surrounding surface. Fallen dead mosquitoes are permitted only when the user explicitly selects BOTH Electric Grid AND Clearly Visible Electric Effect. Glue Board is the only non-electric exception for dead captured mosquitoes, but those bodies must remain fully attached to an explicitly mapped adhesive face and must never be fallen or loose. Auto, Fan Suction, No Effect, Tiny Spark Points, Subtle Electric Arc, and every other combination must contain zero fallen mosquito corpses.",
        "REAL-WORLD PRODUCT SIZE LOCK: every numerical product dimension stated by the user is a mandatory physical-size constraint, not descriptive copy. Keep the rendered product at that exact real-world scale relative to adult hands, people, plates, cups, furniture, tabletop depth, and nearby props. Never enlarge the product to make it the visual hero. Preserve both its stated dimensions and its width-to-height-to-depth proportions; instead adjust camera distance, crop, empty space, and scene composition around the correctly sized product.",
        "PRODUCT-IN-SCENE COMPOSITING PLAN: treat the Main Product as a frozen 2D photographed projection. The downstream generator may translate and uniformly scale this projection to the correct real-world size, but must not rotate it, perspective-warp it, skew it, mirror it, change its yaw/pitch/roll, or alter its visible-face ratios. Design the scene camera, wall/ground plane, support surface, socket or mounting point, furniture, people, and framing around that fixed projection.",
        "Every output prompt must include a Product Integration section that specifies the exact support or mounting relationship, local contact shadow, ambient occlusion, cast-shadow direction, environment color spill, reflection intensity, exposure match, edge softness, depth-of-field match, and any physically correct partial occlusion. These integration effects must make the product belong to the scene without redrawing its geometry or changing its viewpoint.",
        "PLUG-IN WALL PRODUCT HARD CONNECTION LOCK: whenever the user direction specifies a mains plug, wall plug, socket, outlet, receptacle, or plug-in use, the connected user Prompt is the sole highest-priority authority for the socket standard. If it says Chinese, European, American/US, British/UK, or another socket type, use exactly that stated regional receptacle. Never auto-detect, guess, reinterpret, or override the user-stated socket standard from the product image or model assumptions, and never substitute another country's outlet. Reference images may preserve the product and real plug geometry but cannot change the Prompt-specified socket type. Every real blade, round pin, flat pin, angled pin, and grounding pin belonging to that plug must align with its corresponding receptacle opening and be fully inserted; no conductive portion may remain visibly exposed. The occupied receptacle must be hidden behind the product, and the product rear/base must sit tightly against the outlet faceplate with only a narrow realistic contact shadow and ambient occlusion. Never place the product beside, in front of, hovering near, or disconnected from the outlet. Never invent or remove pins, or add an adapter, cable, pedestal, bracket, or extra plug. PHYSICAL-MOUNTING EXCEPTION: this completed plug-to-receptacle connection has higher priority than exact source-view locking. Allow the smallest necessary rotation, yaw/pitch adjustment, and perspective adaptation of the whole unchanged product so its real plug direction aligns with the Prompt-specified receptacle. Preserve the exact product identity, silhouette, proportions, colors, materials, parts, plug geometry, and internal layout; do not redesign or deform it. Once inserted, compose the wall, faceplate, camera, and scene around that physically valid mounted pose.",
        "Attraction behavior: if mosquitoes are requested, show them as a few independent insects at plausible positions around the product. Never draw flight paths, dotted trails, dashed curves, arrows, trajectory lines, motion-guide lines, swirl lines, or graphic route indicators between mosquitoes and the product.",
        "Electric Grid method — two-layer structure lock: the first/front/outer metal mesh is a non-energized protective safety guard. It must remain visually intact and must never carry a spark, arc, impact point, or struck mosquito. The second/rear/inner mesh beneath the protective guard is the energized high-voltage grid; every electrical effect must sit visibly behind the front guard and attach only to this inner grid. Tiny Spark Points uses one or two tiny natural pinprick flashes on the inner grid and MUST NOT show a mosquito being struck or any dead mosquito. Subtle Electric Arc uses one short, irregular, low-intensity micro-arc on the inner grid and MUST NOT show a mosquito touching, being struck, or already dead. CLEARLY VISIBLE ELECTRIC EFFECT is the only preset allowed to show mosquito electrocution and dead mosquitoes: show one readable mosquito at the instant it contacts the inner energized grid, with at least one electric arc physically terminating on and visibly touching the mosquito's body and a compact impact flash centered exactly at that body-contact point; a nearby mosquito with no direct arc contact does not satisfy this requirement. Add several scattered electrical contact points of varied small and medium sizes and multiple white-blue branching arc networks of different lengths running irregularly between nearby inner-grid conductors. Each arc network must contain many fine secondary branches. Use layered electrical opacity: a few bright near-opaque white-blue core channels, medium-bright semi-opaque branches, and numerous thinner semi-transparent faint peripheral branches. Randomly vary branch thickness, opacity, brightness, sharpness, and local bloom so the discharge has realistic depth instead of uniform neon lines. Also show a visibly increased but still commercially acceptable number of dry, intact dead-mosquito silhouettes scattered naturally on the external support surface around the product base, such as the nearby tabletop or ground. Their placement must look genuinely accidental and messy: irregular spacing, random distance from the base, varied body orientation and resting pose, uneven local density, isolated insects mixed with a few loose two- or three-insect clusters, and occasional slight overlap. Never arrange them in a row, arc, ring, grid, equal spacing, mirrored symmetry, or repeated identical pose. Do not place dead mosquitoes inside the product, inside a collection area, on the front guard, or far across the scene. Make the arcs energetic and advertisement-readable but physically rooted in the inner grid, with natural asymmetry. Never create a single giant starburst, evenly radial spokes, a uniform spiderweb/cracked-glass pattern, decorative lightning symbol, or electricity on the front protective mesh. No room-scale lightning, explosion, smoke, fire, blood, burnt anatomy, wet residue, disgusting close-up, or dense dead-insect pile.",
        "Fan Suction method: the functional air intake is the real intake opening directly beneath or inside the illuminated violet/blue-violet attraction-light chamber. Mosquitoes and any intake effect must be pulled toward that upper illuminated-chamber intake only. The grille or vent at the lower base is the exhaust outlet: never show suction, inward airflow, mosquito attraction, or mosquito entry at the bottom exhaust. Every visible mosquito must be alive and either flying nearby or being pulled into the real inlet; show ZERO fallen or dead mosquitoes on any external surface or inside the product. Subtle Suction uses faint local air disturbance. Clearly Visible Suction uses readable short-range atmospheric pull and mosquito posture. Strong Advertising Suction must be unmistakably and dramatically stronger than Clearly Visible Suction: use a powerful compact funnel-shaped zone of refractive air distortion centered on the real intake, pronounced short-range motion blur, turbulent local haze, and multiple mosquitoes visibly accelerating and tilting into the intake. Make it bold and exaggerated like a high-impact technology advertisement, while keeping the effect compact around the intake and the product structurally unchanged. Do not draw dotted paths, dashed trajectories, arrows, or thin graphic guide lines. Do not deform the product, swap inlet and outlet, or invent vents.",
        "Glue Board method — universal adhesive-face map lock: first build an explicit Adhesive Face Map only from the user's prompt, role description, product image, or annotated diagram: identify the exact physical glue-board part; whether adhesive exists on the front face only, rear face only, both faces, or another explicitly marked surface; which adhesive faces are actually visible from the locked source viewpoint; and whether a separate baffle, cover, light, housing, or spacer exists in front of or behind the board. User labels are authoritative and override visual guessing. Never infer adhesive from board color, transparency, material, shape, brightness, or proximity to the light. ADHESIVE IS A SURFACE PROPERTY, NOT A VISIBLE BORDER: words such as adhesive, sticky, glue board, double-sided adhesive, 粘胶, 双面胶, or 双面粘胶 describe which flat face can capture insects. They do not authorize any visible glue bead, glue rim, gel edge, adhesive border, tape strip, raised lip, transparent outline, glossy frame, thick seam, or extra layer around the board. If the source images do not visibly contain such an edge, render none. Preserve the board's exact original clean contour, edge thickness, corner shape, surface color, and relationship to nearby parts. A single-sided board accepts captured mosquitoes only on its explicitly marked adhesive side. A double-sided board accepts captured mosquitoes on either adhesive side, but only where that side is genuinely visible or exposed from the unchanged source view; do not show insects through an opaque board. If the product has no baffle, never invent one. If it has a baffle or cover, preserve the exact annotated depth order and occlusion, and never treat that non-adhesive part as sticky. Captured mosquitoes on the glue board may be alive, immobilized, or dead according to the scene, but every captured body must physically touch and lie flat on an explicitly adhesive surface in the Adhesive Face Map, with body and legs aligned to that surface plane. Glue Board mode must contain ZERO fallen, loose, or detached mosquito bodies on the table, platform, floor, ground, product base, or any surrounding surface; dead captured mosquitoes remain attached to the adhesive face. Zero captured mosquitoes are allowed on any non-adhesive face, board edge, baffle, cover, light, product housing, wall, socket plate, nearby furniture, floor, or surrounding air. Preserve the real board orientation and original product camera angle; never rotate, front-face, side-face, open, separate, flip, or re-pose the product merely to expose more adhesive area. If only a small adhesive area is visible, show fewer captured mosquitoes only inside that area. If no adhesive face is visible, show no already-captured mosquito rather than inventing a visible glue face. Subtle Demonstration shows minimal capture evidence. Clearly Visible Glue Capture makes several captures readable only when enough real adhesive area is visible. Capture Process Demonstration may show one incoming mosquito approaching the explicitly mapped adhesive face, but every already-captured mosquito remains attached and no graphic path is allowed. Every output prompt for Glue Board method must contain an Adhesive Face Map section stating the board part, adhesive side(s), visible adhesive region(s), non-adhesive forbidden surfaces, any conditional occlusion relationship, and an explicit No Visible Glue Border rule. Keep captured insects small, clean, separated, and non-graphic, with no gore, body-detail pile, or disgusting close-up.",
        "Never show blood, crushed insects, insect body detail, piles of dead insects, dirty residue, horror imagery, aggressive danger symbols, or anything likely to cause disgust or fear.",
        "Every output prompt must include a Mosquito Safety Visual Rules section and a Mechanism Effect section."
      ]
    : [];
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
    mosquitoSceneMode ? "Mosquito Control Scene Rules:" : "",
    ...mosquitoSceneRules,
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
    "For every wall-plug product, physical insertion is a mandatory pass/fail condition. The connected user Prompt is the sole highest-priority authority for the socket type: use exactly its stated Chinese, European, American/US, British/UK, or other standard; never auto-detect or override it from images. Fully insert every blade/pin/prong including any grounding pin, hide the occupied socket behind the product, and make the rear/base contact the faceplate. Reject any socket standard different from the Prompt, missing or invented pin, visible conductive pin section, gap, hovering placement, side-by-side placement, or invented adapter. This physical connection overrides exact source-angle locking: permit only the minimum whole-product rotation and perspective adjustment required for real insertion, while preserving product design, proportions, materials, parts, and plug geometry.",
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

function applyUserImageDefinitionsToSchemes(schemes: SceneDirectorScheme[], instruction: string) {
  const definitions = extractUserImageDefinitions(instruction);
  if (!definitions.size) return schemes;
  const marker = "Connected Prompt Image Definitions (authoritative):";
  const rows = [...definitions.entries()].map(([label, clauses]) => `- ${label}: ${clauses.join("; ")}`);
  const section = [
    marker,
    ...rows,
    "These definitions come directly from the connected user Prompt. Preserve every listed image number and its stated purpose. Do not omit, merge, reassign, or replace these roles."
  ].join("\n");
  return schemes.map((scheme) => ({
    ...scheme,
    prompt: scheme.prompt.includes(marker) ? scheme.prompt : `${scheme.prompt.trim()}\n\n${section}`
  }));
}

function isBadScenePrompt(prompt: string, params?: Record<string, string>, dimensionFacts: DimensionFact[] = [], requiredImageLabels: string[] = []) {
  if (prompt.length < 100) return true;
  if (!/<Image\d{3}>/.test(prompt)) return true;
  if (requiredImageLabels.some((label) => !prompt.includes(label))) return true;
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
    const requiredImageLabels = [...extractUserImageDefinitions(instruction).keys()];
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
      schemes = applyUserImageDefinitionsToSchemes(
        applyDimensionFactsToSchemes(parseSchemes(outputText, schemeCount), dimensionFacts),
        instruction
      );
      if (schemes.length === schemeCount && schemes.every((scheme) => !isBadScenePrompt(scheme.prompt, body.params, dimensionFacts, requiredImageLabels))) break;
    }

    if (!lastResponseOk) {
      return NextResponse.json({ error: formatProviderError(planningModel, lastPayload, lastStatus) }, { status: lastStatus });
    }
    schemes = applyUserImageDefinitionsToSchemes(applyDimensionFactsToSchemes(schemes, dimensionFacts), instruction);
    if (schemes.length !== schemeCount || schemes.some((scheme) => isBadScenePrompt(scheme.prompt, body.params, dimensionFacts, requiredImageLabels))) {
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
