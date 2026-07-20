"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import type { Node, NodeProps } from "@xyflow/react";
import { getBaseModelId, getClientAiSettingsPayload, readClientAiSettings } from "@/lib/clientAiSettings";
import { getImageDisplayUrl } from "@/lib/imageDisplayUrl";
import { type CanvasNodeData } from "@/lib/nodeTypes";
import { buildVisibleTextPromptRichHtml } from "@/lib/promptHighlight";
import { NodeActions } from "@/components/nodes/shared/NodeActions";
import { NodeHeader } from "@/components/nodes/shared/NodeHeader";
import { NodePortLayer } from "@/components/nodes/shared/NodePortLayer";
import { NodeShell } from "@/components/nodes/shared/NodeShell";
import {
  defaultGenerateImageModelId,
  defaultGridImageModelId,
  defaultIndustrialDesignImageModelId,
  defaultProductRemixModelId,
  defaultSceneImageModelId,
  generateImageModelSpecs,
  getDefaultGenerateImageParams,
  getDefaultGridImageParams,
  getDefaultIndustrialDesignImageParams,
  getDefaultProductRemixParams,
  getDefaultSceneImageParams,
  getGenerateImageModelSpec,
  getGridImageModelSpec,
  getIndustrialDesignImageModelSpec,
  getProductRemixModelSpec,
  getSceneImageModelSpec,
  gridImageModelSpecs,
  industrialDesignImageModelSpecs,
  productRemixModelSpecs,
  sceneImageModelSpecs
} from "@/lib/generateImageModels";
import { useCanvasStore } from "@/store/canvasStore";
import { downloadImageToFile } from "@/lib/downloadImage";
import { isVideoModel } from "@/lib/modelClassification";

interface StoredApiSettings {
  imageModels: string[];
  textModels: string[];
}

const promptPlannerModelOptions = ["gemini-2.5-flash", "gemini-3.1-flash-lite-preview", "agnes-2.0-flash"];
const generateImageModelIds = generateImageModelSpecs.map((model) => model.id);
const gridImageModelIds = gridImageModelSpecs.map((model) => model.id);
const sceneImageModelIds = sceneImageModelSpecs.map((model) => model.id);
const industrialDesignImageModelIds = industrialDesignImageModelSpecs.map((model) => model.id);
const productRemixModelIds = productRemixModelSpecs.map((model) => model.id);
const openPromptEditorEvent = "ai-canvas-open-prompt-editor";

function useConfiguredModels(kind: "image" | "text", fallbackOptions: string[]) {
  const [models, setModels] = useState<string[]>(fallbackOptions);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const loadModels = () => {
      try {
        const saved = readClientAiSettings();
        const configuredModels = kind === "image" ? saved?.imageModels ?? [] : saved?.textModels ?? [];
        setModels(configuredModels.length ? configuredModels : fallbackOptions);
      } catch {
        setModels(fallbackOptions);
      } finally {
        setLoaded(true);
      }
    };
    loadModels();
    window.addEventListener("ai-canvas-api-settings-updated", loadModels);
    window.addEventListener("storage", loadModels);
    return () => {
      window.removeEventListener("ai-canvas-api-settings-updated", loadModels);
      window.removeEventListener("storage", loadModels);
    };
  }, [fallbackOptions, kind]);

  return { loaded, models };
}

function useConfiguredImageModels(fallbackOptions: string[], currentModel?: string) {
  const { loaded, models } = useConfiguredModels("image", fallbackOptions);
  const fallbackSet = useMemo(() => new Set(fallbackOptions), [fallbackOptions]);
  return useMemo(() => {
    const filtered = models.filter((model) => {
      const baseModel = getBaseModelId(model);
      return typeof baseModel === "string" && fallbackSet.has(baseModel);
    });
    if (!loaded && currentModel && fallbackSet.has(getBaseModelId(currentModel) ?? "") && !filtered.includes(currentModel)) {
      return [currentModel, ...filtered];
    }
    return filtered.length ? filtered : fallbackOptions;
  }, [currentModel, fallbackOptions, fallbackSet, loaded, models]);
}

function useConfiguredTextModels(fallbackOptions: string[], currentModel?: string) {
  const { loaded, models } = useConfiguredModels("text", fallbackOptions);
  return useMemo(() => {
    const filtered = models.filter((model) => !isVideoModel(model));
    if (!loaded && currentModel && !isVideoModel(currentModel) && !filtered.includes(currentModel)) return [currentModel, ...filtered];
    return filtered;
  }, [currentModel, loaded, models]);
}

function usePromptPlannerModel(data: CanvasNodeData) {
  const modelOptions = useConfiguredTextModels(promptPlannerModelOptions, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const modelId = typeof data.modelId === "string" && modelOptions.includes(data.modelId) ? data.modelId : modelOptions[0] ?? "gemini-2.5-flash";
  return { modelDisplayName, modelId, modelOptions };
}

function getModelDisplayName(model: string, options: string[]) {
  const baseModel = getBaseModelId(model) ?? model;
  const sameBaseCount = options.filter((option) => (getBaseModelId(option) ?? option) === baseModel).length;
  return sameBaseCount > 1 ? model : baseModel;
}

export function BaseNode({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runAiPromptNode = useCanvasStore((state) => state.runAiPromptNode);
  const runSceneDirectorNode = useCanvasStore((state) => state.runSceneDirectorNode);
  const runTaobaoPageDirectorNode = useCanvasStore((state) => state.runTaobaoPageDirectorNode);
  const runIndustrialDesignerNode = useCanvasStore((state) => state.runIndustrialDesignerNode);
  const runProductPosterNode = useCanvasStore((state) => state.runProductPosterNode);
  const runVisualDirectorNode = useCanvasStore((state) => state.runVisualDirectorNode);
  const runGenerateImageNode = useCanvasStore((state) => state.runGenerateImageNode);
  const stopGenerateImageNode = useCanvasStore((state) => state.stopGenerateImageNode);
  const setImagePreviewUrl = useCanvasStore((state) => state.setImagePreviewUrl);
  const hiddenAutoImageInputCount = useCanvasStore((state) => {
    if (state.showAutoImageLinks) return 0;
    return state.edges.filter((edge) => (
      edge.target === id &&
      edge.targetHandle === "image-in" &&
      (edge.id.startsWith("edge-mention-image-") || edge.data?.autoLinkedFromMention === true)
    )).length;
  });
  const hasContent = Boolean(data.imageUrl || data.prompt);
  const canCopyPrompt = data.kind === "prompt" && Boolean(data.prompt?.trim());
  const isAiNode = data.kind === "imageChat" || data.kind === "multiGenerate";
  const isGenerateImageNode = data.kind === "generateImage";
  const isImageTextEditorNode = data.kind === "imageTextEditor";
  const isHdRedrawNode = data.kind === "hdRedraw";
  const isHdRedraw2Node = data.kind === "hdRedraw2";
  const isRhinoTestNode = data.kind === "rhinoTest";
  const isTextImageLayoutNode = data.kind === "textImageLayout";
  const isGridImageNode = data.kind === "gridImage";
  const isSceneImageNode = data.kind === "sceneImage";
  const isMosquitoSceneImageNode = data.kind === "mosquitoSceneImage";
  const isIndustrialDesignImageNode = data.kind === "industrialDesignImage";
  const isProductRemixNode = data.kind === "productRemix";
  const isImageGeneratorNode = isGenerateImageNode || isImageTextEditorNode || isHdRedrawNode || isHdRedraw2Node || isRhinoTestNode || isTextImageLayoutNode || isGridImageNode || isSceneImageNode || isMosquitoSceneImageNode || isIndustrialDesignImageNode || isProductRemixNode;
  const isAiPromptNode = data.kind === "imageChat";
  const isSceneDirectorNode = data.kind === "sceneDirector";
  const isMosquitoSceneDirectorNode = data.kind === "mosquitoSceneDirector";
  const isTaobaoPageDirectorNode = data.kind === "taobaoPageDirector";
  const isIndustrialDesignerNode = data.kind === "industrial_designer";
  const isProductPosterNode = data.kind === "product_poster";
  const isVisualDirectorNode = data.kind === "visual_director";
  const isPromptPlannerNode = isAiPromptNode || isSceneDirectorNode || isMosquitoSceneDirectorNode || isTaobaoPageDirectorNode || isIndustrialDesignerNode || isProductPosterNode || isVisualDirectorNode;
  const isImageNode = data.kind === "image";
  const isRunning = data.runState === "running";
  const imageNumber = isImageNode && typeof data.imageNumber === "number" ? String(data.imageNumber).padStart(3, "0") : null;
  const displayTitle = imageNumber ? `Image ${imageNumber}` : data.title;
  const nodeWidth = isSceneDirectorNode || isMosquitoSceneDirectorNode || isTaobaoPageDirectorNode || isIndustrialDesignerNode || isProductPosterNode ? 620 : isImageTextEditorNode ? 480 : isImageGeneratorNode || isAiPromptNode || isVisualDirectorNode ? 420 : 320;
  const nodeHeight = isProductPosterNode ? 720 : isTaobaoPageDirectorNode ? 560 : isSceneDirectorNode ? 760 : isMosquitoSceneDirectorNode ? 690 : isIndustrialDesignerNode ? 620 : isImageTextEditorNode ? 520 : isVisualDirectorNode ? 400 : isProductRemixNode ? 500 : isHdRedrawNode || isHdRedraw2Node ? 430 : isRhinoTestNode ? 450 : isMosquitoSceneImageNode ? 440 : isSceneImageNode || isIndustrialDesignImageNode ? 390 : isImageGeneratorNode || isAiPromptNode ? 360 : 260;
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (data.kind === "group") {
    return (
      <div
        className={`pointer-events-auto rounded-[24px] border border-dashed bg-[rgba(108,99,255,0.035)] ${
          selected ? "border-selected" : "border-[rgba(108,99,255,0.45)]"
        }`}
        style={{ width: Number(data.width ?? 360), height: Number(data.height ?? 260) }}
        tabIndex={-1}
      >
        {selected ? (
          <span className="absolute -right-[11px] -top-[11px] grid h-6 w-6 place-items-center rounded-full bg-selected text-[13px] font-bold text-white shadow-sm">
            ✓
          </span>
        ) : null}
      </div>
    );
  }

  const clear = () => {
    updateNodeData(id, { generatedBy: undefined, imageUrl: undefined, modelId: undefined, prompt: "", runState: "idle" }, { record: true });
  };

  const downloadImage = async () => {
    if (!data.imageUrl) return;
    const suffix = data.imageUrl.startsWith("data:image/jpeg") || data.imageUrl.startsWith("data:image/jpg") ? "jpg" : data.imageUrl.startsWith("data:image/webp") ? "webp" : "png";
    const filename = `${imageNumber ? `image-${imageNumber}` : "image"}.${suffix}`;
    try {
      await downloadImageToFile(data.imageUrl, filename);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "图片下载失败，请重试。");
    }
  };

  const copyPrompt = async () => {
    if (!data.prompt?.trim()) return;
    try {
      await navigator.clipboard.writeText(data.prompt);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = data.prompt;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopiedPrompt(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedPrompt(false), 1200);
  };

  const editNode = () => {
    if (data.kind === "prompt") {
      window.dispatchEvent(new CustomEvent(openPromptEditorEvent, { detail: { nodeId: id } }));
      return;
    }
    if (isImageNode && data.imageUrl) setImagePreviewUrl(data.imageUrl);
  };

  const run = () => {
    if (isAiPromptNode || isSceneDirectorNode || isMosquitoSceneDirectorNode || isTaobaoPageDirectorNode || isIndustrialDesignerNode || isProductPosterNode || isVisualDirectorNode) {
      if (data.runState === "running") {
        stopGenerateImageNode(id);
        return;
      }
      const generationId = `${id}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
      updateNodeData(id, { errorMessage: undefined, generationId, runState: "running" });
      if (isSceneDirectorNode || isMosquitoSceneDirectorNode) void runSceneDirectorNode(id, generationId);
      else if (isTaobaoPageDirectorNode) void runTaobaoPageDirectorNode(id, generationId);
      else if (isIndustrialDesignerNode) void runIndustrialDesignerNode(id, generationId);
      else if (isProductPosterNode) void runProductPosterNode(id, generationId);
      else if (isVisualDirectorNode) void runVisualDirectorNode(id, generationId);
      else void runAiPromptNode(id, generationId);
      return;
    }
    if (isImageGeneratorNode) {
      if (data.runState === "running") {
        stopGenerateImageNode(id);
        return;
      }
      const generationId = `${id}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
      updateNodeData(id, { errorMessage: undefined, generationId, runState: "running" });
      void runGenerateImageNode(id, generationId).catch((error) => {
        updateNodeData(id, {
          errorMessage: error instanceof Error ? error.message : "生图节点运行失败。",
          generationId: undefined,
          runState: "failed"
        });
      });
      return;
    }
    updateNodeData(id, { runState: "running" });
    window.setTimeout(() => updateNodeData(id, { runState: "completed", prompt: "模拟结果已生成，后续接入 AI 服务。" }), 700);
  };

  return (
    <NodeShell
      height={nodeHeight}
      motionState={data.motionState}
      portLayer={<NodePortLayer hiddenAutoImageInputCount={hiddenAutoImageInputCount} kind={data.kind} nodeId={id} />}
      running={isRunning}
      selected={selected}
      width={nodeWidth}
    >
      <NodeHeader
        actions={!isImageGeneratorNode && !isPromptPlannerNode ? (
          <NodeActions
            canEdit={data.kind === "prompt" ? true : isImageNode && Boolean(data.imageUrl)}
            canCopyPrompt={canCopyPrompt}
            canDownloadImage={Boolean(data.imageUrl)}
            copiedPrompt={copiedPrompt}
            hasContent={hasContent}
            onClear={clear}
            onCopyPrompt={() => void copyPrompt()}
            onDownloadImage={downloadImage}
            onEdit={editNode}
            showEdit={data.kind === "prompt" || isImageNode}
            showCopyPrompt={data.kind === "prompt"}
            showDownloadImage={isImageNode}
          />
        ) : null}
        canRun={isAiNode || isImageGeneratorNode || isSceneDirectorNode || isMosquitoSceneDirectorNode || isTaobaoPageDirectorNode || isIndustrialDesignerNode || isProductPosterNode || isVisualDirectorNode}
        onRun={run}
        runState={data.runState}
        title={displayTitle}
      />
      <div className="px-[18px] pb-[18px]">{renderContent(id, data)}</div>
      {isImageNode && data.generatedBy && data.modelId ? (
        <div className="pointer-events-none absolute bottom-[5px] left-[18px] right-[18px] truncate text-center text-[8px] font-medium leading-none text-[#A3A9B5]" title={data.modelId}>
          {data.modelId}
        </div>
      ) : null}
      {(isImageGeneratorNode || isPromptPlannerNode) && data.runState === "failed" && data.errorMessage ? (
        <div className="absolute bottom-3 left-[18px] right-[18px] truncate text-[11px] font-semibold text-danger" title={data.errorMessage}>
          {data.errorMessage}
        </div>
      ) : null}
    </NodeShell>
  );
}

function renderContent(id: string, data: CanvasNodeData) {
  if (data.kind === "image") {
    return <ImageUploadArea id={id} imageUrl={data.imageUrl} />;
  }

  if (data.kind === "prompt") {
    return <PromptTextArea id={id} richHtml={typeof data.promptRichHtml === "string" ? data.promptRichHtml : buildVisibleTextPromptRichHtml(data.prompt ?? "")} value={data.prompt ?? ""} />;
  }

  if (data.kind === "generateImage") {
    return <GenerateImagePanel id={id} data={data} />;
  }
  if (data.kind === "imageTextEditor") {
    return <ImageTextEditorPanel id={id} data={data} />;
  }
  if (data.kind === "hdRedraw") {
    return <HdRedrawPanel id={id} data={data} step="1" />;
  }
  if (data.kind === "hdRedraw2") {
    return <HdRedrawPanel id={id} data={data} step="2" />;
  }
  if (data.kind === "rhinoTest") {
    return <RhinoTestPanel id={id} data={data} />;
  }
  if (data.kind === "textImageLayout") {
    return <TextImageLayoutPanel id={id} data={data} />;
  }
  if (data.kind === "gridImage") {
    return <GridImagePanel id={id} data={data} />;
  }
  if (data.kind === "sceneImage") {
    return <SceneImagePanel id={id} data={data} />;
  }
  if (data.kind === "mosquitoSceneImage") {
    return <SceneImagePanel id={id} data={data} />;
  }
  if (data.kind === "industrialDesignImage") {
    return <IndustrialDesignImagePanel id={id} data={data} />;
  }
  if (data.kind === "productRemix") {
    return <ProductRemixPanel id={id} data={data} />;
  }

  if (data.kind === "imageChat") {
    return <AiPromptPanel id={id} data={data} />;
  }
  if (data.kind === "sceneDirector") {
    return <SceneDirectorPanel id={id} data={data} />;
  }
  if (data.kind === "mosquitoSceneDirector") {
    return <MosquitoSceneDirectorPanel id={id} data={data} />;
  }
  if (data.kind === "taobaoPageDirector") {
    return <TaobaoPageDirectorPanel id={id} data={data} />;
  }
  if (data.kind === "industrial_designer") {
    return <IndustrialDesignerPanel id={id} data={data} />;
  }
  if (data.kind === "product_poster") {
    return <ProductPosterPanel id={id} data={data} />;
  }
  if (data.kind === "visual_director") {
    return <VisualDirectorPanel id={id} data={data} />;
  }

  return (
    <div className="grid h-[186px] gap-2">
      <NodeModelSelect id={id} kind="image" value={data.modelId} />
      <div className="h-[48px] rounded-[12px] border border-[#F2DFB8] bg-[#FFFDF8] p-3 text-sm text-secondary">Prompt input</div>
      <div className="grid flex-1 grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((slot) => (
          <div className="rounded-[10px] border border-line bg-[#F5F6FA]" key={slot} />
        ))}
      </div>
    </div>
  );
}

function ImageTextEditorPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const inputImageUrl = useCanvasStore((state) => {
    const edge = state.edges.find((item) => item.target === id && item.targetHandle === "image-in");
    const node = edge ? state.nodes.find((item) => item.id === edge.source) : undefined;
    return typeof node?.data.imageUrl === "string" ? node.data.imageUrl : "";
  });
  const [extracting, setExtracting] = useState(false);
  const params = data.modelParams ?? {};
  const sensitive = params.safetyStatus === "sensitive";
  const sampleMarker = params.sampleMarker === "true";
  const blocked = sensitive && !sampleMarker;
  const locked = data.runState === "running" || extracting;
  const text = data.prompt ?? params.extractedText ?? "";

  const extractText = async () => {
    if (!inputImageUrl || locked) {
      if (!inputImageUrl) updateNodeData(id, { errorMessage: "请先用绿色端口连接 1 张图片。", runState: "failed" });
      return;
    }
    setExtracting(true);
    updateNodeData(id, { errorMessage: undefined, runState: "running" });
    try {
      const apiPrefix = typeof data.modelId === "string" ? data.modelId.match(/^(\d{3})-/)?.[1] : undefined;
      const extractionModel = apiPrefix ? `${apiPrefix}-gemini-2.5-flash` : "gemini-2.5-flash";
      const response = await fetch("/api/ai/image-text-editor", {
        body: JSON.stringify({
          aiSettings: getClientAiSettingsPayload(),
          image: inputImageUrl,
          model: extractionModel,
          sourceNodeId: id
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const payload = await response.json() as { error?: string; text?: string; sensitiveDocument?: boolean; sampleMarkerVisible?: boolean; reason?: string };
      if (!response.ok) throw new Error(payload.error || `文字提取失败：${response.status}`);
      const extractedText = payload.text?.trim() ?? "";
      updateNodeData(id, {
        errorMessage: payload.sensitiveDocument && !payload.sampleMarkerVisible
          ? "检测到可能属于票据或凭证。请先在输入图片明显位置添加“测试样品”或“SAMPLE”字样，再重新提取。"
          : undefined,
        modelParams: {
          ...params,
          extractedText,
          originalText: extractedText,
          safetyReason: payload.reason ?? "",
          safetyStatus: payload.sensitiveDocument ? "sensitive" : "normal",
          sampleMarker: payload.sampleMarkerVisible ? "true" : "false"
        },
        prompt: extractedText,
        runState: payload.sensitiveDocument && !payload.sampleMarkerVisible ? "failed" : "completed"
      }, { record: true });
    } catch (error) {
      updateNodeData(id, { errorMessage: error instanceof Error ? error.message : "文字提取失败。", runState: "failed" });
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="rounded-[10px] border border-[#DDE4FF] bg-[#F5F7FF] px-3 py-2 text-[11px] font-semibold leading-4 text-[#53649A]">
        只修改文字；字体、字重、颜色、描边、阴影、透视与非文字内容保持原图。输出尺寸和画幅跟随输入图。
      </div>
      <div>
        <span className="mb-1 block px-1 text-[12px] font-semibold text-[#525866]">图片模型</span>
        <NodeModelSelect id={id} kind="image" value={data.modelId} />
      </div>
      <button
        className="nodrag nopan h-9 rounded-[10px] bg-[#EEF0FF] text-[13px] font-bold text-selected transition hover:bg-[#E5E7FF] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={locked || !inputImageUrl}
        onClick={(event) => { event.stopPropagation(); void extractText(); }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {extracting ? "正在提取文字…" : params.extractedText ? "重新提取文字" : "提取文字"}
      </button>
      <div className="block">
        <div className="mb-1 flex items-center justify-between px-1 text-[12px] font-semibold text-[#525866]">
          <span>识别文字（可直接修改或添加）</span>
          <button
            aria-label="打开文字编辑框"
            className="nodrag nopan grid h-7 w-7 place-items-center rounded-full text-[#7F8795] transition hover:bg-[#F0F2F7] hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            disabled={!text.trim()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              window.dispatchEvent(new CustomEvent(openPromptEditorEvent, { detail: { nodeId: id } }));
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            title="打开大编辑框"
            type="button"
          >
            <Pencil size={15} strokeWidth={2.1} />
          </button>
        </div>
        <textarea
          className="nodrag nopan nowheel h-[190px] w-full resize-none rounded-[12px] border border-[#D9DDE6] bg-[#FBFCFE] p-3 text-[13px] leading-5 text-[#343944] outline-none focus:border-selected disabled:opacity-60"
          disabled={locked || !params.extractedText}
          onChange={(event) => updateNodeData(id, { prompt: event.currentTarget.value })}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder="连接图片后点击“提取文字”"
          value={text}
        />
      </div>
      {blocked ? (
        <div className="rounded-[10px] border border-[#F3C4C4] bg-[#FFF6F6] px-3 py-2 text-[11px] font-semibold leading-4 text-danger">
          修改已暂停：请在输入图片上明显添加“测试样品”“测试样本”或“SAMPLE”，然后点击“重新提取文字”。
        </div>
      ) : (
        <div className="text-center text-[11px] font-medium text-[#969DAA]">修改文字后，点击右上角“运行”生成图片</div>
      )}
    </div>
  );
}

function normalizeBoundedCount(value: unknown, min: number, max: number, fallback = min) {
  const numeric = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return String(fallback);
  return String(Math.min(max, Math.max(min, numeric)));
}

function AiPromptPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const rawOutput = typeof data.modelParams?.output === "string" && data.modelParams.output.trim() ? data.modelParams.output : "中文";
  const output = rawOutput === "Chinese" ? "中文" : rawOutput === "English" ? "英文" : rawOutput === "Chinese & English" ? "中英双语" : rawOutput === "Json" ? "JSON" : rawOutput;
  const schemes = normalizeSchemeCount(data.modelParams?.schemes);

  useEffect(() => {
    if (data.modelId === modelId && data.modelParams?.module === "Normal" && data.modelParams?.output === output && data.modelParams?.schemes === schemes) return;
    updateNodeData(id, { modelId, modelParams: { ...(data.modelParams ?? {}), module: "Normal", output, schemes } });
  }, [data.modelId, data.modelParams, id, modelId, output, schemes, updateNodeData]);

  const updateOutput = (value: string) => {
    if (locked) return;
    updateNodeData(id, { modelParams: { ...(data.modelParams ?? {}), module: "Normal", output: value } });
  };

  const updateSchemes = (value: string) => {
    if (locked) return;
    updateNodeData(id, { modelParams: { ...(data.modelParams ?? {}), module: "Normal", schemes: value } });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-5 pt-1">
      <GenerateSelect
        disabled={locked}
        label="AI 模型"
        onChange={(value) => {
          if (locked) return;
          updateNodeData(id, { modelId: value });
        }}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="输出语言"
        onChange={updateOutput}
        options={["中文", "英文", "中英双语", "JSON"]}
        value={output}
      />
      <GenerateNumberInput
        disabled={locked}
        label="方案数量"
        max={10}
        min={1}
        onChange={updateSchemes}
        value={schemes}
      />
    </div>
  );
}

function getMosquitoEffectPresetOptions(method: string) {
  if (method === "风扇吸入") return ["自动匹配", "无特效", "轻微吸入", "明显吸入", "强力吸入", "原理剖析"];
  if (method === "电击灭蚊") return ["自动匹配", "无特效", "微小亮点", "轻微电弧", "明显电击", "原理剖析"];
  if (method === "粘板粘捕") return ["自动匹配", "无特效", "轻度展示", "清晰粘捕", "过程演示", "原理剖析"];
  return ["自动匹配", "无特效", "轻度展示", "明显展示", "强力广告", "原理剖析"];
}

function MosquitoSceneDirectorPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const params = useMemo(() => data.modelParams ?? {}, [data.modelParams]);
  const backgroundPresence = params.backgroundPresence ?? "自动";
  const peopleInteractionDisabled = backgroundPresence === "无人物和宠物" || backgroundPresence === "仅宠物";
  const mosquitoWavelength = params.mosquitoWavelength ?? "395 nm｜标准紫光";
  const attractionLightDisabled = mosquitoWavelength === "无｜灯光关闭";
  const mosquitoMethod = params.mosquitoMethod ?? "自动判断";
  const effectPresetOptions = getMosquitoEffectPresetOptions(mosquitoMethod);
  const effectPreset = effectPresetOptions.includes(params.effectPreset ?? "") ? params.effectPreset as string : "自动匹配";
  const nextParams = useMemo(() => ({
    attractionLight: attractionLightDisabled ? "关闭" : params.attractionLight === "关闭" ? "柔和可见" : params.attractionLight ?? "柔和可见",
    backgroundPresence,
    effectPreset,
    effectStyle: params.effectStyle ?? "舒适商业",
    insectAmount: params.insectAmount ?? "少量",
    insectScale: params.insectScale ?? "自动合理",
    mosquitoMethod,
    mosquitoSceneMode: "true",
    mosquitoWavelength,
    outputLanguage: params.outputLanguage ?? "中文",
    peopleInteraction: peopleInteractionDisabled ? "无人物互动" : params.peopleInteraction === "无人物互动" ? "自动" : params.peopleInteraction ?? "自动",
    productLock: "严格",
    sceneType: params.sceneType ?? "自动",
    schemes: normalizeBoundedCount(params.schemes, 1, 6, 4),
    timeMood: params.timeMood === "暗光室内" ? "暗光环境" : params.timeMood ?? "夜晚"
  }), [attractionLightDisabled, backgroundPresence, effectPreset, mosquitoMethod, mosquitoWavelength, params.attractionLight, params.effectStyle, params.insectAmount, params.insectScale, params.outputLanguage, params.peopleInteraction, params.sceneType, params.schemes, params.timeMood, peopleInteractionDisabled]);

  useEffect(() => {
    const sameModel = data.modelId === modelId;
    const sameParams = Object.entries(nextParams).every(([key, value]) => data.modelParams?.[key] === value);
    if (sameModel && sameParams) return;
    updateNodeData(id, { modelId, modelParams: { ...params, ...nextParams } });
  }, [data.modelId, data.modelParams, id, modelId, nextParams, params, updateNodeData]);

  const updateParam = (key: keyof typeof nextParams, value: string) => {
    if (locked) return;
    updateNodeData(id, { modelParams: { ...params, ...nextParams, [key]: value } });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <div className="rounded-[12px] border border-[#D9E1FF] bg-[#F5F7FF] px-4 py-3 text-[12px] font-semibold leading-5 text-[#506095]">
        按“蚊虫数量”设置规划蓝紫诱蚊光、电击、风吸或粘捕效果；选择“无”时画面不出现蚊虫。
      </div>
      <GenerateSelect disabled={locked} label="AI 模型" onChange={(value) => updateNodeData(id, { modelId: value })} options={modelOptions} renderValue={modelDisplayName} value={modelId} />
      <div className="grid grid-cols-2 gap-x-7 gap-y-4">
        <GenerateSelect disabled={locked} label="灭蚊方式" onChange={(value) => {
          if (locked) return;
          updateNodeData(id, { modelParams: { ...params, ...nextParams, mosquitoMethod: value, effectPreset: "自动匹配" } });
        }} options={["自动判断", "电击灭蚊", "风扇吸入", "粘板粘捕"]} value={nextParams.mosquitoMethod} />
        <GenerateSelect disabled={locked} label="使用场景" onChange={(value) => updateParam("sceneType", value)} options={["自动", "卧室", "客厅", "庭院", "露营", "餐厅", "商业空间"]} value={nextParams.sceneType} />
        <GenerateSelect disabled={locked} label="背景主体" onChange={(value) => updateParam("backgroundPresence", value)} options={["自动", "无人物和宠物", "仅人物", "仅宠物", "人物和宠物"]} value={nextParams.backgroundPresence} />
        <GenerateSelect disabled={locked || peopleInteractionDisabled} label="人物互动" onChange={(value) => updateParam("peopleInteraction", value)} options={peopleInteractionDisabled ? ["无人物互动"] : ["自动", "仅作背景", "手持产品", "操作使用", "拆卸清理", "被蚊虫困扰", "被蚊虫惊扰特效"]} value={nextParams.peopleInteraction} />
        <GenerateSelect disabled={locked} label="时间氛围" onChange={(value) => updateParam("timeMood", value)} options={["夜晚", "傍晚", "暗光环境", "白天环境", "自动"]} value={nextParams.timeMood} />
        <GenerateSelect disabled={locked || attractionLightDisabled} label="诱蚊光效" onChange={(value) => updateParam("attractionLight", value)} options={attractionLightDisabled ? ["关闭"] : ["克制", "柔和可见", "明显可见"]} value={nextParams.attractionLight} />
        <GenerateSelect disabled={locked} label="诱蚊波长" onChange={(value) => updateParam("mosquitoWavelength", value)} options={["无｜灯光关闭", "365 nm｜近紫外深紫", "395 nm｜标准紫光", "410 nm｜蓝紫光"]} value={nextParams.mosquitoWavelength} />
        <GenerateSelect disabled={locked} label="蚊虫数量" onChange={(value) => updateParam("insectAmount", value)} options={["无", "极少", "少量", "适量", "大量"]} value={nextParams.insectAmount} />
        <GenerateSelect disabled={locked} label="效果风格" onChange={(value) => updateParam("effectStyle", value)} options={["舒适商业", "科技演示", "原理可视化"]} value={nextParams.effectStyle} />
        <GenerateSelect disabled={locked} label="蚊虫尺度" onChange={(value) => updateParam("insectScale", value)} options={["自动合理", "真实微小", "细节适度放大", "原理示意放大"]} value={nextParams.insectScale} />
        <GenerateNumberInput disabled={locked} label="方案数量" max={6} min={1} onChange={(value) => updateParam("schemes", value)} value={nextParams.schemes} />
        <GenerateSelect disabled={locked} label="输出语言" onChange={(value) => updateParam("outputLanguage", value)} options={["中文", "英文", "中英双语"]} value={nextParams.outputLanguage} />
        <GenerateSelect disabled label="产品锁定" onChange={() => undefined} options={["严格"]} value={nextParams.productLock} />
        <GenerateSelect disabled={locked} label="功能特效" onChange={(value) => updateParam("effectPreset", value)} options={effectPresetOptions} value={nextParams.effectPreset} />
      </div>
    </div>
  );
}

function SceneDirectorPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const params = data.modelParams ?? {};
  const cn = (value: unknown, fallback: string, translations: Record<string, string>) => {
    const raw = typeof value === "string" && value.trim() ? value : fallback;
    return translations[raw] ?? raw;
  };
  const defaultToAuto = (value: unknown, oldDefault: string) => {
    const raw = typeof value === "string" && value.trim() ? value : "自动";
    return raw === oldDefault ? "自动" : raw;
  };
  const nextParams = useMemo(() => ({
    cameraLock: cn(params.cameraLock, "严格", { Flexible: "灵活", Strict: "严格" }),
    lensDirection: cn(params.lensDirection, "自动", { Auto: "自动", Macro: "微距" }),
    lightingPreset: defaultToAuto(cn(params.lightingPreset, "自动", { Auto: "自动", "Golden Hour": "黄金时刻", "Luxury Hotel": "奢华酒店", "Natural Daylight": "自然日光", "Night Ambience": "夜间氛围", "Studio Softbox": "柔光棚拍" }), "自然日光"),
    outputLanguage: cn(params.outputLanguage, "中文", { Bilingual: "中英双语", Chinese: "中文", English: "英文" }),
    photographyStyle: defaultToAuto(cn(params.photographyStyle, "自动", { Auto: "自动", "E-commerce": "电商", Editorial: "编辑大片", Hospitality: "酒店空间", Lifestyle: "生活方式", Luxury: "奢华", Outdoor: "户外" }), "生活方式"),
    productLock: cn(params.productLock, "严格", { Flexible: "灵活", Strict: "严格" }),
    promptStyle: cn(params.promptStyle, "导演模式", { Compact: "精简", Detailed: "详细", "Director Mode": "导演模式" }),
    schemeDiversity: cn(params.schemeDiversity, "高", { High: "高", Low: "低", Medium: "中" }),
    sceneWeight: normalizeBoundedCount(params.sceneWeight, 0, 100, 90),
    schemes: normalizeBoundedCount(params.schemes, 1, 10, 6),
    sizeWeight: normalizeBoundedCount(params.sizeWeight, 0, 100, 80),
    structureWeight: normalizeBoundedCount(params.structureWeight, 0, 100, 70),
    styleWeight: normalizeBoundedCount(params.styleWeight, 0, 100, 90)
  }), [
    params.cameraLock,
    params.lensDirection,
    params.lightingPreset,
    params.outputLanguage,
    params.photographyStyle,
    params.productLock,
    params.promptStyle,
    params.schemeDiversity,
    params.sceneWeight,
    params.schemes,
    params.sizeWeight,
    params.structureWeight,
    params.styleWeight
  ]);

  useEffect(() => {
    const sameModel = data.modelId === modelId;
    const sameParams = Object.entries(nextParams).every(([key, value]) => data.modelParams?.[key] === value);
    if (sameModel && sameParams) return;
    updateNodeData(id, { modelId, modelParams: { ...params, ...nextParams } });
  }, [data.modelId, data.modelParams, id, modelId, nextParams, params, updateNodeData]);

  const updateParam = (key: keyof typeof nextParams, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <div className="grid grid-cols-2 gap-x-7 gap-y-4">
        <GenerateSelect
          disabled={locked}
          label="AI 模型"
          onChange={(value) => {
            if (locked) return;
            updateNodeData(id, { modelId: value });
          }}
          options={modelOptions}
          renderValue={modelDisplayName}
          value={modelId}
        />
        <GenerateSelect
          disabled={locked}
          label="输出语言"
          onChange={(value) => updateParam("outputLanguage", value)}
          options={["中文", "英文", "中英双语"]}
          value={nextParams.outputLanguage}
        />
        <GenerateNumberInput
          disabled={locked}
          label="方案数量"
          max={10}
          min={1}
          onChange={(value) => updateParam("schemes", value)}
          value={nextParams.schemes}
        />
        <div />
        <GenerateSelect
          disabled={locked}
          label="产品锁定"
          onChange={(value) => updateParam("productLock", value)}
          options={["严格", "灵活"]}
          value={nextParams.productLock}
        />
        <GenerateSelect
          disabled={locked}
          label="镜头锁定"
          onChange={(value) => updateParam("cameraLock", value)}
          options={["严格", "灵活"]}
          value={nextParams.cameraLock}
        />
        <div className="col-span-2">
          <GenerateSelect
            disabled={locked}
            label="提示词风格"
            onChange={(value) => updateParam("promptStyle", value)}
            options={["精简", "详细", "导演模式"]}
            value={nextParams.promptStyle}
          />
        </div>
      </div>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[14px] font-bold text-primary">摄影预设</h3>
          <ChevronDown size={18} strokeWidth={2} className="text-[#525866]" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <GenerateSelect
            disabled={locked}
            label="摄影风格"
            onChange={(value) => updateParam("photographyStyle", value)}
            options={["自动", "生活方式", "奢华", "编辑大片", "电商", "酒店空间", "户外"]}
            value={nextParams.photographyStyle}
          />
          <GenerateSelect
            disabled={locked}
            label="镜头"
            onChange={(value) => updateParam("lensDirection", value)}
            options={["自动", "24mm", "35mm", "50mm", "85mm", "微距"]}
            value={nextParams.lensDirection}
          />
          <GenerateSelect
            disabled={locked}
            label="光影预设"
            onChange={(value) => updateParam("lightingPreset", value)}
            options={["自动", "自然日光", "黄金时刻", "柔光棚拍", "奢华酒店", "夜间氛围"]}
            value={nextParams.lightingPreset}
          />
        </div>
        <div className="mt-5">
          <span className="mb-3 block px-3 text-[13px] font-medium leading-none text-[#525866]">方案差异</span>
          <div className="grid grid-cols-3 gap-3">
            {["低", "中", "高"].map((option) => (
              <label className="flex h-9 items-center gap-2 rounded-[16px] px-3 text-[15px] font-semibold text-[#525866]" key={option}>
                <input
                  checked={nextParams.schemeDiversity === option}
                  className="h-4 w-4 accent-[#6C63FF]"
                  disabled={locked}
                  onChange={() => updateParam("schemeDiversity", option)}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="radio"
                />
                {option}
              </label>
            ))}
          </div>
        </div>
      </section>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <h3 className="mb-4 text-[14px] font-bold text-primary">参考权重 (0-100)</h3>
        <div className="grid grid-cols-2 gap-x-7 gap-y-4">
          <ReferenceWeightControl
            disabled={locked}
            label="结构参考"
            onChange={(value) => updateParam("structureWeight", value)}
            value={nextParams.structureWeight}
          />
          <ReferenceWeightControl
            disabled={locked}
            label="尺寸参考"
            onChange={(value) => updateParam("sizeWeight", value)}
            value={nextParams.sizeWeight}
          />
          <ReferenceWeightControl
            disabled={locked}
            label="风格参考"
            onChange={(value) => updateParam("styleWeight", value)}
            value={nextParams.styleWeight}
          />
          <ReferenceWeightControl
            disabled={locked}
            label="场景参考"
            onChange={(value) => updateParam("sceneWeight", value)}
            value={nextParams.sceneWeight}
          />
        </div>
      </section>
    </div>
  );
}

const posterCopyLevelOptions = ["品牌名", "产品名", "主标题", "英文标题", "副标题", "核心卖点", "产品参数", "价格信息", "促销角标", "行动文案", "页脚说明"];

function ProductPosterPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const params = data.modelParams ?? {};
  const read = (key: string, fallback: string) => typeof params[key] === "string" && params[key].trim() ? params[key] : fallback;
  const nextParams = useMemo(() => ({
    outputLanguage: read("outputLanguage", "中文"),
    schemes: normalizeBoundedCount(params.schemes, 1, 9, 4),
    schemeDiversity: read("schemeDiversity", "高"),
    posterPurpose: read("posterPurpose", "产品主视觉"),
    productLock: read("productLock", "严格"),
    productPosition: read("productPosition", "自动"),
    productScale: read("productScale", "大"),
    layoutStructure: read("layoutStructure", "自动"),
    infoDensity: read("infoDensity", "标准"),
    whitespace: read("whitespace", "标准"),
    styleReferenceStrength: read("styleReferenceStrength", "中"),
    colorStrategy: read("colorStrategy", "自动提取"),
    backgroundType: read("backgroundType", "自动"),
    copySource: read("copySource", "AI 补全文案"),
    copyLevels: read("copyLevels", "产品名,主标题,副标题,核心卖点,行动文案")
  // params is persisted node state; deriving all controls together keeps older project files compatible.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [params]);

  useEffect(() => {
    const sameModel = data.modelId === modelId;
    const sameParams = Object.entries(nextParams).every(([key, value]) => data.modelParams?.[key] === value);
    if (sameModel && sameParams) return;
    updateNodeData(id, { modelId, modelParams: { ...params, ...nextParams } });
  }, [data.modelId, data.modelParams, id, modelId, nextParams, params, updateNodeData]);

  const updateParam = (key: keyof typeof nextParams, value: string) => {
    if (locked) return;
    updateNodeData(id, { modelParams: { ...params, [key]: value } });
  };
  const selectedCopyLevels = new Set(nextParams.copyLevels.split(",").filter(Boolean));
  const toggleCopyLevel = (level: string) => {
    const next = new Set(selectedCopyLevels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    updateParam("copyLevels", posterCopyLevelOptions.filter((item) => next.has(item)).join(","));
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-3">
          <GenerateSelect disabled={locked} label="AI 模型" onChange={(value) => updateNodeData(id, { modelId: value })} options={modelOptions} renderValue={modelDisplayName} value={modelId} />
        </div>
        <GenerateSelect disabled={locked} label="输出语言" onChange={(value) => updateParam("outputLanguage", value)} options={["中文", "英文", "中英双语"]} value={nextParams.outputLanguage} />
        <GenerateNumberInput disabled={locked} label="Prompt 数量" max={9} min={1} onChange={(value) => updateParam("schemes", value)} value={nextParams.schemes} />
        <GenerateSelect disabled={locked} label="方案差异" onChange={(value) => updateParam("schemeDiversity", value)} options={["低", "中", "高"]} value={nextParams.schemeDiversity} />
        <GenerateSelect disabled={locked} label="海报用途" onChange={(value) => updateParam("posterPurpose", value)} options={["产品主视觉", "新品发布", "促销活动", "品牌海报", "社交媒体", "电商主图"]} value={nextParams.posterPurpose} />
        <GenerateSelect disabled={locked} label="产品锁定" onChange={(value) => updateParam("productLock", value)} options={["严格", "标准", "灵活"]} value={nextParams.productLock} />
      </div>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <h3 className="mb-3 text-[14px] font-bold text-primary">产品与版式</h3>
        <div className="grid grid-cols-3 gap-4">
          <GenerateSelect disabled={locked} label="产品位置" onChange={(value) => updateParam("productPosition", value)} options={["自动", "居中", "左侧", "右侧", "顶部", "底部"]} value={nextParams.productPosition} />
          <GenerateSelect disabled={locked} label="产品占比" onChange={(value) => updateParam("productScale", value)} options={["小", "中", "大", "超大主体"]} value={nextParams.productScale} />
          <GenerateSelect disabled={locked} label="版式结构" onChange={(value) => updateParam("layoutStructure", value)} options={["自动", "中心主视觉", "左文右图", "左图右文", "上文下图", "上图下文", "大标题叠加", "满版沉浸", "几何分割"]} value={nextParams.layoutStructure} />
          <GenerateSelect disabled={locked} label="信息密度" onChange={(value) => updateParam("infoDensity", value)} options={["极简", "标准", "高信息量"]} value={nextParams.infoDensity} />
          <GenerateSelect disabled={locked} label="留白程度" onChange={(value) => updateParam("whitespace", value)} options={["少", "标准", "多"]} value={nextParams.whitespace} />
          <GenerateSelect disabled={locked} label="背景类型" onChange={(value) => updateParam("backgroundType", value)} options={["自动", "纯色", "渐变", "场景", "抽象图形", "材质背景", "摄影棚"]} value={nextParams.backgroundType} />
        </div>
      </section>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <h3 className="mb-3 text-[14px] font-bold text-primary">风格与文案</h3>
        <div className="grid grid-cols-3 gap-4">
          <GenerateSelect disabled={locked} label="风格参考强度" onChange={(value) => updateParam("styleReferenceStrength", value)} options={["不使用", "弱", "中", "强"]} value={nextParams.styleReferenceStrength} />
          <GenerateSelect disabled={locked} label="色彩策略" onChange={(value) => updateParam("colorStrategy", value)} options={["自动提取", "跟随产品", "跟随风格参考", "高对比", "柔和统一", "黑白高级"]} value={nextParams.colorStrategy} />
          <GenerateSelect disabled={locked} label="文案来源" onChange={(value) => updateParam("copySource", value)} options={["使用前置 Prompt", "AI 补全文案", "AI 重新创作", "只保留指定文案", "无文字海报"]} value={nextParams.copySource} />
        </div>
        <div className="mt-4">
          <span className="mb-2 block text-[13px] font-medium text-[#525866]">画面文案层级</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {posterCopyLevelOptions.map((level) => (
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-[#525866]" key={level}>
                <input checked={selectedCopyLevels.has(level)} className="h-3.5 w-3.5 accent-[#6C63FF]" disabled={locked} onChange={() => toggleCopyLevel(level)} type="checkbox" />
                {level}
              </label>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

const taobaoPageImageTypes = [
  { countKey: "heroCount", index: "01", label: "主图", name: "Hero", sizeKey: "heroSize", type: "hero" },
  { countKey: "sellingPointCount", index: "02", label: "卖点图", name: "SellingPoint", sizeKey: "sellingPointSize", type: "sellingPoint" },
  { countKey: "lifestyleCount", index: "03", label: "场景图", name: "Lifestyle", sizeKey: "lifestyleSize", type: "lifestyle" },
  { countKey: "detailCount", index: "04", label: "细节图", name: "Detail", sizeKey: "detailSize", type: "detail" },
  { countKey: "sizeCount", index: "05", label: "尺寸规格图", name: "Size", sizeKey: "sizeSize", type: "size" },
  { countKey: "functionCount", index: "06", label: "功能拆解图", name: "Function", sizeKey: "functionSize", type: "function" },
  { countKey: "painPointCount", index: "07", label: "对比痛点图", name: "Compare", sizeKey: "painPointSize", type: "compare" },
  { countKey: "moodCount", index: "08", label: "氛围收尾图", name: "BrandMood", sizeKey: "moodSize", type: "brandMood" }
] as const;

const taobaoPageSizeOptions = ["800x800", "1200x1200", "750x1000", "750x1200", "790x1053", "790x1260", "1080x1440"];

function TaobaoPageDirectorPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const params = data.modelParams ?? {};
  const cn = (value: unknown, fallback: string, translations: Record<string, string> = {}) => {
    const raw = typeof value === "string" && value.trim() ? value : fallback;
    return translations[raw] ?? raw;
  };
  const sizeValue = (value: unknown, fallback: string) => {
    const raw = typeof value === "string" && value.trim() ? value.replace("×", "x") : fallback;
    return taobaoPageSizeOptions.includes(raw) ? raw : fallback;
  };
  const nextParams = useMemo(() => ({
    categoryMode: cn(params.categoryMode, "自动识别"),
    detailCount: normalizeBoundedCount(params.detailCount, 0, 8, 2),
    detailSize: sizeValue(params.detailSize, "800x800"),
    functionCount: normalizeBoundedCount(params.functionCount, 0, 8, 1),
    functionSize: sizeValue(params.functionSize, "750x1200"),
    heroCount: normalizeBoundedCount(params.heroCount, 0, 8, 1),
    heroSize: sizeValue(params.heroSize, "800x800"),
    infoDensity: cn(params.infoDensity, "标准"),
    lifestyleCount: normalizeBoundedCount(params.lifestyleCount, 0, 8, 2),
    lifestyleSize: sizeValue(params.lifestyleSize, "750x1000"),
    marketingIntensity: cn(params.marketingIntensity, "标准"),
    moodCount: normalizeBoundedCount(params.moodCount, 0, 8, 1),
    moodSize: sizeValue(params.moodSize, "750x1000"),
    outputLanguage: cn(params.outputLanguage, "中文", { Bilingual: "中英双语", Chinese: "中文", English: "英文" }),
    painPointCount: normalizeBoundedCount(params.painPointCount, 0, 8, 1),
    painPointSize: sizeValue(params.painPointSize, "750x1200"),
    productLock: cn(params.productLock, "严格", { Flexible: "灵活", Strict: "严格" }),
    sellingPointCount: normalizeBoundedCount(params.sellingPointCount, 0, 8, 2),
    sellingPointSize: sizeValue(params.sellingPointSize, "800x800"),
    sizeCount: normalizeBoundedCount(params.sizeCount, 0, 8, 1),
    sizeSize: sizeValue(params.sizeSize, "750x1000"),
    styleReferenceMode: cn(params.styleReferenceMode, "自动识别"),
    targetImageType: taobaoPageImageTypes.some((item) => item.type === params.targetImageType) ? params.targetImageType as string : "hero",
    visualStyle: cn(params.visualStyle, "自动")
  }), [params]);

  const selectedImageType = taobaoPageImageTypes.find((item) => item.type === nextParams.targetImageType) ?? taobaoPageImageTypes[0];

  useEffect(() => {
    const sameModel = data.modelId === modelId;
    const sameParams = Object.entries(nextParams).every(([key, value]) => data.modelParams?.[key] === value);
    if (sameModel && sameParams) return;
    updateNodeData(id, { modelId, modelParams: { ...params, ...nextParams } });
  }, [data.modelId, data.modelParams, id, modelId, nextParams, params, updateNodeData]);

  const updateParam = (key: keyof typeof nextParams, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <div className="grid grid-cols-2 gap-x-7 gap-y-4">
        <GenerateSelect
          disabled={locked}
          label="AI 模型"
          onChange={(value) => {
            if (locked) return;
            updateNodeData(id, { modelId: value });
          }}
          options={modelOptions}
          renderValue={modelDisplayName}
          value={modelId}
        />
        <GenerateSelect
          disabled={locked}
          label="输出语言"
          onChange={(value) => updateParam("outputLanguage", value)}
          options={["中文", "英文", "中英双语"]}
          value={nextParams.outputLanguage}
        />
        <GenerateSelect
          disabled={locked}
          label="类目模式"
          onChange={(value) => updateParam("categoryMode", value)}
          options={["自动识别", "家居家装", "服饰鞋包", "数码配件", "美妆个护", "食品饮料", "母婴宠物", "工业办公"]}
          value={nextParams.categoryMode}
        />
        <GenerateSelect
          disabled={locked}
          label="商品锁定"
          onChange={(value) => updateParam("productLock", value)}
          options={["严格", "灵活"]}
          value={nextParams.productLock}
        />
        <GenerateSelect
          disabled={locked}
          label="风格参考图模式"
          onChange={(value) => updateParam("styleReferenceMode", value)}
          options={["自动识别", "手动指定", "不使用"]}
          value={nextParams.styleReferenceMode}
        />
        <GenerateSelect
          disabled={locked}
          label="营销强度"
          onChange={(value) => updateParam("marketingIntensity", value)}
          options={["克制", "标准", "强转化"]}
          value={nextParams.marketingIntensity}
        />
        <GenerateSelect
          disabled={locked}
          label="视觉风格"
          onChange={(value) => updateParam("visualStyle", value)}
          options={["自动", "白底电商", "天猫质感", "高级简约", "小红书种草", "日系生活", "科技感"]}
          value={nextParams.visualStyle}
        />
        <GenerateSelect
          disabled={locked}
          label="信息密度"
          onChange={(value) => updateParam("infoDensity", value)}
          options={["干净", "标准", "高信息量"]}
          value={nextParams.infoDensity}
        />
      </div>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <h3 className="mb-3 text-[14px] font-bold text-primary">输出类别配置</h3>
        <div className="grid grid-cols-[1fr_132px_1fr] items-end gap-3">
          <GenerateSelect
            disabled={locked}
            label="输出类别"
            onChange={(value) => updateParam("targetImageType", value)}
            options={taobaoPageImageTypes.map((item) => item.type)}
            renderValue={(value) => {
              const item = taobaoPageImageTypes.find((type) => type.type === value);
              return item ? `${item.index}_${item.label}` : value;
            }}
            value={selectedImageType.type}
          />
          <GenerateNumberInput
            disabled={locked}
            label="张数"
            max={8}
            min={1}
            onChange={(value) => updateParam(selectedImageType.countKey, value)}
            value={nextParams[selectedImageType.countKey]}
          />
          <GenerateSelect
            compact
            disabled={locked}
            label="尺寸"
            onChange={(value) => updateParam(selectedImageType.sizeKey, value)}
            options={taobaoPageSizeOptions}
            value={nextParams[selectedImageType.sizeKey]}
          />
        </div>
      </section>
    </div>
  );
}

function ReferenceWeightControl({
  disabled = false,
  label,
  onChange,
  value
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const numericValue = Number.parseInt(value, 10);
  const displayValue = Number.isFinite(numericValue) ? Math.min(100, Math.max(0, numericValue)) : 0;

  return (
    <label className="block">
      <span className="mb-2 block px-3 text-[13px] font-medium leading-none text-[#525866]">{label}</span>
      <span className="flex items-center gap-3">
        <input
          className="nodrag nopan nowheel h-2 flex-1 cursor-grab accent-[#6C63FF] active:cursor-grabbing"
          disabled={disabled}
          max={100}
          min={0}
          onChange={(event) => onChange(normalizeBoundedCount(event.currentTarget.value, 0, 100, displayValue))}
          onInput={(event) => onChange(normalizeBoundedCount(event.currentTarget.value, 0, 100, displayValue))}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          type="range"
          value={displayValue}
        />
        <input
          className="nodrag nopan nowheel h-9 w-14 rounded-[10px] border border-[#D9DDE6] bg-[#F6F7FA] text-center text-[15px] font-semibold text-[#525866] outline-none transition focus:border-selected disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          max={100}
          min={0}
          onBlur={(event) => onChange(normalizeBoundedCount(event.currentTarget.value, 0, 100, displayValue))}
          onChange={(event) => {
            const raw = event.currentTarget.value.replace(/[^\d]/g, "");
            if (!raw) {
              onChange("0");
              return;
            }
            onChange(normalizeBoundedCount(raw, 0, 100, displayValue));
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          type="number"
          value={displayValue}
        />
      </span>
    </label>
  );
}

function IndustrialDesignerPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const { modelDisplayName, modelId, modelOptions } = usePromptPlannerModel(data);
  const params = data.modelParams ?? {};
  const cn = (value: unknown, fallback: string, translations: Record<string, string>) => {
    const raw = typeof value === "string" && value.trim() ? value : fallback;
    return translations[raw] ?? raw;
  };
  const nextParams = useMemo(() => ({
    designMode: cn(params.designMode, "融合设计", { Redesign: "重新设计", Fusion: "融合设计", "Appearance Variants": "外观变体", Concept: "概念设计", CMF: "CMF设计" }),
    innovationLevel: cn(params.innovationLevel, "平衡创新", { Conservative: "保守优化", Balanced: "平衡创新", Bold: "大胆创新" }),
    outputLanguage: cn(params.outputLanguage, "中文", { Bilingual: "中英双语", Chinese: "中文", English: "英文" }),
    promptStyle: cn(params.promptStyle, "设计总监模式", { Compact: "简洁模式", Detailed: "详细模式", "Design Director": "设计总监模式" }),
    referenceFusion: cn(params.referenceFusion, "自动融合", { Auto: "自动融合", "Competitor First": "竞品优先", "Mood First": "情绪图优先", "Style First": "风格优先" }),
    schemes: normalizeBoundedCount(params.schemes, 1, 20, 6),
    structureLock: cn(params.structureLock, "严格保持", { Strict: "严格保持", Moderate: "适度调整", Free: "自由创新" }),
    visualStyle: cn(params.visualStyle, "自动判断", { Auto: "自动判断", "Minimal Modern": "极简现代", "Tech Futuristic": "科技未来", "Light Luxury Home": "轻奢家居", "Nordic Natural": "北欧自然", "Business Professional": "商务专业", "Youth Trend": "年轻潮流", "Outdoor Exploration": "户外探索" })
  }), [
    params.designMode,
    params.innovationLevel,
    params.outputLanguage,
    params.promptStyle,
    params.referenceFusion,
    params.schemes,
    params.structureLock,
    params.visualStyle
  ]);

  useEffect(() => {
    const sameModel = data.modelId === modelId;
    const sameParams = Object.entries(nextParams).every(([key, value]) => data.modelParams?.[key] === value);
    if (sameModel && sameParams) return;
    updateNodeData(id, { modelId, modelParams: { ...params, ...nextParams } });
  }, [data.modelId, data.modelParams, id, modelId, nextParams, params, updateNodeData]);

  const updateParam = (key: keyof typeof nextParams, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <section className="grid grid-cols-2 gap-x-7 gap-y-4">
        <GenerateSelect
          disabled={locked}
          label="AI模型"
          onChange={(value) => {
            if (locked) return;
            updateNodeData(id, { modelId: value });
          }}
          options={modelOptions}
          renderValue={modelDisplayName}
          value={modelId}
        />
        <GenerateSelect
          disabled={locked}
          label="输出语言"
          onChange={(value) => updateParam("outputLanguage", value)}
          options={["中文", "英文", "中英双语"]}
          value={nextParams.outputLanguage}
        />
        <GenerateNumberInput
          disabled={locked}
          label="方案数量"
          max={20}
          min={1}
          onChange={(value) => updateParam("schemes", value)}
          value={nextParams.schemes}
        />
      </section>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[14px] font-bold text-primary">设计设置</h3>
          <ChevronDown size={18} strokeWidth={2} className="text-[#525866]" />
        </div>
        <div className="grid grid-cols-2 gap-x-7 gap-y-4">
          <GenerateSelect
            disabled={locked}
            label="设计模式"
            onChange={(value) => updateParam("designMode", value)}
            options={["重新设计", "融合设计", "外观变体", "概念设计", "CMF设计"]}
            value={nextParams.designMode}
          />
          <GenerateSelect
            disabled={locked}
            label="创新程度"
            onChange={(value) => updateParam("innovationLevel", value)}
            options={["保守优化", "平衡创新", "大胆创新"]}
            value={nextParams.innovationLevel}
          />
          <GenerateSelect
            disabled={locked}
            label="结构锁定"
            onChange={(value) => updateParam("structureLock", value)}
            options={["严格保持", "适度调整", "自由创新"]}
            value={nextParams.structureLock}
          />
          <GenerateSelect
            disabled={locked}
            label="参考融合方式"
            onChange={(value) => updateParam("referenceFusion", value)}
            options={["自动融合", "竞品优先", "情绪图优先", "风格优先"]}
            value={nextParams.referenceFusion}
          />
        </div>
      </section>
      <section className="rounded-[14px] border border-[#E1E5EE] bg-white/80 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[14px] font-bold text-primary">风格设置</h3>
          <ChevronDown size={18} strokeWidth={2} className="text-[#525866]" />
        </div>
        <div className="grid grid-cols-2 gap-x-7 gap-y-4">
          <GenerateSelect
            disabled={locked}
            label="设计风格"
            onChange={(value) => updateParam("visualStyle", value)}
            options={["自动判断", "极简现代", "科技未来", "轻奢家居", "北欧自然", "商务专业", "年轻潮流", "户外探索"]}
            value={nextParams.visualStyle}
          />
          <GenerateSelect
            disabled={locked}
            label="Prompt 风格"
            onChange={(value) => updateParam("promptStyle", value)}
            options={["简洁模式", "详细模式", "设计总监模式"]}
            value={nextParams.promptStyle}
          />
        </div>
      </section>
    </div>
  );
}

function VisualDirectorPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const locked = data.runState === "running";
  const modelOptions = useConfiguredImageModels(generateImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const modelId = typeof data.modelId === "string" && generateImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId)) ? data.modelId : modelOptions[0] ?? defaultGenerateImageModelId;
  const params = data.modelParams ?? {};
  const outputLanguage = params.outputLanguage === "English" ? "English" : params.outputLanguage === "中英双语" ? "中英双语" : "中文";
  const aspectRatio = ["9:16", "16:9", "4:5", "1:1"].includes(params.aspectRatio ?? "") ? params.aspectRatio as string : "9:16";
  const resolution = ["1K", "2K", "4K"].includes(params.resolution ?? "") ? params.resolution as string : "2K";
  const imageCount = normalizeBoundedCount(params.imageCount, 1, 6, 1);

  useEffect(() => {
    const nextParams = { ...params, aspectRatio, imageCount, outputLanguage, resolution };
    if (data.modelId === modelId && params.aspectRatio === aspectRatio && params.imageCount === imageCount && params.outputLanguage === outputLanguage && params.resolution === resolution) return;
    updateNodeData(id, { modelId, modelParams: nextParams });
  }, [aspectRatio, data.modelId, id, imageCount, modelId, outputLanguage, params, resolution, updateNodeData]);

  const updateParam = (key: "aspectRatio" | "imageCount" | "outputLanguage" | "resolution", value: string) => {
    if (locked) return;
    updateNodeData(id, { modelParams: { ...params, [key]: value } });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-4 pt-1">
      <GenerateSelect
        disabled={locked}
        label="生图模型"
        onChange={(value) => {
          if (locked) return;
          updateNodeData(id, { modelId: value });
        }}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="输出语言"
        onChange={(value) => updateParam("outputLanguage", value)}
        options={["中文", "English", "中英双语"]}
        value={outputLanguage}
      />
      <div className="grid grid-cols-2 gap-4">
        <GenerateSelect
          disabled={locked}
          label="输出比例"
          onChange={(value) => updateParam("aspectRatio", value)}
          options={["9:16", "16:9", "4:5", "1:1"]}
          value={aspectRatio}
        />
        <GenerateSelect
          disabled={locked}
          label="输出分辨率"
          onChange={(value) => updateParam("resolution", value)}
          options={["1K", "2K", "4K"]}
          value={resolution}
        />
      </div>
      <GenerateSelect
        compact
        disabled={locked}
        label="生成张数"
        onChange={(value) => updateParam("imageCount", value)}
        options={["1", "2", "3", "4", "5", "6"]}
        value={imageCount}
      />
      <div className="rounded-[12px] border border-[#E5E1FF] bg-[#F8F7FF] px-4 py-3 text-[12px] font-semibold leading-5 text-[#6D64A8]">
        输出 Visual Guideline Board，用于统一后续电商与营销视觉。
      </div>
    </div>
  );
}

function GenerateImagePanel({ id, data, showGridOption = true }: { id: string; data: CanvasNodeData; showGridOption?: boolean }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const promptCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(generateImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && generateImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultGenerateImageModelId;
  const spec = getGenerateImageModelSpec(modelId);
  const params = { ...getDefaultGenerateImageParams(modelId), ...(data.modelParams ?? {}) };
  const locked = data.runState === "running";
  const gridEnabled = showGridOption && params.gridEnabled === "true";
  const aspectRatioOptions = [
    "自动",
    "1:1 方图",
    "2:3 竖图",
    "3:2 横图",
    "3:4 竖图",
    "4:3 横图",
    "4:5 竖图",
    "5:4 横图",
    "9:16 手机竖图",
    "16:9 宽屏",
    "21:9 超宽屏",
    "4:1 超宽",
    "1:4 超高",
    "8:1 极宽",
    "1:8 极高"
  ];
  const qualityOptions = [
    { label: "自动", value: "Auto" },
    { label: "低", value: "Low" },
    { label: "中", value: "Medium" },
    { label: "高", value: "High" }
  ];
  const currentQuality = qualityOptions.find((option) => option.value === params.quality)?.label ?? "自动";

  useEffect(() => {
    if (data.modelId && data.modelId === modelId && data.modelParams) return;
    updateNodeData(id, { modelId, modelParams: params });
  }, [data.modelId, data.modelParams, id, modelId, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        ...getDefaultGenerateImageParams(nextModelId),
        ...(showGridOption ? { gridEnabled: params.gridEnabled ?? "false" } : {})
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      <GenerateSelect
        disabled={locked}
        label="模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="画幅比例"
        onChange={(value) => updateParam("aspectRatio", value)}
        options={aspectRatioOptions}
        value={params.aspectRatio === "Auto" ? "自动" : params.aspectRatio ?? "自动"}
      />
      <GenerateSelect
        disabled={locked}
        label="分辨率"
        onChange={(value) => updateParam("resolution", value)}
        options={spec.params.find((param) => param.key === "resolution")?.options ?? ["1K"]}
        value={params.resolution ?? "1K"}
      />
      {spec.params.some((param) => param.key === "quality") ? (
        <GenerateSelect
          disabled={locked}
          label="质量"
          onChange={(label) => updateParam("quality", qualityOptions.find((option) => option.label === label)?.value ?? "Auto")}
          options={qualityOptions.map((option) => option.label)}
          value={currentQuality}
        />
      ) : null}
      {showGridOption ? (
        <div className="grid grid-cols-[132px_1fr] items-end gap-3">
          <GenerateSelect
            compact
            disabled={locked || gridEnabled}
            label="生成张数"
            onChange={(value) => updateParam("imageCount", value)}
            options={["1", "2", "3", "4"]}
            value={gridEnabled ? "1" : params.imageCount ?? "1"}
          />
          <label className="flex h-8 items-center justify-between rounded-[16px] border border-[#D9DDE6] bg-[#F6F7FA] px-4 text-[15px] font-semibold text-[#525866]">
            <span>宫图</span>
            <span className="flex items-center gap-3">
              {gridEnabled ? (
                <span className={promptCount > 10 ? "text-danger" : "text-[#7C7F86]"}>
                  {promptCount > 10 ? "10+" : `${promptCount || 0} 宫`}
                </span>
              ) : null}
              <input
                checked={gridEnabled}
                className="h-4 w-4 accent-[#6C63FF]"
                disabled={locked}
                onChange={(event) => updateParam("gridEnabled", event.currentTarget.checked ? "true" : "false")}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                type="checkbox"
              />
            </span>
          </label>
        </div>
      ) : (
        <GenerateSelect
          compact
          disabled={locked}
          label="生成张数"
          onChange={(value) => updateParam("imageCount", value)}
          options={["1", "2", "3", "4"]}
          value={params.imageCount ?? "1"}
        />
      )}
    </div>
  );
}

function HdRedrawPanel({ id, data, step }: { id: string; data: CanvasNodeData; step: "1" | "2" }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const imageInputCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "image-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => node?.data.kind === "image" && node.data.imageUrl).length
  );
  const promptInputCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(generateImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && generateImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultGenerateImageModelId;
  const spec = getGenerateImageModelSpec(modelId);
  const params: Record<string, string> = { ...getDefaultGenerateImageParams(modelId), imageCount: "1", ...(data.modelParams ?? {}) };
  const locked = data.runState === "running";
  const aspectRatioOptions = [
    "自动",
    "1:1 方图",
    "2:3 竖图",
    "3:2 横图",
    "3:4 竖图",
    "4:3 横图",
    "4:5 竖图",
    "5:4 横图",
    "9:16 手机竖图",
    "16:9 宽屏",
    "21:9 超宽屏",
    "4:1 超宽",
    "1:4 超高",
    "8:1 极宽",
    "1:8 极高"
  ];
  const qualityOptions = [
    { label: "自动", value: "Auto" },
    { label: "低", value: "Low" },
    { label: "中", value: "Medium" },
    { label: "高", value: "High" }
  ];
  const currentQuality = qualityOptions.find((option) => option.value === params.quality)?.label ?? "自动";

  useEffect(() => {
    const nextParams = { ...params, gridEnabled: "false", imageCount: "1" };
    if (data.modelId && data.modelId === modelId && data.modelParams?.imageCount === "1") return;
    updateNodeData(id, { modelId, modelParams: nextParams });
  }, [data.modelId, data.modelParams, id, modelId, params, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        ...getDefaultGenerateImageParams(nextModelId),
        gridEnabled: "false",
        imageCount: "1"
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value,
        gridEnabled: "false",
        imageCount: "1"
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-3">
      <div className={`rounded-[12px] border px-4 py-3 text-[12px] font-semibold leading-5 ${
        imageInputCount && (step === "1" || promptInputCount) ? "border-[#DCE8DF] bg-[#F4FBF6] text-[#3B6F4B]" : "border-[#FFE0B8] bg-[#FFF8ED] text-[#9A5B12]"
      }`}>
        {step === "1"
          ? "第一步：连接 1 张 A 图。运行后输出 B 结构参考图和 A 图 Prompt，并自动连接到高清重绘2。"
          : `第二步：接收 A 图、B 图和 A 图 Prompt 后运行，输出最终 C 高清重绘图。图片 ${imageInputCount} 张，Prompt ${promptInputCount} 条。`}
      </div>
      <GenerateSelect
        disabled={locked}
        label="模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="画幅比例"
        onChange={(value) => updateParam("aspectRatio", value)}
        options={aspectRatioOptions}
        value={params.aspectRatio === "Auto" ? "自动" : params.aspectRatio ?? "自动"}
      />
      <div className="grid grid-cols-2 gap-3">
        <GenerateSelect
          compact
          disabled={locked}
          label="分辨率"
          onChange={(value) => updateParam("resolution", value)}
          options={spec.params.find((param) => param.key === "resolution")?.options ?? ["1K"]}
          value={params.resolution ?? "1K"}
        />
        {spec.params.some((param) => param.key === "quality") ? (
          <GenerateSelect
            compact
            disabled={locked}
            label="质量"
            onChange={(label) => updateParam("quality", qualityOptions.find((option) => option.label === label)?.value ?? "Auto")}
            options={qualityOptions.map((option) => option.label)}
            value={currentQuality}
          />
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}

function RhinoTestPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  return (
    <div className="grid gap-3">
      <div className="rounded-[12px] border border-[#DCE8DF] bg-[#F4FBF6] px-4 py-3 text-[12px] font-semibold leading-5 text-[#3B6F4B]">
        Rhino 测试节点会锁定输入图片里的产品外观、比例、角度和透视，只根据 Prompt 调整材质、颜色、灯光和商业摄影效果。
      </div>
      <GenerateImagePanel id={id} data={data} showGridOption={false} />
    </div>
  );
}

function TextImageLayoutPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const modelOptions = useConfiguredImageModels(generateImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && generateImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultGenerateImageModelId;
  const spec = getGenerateImageModelSpec(modelId);
  const modelResolutionOptions = spec.params.find((param) => param.key === "resolution")?.options ?? ["1K"];
  const onlySupports1K = modelResolutionOptions.length === 1 && modelResolutionOptions[0] === "1K";
  const storedResolution = data.modelParams?.resolution;
  const resolution = onlySupports1K ? "1K" : storedResolution ?? "Auto";
  const params = useMemo(() => ({
    aspectRatio: "Auto",
    imageCount: "1",
    ...(data.modelParams ?? {}),
    resolution
  }), [data.modelParams, resolution]);
  const locked = data.runState === "running";
  const aspectRatioOptions = [
    "Auto",
    "1:1 Square",
    "2:3 Portrait",
    "3:2 Landscape",
    "3:4 Portrait",
    "4:3 Landscape",
    "4:5 Portrait",
    "5:4 Landscape",
    "9:16 Phone Portrait",
    "16:9 Widescreen",
    "21:9 Ultrawide",
    "4:1 Superwide",
    "1:4 Supertall"
  ];
  const resolutionOptions = onlySupports1K ? ["1K"] : ["Auto", ...modelResolutionOptions];

  useEffect(() => {
    if (data.modelId && data.modelId === modelId && data.modelParams && data.modelParams.resolution === resolution) return;
    updateNodeData(id, { modelId, modelParams: params });
  }, [data.modelId, data.modelParams, id, modelId, params, resolution, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        aspectRatio: params.aspectRatio ?? "Auto",
        imageCount: params.imageCount ?? "1",
        resolution: getGenerateImageModelSpec(nextModelId).params.find((param) => param.key === "resolution")?.options.length === 1 ? "1K" : "Auto"
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      <GenerateSelect
        disabled={locked}
        label="模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="画幅比例"
        onChange={(value) => updateParam("aspectRatio", value)}
        options={aspectRatioOptions}
        value={params.aspectRatio ?? "Auto"}
      />
      <GenerateSelect
        disabled={locked}
        label="分辨率"
        onChange={(value) => updateParam("resolution", value)}
        options={resolutionOptions}
        value={resolution}
      />
      <GenerateSelect
        compact
        disabled={locked}
        label="生成张数"
        onChange={(value) => updateParam("imageCount", value)}
        options={["1", "2", "3", "4"]}
        value={params.imageCount ?? "1"}
      />
    </div>
  );
}

function GridImagePanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const promptCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(gridImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && gridImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultGridImageModelId;
  const spec = getGridImageModelSpec(modelId);
  const params = { ...getDefaultGridImageParams(modelId), ...(data.modelParams ?? {}) };
  const visibleParams = spec.params;
  const locked = data.runState === "running";

  useEffect(() => {
    if (data.modelId && data.modelId === modelId && data.modelParams) return;
    updateNodeData(id, { modelId, modelParams: params });
  }, [data.modelId, data.modelParams, id, modelId, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: getDefaultGridImageParams(nextModelId)
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      <GenerateSelect
        label="AI Model"
        disabled={locked}
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      {visibleParams.map((param) => (
        <GenerateSelect
          compact={param.compact}
          disabled={locked}
          key={param.key}
          label={param.label}
          onChange={(value) => updateParam(param.key, value)}
          options={param.options}
          value={params[param.key] ?? param.options[0]}
        />
      ))}
      <div className="mt-1 flex h-8 items-center justify-between rounded-[16px] border border-[#D9DDE6] bg-[#F6F7FA] px-4 text-[14px] font-semibold text-[#525866]">
        <span>Grid</span>
        <span className={promptCount > 10 ? "text-danger" : "text-[#7C7F86]"}>{promptCount > 10 ? "10+" : promptCount || 0}</span>
      </div>
    </div>
  );
}

function SceneImagePanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const promptCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(sceneImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && sceneImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultSceneImageModelId;
  const spec = getSceneImageModelSpec(modelId);
  const params = { ...getDefaultSceneImageParams(modelId), ...(data.modelParams ?? {}) };
  const locked = data.runState === "running";
  const isMosquitoMode = data.kind === "mosquitoSceneImage";
  const gridEnabled = params.gridEnabled === "true";
  const aspectRatioOptions = [
    "自动",
    "1:1 方图",
    "2:3 竖图",
    "3:2 横图",
    "3:4 竖图",
    "4:3 横图",
    "4:5 竖图",
    "5:4 横图",
    "9:16 手机竖图",
    "16:9 宽屏",
    "21:9 超宽屏",
    "4:1 超宽",
    "1:4 超高",
    "8:1 极宽",
    "1:8 极高"
  ];

  useEffect(() => {
    if (data.modelId && data.modelId === modelId && data.modelParams) return;
    updateNodeData(id, { modelId, modelParams: params });
  }, [data.modelId, data.modelParams, id, modelId, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        ...getDefaultSceneImageParams(nextModelId),
        gridEnabled: params.gridEnabled ?? "false"
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      {isMosquitoMode ? (
        <div className="rounded-[12px] border border-[#D9E1FF] bg-[#F5F7FF] px-3 py-2 text-[12px] font-semibold leading-5 text-[#506095]">
          严格执行 Prompt 明确要求的内容；未要求时不自动添加人物、宠物或蚊虫。
        </div>
      ) : null}
      <GenerateSelect
        disabled={locked}
        label="模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="画幅比例"
        onChange={(value) => updateParam("aspectRatio", value)}
        options={aspectRatioOptions}
        value={params.aspectRatio === "Auto" ? "自动" : params.aspectRatio ?? "自动"}
      />
      <GenerateSelect
        disabled={locked}
        label="分辨率"
        onChange={(value) => updateParam("resolution", value)}
        options={spec.params.find((param) => param.key === "resolution")?.options ?? ["1K"]}
        value={params.resolution ?? "1K"}
      />
      <GenerateSelect
        compact
        disabled={locked || gridEnabled}
        label="生成张数"
        onChange={(value) => updateParam("imageCount", value)}
        options={["1", "2", "3", "4"]}
        value={gridEnabled ? "1" : params.imageCount ?? "1"}
      />
      <label className="flex h-10 items-center justify-between rounded-[18px] border border-[#D9DDE6] bg-[#F6F7FA] px-4 text-[15px] font-semibold text-[#525866]">
        <span>宫图</span>
        <span className="flex items-center gap-3">
          {gridEnabled ? (
            <span className={promptCount > 10 ? "text-danger" : "text-[#7C7F86]"}>
              {promptCount > 10 ? "10+" : `${promptCount || 0} 宫`}
            </span>
          ) : null}
          <input
            checked={gridEnabled}
            className="h-4 w-4 accent-[#6C63FF]"
            disabled={locked}
            onChange={(event) => updateParam("gridEnabled", event.currentTarget.checked ? "true" : "false")}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            type="checkbox"
          />
        </span>
      </label>
    </div>
  );
}

function IndustrialDesignImagePanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const promptCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(industrialDesignImageModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && industrialDesignImageModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultIndustrialDesignImageModelId;
  const spec = getIndustrialDesignImageModelSpec(modelId);
  const params = { ...getDefaultIndustrialDesignImageParams(modelId), ...(data.modelParams ?? {}) };
  const locked = data.runState === "running";
  const gridEnabled = params.gridEnabled === "true";
  const aspectRatioOptions = [
    "自动",
    "1:1 方图",
    "2:3 竖图",
    "3:2 横图",
    "3:4 竖图",
    "4:3 横图",
    "4:5 竖图",
    "5:4 横图",
    "9:16 手机竖图",
    "16:9 宽屏",
    "21:9 超宽屏",
    "4:1 超宽",
    "1:4 超高",
    "8:1 极宽",
    "1:8 极高"
  ];

  useEffect(() => {
    if (data.modelId && data.modelId === modelId && data.modelParams) return;
    updateNodeData(id, { modelId, modelParams: params });
  }, [data.modelId, data.modelParams, id, modelId, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        ...getDefaultIndustrialDesignImageParams(nextModelId),
        gridEnabled: params.gridEnabled ?? "false"
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value
      }
    });
  };

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      <GenerateSelect
        disabled={locked}
        label="模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <GenerateSelect
        disabled={locked}
        label="画幅比例"
        onChange={(value) => updateParam("aspectRatio", value)}
        options={aspectRatioOptions}
        value={params.aspectRatio === "Auto" ? "自动" : params.aspectRatio ?? "自动"}
      />
      <GenerateSelect
        disabled={locked}
        label="分辨率"
        onChange={(value) => updateParam("resolution", value)}
        options={spec.params.find((param) => param.key === "resolution")?.options ?? ["1K"]}
        value={params.resolution ?? "1K"}
      />
      <GenerateSelect
        compact
        disabled={locked || gridEnabled}
        label="生成张数"
        onChange={(value) => updateParam("imageCount", value)}
        options={["1", "2", "3", "4"]}
        value={gridEnabled ? "1" : params.imageCount ?? "1"}
      />
      <label className="flex h-10 items-center justify-between rounded-[18px] border border-[#D9DDE6] bg-[#F6F7FA] px-4 text-[15px] font-semibold text-[#525866]">
        <span>宫图</span>
        <span className="flex items-center gap-3">
          {gridEnabled ? (
            <span className={promptCount > 10 ? "text-danger" : "text-[#7C7F86]"}>
              {promptCount > 10 ? "10+" : `${promptCount || 0} 宫`}
            </span>
          ) : null}
          <input
            checked={gridEnabled}
            className="h-4 w-4 accent-[#6C63FF]"
            disabled={locked}
            onChange={(event) => updateParam("gridEnabled", event.currentTarget.checked ? "true" : "false")}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            type="checkbox"
          />
        </span>
      </label>
    </div>
  );
}

const remixMeaningByValue: Record<number, string> = {
  0: "完全保留主产品，几乎等于原主产品图，不参考参考产品",
  5: "极轻微参考，只允许出现非常小的颜色、光泽或质感变化",
  10: "轻微参考参考产品，主产品结构、轮廓、比例基本不变",
  15: "在主产品基础上加入少量参考产品的细节，比如纹理、边角、装饰线",
  20: "主产品仍占绝对主导，参考产品只影响局部材质或小部件",
  25: "主产品为主，轻微吸收参考产品的配色、材质或细节语言",
  30: "主产品结构稳定，参考产品开始影响局部造型和视觉风格",
  35: "主产品仍明显可识别，但参考产品的设计特征变得更清楚",
  40: "主产品占主导，参考产品开始影响整体风格、比例或表面处理",
  45: "略偏主产品，参考产品参与较多，但主体轮廓仍以主产品为准",
  50: "主产品和参考产品均衡融合，结构、风格、材质各占一半",
  55: "略偏参考产品，但仍保留主产品的核心识别和主要功能结构",
  60: "参考产品开始主导外观风格，主产品保留基础轮廓或关键元素",
  65: "明显参考产品方向，主产品只保留部分结构、品牌感或功能线索",
  70: "参考产品占主导，主产品变成辅助参考，整体外观明显改变",
  75: "明显偏向参考产品，主产品只保留少量识别特征",
  80: "大幅采用参考产品的造型、材质、比例和设计语言",
  85: "几乎是参考产品方向，仅保留主产品的一点功能或品牌线索",
  90: "极度偏向参考产品，主产品影响很弱，只作为轻微约束",
  95: "接近完全参考产品，主产品几乎不再影响最终外观",
  100: "完全偏向参考产品，结果应接近参考产品图，不保留主产品结构"
};

function normalizeRemixValue(value: unknown, fallback: number) {
  const numeric = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return String(fallback);
  return String(Math.min(100, Math.max(0, Math.round(numeric / 5) * 5)));
}

function ProductRemixPanel({ id, data }: { id: string; data: CanvasNodeData }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const imageInputCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "image-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => node?.data.kind === "image" && node.data.imageUrl).length
  );
  const promptInputCount = useCanvasStore((state) => state.edges
    .filter((edge) => edge.target === id && edge.targetHandle === "text-in")
    .map((edge) => state.nodes.find((node) => node.id === edge.source))
    .filter((node) => typeof node?.data.prompt === "string" && node.data.prompt.trim()).length
  );
  const modelOptions = useConfiguredImageModels(productRemixModelIds, data.modelId);
  const modelDisplayName = (model: string) => getModelDisplayName(model, modelOptions);
  const hasKnownModel = typeof data.modelId === "string" && modelOptions.includes(data.modelId) && productRemixModelSpecs.some((model) => model.id === getBaseModelId(data.modelId));
  const modelId = hasKnownModel ? data.modelId as string : modelOptions[0] ?? defaultProductRemixModelId;
  const spec = getProductRemixModelSpec(modelId);
  const params = { ...getDefaultProductRemixParams(modelId), ...(data.modelParams ?? {}) };
  const locked = data.runState === "running";
  const gridMode = ["1", "2", "4", "6", "9"].includes(params.gridMode) ? params.gridMode : "1";
  const isSingle = gridMode === "1";
  const remix = normalizeRemixValue(params.remix, 50);
  const startRemix = normalizeRemixValue(params.startRemix, 0);
  const endRemix = normalizeRemixValue(params.endRemix, 100);
  const sizeParam = spec.params.find((param) => param.key === "size");
  const resolutionParam = spec.params.find((param) => param.key === "resolution");
  const hasAspectRatioParam = spec.params.some((param) => param.key === "aspectRatio");
  const aspectRatioOptions = [
    "自动",
    "1:1 方图",
    "2:3 竖图",
    "3:2 横图",
    "3:4 竖图",
    "4:3 横图",
    "4:5 竖图",
    "5:4 横图",
    "9:16 手机竖图",
    "16:9 宽屏",
    "21:9 超宽屏",
    "4:1 超宽",
    "1:4 超高",
    "8:1 极宽",
    "1:8 极高"
  ];

  useEffect(() => {
    const nextParams = { ...params, endRemix, gridMode, imageCount: "1", remix, startRemix };
    if (data.modelId && data.modelId === modelId && data.modelParams?.endRemix === endRemix && data.modelParams?.gridMode === gridMode && data.modelParams?.imageCount === "1" && data.modelParams?.remix === remix && data.modelParams?.startRemix === startRemix) return;
    updateNodeData(id, { modelId, modelParams: nextParams });
  }, [data.modelId, data.modelParams, endRemix, gridMode, id, modelId, params, remix, startRemix, updateNodeData]);

  const updateModel = (nextModelId: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelId: nextModelId,
      modelParams: {
        ...getDefaultProductRemixParams(nextModelId),
        endRemix,
        gridMode,
        remix,
        startRemix
      }
    });
  };

  const updateParam = (key: string, value: string) => {
    if (locked) return;
    updateNodeData(id, {
      modelParams: {
        ...params,
        [key]: value,
        imageCount: "1"
      }
    });
  };

  const currentMeaning = isSingle
    ? remixMeaningByValue[Number(remix)]
    : `第 1 格为 ${startRemix}，最后 1 格为 ${endRemix}，中间宫格按 5 的倍数自动均分。`;

  return (
    <div className="nodrag nopan nowheel grid gap-3 pt-1">
      <GenerateSelect
        disabled={locked}
        label="生图模型"
        onChange={updateModel}
        options={modelOptions}
        renderValue={modelDisplayName}
        value={modelId}
      />
      <div className="grid grid-cols-2 gap-3">
        <GenerateSelect
          disabled={locked}
          label="输出模式"
          onChange={(value) => updateParam("gridMode", value.replace("宫", ""))}
          options={["1宫", "2宫", "4宫", "6宫", "9宫"]}
          value={`${gridMode}宫`}
        />
        {sizeParam ? (
          <GenerateSelect
            disabled={locked}
            label="尺寸"
            onChange={(value) => updateParam("size", value)}
            options={sizeParam.options}
            value={params.size ?? sizeParam.options[0]}
          />
        ) : (
          <GenerateSelect
            disabled={locked}
            label="分辨率"
            onChange={(value) => updateParam("resolution", value)}
            options={resolutionParam?.options ?? ["1K", "2K", "4K"]}
            value={params.resolution ?? "2K"}
          />
        )}
      </div>
      {hasAspectRatioParam ? (
        <GenerateSelect
          disabled={locked}
          label="画面比例"
          onChange={(value) => updateParam("aspectRatio", value)}
          options={aspectRatioOptions}
          value={params.aspectRatio === "Auto" ? "自动" : params.aspectRatio ?? "自动"}
        />
      ) : null}
      {isSingle ? (
        <RemixSlider disabled={locked} label="Remix 强度" onChange={(value) => updateParam("remix", value)} value={remix} />
      ) : (
        <div className="grid gap-3">
          <RemixSlider disabled={locked} label="起始 Remix" onChange={(value) => updateParam("startRemix", value)} value={startRemix} />
          <RemixSlider disabled={locked} label="结束 Remix" onChange={(value) => updateParam("endRemix", value)} value={endRemix} />
        </div>
      )}
      <div className={`rounded-[12px] border px-4 py-3 text-[12px] font-semibold leading-5 ${
        imageInputCount > 5 ? "border-[#FFD6D6] bg-[#FFF5F5] text-danger" : "border-[#DDE6F6] bg-[#F7FAFF] text-[#58637A]"
      }`}>
        <div>{currentMeaning}</div>
        <div className="mt-1 text-[#7C8494]">图片 {imageInputCount} 张，前置 Prompt {promptInputCount} 条。主产品和参考产品由前置 Prompt 定义，总图片最多 5 张，节点始终输出 1 张图片。</div>
      </div>
    </div>
  );
}

function normalizeSchemeCount(value: unknown) {
  const numeric = Number.parseInt(typeof value === "string" ? value : String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return "1";
  return String(Math.min(10, Math.max(1, numeric)));
}

function GenerateNumberInput({
  disabled = false,
  label,
  max,
  min,
  onChange,
  value
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  value: string;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraftValue(value);
  }, [focused, value]);

  const commitValue = () => {
    const normalized = normalizeBoundedCount(draftValue, min, max, min);
    setDraftValue(normalized);
    setFocused(false);
    onChange(normalized);
  };

  return (
    <label className="block w-[132px]">
      <span className="mb-0.5 block px-3 text-[13px] font-medium leading-none text-[#525866]">{label}</span>
      <input
        className="nodrag nopan nowheel h-8 w-full rounded-[16px] border border-[#D9DDE6] bg-[#F6F7FA] px-4 text-[16px] font-semibold text-[#7C7F86] outline-none transition focus:border-selected disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => {
          const raw = event.currentTarget.value.replace(/[^\d]/g, "");
          setDraftValue(raw);
          const numeric = Number.parseInt(raw, 10);
          if (Number.isFinite(numeric) && numeric >= min && numeric <= max) onChange(String(numeric));
        }}
        onBlur={commitValue}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="number"
        value={focused ? draftValue : value}
      />
    </label>
  );
}

function RemixSlider({
  disabled = false,
  label,
  onChange,
  value
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between px-3 text-[13px] font-medium leading-none text-[#525866]">
        <span>{label}</span>
        <span className="text-[14px] font-bold text-[#353A45]">{value}</span>
      </span>
      <input
        className="nodrag nopan nowheel h-5 w-full accent-[#6C63FF] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        max={100}
        min={0}
        onChange={(event) => onChange(normalizeRemixValue(event.currentTarget.value, Number(value)))}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        step={5}
        type="range"
        value={value}
      />
      <span className="mt-0.5 flex justify-between px-3 text-[10px] font-semibold text-[#8B93A3]">
        <span>主产品</span>
        <span>均衡</span>
        <span>参考产品</span>
      </span>
    </label>
  );
}

function GenerateSelect({
  compact,
  disabled = false,
  label,
  onChange,
  options,
  renderValue,
  value
}: {
  compact?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  renderValue?: (value: string) => string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof globalThis.Node) || !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className={`relative block ${compact ? "w-[132px]" : "w-full"}`} ref={wrapperRef}>
      <span className="mb-0.5 block px-3 text-[13px] font-medium leading-none text-[#525866]">{label}</span>
      <span className="relative block">
        <button
          className={`h-8 w-full rounded-[16px] border bg-[#F6F7FA] px-4 pr-9 text-left text-[16px] font-semibold text-[#7C7F86] outline-none transition ${
            disabled ? "cursor-not-allowed opacity-60" : ""
          } ${open ? "border-selected" : "border-[#D9DDE6]"
          }`}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (disabled) return;
            setOpen((current) => !current);
          }}
          type="button"
        >
          <span className="block truncate">{renderValue ? renderValue(value) : value}</span>
        </button>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#4B4F58]" size={18} strokeWidth={2} />
      </span>
      {open ? (
        <div
          className="absolute left-0 right-0 top-[46px] z-50 max-h-[236px] overflow-y-auto rounded-[12px] border border-[#D9DDE6] bg-white p-1 shadow-soft"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {options.map((option) => (
            <button
              className={`block h-8 w-full rounded-[9px] px-3 text-left text-[16px] font-semibold ${
                option === value ? "bg-selected text-white" : "text-[#7C7F86] hover:bg-[#F4F6FA]"
              }`}
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              type="button"
            >
              {option === value ? "✓ " : ""}
              {renderValue ? renderValue(option) : option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NodeModelSelect({ id, kind, value }: { id: string; kind: "image" | "text"; value?: string }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    const loadModels = () => {
      try {
        const saved = readClientAiSettings() as StoredApiSettings | null;
        if (!active) return;
        setModels(kind === "image" ? saved?.imageModels ?? [] : saved?.textModels ?? []);
      } catch {
        if (active) setModels([]);
      }
    };
    loadModels();
    window.addEventListener("ai-canvas-api-settings-updated", loadModels);
    window.addEventListener("storage", loadModels);
    return () => {
      active = false;
      window.removeEventListener("ai-canvas-api-settings-updated", loadModels);
      window.removeEventListener("storage", loadModels);
    };
  }, [kind]);

  useEffect(() => {
    if (!models.length || (value && models.includes(value))) return;
    updateNodeData(id, { modelId: models[0] });
  }, [id, models, updateNodeData, value]);

  return (
    <div className="nodrag nopan nowheel relative">
      <select
        className="h-8 w-full appearance-none rounded-[10px] border border-line bg-[#FBFCFE] px-3 pr-8 text-xs font-semibold text-secondary outline-none transition focus:border-selected"
        disabled={!models.length}
        onChange={(event) => updateNodeData(id, { modelId: event.currentTarget.value })}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        value={value && models.includes(value) ? value : models[0] ?? ""}
      >
        <option value="">{models.length ? "选择模型" : "连接后读取模型"}</option>
        {models.map((model) => (
          <option key={model} value={model}>
            {getModelDisplayName(model, models)}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-secondary" size={15} strokeWidth={1.8} />
    </div>
  );
}

function ImageUploadArea({ id, imageUrl }: { id: string; imageUrl?: string }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setImagePreviewUrl = useCanvasStore((state) => state.setImagePreviewUrl);
  const displayImageUrl = getImageDisplayUrl(imageUrl, "canvas-node-preview.png");

  const openPicker = () => {
    inputRef.current?.click();
  };

  const readImage = (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      updateNodeData(id, { generatedBy: undefined, imageUrl: String(reader.result), modelId: undefined, runState: "idle" }, { record: true });
    };
    reader.readAsDataURL(file);
  };

  return (
    <button
      aria-label="上传图片"
      className="nodrag nopan flex h-[186px] w-full cursor-pointer items-center justify-center overflow-hidden rounded-[12px] border border-[#ECEFF5] bg-[#F5F6FA] p-0 transition hover:border-[#D9DDEA] hover:bg-[#F3F5F9]"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (imageUrl) {
          setImagePreviewUrl(imageUrl);
          return;
        }
        openPicker();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{ lineHeight: 0 }}
      title="双击上传图片"
      type="button"
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={(event) => {
            if (!imageUrl || event.currentTarget.src === imageUrl) return;
            event.currentTarget.src = imageUrl;
          }}
          src={displayImageUrl}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            objectPosition: "center"
          }}
        />
      ) : (
        <span className="grid h-full place-items-center text-sm text-secondary">Image</span>
      )}
      <input
        accept="image/png,image/jpeg,image/jpg,image/webp"
        className="hidden"
        onChange={(event) => {
          readImage(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
        ref={inputRef}
        type="file"
      />
    </button>
  );
}

function sanitizeInlinePromptHtml(value: string) {
  return value
    .replace(/<(?!\/?(?:span|br)\b)[^>]*>/gi, "")
    .replace(/<span\b(?![^>]*style=["']color:\s*#?ff3b30;?\s*font-weight:\s*700["'][^>]*>)/gi, "<span>")
    .replace(/\son\w+=["'][^"']*["']/gi, "");
}

function PromptTextArea({ id, richHtml, value }: { id: string; richHtml?: string; value: string }) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const saveHistory = useCanvasStore((state) => state.saveHistory);
  const nodes = useCanvasStore((state) => state.nodes);
  const imageMentions = useMemo(() =>
    nodes
      .filter((node) => node.data.kind === "image" && typeof node.data.imageNumber === "number")
      .map((node) => ({
        id: node.id,
        imageNumber: node.data.imageNumber as number,
        imageUrl: typeof node.data.imageUrl === "string" ? node.data.imageUrl : undefined,
        label: `Image ${String(node.data.imageNumber as number).padStart(3, "0")}`
      }))
      .sort((a, b) => a.imageNumber - b.imageNumber),
    [nodes]
  );
  const [draft, setDraft] = useState(value);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionOptionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const composingRef = useRef(false);
  const editHistorySavedRef = useRef(false);
  const filteredMentions = useMemo(() => (
    mentionQuery === null
      ? []
      : imageMentions.filter((image) => image.label.toLowerCase().includes(mentionQuery.trim().toLowerCase()))
  ), [imageMentions, mentionQuery]);

  useEffect(() => {
    if (!composingRef.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!filteredMentions.length) setMentionIndex(0);
    else setMentionIndex((current) => Math.min(current, filteredMentions.length - 1));
  }, [filteredMentions.length]);

  useEffect(() => {
    const activeMention = filteredMentions[mentionIndex];
    if (!activeMention) return;
    mentionOptionRefs.current[activeMention.id]?.scrollIntoView({ block: "nearest" });
  }, [filteredMentions, mentionIndex]);

  const syncMentionState = (next: string, caret: number) => {
    const beforeCaret = next.slice(0, caret);
    const match = beforeCaret.match(/(?:^|\s)@([A-Za-z0-9 ]{0,24})$/);
    if (!match) {
      setMentionQuery(null);
      setMentionStart(null);
      return;
    }
    setMentionQuery(match[1] ?? "");
    setMentionStart(caret - (match[1]?.length ?? 0) - 1);
  };

  const selectMention = (label: string) => {
    if (mentionStart === null) return;
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mentionStart)}@${label} ${draft.slice(caret)}`;
    setDraft(next);
    updateNodeData(id, { prompt: next });
    setMentionQuery(null);
    setMentionStart(null);
    window.requestAnimationFrame(() => {
      const nextCaret = mentionStart + label.length + 2;
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  if (richHtml) {
    return (
      <div className="relative">
        <div
          className="nodrag nopan nowheel h-[186px] overflow-y-auto whitespace-pre-wrap rounded-[12px] border border-[#F2DFB8] bg-[#FFFDF8] p-4 text-sm leading-6 text-primary outline-none"
          dangerouslySetInnerHTML={{ __html: sanitizeInlinePromptHtml(richHtml) }}
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <textarea
        className="nodrag nopan nowheel h-[186px] w-full resize-none rounded-[12px] border border-[#F2DFB8] bg-[#FFFDF8] p-4 text-sm leading-6 text-primary outline-none placeholder:text-secondary focus:border-[#E4C47F]"
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          syncMentionState(next, event.currentTarget.selectionStart);
          if (!composingRef.current) updateNodeData(id, { prompt: next });
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const next = event.currentTarget.value;
          setDraft(next);
          syncMentionState(next, event.currentTarget.selectionStart);
          updateNodeData(id, { prompt: next });
          event.stopPropagation();
        }}
        onCompositionStart={(event) => {
          composingRef.current = true;
          event.stopPropagation();
        }}
        onCompositionUpdate={(event) => event.stopPropagation()}
        onClick={(event) => {
          syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart);
          event.stopPropagation();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
        onFocus={(event) => {
          syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart);
          if (editHistorySavedRef.current) return;
          editHistorySavedRef.current = true;
          saveHistory();
        }}
        onBlur={() => {
          editHistorySavedRef.current = false;
          window.setTimeout(() => {
            setMentionQuery(null);
            setMentionStart(null);
          }, 120);
        }}
        onKeyDown={(event) => {
          if (mentionQuery !== null && filteredMentions.length) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((current) => (current + 1) % filteredMentions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex((current) => (current - 1 + filteredMentions.length) % filteredMentions.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              selectMention(filteredMentions[mentionIndex]?.label ?? filteredMentions[0].label);
              return;
            }
            if (event.key === "Escape") {
              setMentionQuery(null);
              setMentionStart(null);
              return;
            }
          }
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseMove={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        placeholder="输入提示词"
        ref={textareaRef}
        value={draft}
      />
      {mentionQuery !== null && filteredMentions.length ? (
        <div
          className="nodrag nopan nowheel absolute left-3 right-3 top-12 z-50 max-h-[210px] overflow-y-auto rounded-[12px] border border-[#D9DDE6] bg-white p-1 shadow-soft"
          onMouseDown={(event) => event.preventDefault()}
        >
          {filteredMentions.map((image, index) => (
            <button
              className={`flex h-10 w-full items-center gap-2 rounded-[9px] px-2 text-left text-[13px] font-semibold transition ${
                index === mentionIndex ? "bg-selected text-white" : "text-primary hover:bg-[#F4F6FA]"
              }`}
              key={image.id}
              onClick={() => selectMention(image.label)}
              ref={(element) => {
                mentionOptionRefs.current[image.id] = element;
              }}
              type="button"
            >
              <span className={`grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[7px] border ${
                index === mentionIndex ? "border-white/45 bg-white/15" : "border-[#E3E7EF] bg-[#F5F6FA]"
              }`}>
                {image.imageUrl ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                    onError={(event) => {
                      if (!image.imageUrl || event.currentTarget.src === image.imageUrl) return;
                      event.currentTarget.src = image.imageUrl;
                    }}
                    src={getImageDisplayUrl(image.imageUrl, "mention-preview.png")}
                  />
                ) : (
                  <span className={index === mentionIndex ? "text-[10px] text-white/85" : "text-[10px] text-secondary"}>空</span>
                )}
              </span>
              <span>{image.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
