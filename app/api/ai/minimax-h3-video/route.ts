import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { parseHttpUrl } from "@/lib/urlSafety";
import { looksLikeUnparsedJsonPrompt, normalizeMinimaxH3Prompt } from "@/lib/minimaxH3Prompt";

interface RequestBody {
  aiSettings?: StoredApiSettings;
  images?: Array<{ imageNumber?: number; url?: string }>;
  mode?: "submit" | "poll";
  model?: string;
  params?: Record<string, string>;
  prompt?: string;
  requestId?: string;
  taskId?: string;
  videos?: Array<{ name?: string; videoNumber?: number; url?: string }>;
}

const settingsPath = getCanvasDataPath("api-settings.local.json");
const max12ApiPromptLength = 5000;
const safe12ApiPromptLength = 4800;
const allowedAspectRatios = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

function normalizeVideoApiRoot(value: string) {
  const url = parseHttpUrl(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/(?:v1|v2)(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function taskSubmitUrl(baseUrl: string) {
  return `${baseUrl}/v1/task/submit`;
}

function taskStatusUrl(baseUrl: string, taskId: string) {
  return `${baseUrl}/v1/task/${encodeURIComponent(taskId)}`;
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error(`所选 API 返回了网页而不是 JSON，请检查该 API 是否支持 MiniMax-H3 任务接口 (${response.status})。`);
    }
    throw new Error(text.trim().slice(0, 180) || `上游 API 返回格式异常 (${response.status})`);
  }
}

function upstreamError(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error;
  const errorObject = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = typeof error === "string"
    ? error
    : typeof errorObject?.message === "string"
      ? errorObject.message
      : typeof payload.message === "string"
        ? payload.message
        : fallback;
  const code = errorObject?.code ?? errorObject?.type ?? payload.code ?? payload.type;
  const requestId = payload.request_id ?? payload.requestId;
  const details = errorObject?.details ?? payload.details;
  return [
    message,
    code ? `错误码：${String(code)}` : "",
    requestId ? `请求 ID：${String(requestId)}` : "",
    details ? `详情：${typeof details === "string" ? details : JSON.stringify(details).slice(0, 500)}` : ""
  ].filter(Boolean).join("；");
}

function compactPromptFor12Api(value: string) {
  const prompt = value.trim();
  if (prompt.length <= max12ApiPromptLength) return { prompt, trimmed: false };
  const candidate = prompt.slice(0, safe12ApiPromptLength);
  const paragraphBreak = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"));
  return {
    prompt: (paragraphBreak >= Math.floor(safe12ApiPromptLength * 0.75) ? candidate.slice(0, paragraphBreak) : candidate).trim(),
    trimmed: true
  };
}

async function requestVideoApi(url: string, init: RequestInit) {
  let lastError: unknown;
  const errors: string[] = [];
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      const code = error instanceof Error && "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause
        ? String(error.cause.code)
        : error instanceof Error ? error.name : "UNKNOWN";
      errors.push(code);
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
      }
    }
  }
  const cause = lastError instanceof Error && "cause" in lastError && lastError.cause && typeof lastError.cause === "object" && "code" in lastError.cause
    ? String(lastError.cause.code)
    : "";
  const attempts = errors.length ? `，${errors.length} 次连接结果：${errors.join(" → ")}` : "";
  throw new Error(`无法连接所选 MiniMax-H3 API${cause ? `（${cause}）` : ""}${attempts}。`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    const requestId = body.requestId?.trim() || crypto.randomUUID();
    const rawModel = body.model?.trim() ?? "";
    const model = getBaseModelId(rawModel) ?? "";
    if (!rawModel || !/h3/i.test(model)) {
      return NextResponse.json({ error: "请选择设置页实际读取到的 MiniMax-H3 模型。" }, { status: 400 });
    }
    const settings = await readApiSettings(settingsPath, {
      clientSettings: body.aiSettings,
      model: rawModel,
      normalizeBaseUrl: (value) => value.trim() ? normalizeVideoApiRoot(value) : ""
    });
    if (!settings.baseUrl || !settings.apiKey) {
      return NextResponse.json({ error: "请先在设置中为所选模型对应的 API 保存服务地址和 API Key。" }, { status: 400 });
    }
    const headers = {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
      "X-Request-ID": requestId
    };
    console.info("[minimax-h3-video] request received", {
      mode: body.mode ?? "submit",
      model: rawModel,
      requestId,
      selectedApiRoot: settings.baseUrl
    });
    if (body.mode === "poll") {
      if (!body.taskId?.trim()) return NextResponse.json({ error: "缺少 MiniMax H3 任务 ID。" }, { status: 400 });
      const response = await requestVideoApi(taskStatusUrl(settings.baseUrl, body.taskId), {
        headers,
        method: "GET",
        signal: AbortSignal.timeout(60000)
      });
      const payload = await readJson(response);
      if (!response.ok) return NextResponse.json({ error: upstreamError(payload, `12API 查询失败 (${response.status})`) }, { status: response.status });
      const status = String(payload.status ?? payload.phase ?? "").toLowerCase();
      const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
      const videoUrl = outputs.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)) ?? "";
      if (videoUrl || status === "completed") return NextResponse.json({ requestId, status: "succeeded", videoUrl });
      if (status === "failed" || status === "fail" || status === "cancelled") return NextResponse.json({ error: upstreamError(payload, "MiniMax H3 视频生成失败。"), status }, { status: 422 });
      return NextResponse.json({ requestId, status: status || "queued" }, { status: 202 });
    }

    const params = body.params ?? {};
    const generationType = params.generationType ?? "text";
    const originalPrompt = normalizeMinimaxH3Prompt(body.prompt?.trim() ?? "");
    const { prompt, trimmed: promptTrimmed } = compactPromptFor12Api(originalPrompt);
    if (!prompt) return NextResponse.json({ error: "Prompt 不能为空。" }, { status: 400 });
    if (looksLikeUnparsedJsonPrompt(prompt)) return NextResponse.json({ error: "H3 Prompt 必须是纯文本，不能是 JSON。请重新运行 MiniMax H3 提示词节点。" }, { status: 400 });
    const images = (body.images ?? []).filter((item) => item.url);
    const videos = (body.videos ?? []).filter((item) => item.url);
    if (videos.length) return NextResponse.json({ error: "12API 的 MiniMax-H3 当前不支持参考视频，请改用参考图片。" }, { status: 400 });
    if (!allowedAspectRatios.has(params.ratio ?? "16:9")) return NextResponse.json({ error: "MiniMax-H3 画面比例只允许 21:9、16:9、4:3、1:1、3:4 或 9:16。" }, { status: 400 });
    const requestedDuration = Number.parseInt(params.duration ?? "5", 10);
    if (!Number.isInteger(requestedDuration) || requestedDuration < 5 || requestedDuration > 15) return NextResponse.json({ error: "MiniMax-H3 视频时长只能是 5–15 秒。" }, { status: 400 });
    if (generationType === "text" && images.length) return NextResponse.json({ error: "文生视频模式不能连接参考图片；请断开图片或改为多模态生视频。" }, { status: 400 });
    if (generationType === "firstLast" && images.length !== 2) return NextResponse.json({ error: "首尾帧模式必须且只能连接 2 张图片。" }, { status: 400 });
    if (generationType === "multimodal" && (images.length < 1 || images.length > 5)) return NextResponse.json({ error: "多模态模式必须连接 1–5 张参考图片。" }, { status: 400 });
    const input: Record<string, unknown> = {
      aspect_ratio: params.ratio || "16:9",
      audio: true,
      duration: requestedDuration,
      n: 1,
      prompt,
      resolution: "2K"
    };
    if (generationType === "firstLast") {
      input.start_frames = [{ url: images[0].url as string }];
      input.end_frames = [{ url: images[1].url as string }];
    } else if (generationType === "multimodal") {
      input.image_references = images.slice(0, 5).map((item) => ({ strength: "MID", url: item.url as string }));
    }
    const submitUrl = taskSubmitUrl(settings.baseUrl);
    const response = await requestVideoApi(submitUrl, {
      body: JSON.stringify({ input, model: "MiniMax-H3" }),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(180000)
    });
    const payload = await readJson(response);
    if (!response.ok) {
      console.error("[minimax-h3-video] submit rejected", {
        generationType,
        imageCount: images.length,
        imageKinds: images.map((item) => item.url?.startsWith("data:") ? "data-uri" : item.url?.startsWith("http") ? "remote-url" : "other"),
        model: "MiniMax-H3",
        endpoint: submitUrl,
        payload,
        promptLength: originalPrompt.length,
        promptTrimmed,
        requestId,
        status: response.status,
        submittedPromptLength: prompt.length
      });
      const reason = upstreamError(payload, `12API 提交失败 (${response.status})`);
      return NextResponse.json({
        error: `${reason}；请求编号：${requestId}；提交路径：${submitUrl}；参数：MiniMax-H3 / ${String(input.aspect_ratio)} / 2K / ${String(input.duration)} 秒 / ${images.length} 张参考图`
      }, { status: response.status });
    }
    const taskId = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
    const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
    const videoUrl = outputs.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)) ?? "";
    if (!taskId && !videoUrl) return NextResponse.json({ error: "12API 没有返回任务 ID 或视频地址。" }, { status: 502 });
    return NextResponse.json({ promptTrimmed, requestId, taskId, videoUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "MiniMax H3 视频请求失败。" }, { status: 500 });
  }
}
