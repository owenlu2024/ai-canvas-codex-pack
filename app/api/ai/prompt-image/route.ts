import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getCanvasDataPath, getPublicAssetPath } from "@/lib/serverPaths";
import { assertSafeRemoteFetchUrl, normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface ApiSettings {
  baseUrl: string;
  apiKey: string;
}

interface StoredApiSettings {
  settings?: Partial<ApiSettings>;
  agnesSettings?: Partial<ApiSettings>;
}

interface PromptImageRequest {
  images?: Array<{ imageNumber?: number; url?: string }>;
  model?: string;
  module?: string;
  output?: string;
  schemes?: string | number;
  instruction?: string;
  sourceNodeId?: string;
}

interface PromptScheme {
  prompt: string;
  title?: string;
}

type PromptOutputMode = "template" | "natural" | "english" | "bilingual" | "json";

const settingsPath = getCanvasDataPath("api-settings.local.json");
const defaultModel = "gemini-2.5-flash";

function normalizeSchemeCount(value: unknown) {
  const parsed = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(10, Math.max(1, parsed));
}

function normalizeBaseRoot(value: string) {
  if (!value.trim()) return "";
  return normalizeHttpBaseUrl(value, "root");
}

function isAgnesTextModel(model?: string) {
  return Boolean(model?.startsWith("agnes-") && !model.includes("image"));
}

async function readSettings(model?: string): Promise<ApiSettings> {
  const saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as StoredApiSettings;
  const source = isAgnesTextModel(model) ? saved.agnesSettings : saved.settings;
  return {
    apiKey: source?.apiKey?.trim() ?? "",
    baseUrl: normalizeBaseRoot(source?.baseUrl ?? (isAgnesTextModel(model) ? "https://apihub.agnes-ai.com" : ""))
  };
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

function getPromptOutputMode(extraInstruction = "", output?: string): PromptOutputMode {
  const normalizedOutput = output?.trim().toLowerCase();
  if (normalizedOutput === "json") return "json";
  if (normalizedOutput === "english" || normalizedOutput === "英文") return "english";
  if (normalizedOutput === "chinese & english" || normalizedOutput === "中英双语") return "bilingual";
  if (normalizedOutput === "chinese" || normalizedOutput === "中文") return "template";
  if (/\bjson\b|需要\s*JSON|输出\s*JSON|返回\s*JSON/i.test(extraInstruction)) return "json";
  if (/英文|英语|\benglish\b/i.test(extraInstruction)) return "english";
  if (/自然语言|自然段|不要模板|不要字段|不要格式/i.test(extraInstruction)) return "natural";
  return "template";
}

function getOutputLabel(mode: PromptOutputMode) {
  if (mode === "json") return "Json";
  if (mode === "english") return "English";
  if (mode === "bilingual") return "Chinese & English";
  return "Chinese";
}

function getOutputModeInstruction(mode: PromptOutputMode) {
  if (mode === "json") {
    return [
      "用户明确要求 JSON，因此最终只输出合法 JSON 对象，不要 Markdown 代码块，不要额外解释。",
      "JSON 必须包含 prompt 字段，prompt 的描述语言必须使用英文，这样更适合后续生图 AI 跨模型读取。",
      "建议字段结构：prompt、visible_text、style、lighting、composition、quality。字段名使用英文 snake_case。",
      "图片中真实可见的中文或英文 Logo、品牌名、包装文字、型号或屏幕文字可以在 visible_text 或 prompt 里原样保留。",
      "JSON 内容仍然要基于图片真实信息填写；多图时必须使用 Image 编号作为键或字段值。"
    ].join("\n");
  }
  if (mode === "english") {
    return [
      "用户明确要求英文，因此最终只输出英文生图 Prompt。",
      "描述语言必须是英文；只有图片中真实可见的中文 Logo、品牌名、包装文字、型号或屏幕文字可以原样保留，并且必须用英文描述它，例如 “with the Chinese text ‘自然堂’ on the package”。",
      "不要输出中文字段模板，不要 Markdown，不要解释。"
    ].join("\n");
  }
  if (mode === "bilingual") {
    return [
      "用户明确要求中英双语，因此最终必须同时输出中文和英文生图 Prompt。",
      "严格使用两段格式：中文：具体中文 Prompt。English: complete English prompt.",
      "中文段落的描述语言必须是中文，英文段落的描述语言必须是英文；图片中真实可见的 Logo、品牌名、包装文字、型号或屏幕文字可以在两段里原样保留。",
      "不要 Markdown，不要解释。"
    ].join("\n");
  }
  if (mode === "natural") {
    return [
      "用户明确要求自然语言，因此最终只输出一段已经写好的自然中文生图 Prompt。",
      "不要字段名，不要模板，不要引号，不要括号，不要 JSON，不要 Markdown。"
    ].join("\n");
  }
  return [
    "默认输出格式必须是已经填写完整的中文字段模板。",
    "严格使用这一行格式：主体：具体内容，外观结构：具体内容，颜色：具体内容，材质：具体内容，关键细节：具体内容，场景：具体内容，光线：具体内容，镜头角度：具体内容，构图：具体内容，风格：具体内容，画质要求：具体内容。",
    "每个字段都必须填入具体中文内容，禁止留空，禁止使用括号占位，禁止只写字段名。",
    "输出语言必须是中文；只有图片中真实可见的英文 Logo、品牌名、包装文字、型号或屏幕文字可以原样保留，并且必须用中文描述它，例如“印有 ‘SK-II’ 标志”或“包装上有 ‘AIR’ 字样”。",
    "禁止用英文写说明、目标、限制、风格、质量、镜头、构图或其他描述性句子。"
  ].join("\n");
}

function buildImageToChinesePromptInstruction(module = "Normal", extraInstruction = "", output?: string) {
  const moduleLine = module.trim() ? `当前模块：${module.trim()}。` : "";
  const extraLine = extraInstruction.trim() ? `用户补充要求：${extraInstruction.trim()}。` : "";
  const outputMode = getPromptOutputMode(extraInstruction, output);
  const finalWrapperLine = outputMode === "json"
    ? "最终只输出一个 JSON 对象本身，不要 Markdown，不要解释。"
    : "最终答案必须放在 <final> 和 </final> 标签之间；标签外禁止输出任何会被用户使用的内容。";
  return [
    "你是一个专业的图片识别与中文 AI 生图 Prompt 编写专家。",
    "你的任务是根据用户提供的一张或多张图片，分析主体、外观、颜色、材质、结构、场景、光线、镜头角度、构图和整体风格，然后重新组织成一段适合中文生图模型使用的 Prompt。",
    getOutputModeInstruction(outputMode),
    finalWrapperLine,
    "Output 是最高优先级约束。用户补充要求只能补充内容细节，不能改变 Output 指定的语言、格式或 JSON 要求。",
    "除非 Output 明确选择 English、Chinese & English 或 Json，否则不要用英文写描述；但图片中真实可见的英文 Logo、品牌名、包装文字、型号或屏幕文字可以原样保留。除非 Output 明确选择 Json，否则不要输出 JSON。不要输出 Markdown。不要输出标题。不要输出分析过程。不要使用“这张图片”“图片中”“看起来像”“可能是”“我认为”等描述。不要解释图片。不要输出 Negative Prompt。不要输出多个版本。不要编造图片中不存在的重要元素。",
    "如果是产品图，重点描述产品名称、造型结构、颜色材质、功能细节、摆放场景、商业摄影光线、产品完整度和高级质感。",
    "如果是电商图，重点描述干净背景、主体居中、产品完整展示、柔和阴影、高清商业产品摄影。",
    "如果是场景图，重点描述空间环境、氛围、主体关系、自然光影、镜头感和画面层次。",
    "如果是人物图，重点描述人物外貌、服装、姿态、表情、场景、光线和风格，但不要推测敏感身份。",
    "如果是工业设计图，重点描述产品造型、曲面结构、比例、材质、细节、设计感和渲染质感。",
    "Prompt 长度控制在 80 到 260 个中文字符之间。",
    "结尾需要包含画质要求，例如：高清真实质感，细节清晰，主体完整，画面干净，高级感。",
    "如果只有一张图片，不要提“第一张图”。如果有多张图片，必须用 Image 编号绑定描述，例如“Image 001 的主体……”或“参考 Image 001 的造型与 Image 003 的光线”，不能只写“第一张图、第二张图”。",
    moduleLine,
    extraLine,
    "最终只输出用户要求的结果本身，不能包含任何其他内容。"
  ].filter(Boolean).join("\n");
}

function buildIndustrialDesignInstruction(extraInstruction = "", output?: string, schemeCount = 1) {
  const outputMode = getPromptOutputMode(extraInstruction, output);
  const outputLabel = getOutputLabel(outputMode);
  return [
    "你是资深工业设计师和产品视觉提示词专家，任务是基于多张 Image 参考图重新设计工业产品方案。",
    "用户会用 @Image 001、@Image 008 这类标记指定图片角色，例如竞品产品、情绪图、线条参考、顶面设计参考。必须优先尊重这些标记，并在每个方案 prompt 中明确写出参考的 Image 编号和用途。",
    `必须生成 ${schemeCount} 个不同设计方案，不能多也不能少。`,
    `Output 选择为 ${outputLabel}。`,
    "最终只输出合法 JSON 对象，不要 Markdown，不要解释，不要标题，不要分析过程。",
    "JSON 格式必须严格为：{\"schemes\":[{\"title\":\"方案 01：名称\",\"prompt\":\"完整生图 Prompt\"}]}。",
    "每个 schemes[i].prompt 都必须是可以直接接入生图节点的完整提示词，而不是分析说明。",
    "每个方案都要体现差异化设计方向，例如比例、曲面、分件线、CMF、交互区、结构层次、细节语言、未来感或专业属性的不同。",
    "如果 Output 是 Chinese，prompt 描述语言使用中文；图片中真实可见的英文 Logo、品牌名、型号或包装文字可原样保留。",
    "如果 Output 是 English，prompt 描述语言使用英文；图片中真实可见的中文文字可原样保留。",
    "如果 Output 是 Chinese & English，prompt 内必须包含“中文：”和“English:”两段。",
    "如果 Output 是 Json，最终外层仍然使用 schemes JSON 数组；每个 schemes[i].prompt 必须是一段英文生图 Prompt 字符串，不要在 prompt 字段里再嵌套 JSON。",
    "如果某个 @Image 当前没有图片，只保留它的引用关系，不要编造它的画面内容。",
    "不要复制竞品外观；要提取竞品比例、品类、使用场景和功能关系，再结合参考图重新设计。",
    extraInstruction.trim() ? `用户前置 Prompt：${extraInstruction.trim()}` : "",
    "最终只输出 JSON 对象本身。"
  ].filter(Boolean).join("\n");
}

function getCandidateText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
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
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  return candidates.map((candidate) => {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts.map((part) => typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
  }).join("\n").trim();
}

function stripCodeFence(value: string) {
  return value
    .replace(/```(?:json|JSON|[a-zA-Z]*)?\s*/g, "")
    .replace(/```/g, "")
    .trim();
}

function normalizeNaturalChinesePrompt(value: string) {
  const fieldNames = "主体|外观结构|颜色|材质|关键细节|场景|光线|镜头角度|构图|风格|画质要求";
  const withoutCodeFence = stripCodeFence(value)
    .replace(/^\s*(?:Prompt|中文\s*Prompt|生图\s*Prompt|以下是|根据图片生成)[:：]\s*/i, "")
    .replace(/[#*_`{}\[\]]/g, "")
    .replace(/(?:Negative Prompt|JSON)[:：][\s\S]*$/i, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(new RegExp(`[“"'‘’]?\\s*(?:${fieldNames})\\s*[”"'‘’]?\\s*[：:()（）-]*\\s*`, "g"), "")
    .replace(/[()（）"“”'‘’]/g, "")
    .replace(/[–—]+/g, "，")
    .replace(/\b(?:first|second|third|image|images|prompt|negative|style|camera|lighting|composition|quality|high|realistic|photo|photography|render|detail|details)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstLine = withoutCodeFence.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/^(?:这张图片|图片中|我看到|我认为|分析结果|可以描述为)[:：，,\s]*/g, "")
    .replace(/^(?:以下是|根据图片生成的?)[:：，,\s]*/g, "")
    .replace(/\s*[,;:]\s*/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/^[，。、\s]+|[，、\s]+$/g, "")
    .trim();
}

function normalizeTemplatePrompt(value: string) {
  const withoutCodeFence = extractFinalAnswer(stripCodeFence(value));
  const matches = [...withoutCodeFence.matchAll(/主体\s*[：:]/g)];
  const templateStart = matches.length ? matches[matches.length - 1].index ?? -1 : -1;
  return (templateStart >= 0 ? withoutCodeFence.slice(templateStart) : withoutCodeFence)
    .replace(/^\s*(?:Prompt|中文\s*Prompt|生图\s*Prompt|以下是|根据图片生成)[:：]\s*/i, "")
    .replace(/[#*_`{}\[\]"“”'‘’]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/[–—]+/g, "，")
    .replace(/\s*[,;:]\s*/g, "，")
    .replace(/\s+/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/^[，。、\s]+|[，、\s]+$/g, "")
    .trim();
}

function normalizeFlexiblePrompt(value: string, mode: PromptOutputMode) {
  if (mode === "json") return extractJsonObject(stripCodeFence(value));
  if (mode === "english") return extractFinalAnswer(stripCodeFence(value)).replace(/^\s*(?:Prompt|English Prompt)[:：]\s*/i, "").trim();
  if (mode === "bilingual") return extractFinalAnswer(stripCodeFence(value)).trim();
  if (mode === "natural") return normalizeNaturalChinesePrompt(value);
  return normalizeTemplatePrompt(value);
}

function extractFinalAnswer(value: string) {
  const matches = [...value.matchAll(/<final>([\s\S]*?)<\/final>/gi)];
  if (matches.length) return (matches[matches.length - 1][1] ?? "").trim();
  return value.trim();
}

function extractJsonObject(value: string) {
  const trimmed = value.trim();
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
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Keep looking for a smaller valid object.
      }
    }
  }
  return trimmed;
}

function extractJsonObjectWithKey(value: string, key: string) {
  const trimmed = value.trim();
  const starts: number[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  let fallback = "";
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    for (let end = trimmed.length - 1; end > start; end -= 1) {
      if (trimmed[end] !== "}") continue;
      const candidate = trimmed.slice(start, end + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (!fallback) fallback = candidate;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && key in parsed) return candidate;
      } catch {
        // Keep looking for a valid object with the requested key.
      }
    }
  }
  return fallback || trimmed;
}

function stripQuotedText(value: string) {
  return value
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/“[^”]*”/g, "")
    .replace(/‘[^’]*’/g, "");
}

function hasEnglishProse(value: string) {
  const withoutQuotedText = stripQuotedText(value).replace(/@?Image\s*\d{1,3}/gi, "");
  const words = withoutQuotedText.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (!words.length) return false;
  const visibleTextContext = /(?:Logo|logo|品牌|商标|标志|字样|文字|包装|型号|屏幕|标识|印有|写有|显示|可见|名为)/.test(value);
  const prosePattern = /\b(?:the|this|that|these|those|and|or|with|without|for|from|into|about|goal|task|create|craft|describe|description|formatting|restrictions|compliant|comprehensive|streamlined|instruction|prompt|image|model|commercial|quality|lighting|composition|camera|style|realistic|detailed|high-quality)\b/i;
  if (prosePattern.test(withoutQuotedText)) return true;
  return words.length > (visibleTextContext ? 14 : 6);
}

function hasChineseProse(value: string) {
  const withoutQuotedText = stripQuotedText(value).replace(/@?Image\s*\d{1,3}/gi, "");
  const chineseCount = withoutQuotedText.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  if (!chineseCount) return false;
  const visibleTextContext = /(?:Logo|logo|brand|trademark|text|lettering|wording|package|model|screen|label|marked|printed|reads|shows|displayed|visible|named)/i.test(value);
  return chineseCount > (visibleTextContext ? 18 : 6);
}

function getJsonPromptValue(parsed: unknown) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const record = parsed as Record<string, unknown>;
  if (typeof record.prompt === "string") return record.prompt;
  const candidates = ["description", "positive_prompt", "image_prompt", "prompt_text"];
  for (const key of candidates) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function isBadPromptOutput(raw: string, normalized: string, mode: PromptOutputMode) {
  if (mode === "json") {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      const promptValue = getJsonPromptValue(parsed);
      const englishWordCount = promptValue.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
      return !promptValue || promptValue.length < 40 || englishWordCount < 20 || hasChineseProse(promptValue);
    } catch {
      return true;
    }
  }
  if (mode === "english") {
    const englishWordCount = normalized.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
    return normalized.length < 40 || englishWordCount < 20 || hasChineseProse(normalized) || /主体|外观结构|颜色|材质|关键细节|场景|光线|镜头角度|构图|风格|画质要求/.test(normalized);
  }
  if (mode === "bilingual") {
    const chinesePart = normalized.match(/中文\s*[：:]([\s\S]*?)(?:English\s*:|$)/i)?.[1]?.trim() ?? "";
    const englishPart = normalized.match(/English\s*:([\s\S]*)/i)?.[1]?.trim() ?? "";
    const hasEnoughChinese = (normalized.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= 40;
    const hasEnoughEnglish = (normalized.match(/[A-Za-z]+/g)?.length ?? 0) >= 30;
    return (
      !hasEnoughChinese ||
      !hasEnoughEnglish ||
      !/中文\s*[：:]/.test(normalized) ||
      !/English\s*:/i.test(normalized) ||
      !chinesePart ||
      !englishPart ||
      hasEnglishProse(chinesePart) ||
      hasChineseProse(englishPart)
    );
  }
  if (mode === "natural") {
    const hasEnoughChinese = (normalized.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= 40;
    return !hasEnoughChinese || hasEnglishProse(normalized);
  }
  const fieldMatches = normalized.match(/主体|外观结构|颜色|材质|关键细节|场景|光线|镜头角度|构图|风格|画质要求/g)?.length ?? 0;
  const hasEmptySlots = /[()（）]\s*[，。,.、;；)]/.test(normalized) || /["“”']\s*[()（）]/.test(normalized);
  const hasTooManyQuotes = (normalized.match(/["“”']/g)?.length ?? 0) >= 8;
  const requiredFields = ["主体", "外观结构", "颜色", "材质", "关键细节", "场景", "光线", "镜头角度", "构图", "风格", "画质要求"];
  const missingField = requiredFields.some((field) => !normalized.includes(`${field}：`) && !normalized.includes(`${field}:`));
  const hasEnoughChinese = (normalized.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= 40;
  return fieldMatches < 6 || missingField || hasEmptySlots || hasTooManyQuotes || !hasEnoughChinese || hasEnglishProse(normalized);
}

function normalizeSchemePrompt(value: unknown, mode: PromptOutputMode) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const asJson = JSON.stringify(value, null, mode === "json" ? 2 : 0);
    return asJson.trim();
  }
  return "";
}

function getIndustrialSchemes(rawText: string, mode: PromptOutputMode): PromptScheme[] {
  const jsonText = extractJsonObjectWithKey(stripCodeFence(rawText), "schemes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const schemes = (parsed as { schemes?: unknown }).schemes;
  if (!Array.isArray(schemes)) return [];
  const normalizedSchemes: Array<PromptScheme | null> = schemes
    .map((scheme, index): PromptScheme | null => {
      if (!scheme || typeof scheme !== "object") return null;
      const record = scheme as Record<string, unknown>;
      const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `方案 ${String(index + 1).padStart(2, "0")}`;
      const prompt = normalizeSchemePrompt(record.prompt ?? record.description ?? record.json, mode);
      if (!prompt) return null;
      return { prompt, title };
    });
  return normalizedSchemes.filter((scheme): scheme is PromptScheme => Boolean(scheme));
}

function isBadIndustrialScheme(prompt: string, mode: PromptOutputMode) {
  if (prompt.length < 60) return true;
  if (/\b(?:analysis|summary|breakdown|goal|task|thinking through|here'?s how|okay)\b/i.test(prompt)) return true;
  if (mode === "json") {
    const englishWordCount = prompt.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
    return englishWordCount < 20 || hasChineseProse(prompt) || /主体|外观结构|颜色|材质|关键细节|场景|光线|镜头角度|构图|风格|画质要求/.test(prompt);
  }
  if (mode === "english") {
    const englishWordCount = prompt.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0;
    return englishWordCount < 20 || hasChineseProse(prompt);
  }
  if (mode === "bilingual") {
    const chinesePart = prompt.match(/中文\s*[：:]([\s\S]*?)(?:English\s*:|$)/i)?.[1]?.trim() ?? "";
    const englishPart = prompt.match(/English\s*:([\s\S]*)/i)?.[1]?.trim() ?? "";
    return !chinesePart || !englishPart || hasEnglishProse(chinesePart) || hasChineseProse(englishPart);
  }
  const chineseCount = prompt.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return chineseCount < 40 || hasEnglishProse(prompt);
}

async function executeIndustrialDesignPrompt(settings: ApiSettings, body: PromptImageRequest, images: Array<{ imageNumber?: number; url: string }>) {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
  const outputMode = getPromptOutputMode(body.instruction, body.output);
  const schemeCount = normalizeSchemeCount(body.schemes);
  const instruction = buildIndustrialDesignInstruction(body.instruction, body.output, schemeCount);
  const imageParts = await Promise.all(images.map(async (image) => {
    const inline = await toInlineData(image.url);
    const label = Number.isInteger(image.imageNumber) ? `Image ${String(image.imageNumber).padStart(3, "0")}` : "Image 未编号";
    return [
      { text: `参考${label}：` },
      { inlineData: { data: inline.data, mimeType: inline.mimeType } }
    ];
  }));
  const chatImageParts = await Promise.all(images.map(async (image) => {
    const label = Number.isInteger(image.imageNumber) ? `Image ${String(image.imageNumber).padStart(3, "0")}` : "Image 未编号";
    return [
      { type: "text", text: `参考${label}：` },
      { type: "image_url", image_url: { url: await imageSourceForTask(image.url) } }
    ];
  }));

  let lastPayload: unknown = null;
  let lastStatus = 200;
  let lastResponseOk = false;
  let schemes: PromptScheme[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = isAgnesTextModel(model)
      ? await fetch(`${settings.baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [
            {
              content: [
                {
                  type: "text",
                  text: attempt === 0
                    ? instruction
                    : `${instruction}\n\n上一次输出没有满足要求。请只输出合法 JSON 对象，schemes 数组必须正好 ${schemeCount} 项，每项必须有 title 和 prompt，prompt 必须符合 Output=${body.output ?? "Chinese"}。如果 Output=Json，schemes[i].prompt 是英文字符串，不要嵌套 JSON。`
                },
                ...chatImageParts.flat()
              ],
              role: "user"
            }
          ],
          model,
          temperature: attempt === 0 ? 0.45 : 0.25
        }),
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json"
        },
        method: "POST",
        signal: AbortSignal.timeout(180000)
      })
      : await fetch(`${settings.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
        body: JSON.stringify({
          contents: [
          {
            role: "user",
            parts: [
              {
                text: attempt === 0
                  ? instruction
                  : `${instruction}\n\n上一次输出没有满足要求。请只输出合法 JSON 对象，schemes 数组必须正好 ${schemeCount} 项，每项必须有 title 和 prompt，prompt 必须符合 Output=${body.output ?? "Chinese"}。如果 Output=Json，schemes[i].prompt 是英文字符串，不要嵌套 JSON。`
              },
              ...imageParts.flat()
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: attempt === 0 ? 0.45 : 0.25
        }
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(180000)
      });

    lastPayload = await response.json().catch(() => null) as unknown;
    lastStatus = response.status;
    lastResponseOk = response.ok;
    if (!response.ok) break;

    const rawText = getCandidateText(lastPayload);
    schemes = getIndustrialSchemes(rawText, outputMode);
    if (schemes.length === schemeCount && schemes.every((scheme) => !isBadIndustrialScheme(scheme.prompt, outputMode))) break;
  }

  if (!lastResponseOk) {
    return NextResponse.json({ error: formatProviderError(model, lastPayload, lastStatus) }, { status: lastStatus });
  }
  if (schemes.length !== schemeCount || schemes.some((scheme) => isBadIndustrialScheme(scheme.prompt, outputMode))) {
    return NextResponse.json({ error: `AI 工业设计输出没有满足 Schemes=${schemeCount} / Output=${body.output ?? "Chinese"} 要求，请重试。` }, { status: 502 });
  }
  return NextResponse.json({
    prompt: schemes.map((scheme, index) => `${scheme.title || `方案 ${String(index + 1).padStart(2, "0")}`}：${scheme.prompt}`).join("\n\n"),
    schemes,
    debug: {
      imageCount: images.length,
      model,
      module: "Industrial Design",
      output: body.output ?? "Chinese",
      schemeCount,
      sourceNodeId: body.sourceNodeId
    }
  });
}

function readProviderError(payload: unknown, status: number) {
  if (!payload || typeof payload !== "object") return `AI 服务返回错误：${status}`;
  const record = payload as { error?: { message?: string } | string; message?: string };
  if (typeof record.error === "string") return record.error;
  return record.error?.message ?? record.message ?? `AI 服务返回错误：${status}`;
}

function formatProviderError(model: string, payload: unknown, status: number) {
  const message = readProviderError(payload, status);
  if (message === "openai_error") {
    return `${model} 当前在 12AI 服务返回 openai_error。已测试该模型纯文本/图片请求均失败，请先切换 gemini-2.5-flash，或检查 12AI 模型是否已开放。`;
  }
  return message;
}

function readCaughtError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timeout/i.test(message)) {
    return "AI 服务连接失败，请检查设置里的服务地址、API Key 或网络后重试。";
  }
  return message || "AI Prompt 生成失败。";
}

function getRetryInstruction(mode: PromptOutputMode) {
  if (mode === "json") {
    return "请重新输出合法 JSON 对象，必须包含英文 prompt 字段，字段名使用英文，描述语言使用英文；只有图片中真实可见的文字可以原样保留。";
  }
  if (mode === "english") {
    return "请重新输出纯英文生图 Prompt，不要中文字段模板，不要中文描述；只有图片中真实可见的中文文字可以原样保留。";
  }
  if (mode === "bilingual") {
    return "请重新输出中英双语格式，必须包含“中文：”和“English:”两段；中文段用中文描述，英文段用英文描述。";
  }
  if (mode === "template") {
    return "请重新输出已经填写完整的中文字段模板，每个字段都必须有具体内容，不要括号，不要空项。描述语言必须是中文；只有图片中真实可见的英文 Logo、品牌、包装文字或型号可以原样保留。";
  }
  return "请严格按照 Output 指定格式重新输出，不要添加解释或标题。";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PromptImageRequest;
    const images = (body.images ?? []).filter((image): image is { imageNumber?: number; url: string } => typeof image.url === "string" && Boolean(image.url));
    if (!images.length) {
      return NextResponse.json({ error: "请先连接 Image 图框。" }, { status: 400 });
    }

    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const settings = await readSettings(model);
    if (!settings.apiKey || !settings.baseUrl) {
      return NextResponse.json({ error: isAgnesTextModel(model) ? "请先在设置里保存 Agnes 服务地址和 API Key。" : "请先在设置里保存 AI 服务地址和 API Key。" }, { status: 400 });
    }

    if (body.module === "Industrial Design") {
      return executeIndustrialDesignPrompt(settings, body, images);
    }

    const outputMode = getPromptOutputMode(body.instruction, body.output);
    const instruction = buildImageToChinesePromptInstruction(body.module, body.instruction, body.output);
    const imageParts = await Promise.all(images.map(async (image) => {
      const inline = await toInlineData(image.url);
      const label = Number.isInteger(image.imageNumber) ? `Image ${String(image.imageNumber).padStart(3, "0")}` : "Image 未编号";
      return [
        { text: `参考 ${label}：` },
        { inlineData: { data: inline.data, mimeType: inline.mimeType } }
      ];
    }));

    let prompt = "";
    let lastPayload: unknown = null;
    let lastStatus = 200;
    let lastResponseOk = false;
    let outputStillInvalid = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = isAgnesTextModel(model)
        ? await fetch(`${settings.baseUrl}/v1/chat/completions`, {
          body: JSON.stringify({
            messages: [
              {
                content: [
                  {
                    type: "text",
                    text: attempt === 0
                      ? instruction
                      : `${instruction}\n\n上一次输出没有满足格式要求。${getRetryInstruction(outputMode)}`
                  },
                  ...(await Promise.all(images.map(async (image) => {
                    const label = Number.isInteger(image.imageNumber) ? `Image ${String(image.imageNumber).padStart(3, "0")}` : "Image 未编号";
                    return [
                      { type: "text", text: `参考 ${label}：` },
                      { type: "image_url", image_url: { url: await imageSourceForTask(image.url) } }
                    ];
                  }))).flat()
                ],
                role: "user"
              }
            ],
            model,
            temperature: attempt === 0 ? 0.35 : 0.2
          }),
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json"
          },
          method: "POST",
          signal: AbortSignal.timeout(180000)
        })
        : await fetch(`${settings.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
          body: JSON.stringify({
            contents: [
            {
              role: "user",
              parts: [
                {
                  text: attempt === 0
                    ? instruction
                    : `${instruction}\n\n上一次输出没有满足格式要求。${getRetryInstruction(outputMode)}`
                },
                ...imageParts.flat()
              ]
            }
          ],
          generationConfig: {
            ...(outputMode === "json" ? { responseMimeType: "application/json" } : {}),
            temperature: attempt === 0 ? 0.35 : 0.2
          }
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST",
        signal: AbortSignal.timeout(180000)
        });

      lastPayload = await response.json().catch(() => null) as unknown;
      lastStatus = response.status;
      lastResponseOk = response.ok;
      if (!response.ok) break;

      const rawText = getCandidateText(lastPayload);
      const normalized = normalizeFlexiblePrompt(rawText, outputMode);
      prompt = normalized;
      outputStillInvalid = isBadPromptOutput(rawText, normalized, outputMode);
      if (!outputStillInvalid) break;
    }

    if (!lastResponseOk) {
      return NextResponse.json({ error: formatProviderError(model, lastPayload, lastStatus) }, { status: lastStatus });
    }

    if (!prompt) {
      return NextResponse.json({ error: "AI 没有返回可用 Prompt。" }, { status: 502 });
    }

    if (outputStillInvalid) {
      return NextResponse.json({ error: `AI 输出没有满足 Output=${body.output ?? "Chinese"} 要求，请重试。` }, { status: 502 });
    }

    return NextResponse.json({
      prompt,
      debug: {
        imageCount: images.length,
        model,
        sourceNodeId: body.sourceNodeId
      }
    });
  } catch (error) {
    return NextResponse.json({ error: readCaughtError(error) }, { status: 500 });
  }
}
