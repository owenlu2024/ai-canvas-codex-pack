import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type ApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface IndustrialDesignerRequest {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number; title?: string; url?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
  sourceNodeId?: string;
}

interface DesignScheme {
  prompt: string;
  title?: string;
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

function normalizeSchemeCount(value: unknown) {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(20, Math.max(1, parsed));
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

async function imageSourceForTask(value: string) {
  if (!value.startsWith("/")) return /^https?:\/\//i.test(value) ? assertSafeRemoteFetchUrl(value) : value;
  const filePath = getPublicAssetPath(value);
  const body = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${type};base64,${body.toString("base64")}`;
}

async function toChatImageUrl(imageUrl: string) {
  return imageSourceForTask(imageUrl);
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
        // Keep searching for a valid JSON object.
      }
    }
  }
  return trimmed;
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
  if (error instanceof Error && error.name === "AbortError") return "Industrial Designer 生成超时，请稍后重试。";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timeout/i.test(message)) {
    return "AI 服务连接失败，请检查设置里的服务地址、API Key 或网络后重试。";
  }
  return message || "Industrial Designer 生成失败。";
}

function getPlanningModel(model: string) {
  return model;
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
  const retryText = `${instructionText}\n\nPrevious output was invalid. Return only valid JSON with exactly ${schemeCount} schemes. Every prompt must preserve image references. If Output Language is English, use only English section headings: Image References, Design Positioning, Appearance Analysis, Form Language, Light CMF Notes, User Experience, Differentiation, Mass Production Notes, Final Prompt. Prioritize exterior appearance analysis over CMF.`;
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
        temperature: attempt === 0 ? 0.65 : 0.35
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

function getReferenceAliases(instruction: string) {
  const aliases = new Set<string>();
  instruction.match(/<[^<>\n]{1,32}>/g)?.forEach((alias) => aliases.add(alias));
  return [...aliases].slice(0, 40);
}

function buildInstruction(body: IndustrialDesignerRequest, images: Array<{ imageNumber?: number; title?: string; url: string }>) {
  const params = body.params ?? {};
  const schemes = normalizeSchemeCount(params.schemes);
  const outputLanguage = normalizeLanguage(params.outputLanguage);
  const designMode = normalizeOption(params.designMode, "Fusion", { 重新设计: "Redesign", 融合设计: "Fusion", 外观变体: "Appearance Variants", 概念设计: "Concept", CMF设计: "CMF" });
  const innovationLevel = normalizeOption(params.innovationLevel, "Balanced", { 保守优化: "Conservative", 平衡创新: "Balanced", 大胆创新: "Bold" });
  const structureLock = normalizeOption(params.structureLock, "Strict", { 严格保持: "Strict", 适度调整: "Moderate", 自由创新: "Free" });
  const referenceFusion = normalizeOption(params.referenceFusion, "Auto", { 自动融合: "Auto", 竞品优先: "Competitor First", 情绪图优先: "Mood First", 风格优先: "Style First" });
  const visualStyle = normalizeOption(params.visualStyle, "Auto", { 自动判断: "Auto", 极简现代: "Minimal Modern", 科技未来: "Tech Futuristic", 轻奢家居: "Light Luxury Home", 北欧自然: "Nordic Natural", 商务专业: "Business Professional", 年轻潮流: "Youth Trend", 户外探索: "Outdoor Exploration" });
  const promptStyle = normalizeOption(params.promptStyle, "Design Director", { 简洁模式: "Compact", 详细模式: "Detailed", 设计总监模式: "Design Director" });
  const imageLabels = images.map((image, index) => {
    const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
    return `<Image${String(number).padStart(3, "0")}>`;
  });
  const primaryBaseLabel = imageLabels[0] ?? "<Image001>";
  const fusionReferenceLabels = imageLabels.slice(1);
  const userAliases = getReferenceAliases(body.instruction ?? "");
  const innovationRule = innovationLevel === "Conservative"
    ? "Add: Suitable for mass production. Maintain market familiarity. Keep upgrades subtle and commercially safe."
    : innovationLevel === "Bold"
      ? "Add: Explore future-oriented concepts. Encourage unconventional solutions while keeping the concept explainable as an industrial design proposal."
      : "Add: Balance novelty and practicality.";
  const structureRule = structureLock === "Strict"
    ? "Preserve the original functional layout. Maintain structural relationships. Do not change core layout, product structure, or dimensional relationships."
    : structureLock === "Moderate"
      ? "Allow moderate detail optimization and user-experience improvements without losing the core product logic."
      : "Allow structural replanning when it creates a stronger industrial design concept.";
  const languageRule = outputLanguage === "English"
    ? "Language hard rule: output every title, section heading, explanation, and final prompt in English only. Do not output Chinese words or Chinese punctuation except literal user-provided reference aliases inside angle brackets."
    : outputLanguage === "Bilingual"
      ? "Language hard rule: output bilingual Chinese and English content. Keep each section understandable in both languages."
      : "Language hard rule: output every title, section heading, explanation, and final prompt in Chinese only, except technical material abbreviations such as ABS, PC, CMF, UX, and literal reference aliases.";
  const sectionHeadingRule = outputLanguage === "English"
    ? "Each scheme must include these English section headings exactly: Image References, Design Positioning, Appearance Analysis, Form Language, Light CMF Notes, User Experience, Differentiation, Mass Production Notes, Final Prompt."
    : outputLanguage === "Bilingual"
      ? "Each scheme must include bilingual section headings: 引用图片 / Image References, 设计定位 / Design Positioning, 外观分析 / Appearance Analysis, 造型语言 / Form Language, 轻量CMF / Light CMF Notes, 用户体验 / User Experience, 差异化优势 / Differentiation, 量产建议 / Mass Production Notes, 最终 Prompt / Final Prompt."
      : "Each scheme must include these Chinese section headings exactly: 引用图片, 设计定位, 外观分析, 造型语言, 轻量CMF, 用户体验, 差异化优势, 量产建议, 最终 Prompt.";
  const titleShape = outputLanguage === "English"
    ? "JSON title examples: \"Scheme 01: Streamlined Power Form\". Do not use 方案 in English mode."
    : outputLanguage === "Bilingual"
      ? "JSON title examples: \"方案01 / Scheme 01: 流线动感型 / Streamlined Power Form\"."
      : "JSON title examples: \"方案01：流线动感型\".";
  const fusionModeRule = designMode === "Fusion"
    ? [
        "Fusion Design hard rule:",
        `- Treat ${primaryBaseLabel} as the PRIMARY BASE PRODUCT unless the user explicitly names a different main/existing product.`,
        fusionReferenceLabels.length
          ? `- Treat ${fusionReferenceLabels.join(", ")} as FUSION REFERENCES. They must visibly influence exterior form language: silhouette rhythm, volume stacking, top/middle/bottom proportion, front-window/opening shape, grille/perforation strategy, side ribs, panel segmentation, vertical grooves, vents, control-area placement, and edge transitions.`
          : "- Use every available supporting reference as a visible fusion source when possible.",
        "- Each scheme must be a hybrid of the primary base product and the fusion references, not a generic new product and not only a competitor copy.",
        "- Preserve the primary base product's product category, functional architecture, main cylindrical/body architecture, opening/window relationship, air-inlet/outlet logic, main massing, and usability layout.",
        "- Transform reference traits into an original exterior design: borrow form DNA, not logos, labels, exact graphics, or a one-to-one silhouette.",
        "- Every Final Prompt must explicitly include a Base Product line and a Fusion References line, then describe which exterior traits are taken from each.",
        "- CMF is secondary in Fusion Design. Do not make color/material the main idea unless Design Mode is CMF."
      ].join("\n")
    : "";

  return [
    "You are Industrial Designer, a senior industrial design prompt planner.",
    "You think, design, and write downstream image prompts. You never generate images.",
    `Generate exactly ${schemes} industrial design schemes.`,
    `Output Language: ${outputLanguage}.`,
    languageRule,
    `Design Mode: ${designMode}.`,
    fusionModeRule,
    `Innovation Level: ${innovationLevel}. ${innovationRule}`,
    `Structure Lock: ${structureLock}. ${structureRule}`,
    `Reference Fusion: ${referenceFusion}.`,
    `Design Style: ${visualStyle}.`,
    `Prompt Style: ${promptStyle}.`,
    "Available connected image references:",
    imageLabels.join(", "),
    userAliases.length ? `User-written reference aliases that must be preserved if used by the user: ${userAliases.join(", ")}` : "User-written reference aliases: none detected.",
    body.instruction?.trim() ? `User design requirement:\n${body.instruction.trim()}` : "User design requirement: none.",
    "Reference rules:",
    "- Preserve every image reference token exactly as written, including <Image###> references and any user aliases such as <竞品01>, <情绪图01>, <材质参考01>, <结构参考01>, or <现有产品01>.",
    `- If the user has not explicitly assigned image roles, use ${primaryBaseLabel} as the base product and use the other connected images as fusion references.`,
    "- First analyze exterior appearance, not CMF: overall silhouette, volume hierarchy, height/diameter ratio, top cap, waistline, front opening/window, grille/perforation density, side columns/ribs, panel seams, foot/base treatment, control-area placement, edge radius, and visual center of gravity.",
    "- Understand competitor images as category, function, layout, benchmark proportions, exterior architecture, and recognizable form cues. Do not directly copy competitors, but the final design direction must visibly respond to their exterior and functional DNA.",
    "- Understand style references as form language, silhouette rhythm, detail treatment, surface transitions, panel strategy, grille/window language, and visual identity.",
    "- Understand structure references as exterior architecture, air path/opening logic, component relationships, assembly seams, dimensions, and manufacturable constraints.",
    "- Understand CMF references as secondary guidance for color/material/finish only. Keep CMF notes short unless Design Mode is CMF.",
    "- If the user says a reference is a hand sketch, product sketch, rough sketch, simple line drawing, front-end input sketch, 手绘草图, 产品草图, 简单线条图, 线条图, 线稿, 草图, or 手稿, treat that image as the product concept source. This capability must work even when there is no competitor image, no style reference, and only one simple sketch reference. Convert the sketch into a realistic, manufacturable product design: infer the intended silhouette, proportions, component layout, openings, seams, controls, ergonomic surfaces, and functional architecture, then add believable materials, CMF, construction details, and production-ready geometry. Do not keep the final result as a drawing, doodle, blueprint, wireframe, marker sketch, or flat illustration unless the user explicitly asks for sketch style.",
    sectionHeadingRule,
    "The final prompt must preserve image references, include complete industrial design guidance, and be directly usable by downstream image generation nodes.",
    "The final prompt must explicitly state what exterior traits to extract from each reference image, for example product category, body proportion, cylindrical/body architecture, top cap, front opening/window, grille/perforation layout, vents, side ribs, panel segmentation, base treatment, edge transitions, and construction logic.",
    "When a referenced image is a sketch, the final prompt must explicitly say to transform the sketch into a realistic commercial studio product render with clean background, real materials, physical thickness, bevels, seams, assembly logic, plausible scale, and high-quality surface finish while preserving the sketch's core product idea and silhouette. Do not require competitor references for sketch-to-product conversion.",
    "For Fusion Design, the final prompt must explicitly say: use the base product as the structural and appearance foundation, then integrate visible exterior traits from the fusion references into the same product design.",
    "The final prompt must ask the image model to make the influence of each relevant reference visible in the new design without direct copying.",
    "The final prompt must not mention internal API names, vendors, provider brands, or model names.",
    "Design Director mode must include design positioning, exterior appearance analysis, form language, brief CMF notes, user experience, differentiation, and mass-production suggestions. Detailed mode may be shorter but must still prioritize exterior form and UX. Compact mode may be concise but must keep all required sections.",
    titleShape,
    "Return only valid JSON. No Markdown. JSON shape: {\"schemes\":[{\"title\":\"short scheme title\",\"prompt\":\"complete downstream industrial design prompt\"}]}."
  ].join("\n");
}

function getSchemeArray(parsed: unknown) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const candidates = [
    record.schemes,
    record.designs,
    record.concepts,
    record.options,
    record.results,
    record.prompts,
    record.items
  ];
  return candidates.find((candidate): candidate is unknown[] => Array.isArray(candidate)) ?? [];
}

function getRecordText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHeadingLanguage(prompt: string, outputLanguage: string) {
  if (outputLanguage !== "English") return prompt;
  return prompt
    .replace(/引用图片\s*[：:]/g, "Image References:")
    .replace(/设计定位\s*[：:]/g, "Design Positioning:")
    .replace(/外观分析\s*[：:]/g, "Appearance Analysis:")
    .replace(/造型语言\s*[：:]/g, "Form Language:")
    .replace(/CMF建议\s*[：:]/g, "CMF Suggestions:")
    .replace(/轻量CMF\s*[：:]/g, "Light CMF Notes:")
    .replace(/用户体验\s*[：:]/g, "User Experience:")
    .replace(/差异化优势\s*[：:]/g, "Differentiation:")
    .replace(/量产建议\s*[：:]/g, "Mass Production Notes:")
    .replace(/最终\s*Prompt\s*[：:]/g, "Final Prompt:");
}

function ensureDesignPromptSections(prompt: string, outputLanguage: string, imageLabels: string[]) {
  const normalized = normalizeHeadingLanguage(prompt.trim(), outputLanguage);
  if (!normalized) return "";
  if (!isBadDesignPrompt(normalized)) return normalized;

  if (outputLanguage === "English") {
    return [
      `Image References: ${imageLabels.join(", ")}`,
      "Design Positioning: Industrial design proposal generated from the connected base product and fusion references.",
      "Appearance Analysis: Start from the base product's exterior architecture. If any reference is described as a hand sketch, product sketch, simple line drawing, line drawing, or rough sketch, convert that sketch into a realistic product concept by preserving its intended silhouette, proportions, component layout, openings, seams, controls, and functional architecture. This must work even when the sketch is the only reference image and there are no competitor or style references. Then fuse any available reference traits such as silhouette rhythm, volume stacking, top/middle/bottom proportion, front opening/window shape, grille or perforation layout, side ribs, panel seams, base treatment, and edge transitions.",
      "Form Language: Preserve the base product architecture while integrating visible reference form traits such as proportion rhythm, panel segmentation, vertical grooves, vents/openings, surface transitions, and detail hierarchy.",
      "Light CMF Notes: Keep color, material, and finish as a supporting layer only; do not make CMF the main design idea unless the design mode is CMF.",
      "User Experience: Improve ergonomics, perceived quality, clarity of operation, and maintenance logic.",
      "Differentiation: Create an original fused design that visibly responds to the references without directly copying logos, labels, or exact silhouettes.",
      "Mass Production Notes: Keep part splits, molded surfaces, assembly logic, vents, grips, physical thickness, bevels, and surface finishes feasible for production. The downstream image should be a realistic clean-background commercial studio product render, not a sketch, doodle, blueprint, wireframe, or flat illustration unless explicitly requested.",
      `Final Prompt: ${normalized}`
    ].join("\n\n");
  }

  return [
    `引用图片：${imageLabels.join(", ")}`,
    "设计定位：基于连接的主图与参考图生成工业设计方案。",
    "外观分析：先分析主图外观架构。如果参考图被描述为手绘草图、产品草图、简单线条图、线条图、线稿或粗略草图，需要把草图转译为真实产品概念，保留其核心轮廓、比例、部件布局、开孔、分件线、控制区与功能架构。即使只有这一张草图、没有竞品图或风格参考图，也必须具备草图转真实产品的能力。再融合任何可用参考图的轮廓节奏、体块层级、顶部/中段/底座比例、正面开窗、格栅/孔阵、侧向筋线、分件线、底座处理与边缘转折。",
    "造型语言：保留主图产品架构，融合参考图的比例节奏、分件线、纵向沟槽、开孔/格栅、曲面转折与细节层级。",
    "轻量CMF：颜色、材料、工艺只作为辅助层，不作为主要设计重点，除非当前设计模式是 CMF设计。",
    "用户体验：优化握持、品质感、操作清晰度与维护逻辑。",
    "差异化优势：形成可见融合关系，但不直接复制标识、文字或完整轮廓。",
    "量产建议：控制分件、曲面、装配、开孔、握把、实体厚度、倒角与表面工艺的量产可行性。下游出图应是真实干净背景的商业摄影棚产品图，不是草图、涂鸦、蓝图、线框或扁平插画，除非用户明确要求草图风格。",
    `最终 Prompt：${normalized}`
  ].join("\n\n");
}

function parseSchemes(rawText: string, expectedCount: number, outputLanguage: string, imageLabels: string[]): DesignScheme[] {
  const jsonText = extractJsonObjectWithKey(rawText, "schemes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return [];
  }
  const schemes = getSchemeArray(parsed);
  return schemes.slice(0, expectedCount).map((scheme, index): DesignScheme | null => {
    if (typeof scheme === "string") {
      const prompt = ensureDesignPromptSections(scheme, outputLanguage, imageLabels);
      return prompt ? { prompt, title: outputLanguage === "English" ? `Scheme ${String(index + 1).padStart(2, "0")}` : `方案${String(index + 1).padStart(2, "0")}` } : null;
    }
    if (!scheme || typeof scheme !== "object") return null;
    const record = scheme as Record<string, unknown>;
    const promptText = getRecordText(record, ["prompt", "finalPrompt", "final_prompt", "imagePrompt", "image_prompt", "designPrompt", "design_prompt", "description", "content"]);
    const prompt = ensureDesignPromptSections(promptText, outputLanguage, imageLabels);
    if (!prompt) return null;
    const title = getRecordText(record, ["title", "name", "schemeTitle", "scheme_title"]);
    return {
      prompt,
      title: title || (outputLanguage === "English" ? `Scheme ${String(index + 1).padStart(2, "0")}` : `方案${String(index + 1).padStart(2, "0")}`)
    };
  }).filter((scheme): scheme is DesignScheme => scheme !== null);
}

function isBadDesignPrompt(prompt: string) {
  if (prompt.length < 120) return true;
  if (!/<[^<>\n]{1,32}>/.test(prompt)) return true;
  const requiredSignals = [
    /引用图片|Image References/i,
    /设计定位|Design Positioning/i,
    /外观分析|Appearance Analysis|silhouette|外观|轮廓|体块/i,
    /造型语言|Form Language/i,
    /用户体验|User Experience|UX/i,
    /差异化|Differentiation/i,
    /量产|Mass Production|manufactur/i,
    /最终\s*Prompt|Final Prompt/i
  ];
  return requiredSignals.some((pattern) => !pattern.test(prompt));
}

function hasUnexpectedChineseForEnglish(value: string) {
  const withoutAliases = value.replace(/<[^<>]+>/g, "");
  return /[\u4e00-\u9fff]/.test(withoutAliases);
}

function fillMissingSchemes(schemes: DesignScheme[], expectedCount: number, outputLanguage: string, imageLabels: string[]) {
  if (!schemes.length || schemes.length >= expectedCount) return schemes.slice(0, expectedCount);
  const filled = [...schemes];
  while (filled.length < expectedCount) {
    const source = schemes[(filled.length - schemes.length) % schemes.length];
    const number = filled.length + 1;
    const variationNote = outputLanguage === "English"
      ? `\n\nAdditional variation direction: create a distinct fusion variant ${number} from the same base product and fusion references, changing proportion emphasis, CMF accent placement, panel segmentation, grip texture, vent language, and detail density while preserving ${imageLabels.join(", ")} references.`
      : `\n\n补充变体方向：基于同一主图与参考图生成第 ${number} 个融合变体，调整比例重点、CMF强调位置、分件线、握把纹理、开孔语言与细节密度，并保留 ${imageLabels.join(", ")} 引用。`;
    filled.push({
      prompt: `${source.prompt}${variationNote}`,
      title: outputLanguage === "English" ? `Scheme ${String(number).padStart(2, "0")}: Fusion Variant` : `方案${String(number).padStart(2, "0")}：融合变体`
    });
  }
  return filled;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as IndustrialDesignerRequest;
    const images = (body.images ?? []).filter((image): image is { imageNumber?: number; title?: string; url: string } => typeof image.url === "string" && Boolean(image.url));
    const instruction = body.instruction?.trim() ?? "";
    if (!images.length) return NextResponse.json({ error: "请先连接 Image 图框。" }, { status: 400 });
    if (!instruction) return NextResponse.json({ error: "请先连接设计需求 Prompt。" }, { status: 400 });

    const rawModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const model = getBaseModelId(rawModel) ?? defaultModel;
    const settings = await readSettings(rawModel, body.aiSettings);
    if (!settings.apiKey || !settings.baseUrl) {
      return NextResponse.json({ error: isAgnesTextModel(model) ? "请先在设置里保存 Agnes 服务地址和 API Key。" : "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });
    }
    const planningModel = getPlanningModel(model);
    const schemeCount = normalizeSchemeCount(body.params?.schemes);
    const outputLanguage = normalizeLanguage(body.params?.outputLanguage);
    const instructionText = buildInstruction(body, images);
    const imageLabels = images.map((image, index) => {
      const number = Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1;
      return `<Image${String(number).padStart(3, "0")}>`;
    });
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
    let schemes: DesignScheme[] = [];
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
                    : `${instructionText}\n\nPrevious output was invalid. Return only valid JSON with exactly ${schemeCount} schemes. Every prompt must preserve image references. If Output Language is English, use only English section headings: Image References, Design Positioning, Appearance Analysis, Form Language, Light CMF Notes, User Experience, Differentiation, Mass Production Notes, Final Prompt. Prioritize exterior appearance analysis over CMF.`
                },
                ...imageParts.flat()
              ]
            }
          ],
          temperature: attempt === 0 ? 0.65 : 0.35
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

      schemes = fillMissingSchemes(parseSchemes(candidateText || getChatCompletionText(lastPayload), schemeCount, outputLanguage, imageLabels), schemeCount, outputLanguage, imageLabels);
      if (schemes.length === schemeCount && schemes.every((scheme) => !isBadDesignPrompt(scheme.prompt))) break;
    }

    if (!lastResponseOk) {
      return NextResponse.json({ error: formatProviderError(planningModel, lastPayload, lastStatus) }, { status: lastStatus });
    }
    schemes = fillMissingSchemes(schemes, schemeCount, outputLanguage, imageLabels);
    if (schemes.length !== schemeCount || schemes.some((scheme) => isBadDesignPrompt(scheme.prompt))) {
      return NextResponse.json({ error: `Industrial Designer 输出没有满足 Schemes=${schemeCount} 要求，请重试。` }, { status: 502 });
    }

    return NextResponse.json({
      prompt: schemes.map((scheme) => `${scheme.title ?? "Industrial Design"}${outputLanguage === "English" ? ":" : "："}${scheme.prompt}`).join("\n\n"),
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
