import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { normalizeHttpBaseUrl } from "@/lib/urlSafety";
import { normalizeMinimaxH3Prompt } from "@/lib/minimaxH3Prompt";

interface RequestBody {
  aiSettings?: StoredApiSettings;
  instruction?: string;
  model?: string;
  params?: Record<string, string>;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");

const systemPrompt = `你是 MiniMax H3 视频提示词规划节点。依据 MiniMax-H3 官方 VIDEO_PROMPT_WRITING_GUIDE_base_en 与 VIDEO_PROMPT_WRITING_GUIDE_ref_en，将用户输入扩展成一个可直接交给 H3 的完整 Prompt。不得解释规则，不得输出多个版本，不得虚构用户没有提供的素材、编号、对白、歌词、品牌信息或画面文字。

一、模式判断
1. 纯文本使用 T2VA。
2. 明确将一张图作为第 0 秒首帧使用 I2VA。
3. 明确首帧和尾帧使用 FL2VA。
4. 明确将一张图作为最终帧使用 L2VA。
5. 多图参考、参考视频、参考音频、视频编辑或续写使用 Full-Reference。
用户没有说明参考素材时，禁止自行创建 Picture、Video、Audio 或 Subject 编号。

二、基础模式输出
T2VA、I2VA、FL2VA、L2VA 必须依次输出 integrated_multimodal_description、overall_soundscape、non_diegetic_music。
I2VA 首行必须使用官方 0.00 秒 Picture 1 对齐指令；FL2VA 首行必须声明 Picture 1 对齐 0.00 秒、Picture 2 对齐实际结尾时间；L2VA 首行必须声明 Picture 1 对齐实际结尾时间。对齐指令后空一行。
I2VA 从参考首帧的主体、构图和空间关系连续向后发展；FL2VA 描述首尾帧之间可观察的连续运动路径，默认优先单镜头；L2VA 从合理的前置状态逐步收敛到参考尾帧。

三、镜头时间线
[Shot 1] 不带时间戳，必须建立风格、构图、主体、场景与初始动作。后续镜头严格使用 [Shot N] At MM:SS.mmm, ...，时间递增且不得超过用户指定时长。切镜只用于提供新的主体、空间、状态、视角或时间信息；轻微景别与角度变化优先使用运镜。
运镜必须写成自然英文动作，可使用 Zoom In/Out、Push In/Pull Out、Pan Left/Right、Truck Left/Right、Tilt Up/Down、Pedestal Up/Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly/Strongly、POV、Roll Clockwise/Counterclockwise，并在有意义时补充 with small/large amplitude 与 at slow/fast speed，不得堆成标签列表。

四、对白、文字和声音
发声者使用稳定的 (S1)、(S2) 编号，跨镜头不得改变。对白与歌词严格使用 <d>[Language] 用户原文</d>，不得翻译或改写。画外音使用 says in an off-screen voiceover，并说明对应画面人物 lips remain completely closed。跨切镜连续对白使用 <scenetrans> 并说明声音连续；结尾截断使用 <cutoff>。
画面可见文字仅在用户明确要求时出现，必须用英文双引号包住并保留原文。默认禁止自行增加标题、字幕、口号、标签、水印、网址、二维码或其他可读文字。
overall_soundscape 使用 1–4 句英文描述环境声、动作声与非语言人声，不重复对白或歌词；用户明确要求全程无声时才写 N/A。non_diegetic_music 使用 1–3 句英文描述观众可听、角色不可听的配乐乐器、速度、节奏与动态；无配乐写 N/A。

五、Full-Reference
严格依次输出 subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music，六段均以英文撰写，只有对白、歌词和真实可见文字保留原语言。
<Subject N> 只定义实际复用的可见人物、物体、场景、服装、风格、动作或效果；<Picture N> 只在图片作为首帧、关键帧、尾帧、编辑帧、构图锚点或分镜规划时独立定义；<Video N> 只表示编辑源、续写起点或整段时间结构；<Audio N> 只表示实际复制或参考的独立音频关系。标签一旦定义，在所有段落保持同一含义，Picture、Video、Audio 各自独立编号。
summary 必须以官方任务类型开头：[keyframe completion]、[reference generation]、[video editing]、[video continuation]、[audio reuse]、[audio reference]，多项用 + 组合，不得因为存在媒体就机械添加任务类型。
retention_analysis 必须逐项使用正确关系：可见内容使用 fully_preserved、partially_preserved、attribute_transfer、weak_reference；音频使用 fully_copy、partially_copy、reference、weak_reference。不得把新增背景或动作误判为参考损失。
detailed_description 在 [Shot 1] 前用 1–2 句英文建立整体风格；逐镜说明构图、主体外观与位置、环境、灯光、动作变化、运镜、声音及引用实际生效的位置。生成任务通常保持足够明确的 350–500 英文词信息量，不能退化为剧情摘要或引用清单。

六、最终校验
描述主体使用英文；用户提供的对白、歌词、画面文字保留原语言。确保 Shot 编号连续、时间戳递增、说话人和引用标签稳定、声音分类正确、没有新增可读文字。保留用户全部明确约束，只补充可观察、可生成的镜头、动作、连续性、灯光和声音细节。

长度硬限制：最终 prompt 必须不超过 4500 个字符。优先保留素材定义、镜头主体、动作、时间线和关键声音信息；删减重复形容词、重复外观描述和非必要解释，绝不能因为压缩而截断句子或破坏标签、镜头编号。

技术返回格式：最终只输出合法 JSON 对象 {"prompt":"完整 MiniMax H3 Prompt"}。prompt 内只放最终 Prompt，不要 Markdown、分析、解释或候选方案。`;

function extractText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object" && "text" in content && typeof content.text === "string") return content.text.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "").join("").trim();
  return "";
}

async function requestCompletion(url: string, init: RequestInit) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  const cause = lastError instanceof Error && "cause" in lastError && lastError.cause && typeof lastError.cause === "object" && "code" in lastError.cause
    ? String(lastError.cause.code)
    : "";
  throw new Error(`无法连接所选 LLM 的 API 服务${cause ? `（${cause}）` : ""}，请检查服务地址、网络或稍后重试。`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    const instruction = body.instruction?.trim() ?? "";
    if (!instruction) return NextResponse.json({ error: "请先连接 Prompt 文本节点。" }, { status: 400 });
    const rawModel = body.model?.trim() || "gemini-2.5-flash";
    const model = getBaseModelId(rawModel) || rawModel;
    const settings = await readApiSettings(settingsPath, {
      clientSettings: body.aiSettings,
      model: rawModel,
      normalizeBaseUrl: (value) => value.trim() ? normalizeHttpBaseUrl(value, "v1") : ""
    });
    if (!settings.baseUrl || !settings.apiKey) return NextResponse.json({ error: "请先在设置中保存所选 LLM 对应的服务地址和 API Key。" }, { status: 400 });

    const params = body.params ?? {};
    const userPrompt = [
      `用户原始 Prompt：${instruction}`,
      `指定生成模式：${params.mode || "自动判断"}`,
      `目标视频时长：${params.duration || "5"} 秒`,
      `镜头结构：${params.shotStructure || "自动"}`,
      `声音策略：${params.soundStrategy || "自动规划"}`,
      "画面文字规则：除非用户原始 Prompt 明确指定，否则禁止生成任何可读文字。",
      "必须将以上面板设置落实到最终 Prompt；若模式所需素材关系未在用户 Prompt 中定义，不得虚构素材编号。"
    ].join("\n");
    const response = await requestCompletion(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      body: JSON.stringify({
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        model,
        response_format: { type: "json_object" },
        temperature: 0.45
      }),
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(180000)
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "object" && payload.error && "message" in payload.error && typeof payload.error.message === "string" ? payload.error.message : `上游 API 错误 (${response.status})`;
      return NextResponse.json({ error: `模型 ${rawModel} 当前不可用：${message}` }, { status: response.status });
    }
    const rawPrompt = normalizeMinimaxH3Prompt(extractText(payload));
    const prompt = rawPrompt.length > 4800
      ? rawPrompt.slice(0, Math.max(rawPrompt.lastIndexOf("\n", 4800), 4500)).trim()
      : rawPrompt;
    if (prompt.length < 40) throw new Error("LLM 没有返回足够完整的 MiniMax H3 Prompt，请更换 LLM 模型后重试。");
    return NextResponse.json({ prompt });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "MiniMax H3 提示词生成失败。" }, { status: 500 });
  }
}
