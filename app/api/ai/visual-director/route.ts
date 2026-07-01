import { NextRequest, NextResponse } from "next/server";

interface VisualDirectorRequest {
  images?: Array<{ imageNumber?: number; title?: string; url?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
  sourceNodeId?: string;
}

function normalizeLanguage(value?: string) {
  if (value === "English") return "English";
  return "Bilingual Chinese and English";
}

function getStyleReferenceLabel(instruction: string, labels: string[]) {
  const normalized = instruction.toLowerCase().replace(/[<>@\s_-]/g, "");
  const stylePattern = /风格参考|参考风格|风格图|stylereference|referencestyle/;
  const mentionsStyleReference = stylePattern.test(normalized);
  if (!mentionsStyleReference) return { label: "", mentionsStyleReference: false };

  const styleOffsets = [...normalized.matchAll(/风格参考|参考风格|风格图|stylereference|referencestyle/g)].map((match) => match.index);
  const scoredLabels = labels.map((candidate) => {
    const number = Number.parseInt(candidate.replace(/\D/g, ""), 10);
    const tokens = [`image${number}`, `image${String(number).padStart(3, "0")}`];
    let score = Number.POSITIVE_INFINITY;
    tokens.forEach((token) => {
      let offset = normalized.indexOf(token);
      while (offset >= 0) {
        styleOffsets.forEach((styleOffset) => {
          score = Math.min(score, Math.abs(styleOffset - offset));
        });
        offset = normalized.indexOf(token, offset + token.length);
      }
    });
    return { label: candidate, score };
  }).sort((a, b) => a.score - b.score);
  const bestMatch = scoredLabels[0];
  return { label: bestMatch && bestMatch.score <= 80 ? bestMatch.label : "", mentionsStyleReference: true };
}

function buildBoardPrompt(body: VisualDirectorRequest, labels: string[], analysis: string, styleReferenceLabel: string) {
  const language = normalizeLanguage(body.params?.outputLanguage);
  const englishOnly = language === "English";
  const ratio = body.params?.aspectRatio ?? "9:16";
  const imageCount = Math.min(6, Math.max(1, Number.parseInt(body.params?.imageCount ?? "1", 10) || 1));
  const languageRule = englishOnly
    ? "LANGUAGE HARD RULE: Every visible word, title, subtitle, label, annotation, font specimen, diagram caption, and keyword on the board must be English only. Do not render Chinese, CJK glyphs, bilingual labels, or Chinese punctuation anywhere. The user brief is semantic guidance only; never copy its original wording onto the board."
    : "LANGUAGE HARD RULE: Use Chinese as the dominant primary language and English only as supporting translation. Every visible title, subtitle, label, annotation, font specimen, diagram caption, and keyword must show prominent Chinese first, with a smaller, lighter, visually secondary English translation beside or below it. Chinese must use larger type, stronger weight, and higher visual priority. Never give Chinese and English equal emphasis, and do not produce Chinese-only sections.";
  const sections = englishOnly
    ? [
        "01 Title — Brand Visual Guideline / Visual Guideline Board and concise positioning.",
        "02 Color System — primary, secondary, accent, and background swatches, each with a readable HEX value.",
        "03 Typography — heading, body, and numeric font recommendations with English specimen text.",
        "04 Information Hierarchy — H1, H2, body, and parameter scale relationship.",
        "05 Composition — clear wireframe for title, product, selling points, parameters, and ending zones.",
        "06 Image-to-Text Ratio — a simple visual ratio diagram with percentages.",
        "07 Iconography — consistent linear, rounded, minimalist icon examples.",
        "08 Whitespace — compact, standard, or premium whitespace demonstration, highlighting the chosen level.",
        "09 Page Rhythm — reading-flow diagram covering strong point, weak point, information interleave, and visual pause.",
        "10 Visual DNA — six concise English keyword chips."
      ]
    : [
        "01 标题区 / Title — prominent Chinese 品牌视觉规范 as the primary title, with smaller English Brand Visual Guideline and concise bilingual positioning.",
        "02 色彩系统 / Color System — 主色、辅助色、强调色、背景色 / primary, secondary, accent, and background swatches with HEX values.",
        "03 字体规范 / Typography — 标题、正文、数字字体 / heading, body, and numeric fonts with bilingual specimen text.",
        "04 信息层级 / Information Hierarchy — 一级标题、二级标题、正文、参数文字 / H1, H2, body, and parameter scale.",
        "05 构图规范 / Composition — 标题、产品、卖点、参数、结尾区 / title, product, selling points, parameters, and ending-zone wireframe.",
        "06 图文比例 / Image-to-Text Ratio — bilingual ratio diagram with percentages.",
        "07 图标规范 / Iconography — 线性、圆角、极简图标 / linear, rounded, minimalist icon examples.",
        "08 留白规范 / Whitespace — 紧凑、标准、高级留白 / compact, standard, and premium whitespace demonstration.",
        "09 页面节奏 / Page Rhythm — 强卖点、弱卖点、信息穿插、视觉停顿 / strong point, weak point, information interleave, and visual pause.",
        "10 视觉关键词 / Visual DNA — six bilingual keyword chips."
      ];
  const referenceManifest = labels.map((label, index) => `Attached image ${index + 1} = ${label}${index === 0 ? " (main product by default)" : label === styleReferenceLabel ? " (mandatory style reference)" : " (supporting reference)"}.`).join("\n");
  const styleRule = styleReferenceLabel
    ? [
        `MANDATORY STYLE REFERENCE: ${styleReferenceLabel}.`,
        `The visual language of every output board must visibly follow ${styleReferenceLabel}. Extract and apply its color relationships, typography mood, grid and alignment logic, information density, icon treatment, corner language, whitespace, image treatment, and overall art direction.`,
        `Use ${styleReferenceLabel} for visual style only. Do not replace or distort the main product with content from the style reference, and do not copy its brand name, logo, product, or exact text.`,
        `A reviewer must be able to recognize the influence of ${styleReferenceLabel} in the final board. Ignoring it is not allowed.`
      ].join("\n")
    : "No explicit style-reference image was assigned. Derive the visual direction from the main product, supporting references, and user brief.";
  return [
    `Create ${imageCount === 1 ? "one" : imageCount} polished Visual Guideline Board${imageCount === 1 ? "" : " variations"}, not detail pages and not marketing posters.`,
    imageCount > 1 ? "Every generated image must be a complete, self-contained guideline board containing all ten required sections. Do not split sections across images. Vary the complete visual direction while preserving the same product and brand brief." : "The generated image must be a complete, self-contained guideline board containing all ten required sections.",
    `Canvas aspect ratio: ${ratio}. Board language: ${language}.`,
    languageRule,
    `REFERENCE ATTACHMENT MAP:\n${referenceManifest}`,
    `Use ${labels[0]} as the main product reference. Preserve the real product silhouette, proportions, materials, logo, and recognizable details. Supporting references: ${labels.slice(1).join(", ") || "none"}.`,
    styleRule,
    englishOnly ? "Title area must read: Brand Visual Guideline / Visual Guideline Board." : "Title area must use prominent Chinese 品牌视觉规范 as the main title, with smaller secondary English Brand Visual Guideline / Visual Guideline Board.",
    "Present the board as a premium design-system presentation with a precise grid, high legibility, restrained decoration, and generous alignment.",
    "Every board must visibly contain these ten numbered sections:",
    ...sections,
    "Include the main product image as a controlled reference specimen inside the board, not as a hero advertisement.",
    "Do not generate a full e-commerce detail page, Amazon A+, Taobao page, independent-site poster, final campaign image, or Prompt Pack.",
    "Do not add price, CTA, purchase button, fake campaign copy, multiple page mockups, or unrelated lifestyle scenes.",
    `Approved visual-direction analysis:\n${analysis}`,
    "Render as a finished, presentation-ready visual standards board with crisp typography, accurate swatches, clean vector-like diagrams, and professional art direction.",
    languageRule
  ].join("\n\n");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as VisualDirectorRequest;
    const images = (body.images ?? []).filter((image): image is { imageNumber?: number; title?: string; url: string } => typeof image.url === "string" && Boolean(image.url));
    if (!images.length) return NextResponse.json({ error: "请至少连接 1 张产品图片。" }, { status: 400 });

    const labels = images.map((image, index) => `<Image${String(Number.isInteger(image.imageNumber) ? image.imageNumber : index + 1).padStart(3, "0")}>`);
    const styleReference = getStyleReferenceLabel(body.instruction ?? "", labels);
    if (styleReference.mentionsStyleReference && !styleReference.label) {
      return NextResponse.json({ error: "请在 Prompt 中明确指定已连接的风格参考图编号，例如：Image 004 是风格参考图。" }, { status: 400 });
    }
    const analysis = body.instruction?.trim()
      ? `User-approved visual brief: ${body.instruction.trim()}`
      : "Analyze the connected product references directly and define the most commercially appropriate visual direction, including concrete fonts, HEX colors, hierarchy, composition, whitespace, icons, and page rhythm.";

    return NextResponse.json({
      prompt: buildBoardPrompt(body, labels, analysis, styleReference.label),
      debug: { imageCount: images.length, sourceNodeId: body.sourceNodeId, styleReference: styleReference.label || undefined }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Visual Director 生成失败。";
    return NextResponse.json({ error: /fetch failed|timeout|ECONNREFUSED|ENOTFOUND/i.test(message) ? "AI 服务连接失败，请检查设置或网络。" : message }, { status: 500 });
  }
}
