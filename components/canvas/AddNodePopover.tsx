"use client";

import { useEffect, useRef, useState } from "react";
import type { NodeKind } from "@/lib/nodeTypes";
import { useCanvasStore } from "@/store/canvasStore";

type AddNodeOption = {
  kind: NodeKind;
  label: string;
  description: string;
};

type AddNodeColumn = {
  title: string;
  options: AddNodeOption[];
};

const columns: AddNodeColumn[] = [
  {
    title: "输入节点",
    options: [
      { kind: "image", label: "Image", description: "图片输入" },
      { kind: "prompt", label: "Prompt", description: "文本提示词" }
    ]
  },
  {
    title: "Skills",
    options: [
      { kind: "imageChat", label: "AI Prompt", description: "生图提示词" },
      { kind: "sceneDirector", label: "Scene Director", description: "场景 Prompt 导演" },
      { kind: "taobaoPageDirector", label: "Taobao Page Director", description: "淘宝图片页拆解" },
      { kind: "industrial_designer", label: "Industrial Designer", description: "工业设计 Prompt" }
    ]
  },
  {
    title: "生图节点",
    options: [
      { kind: "visual_director", label: "Visual Director", description: "视觉规范师" },
      { kind: "generateImage", label: "Generate Image", description: "AI 成图" },
      { kind: "rhinoTest", label: "Rhino 测试", description: "Rhino 产品照片级渲染" },
      { kind: "textImageLayout", label: "Text Image Layout", description: "图文混排成图" },
      { kind: "sceneImage", label: "Scene Image", description: "场景图生成" },
      { kind: "industrialDesignImage", label: "ID Image", description: "工业设计成图" },
      { kind: "productRemix", label: "产品 Remix 合成器", description: "产品融合宫格图" }
    ]
  }
];

const popoverWidth = 760;
const popoverEstimatedHeight = 252;
const popoverMargin = 16;

export function AddNodePopover({ toCanvasPosition }: { toCanvasPosition: (point: { x: number; y: number }) => { x: number; y: number } }) {
  const open = useCanvasStore((state) => state.addMenuOpen);
  const position = useCanvasStore((state) => state.addMenuPosition);
  const setAddMenuPosition = useCanvasStore((state) => state.setAddMenuPosition);
  const closeAddMenu = useCanvasStore((state) => state.closeAddMenu);
  const addNode = useCanvasStore((state) => state.addNode);
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!dragging) return undefined;
    const moveMenu = (clientX: number, clientY: number) => {
      if (!dragOffsetRef.current) return;
      setAddMenuPosition({
        x: clientX - dragOffsetRef.current.x,
        y: clientY - dragOffsetRef.current.y
      });
    };
    const handlePointerMove = (event: PointerEvent) => moveMenu(event.clientX, event.clientY);
    const handleMouseMove = (event: MouseEvent) => moveMenu(event.clientX, event.clientY);
    const stopDragging = () => {
      dragOffsetRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("blur", stopDragging);
    };
  }, [dragging, setAddMenuPosition]);

  if (!open) return null;

  const visiblePosition = typeof window === "undefined"
    ? position
    : {
      x: Math.min(Math.max(popoverMargin, position.x), Math.max(popoverMargin, window.innerWidth - popoverWidth - popoverMargin)),
      y: Math.min(Math.max(popoverMargin, position.y), Math.max(popoverMargin, window.innerHeight - popoverEstimatedHeight - popoverMargin))
    };

  return (
    <div
      className="fixed z-40 w-[760px] rounded-[12px] border border-line bg-white p-2.5 shadow-[0_16px_42px_rgba(15,23,42,0.12)]"
      data-add-node-popover="true"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
      }}
      style={{
        left: visiblePosition.x,
        top: visiblePosition.y,
        transform: "scale(var(--ui-scale, 1))",
        transformOrigin: "top left",
        userSelect: "none"
      }}
    >
      <div
        className={`mb-2 flex h-7 items-center rounded-[8px] px-1.5 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerCancel={() => {
          dragOffsetRef.current = null;
          setDragging(false);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragOffsetRef.current = {
            x: event.clientX - visiblePosition.x,
            y: event.clientY - visiblePosition.y
          };
          setDragging(true);
        }}
        onPointerUp={() => {
          dragOffsetRef.current = null;
          setDragging(false);
        }}
      >
        <div className="text-[14px] font-bold leading-none text-primary">添加节点</div>
      </div>
      <div className="grid grid-cols-[1fr_1.25fr_2fr] gap-2">
        {columns.map((column) => (
          <section className="min-h-[170px] rounded-[10px] border border-line bg-[#FBFCFE] p-2" key={column.title}>
            <div className="mb-1.5 px-1.5 text-[11px] font-bold leading-4 text-secondary">{column.title}</div>
            <div className={`grid gap-0.5 ${column.title === "生图节点" ? "grid-cols-2 gap-x-1.5" : ""}`}>
              {column.options.map(({ kind, label, description }) => (
                <button
                  className="h-[46px] rounded-[8px] px-1.5 text-left transition hover:bg-white hover:shadow-[0_5px_14px_rgba(15,23,42,0.07)]"
                  key={kind}
                  onClick={() => {
                    addNode(kind, toCanvasPosition(visiblePosition));
                    closeAddMenu();
                  }}
                  type="button"
                >
                  <span className="block truncate text-[13px] font-semibold leading-[17px] text-primary">{label}</span>
                  <span className="block truncate text-[12px] leading-[16px] text-secondary">{description}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
