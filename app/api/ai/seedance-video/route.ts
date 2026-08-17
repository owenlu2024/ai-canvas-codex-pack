import { NextRequest, NextResponse } from "next/server";
import { getBaseModelId } from "@/lib/clientAiSettings";
import { readApiSettings, type StoredApiSettings } from "@/lib/serverAiSettings";
import { getCanvasDataPath } from "@/lib/serverPaths";
import { parseHttpUrl } from "@/lib/urlSafety";

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
const allowedModels = new Set(["seedance-2.0", "seedance-2.0-fast", "seedance-2.5"]);
const allowedRatios = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

function normalizeVideoApiRoot(value: string) {
  const url = parseHttpUrl(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/(?:v1|v2)(?:\/.*)?$/i, "").replace(/\/+$/, "");
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
      throw new Error(`所选 API 返回了网页而不是 JSON，请检查该 API 是否支持 Seedance 异步任务接口 (${response.status})。`);
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
  return [message, code ? `错误码：${String(code)}` : ""].filter(Boolean).join("；");
}

async function requestVideoApi(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
    }
  }
  throw new Error(lastError instanceof Error ? `无法连接所选 Seedance API：${lastError.message}` : "无法连接所选 Seedance API。");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RequestBody;
    const rawModel = body.model?.trim() ?? "";
    const model = getBaseModelId(rawModel) ?? "";
    if (!rawModel || !allowedModels.has(model)) {
      return NextResponse.json({ error: "请选择设置页实际读取到的 Seedance 视频模型。" }, { status: 400 });
    }
    const settings = await readApiSettings(settingsPath, {
      clientSettings: body.aiSettings,
      model: rawModel,
      normalizeBaseUrl: (value) => value.trim() ? normalizeVideoApiRoot(value) : ""
    });
    if (!settings.baseUrl || !settings.apiKey) {
      return NextResponse.json({ error: "请先在设置中为所选 Seedance 模型对应的 API 保存服务地址和 API Key。" }, { status: 400 });
    }
    const requestId = body.requestId?.trim() || crypto.randomUUID();
    const headers = {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
      "X-Request-ID": requestId
    };

    if (body.mode === "poll") {
      const taskId = body.taskId?.trim() ?? "";
      if (!taskId) return NextResponse.json({ error: "缺少 Seedance 任务 ID。" }, { status: 400 });
      const response = await requestVideoApi(taskStatusUrl(settings.baseUrl, taskId), {
        headers,
        method: "GET",
        signal: AbortSignal.timeout(60000)
      });
      const payload = await readJson(response);
      if (!response.ok) return NextResponse.json({ error: upstreamError(payload, `12API 查询失败 (${response.status})`) }, { status: response.status });
      const status = String(payload.status ?? payload.phase ?? "").toLowerCase();
      const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
      const videoUrl = outputs.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)) ?? "";
      if (videoUrl) return NextResponse.json({ requestId, status: "succeeded", videoUrl });
      if (status === "failed" || status === "fail" || status === "cancelled") {
        return NextResponse.json({ error: upstreamError(payload, "Seedance 视频生成失败。"), status }, { status: 422 });
      }
      if (status === "completed") return NextResponse.json({ error: "Seedance 任务已完成，但没有返回视频地址。" }, { status: 502 });
      return NextResponse.json({ requestId, status: status || "queued" }, { status: 202 });
    }

    const params = body.params ?? {};
    const prompt = body.prompt?.trim() ?? "";
    const generationType = params.generationType ?? "text";
    const ratio = params.ratio ?? "16:9";
    const resolution = params.resolution ?? "720p";
    const duration = Number.parseInt(params.duration ?? "4", 10);
    const durationMax = model === "seedance-2.5" ? 30 : 15;
    const imageLimit = model === "seedance-2.5" ? 30 : 4;
    const videoLimit = model === "seedance-2.5" ? 10 : 3;
    const images = (body.images ?? []).filter((item): item is { imageNumber?: number; url: string } => typeof item.url === "string" && Boolean(item.url));
    const videos = (body.videos ?? []).filter((item): item is { name?: string; videoNumber?: number; url: string } => typeof item.url === "string" && Boolean(item.url));

    if (!prompt) return NextResponse.json({ error: "请先连接 Prompt 文本节点。" }, { status: 400 });
    if (!allowedRatios.has(ratio)) return NextResponse.json({ error: "Seedance 画面比例不符合官方范围。" }, { status: 400 });
    if (resolution !== "720p") return NextResponse.json({ error: "当前 Seedance 模型仅支持 720p。" }, { status: 400 });
    if (!Number.isInteger(duration) || duration < 4 || duration > durationMax) return NextResponse.json({ error: `当前 Seedance 模型视频时长只能是 4–${durationMax} 秒。` }, { status: 400 });
    if (generationType === "text" && (images.length || videos.length)) return NextResponse.json({ error: "文生视频模式不能连接参考图片或视频。" }, { status: 400 });
    if (generationType === "reference" && !images.length && !videos.length) return NextResponse.json({ error: "参考素材生视频至少需要连接 1 张图片或 1 条视频。" }, { status: 400 });
    if (generationType === "reference" && images.length > imageLimit) return NextResponse.json({ error: `当前模型最多支持 ${imageLimit} 张参考图片。` }, { status: 400 });
    if (generationType === "reference" && videos.length > videoLimit) return NextResponse.json({ error: `当前模型最多支持 ${videoLimit} 条参考视频。` }, { status: 400 });
    if (generationType === "firstLast" && images.length !== 2) return NextResponse.json({ error: "首尾帧生视频必须且只能连接 2 张图片。" }, { status: 400 });
    if (generationType === "firstLast" && videos.length) return NextResponse.json({ error: "首尾帧模式不能同时连接普通参考视频。" }, { status: 400 });

    const input: Record<string, unknown> = {
      aspect_ratio: ratio,
      audio: params.audio !== "false",
      duration,
      n: 1,
      prompt,
      resolution
    };
    if (generationType === "reference") {
      if (images.length) input.image_references = images.map((item) => item.url);
      if (videos.length) input.video_references = videos.map((item) => item.url);
    }
    if (generationType === "firstLast") {
      input.start_frames = [images[0].url];
      input.end_frames = [images[1].url];
    }

    const response = await requestVideoApi(taskSubmitUrl(settings.baseUrl), {
      body: JSON.stringify({ input, model }),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(180000)
    });
    const payload = await readJson(response);
    if (!response.ok) return NextResponse.json({ error: upstreamError(payload, `12API 提交失败 (${response.status})`) }, { status: response.status });
    const taskId = typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : "";
    const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
    const videoUrl = outputs.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)) ?? "";
    if (!taskId && !videoUrl) return NextResponse.json({ error: "12API 没有返回任务 ID 或视频地址。" }, { status: 502 });
    return NextResponse.json({ requestId, taskId, videoUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Seedance 视频请求失败。" }, { status: 500 });
  }
}
