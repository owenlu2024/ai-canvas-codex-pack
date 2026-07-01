"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Image as ImageIcon, SendHorizontal, Trash2, X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { readClientGeneratedImages, removeClientGeneratedImages } from "@/lib/clientGeneratedImages";
import { downloadImageToFile } from "@/lib/downloadImage";

interface GeneratedImageItem {
  id: string;
  imageUrl: string;
  modelId?: string;
  prompt?: string;
  createdAt?: string;
}

function formatSavedAt(value?: string) {
  if (!value) return "AI 返图";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  }).format(new Date(value));
}

function getImageFilename(item: GeneratedImageItem) {
  const stamp = item.createdAt ? item.createdAt.replace(/[-:.TZ]/g, "").slice(0, 14) : item.id.slice(-6);
  const suffix = item.imageUrl.startsWith("data:image/jpeg") || item.imageUrl.startsWith("data:image/jpg") ? "jpg" : item.imageUrl.startsWith("data:image/webp") ? "webp" : "png";
  return `ai-output-${stamp}.${suffix}`;
}

async function triggerImageDownload(item: GeneratedImageItem) {
  await downloadImageToFile(item.imageUrl, getImageFilename(item));
}

export function GeneratedImagesPanel() {
  const open = useCanvasStore((state) => state.generatedImagesPanelOpen);
  const setOpen = useCanvasStore((state) => state.setGeneratedImagesPanelOpen);
  const addNode = useCanvasStore((state) => state.addNode);
  const viewport = useCanvasStore((state) => state.viewport);
  const [images, setImages] = useState<GeneratedImageItem[]>([]);
  const [status, setStatus] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [previewDragging, setPreviewDragging] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const [panelDragging, setPanelDragging] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const panelDragRef = useRef<{ left: number; top: number; x: number; y: number } | null>(null);
  const sendOffsetRef = useRef(0);

  const hydrateImages = useCallback(async () => {
    if (!open) return;
    try {
      setImages([...readClientGeneratedImages()].reverse());
      setStatus("");
    } catch {
      setStatus("无法读取 AI 返图备份。");
    }
  }, [open]);

  useEffect(() => {
    void hydrateImages();
    if (!open) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void hydrateImages();
    };
    window.addEventListener("focus", hydrateImages);
    window.addEventListener("ai-canvas-generated-images-updated", hydrateImages);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", hydrateImages);
      window.removeEventListener("ai-canvas-generated-images-updated", hydrateImages);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [hydrateImages, open]);

  useEffect(() => {
    if (!previewUrl) {
      setPreviewScale(1);
      setPreviewPan({ x: 0, y: 0 });
      setPreviewDragging(false);
      dragStartRef.current = null;
    }
  }, [previewUrl]);

  const clampPanelPosition = useCallback((position: { x: number; y: number }) => {
    const rect = panelRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 380;
    const height = rect?.height ?? Math.min(620, window.innerHeight - 132);
    return {
      x: Math.min(Math.max(88, position.x), Math.max(88, window.innerWidth - width - 16)),
      y: Math.min(Math.max(84, position.y), Math.max(84, window.innerHeight - height - 16))
    };
  }, []);

  useEffect(() => {
    if (!panelDragging) return undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (!panelDragRef.current) return;
      const next = {
        x: panelDragRef.current.left + event.clientX - panelDragRef.current.x,
        y: panelDragRef.current.top + event.clientY - panelDragRef.current.y
      };
      setPanelPosition(clampPanelPosition(next));
    };
    const onPointerUp = () => {
      panelDragRef.current = null;
      setPanelDragging(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [clampPanelPosition, panelDragging]);

  useEffect(() => {
    if (!open) return undefined;
    const onResize = () => {
      setPanelPosition((current) => (current ? clampPanelPosition(current) : current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPanelPosition, open]);

  const removeImages = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const next = removeClientGeneratedImages(ids);
    setImages([...next].reverse());
    setStatus(ids.length > 1 ? "已清理全部 AI 返图备份。" : "已删除这张 AI 返图备份。");
  }, []);

  const downloadOne = async (item: GeneratedImageItem) => {
    setStatus("正在保存图片到本地...");
    try {
      await triggerImageDownload(item);
      setStatus("图片已保存到本地下载目录。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片下载失败，请重试。");
    }
  };

  const downloadAll = async () => {
    setStatus(`正在保存 ${images.length} 张图片到本地...`);
    try {
      for (const item of images) {
        await triggerImageDownload(item);
      }
      setStatus(`已保存 ${images.length} 张图片到本地下载目录。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片下载失败，请重试。");
    }
  };

  const sendToCanvas = (item: GeneratedImageItem) => {
    const zoom = viewport.zoom || 1;
    const panelWidth = Math.min(760, Math.max(420, window.innerWidth * 0.38));
    const panelLeft = window.innerWidth - panelWidth - 24;
    const offset = sendOffsetRef.current % 8;
    sendOffsetRef.current += 1;
    const screenX = Math.max(120, panelLeft - 380 + offset * 28);
    const screenY = Math.max(120, window.innerHeight * 0.42 + offset * 28);
    addNode("image", {
      x: (screenX - viewport.x) / zoom,
      y: (screenY - viewport.y) / zoom
    }, {
      imageUrl: item.imageUrl,
      title: "Image"
    });
    setStatus("已发送到当前画布。");
  };

  if (!open) return null;

  return (
    <>
      <aside
        aria-label="AI 返图备份"
        className="pointer-events-auto absolute z-50 flex min-w-[320px] max-w-[560px] flex-col rounded-[18px] border border-line bg-white/95 shadow-[0_20px_56px_rgba(15,23,42,0.14)] backdrop-blur"
        ref={panelRef}
        style={{
          height: "min(620px, calc(100vh - 132px))",
          left: panelPosition ? panelPosition.x : undefined,
          right: panelPosition ? undefined : 24,
          top: panelPosition ? panelPosition.y : 96,
          width: "clamp(360px, 34vw, 560px)"
        }}
      >
        <div
          className="flex shrink-0 cursor-grab items-center gap-2.5 border-b border-line px-4 py-3 active:cursor-grabbing"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;
            event.preventDefault();
            event.stopPropagation();
            panelDragRef.current = { left: rect.left, top: rect.top, x: event.clientX, y: event.clientY };
            setPanelPosition({ x: rect.left, y: rect.top });
            setPanelDragging(true);
          }}
        >
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[#EEF1FF] text-selected">
            <ImageIcon size={17} strokeWidth={1.95} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold leading-5 text-primary">AI 返图备份</h2>
            <p className="truncate text-xs font-semibold text-secondary">
              {images.length ? `${images.length} 张已备份图片` : "暂无 AI 返图备份"}
            </p>
          </div>
          <button
            aria-label="关闭 AI 返图备份"
            className="grid h-8 w-8 place-items-center rounded-full text-primary transition hover:bg-[#F4F6FA] active:scale-95"
            onClick={() => setOpen(false)}
            title="关闭"
            type="button"
          >
            <X size={17} strokeWidth={2} />
          </button>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
          <p className="min-w-0 flex-1 truncate text-xs font-semibold text-secondary">{status || "双击图片可放大预览"}</p>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
              disabled={!images.length}
              onClick={() => void downloadAll()}
              type="button"
            >
              <Download size={14} strokeWidth={1.9} />
              下载全部
            </button>
            <button
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-line bg-white px-2.5 text-xs font-bold text-primary shadow-sm transition hover:bg-[#F7F8FB] disabled:text-[#B8C0CC]"
              disabled={!images.length}
              onClick={() => removeImages(images.map((item) => item.id))}
              type="button"
            >
              <Trash2 size={14} strokeWidth={1.85} />
              清理
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {images.length ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-3">
              {images.map((item) => (
                <article className="overflow-hidden rounded-[12px] border border-line bg-[#FBFCFE]" key={item.id}>
                  <button
                    aria-label="放大预览图片"
                    className="m-2.5 block h-[132px] w-[calc(100%-20px)] overflow-hidden rounded-[9px] border border-[#ECEFF5] bg-[#F5F6FA]"
                    onClick={(event) => {
                      if (event.detail >= 2) setPreviewUrl(item.imageUrl);
                    }}
                    onDoubleClick={() => setPreviewUrl(item.imageUrl)}
                    type="button"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="" className="h-full w-full object-contain" decoding="async" draggable={false} loading="lazy" src={item.imageUrl} />
                  </button>
                  <div className="flex items-center justify-between gap-2 border-t border-line px-2.5 py-2">
                    <span className="truncate text-[11px] font-semibold text-secondary">{formatSavedAt(item.createdAt)}</span>
                    <span className="flex items-center gap-1">
                      <button
                        aria-label="发送到画布"
                        className="grid h-7 w-7 place-items-center rounded-[7px] text-primary transition hover:bg-[#F5F7FB]"
                        onClick={() => sendToCanvas(item)}
                        title="发送到画布"
                        type="button"
                      >
                        <SendHorizontal size={15} strokeWidth={1.9} />
                      </button>
                      <button
                        aria-label="下载图片"
                        className="grid h-7 w-7 place-items-center rounded-[7px] text-primary transition hover:bg-[#F5F7FB]"
                        onClick={() => void downloadOne(item)}
                        title="下载图片"
                        type="button"
                      >
                        <Download size={15} strokeWidth={1.9} />
                      </button>
                      <button
                        aria-label="删除图片"
                        className="grid h-7 w-7 place-items-center rounded-[7px] text-primary transition hover:bg-[#F5F7FB]"
                        onClick={() => removeImages([item.id])}
                        title="删除图片"
                        type="button"
                      >
                        <Trash2 size={15} strokeWidth={1.85} />
                      </button>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="grid min-h-[180px] place-items-center rounded-[12px] border border-dashed border-line bg-[#FBFCFE] text-xs font-semibold text-secondary">
              AI Run 返图后，会在这里保存一份备份。
            </div>
          )}
        </div>
      </aside>
      {previewUrl ? (
        <button
          aria-label="关闭图片预览"
          className="absolute inset-y-[96px] right-6 z-[60] flex min-w-[320px] max-w-[560px] items-center justify-center overflow-hidden rounded-[18px] border border-line bg-white/40 p-4 shadow-[0_20px_56px_rgba(15,23,42,0.16)] backdrop-blur-sm"
          onClick={() => setPreviewUrl(null)}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragStartRef.current = { x: event.clientX, y: event.clientY };
            setPreviewDragging(true);
          }}
          onMouseLeave={() => {
            dragStartRef.current = null;
            setPreviewDragging(false);
          }}
          onMouseMove={(event) => {
            if (!previewDragging || !dragStartRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            const dx = event.clientX - dragStartRef.current.x;
            const dy = event.clientY - dragStartRef.current.y;
            dragStartRef.current = { x: event.clientX, y: event.clientY };
            setPreviewPan((current) => ({ x: current.x + dx, y: current.y + dy }));
          }}
          onMouseUp={() => {
            dragStartRef.current = null;
            setPreviewDragging(false);
          }}
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPreviewScale((current) => Math.min(4, Math.max(1, Number((event.deltaY < 0 ? current * 1.06 : current / 1.06).toFixed(3)))));
          }}
          style={{
            cursor: previewDragging ? "grabbing" : "grab",
            width: "clamp(360px, 34vw, 560px)"
          }}
          type="button"
        >
          <span
            aria-hidden="true"
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white text-primary shadow-sm"
          >
            <X size={19} strokeWidth={2} />
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            draggable={false}
            src={previewUrl}
            style={{
              display: "block",
              maxHeight: "100%",
              maxWidth: "100%",
              objectFit: "contain",
              transform: `translate3d(${previewPan.x}px, ${previewPan.y}px, 0) scale(${previewScale})`,
              transformOrigin: "center",
              transition: previewDragging ? "none" : "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)"
            }}
          />
        </button>
      ) : null}
    </>
  );
}
