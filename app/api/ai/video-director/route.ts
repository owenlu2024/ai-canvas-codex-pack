import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { normalizeHttpBaseUrl } from "@/lib/urlSafety";

interface RequestBody {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number }>;
  videos?: Array<{ videoNumber?: number; name?: string }>;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");

function autoShotCount(duration: number) {
  if (duration <= 10) return Math.max(2, Math.ceil(duration / 3));
  if (duration <= 30) return Math.ceil(duration / 5);
  if (duration <= 60) return Math.ceil(duration / 6);
  if (duration <= 120) return Math.ceil(duration / 7);
  return Math.min(30, Math.ceil(duration / 8));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    const rawModel = body.model?.trim() || "gemini-2.5-flash";
    const model = getBaseModelId(rawModel) || rawModel;
    const settings = await readApiSettings(settingsPath, {
      clientSettings: body.aiSettings,
      model: rawModel,
      normalizeBaseUrl: (value) => value.trim() ? normalizeHttpBaseUrl(value, "v1") : ""
    });
    if (!settings.baseUrl || !settings.apiKey) {
      return NextResponse.json({ error: "请先在设置中保存该模型对应的 AI 服务地址和 API Key。" }, { status: 400 });
    }
    const params = body.params ?? {};
    const duration = Math.min(180, Math.max(5, Number.parseInt(params.duration ?? "30", 10) || 30));
    const requestedShots = Number.parseInt(params.shotCount ?? "", 10);
    const shotCount = Number.isFinite(requestedShots) ? Math.min(30, Math.max(2, requestedShots)) : autoShotCount(duration);
    const imageManifest = (body.images ?? []).map((item) => `Image ${String(item.imageNumber ?? 0).padStart(3, "0")}`).join("、") || "无";
    const videoManifest = (body.videos ?? []).map((item) => `Video ${String(item.videoNumber ?? 0).padStart(3, "0")}（${item.name || "本地视频"}）`).join("、") || "无";
    const requestedScreenCopy = params.screenCopy ?? "不需要";
    const userExplicitlyRequestsText = /(?:画面|屏幕|标题|字幕|文案|口号|文字|logo).{0,12}(?:显示|出现|加入|添加|写入|保留|需要)|(?:显示|加入|添加|写入).{0,12}(?:标题|字幕|文案|文字|口号)/i.test(body.instruction ?? "");
    const allowScreenText = !["不需要", "自动生成"].includes(requestedScreenCopy) || userExplicitlyRequestsText;
    const screenTextInstruction = allowScreenText
      ? `只有用户明确指定的${requestedScreenCopy === "不需要" || requestedScreenCopy === "自动生成" ? "文字" : requestedScreenCopy}可以出现在画面中，不得自行增加其他标题、字幕、广告语、卖点文案、标签、水印、网址、二维码或占位文字。`
      : "所有分镜默认生成纯画面，除产品参考图上原有且必须保留的 Logo 外，画面内禁止出现任何标题、字幕、广告语、卖点文案、标签、额外品牌文字、水印、网址、二维码、占位文字或其他可读文字。";
    const system = `你是产品广告宣传片的视频大导演。必须输出严格 JSON，不要 Markdown。生成恰好 ${shotCount} 个独立分镜，总时长必须恰好 ${duration} 秒，每个镜头至少 1 秒。JSON 格式：{"prompt":"总策划摘要","schemes":[{"title":"分镜 1","prompt":"完整分镜提示"}]}。每个 prompt 必须包含：时间范围、秒数、使用素材、镜头目的、画面内容、产品锁定、运镜、动作、灯光、旁白、画面文字规则、声音、转场、可直接用于视频模型的生成 Prompt。${screenTextInstruction} 必须逐个判断每个分镜真正需要哪些前置图片：只有当该分镜画面需要出现产品、沿用指定场景或参考指定风格时，才在该分镜 prompt 中写入对应的 Image 001、Image 002 等编号；不得把所有前置图片机械地塞进每个分镜。产品特写应选择角度最匹配的产品图，场景镜头只选择必要的主产品图或场景参考图，纯环境、转场或氛围镜头可以不引用任何 Image。只要画面出现产品，就必须至少引用一张匹配的产品图片，并锁定产品外观、结构、比例、材质、颜色、Logo 和关键细节。若用户在前置 Prompt 中定义了主产品图、场景图或风格参考图，则严格按照用户定义选择和使用。不得把参考产品替换为无关产品，不要编造不存在的编号。用户对素材角色的定义优先级最高。`;
    const user = [`可用图片：${imageManifest}`, `可用视频：${videoManifest}`, `用户前置 Prompt：${body.instruction || "未提供，请智能策划"}`, `设置：${JSON.stringify({ duration, shotCount, aspectRatio: params.aspectRatio, adType: params.adType, pacing: params.pacing, productLock: params.productLock, outputLanguage: params.outputLanguage, creativeDirection: params.creativeDirection, voiceover: params.voiceover, screenCopy: params.screenCopy, detailLevel: params.detailLevel })}`].join("\n");
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" }, temperature: 0.7 }), signal: AbortSignal.timeout(180000) });
    const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(payload?.error?.message || `上游 API 错误 (${response.status})`);
    const text = payload?.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) as { prompt?: string; schemes?: unknown[] };
    if (!Array.isArray(parsed.schemes) || parsed.schemes.length !== shotCount) throw new Error(`模型没有返回 ${shotCount} 个完整分镜。`);
    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "视频大导演生成失败。" }, { status: 500 });
  }
}
