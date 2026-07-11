"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { X } from "lucide-react";
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

type AddNodeCategory = {
  id: string;
  title: string;
  skillOptions: AddNodeOption[];
  imageOptions: AddNodeOption[];
};

const inputColumn: AddNodeColumn = {
  title: "输入节点",
  options: [
    { kind: "image", label: "Image", description: "图片输入" },
    { kind: "prompt", label: "Prompt", description: "文本提示词" }
  ]
};

const categories: AddNodeCategory[] = [
  {
    id: "general",
    title: "常规",
    skillOptions: [
      { kind: "imageChat", label: "AI Prompt", description: "生图提示词" }
    ],
    imageOptions: [
      { kind: "generateImage", label: "Generate Image", description: "AI 成图" },
      { kind: "hdRedraw", label: "高清重绘1", description: "生成 B 图和 A Prompt" },
      { kind: "hdRedraw2", label: "高清重绘2", description: "生成 C 高清图" }
    ]
  },
  {
    id: "scene",
    title: "场景效果图",
    skillOptions: [
      { kind: "sceneDirector", label: "Scene Director", description: "场景 Prompt 导演" }
    ],
    imageOptions: [
      { kind: "sceneImage", label: "Scene Image", description: "场景图生成" }
    ]
  },
  {
    id: "product",
    title: "产品设计",
    skillOptions: [
      { kind: "industrial_designer", label: "Industrial Designer", description: "工业设计 Prompt" }
    ],
    imageOptions: [
      { kind: "industrialDesignImage", label: "ID Image", description: "工业设计成图" },
      { kind: "rhinoTest", label: "Rhino 测试", description: "锁定 Rhino 产品图生成渲染" },
      { kind: "productRemix", label: "产品 Remix 合成器", description: "产品融合宫格图" }
    ]
  },
  {
    id: "graphic",
    title: "平面设计",
    skillOptions: [
      { kind: "product_poster", label: "产品海报导演", description: "产品海报 Prompt 策划" }
    ],
    imageOptions: [
      { kind: "visual_director", label: "Visual Director", description: "视觉规范师" },
      { kind: "textImageLayout", label: "Text Image Layout", description: "图文混排成图" }
    ]
  },
  {
    id: "ecommerce",
    title: "电商设计",
    skillOptions: [
      { kind: "taobaoPageDirector", label: "Taobao Page Director", description: "淘宝图片页拆解" }
    ],
    imageOptions: [
      { kind: "visual_director", label: "Visual Director", description: "视觉规范师" },
      { kind: "textImageLayout", label: "Text Image Layout", description: "图文混排成图" }
    ]
  }
];

const popoverWidth = 900;
const popoverEstimatedHeight = 288;
const popoverMargin = 16;

export function AddNodePopover({ toCanvasPosition }: { toCanvasPosition: (point: { x: number; y: number }) => { x: number; y: number } }) {
  const open = useCanvasStore((state) => state.addMenuOpen);
  const position = useCanvasStore((state) => state.addMenuPosition);
  const setAddMenuPosition = useCanvasStore((state) => state.setAddMenuPosition);
  const closeAddMenu = useCanvasStore((state) => state.closeAddMenu);
  const addNode = useCanvasStore((state) => state.addNode);
  const [dragging, setDragging] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState(categories[0].id);
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
  const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? categories[0];
  const addOption = (kind: NodeKind) => {
    addNode(kind, toCanvasPosition(visiblePosition));
    closeAddMenu();
  };
  const addOptionOnPrimaryClick = (event: ReactMouseEvent<HTMLButtonElement>, kind: NodeKind) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0) return;
    addOption(kind);
  };

  return (
    <div
      className="fixed z-40 w-[900px] rounded-[14px] border border-line bg-white p-3 shadow-[0_18px_46px_rgba(15,23,42,0.13)]"
      data-add-node-popover="true"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
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
      <button
        aria-label="关闭添加节点窗口"
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-[#8A94A6] transition hover:bg-[#F4F7FB] hover:text-primary"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeAddMenu();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="关闭"
        type="button"
      >
        <X size={18} strokeWidth={2.2} />
      </button>
      <div
        className={`mb-3 flex h-7 items-center rounded-[8px] px-1 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
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
        <div className="text-[15px] font-bold leading-none text-primary">添加节点</div>
      </div>
      <div className="grid grid-cols-[240px_1fr] gap-3">
        <section className="min-h-[204px] rounded-[12px] border border-line bg-[#FBFCFE] p-3">
          <div className="mb-2 px-1 text-[12px] font-bold leading-4 text-[#8A94A6]">{inputColumn.title}</div>
          <div className="grid gap-1">
            {inputColumn.options.map(({ kind, label, description }) => (
              <button
                className="h-[54px] rounded-[10px] px-2 text-left transition hover:bg-white hover:shadow-[0_7px_18px_rgba(15,23,42,0.08)]"
                key={kind}
                onClick={(event) => addOptionOnPrimaryClick(event, kind)}
                type="button"
              >
                <span className="block truncate text-[14px] font-bold leading-5 text-primary">{label}</span>
                <span className="block truncate text-[13px] leading-[18px] text-secondary">{description}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="min-h-[204px] rounded-[12px] border border-line bg-[#FBFCFE] p-3">
          <div className="mb-3 rounded-[12px] border border-[#E7ECF4] bg-[#F4F7FB] p-1">
            <div className="grid grid-cols-5 gap-1">
              {categories.map((category) => {
                const active = category.id === activeCategory.id;
                return (
                  <button
                    aria-pressed={active}
                    className={`h-9 rounded-[10px] px-2 text-center text-[12px] font-bold leading-9 transition ${
                      active
                        ? "bg-primary text-white shadow-[0_8px_18px_rgba(15,23,42,0.18)]"
                        : "bg-white/70 text-[#7C8798] shadow-[inset_0_0_0_1px_rgba(226,232,240,0.8)] hover:bg-white hover:text-primary"
                    }`}
                    key={category.id}
                    onClick={() => setActiveCategoryId(category.id)}
                    type="button"
                  >
                    <span className="block truncate">{category.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {activeCategory.skillOptions.length || activeCategory.imageOptions.length ? (
            <div className="grid grid-cols-2 gap-3">
              <NodeOptionGroup onAdd={addOptionOnPrimaryClick} options={activeCategory.skillOptions} title="Skills" />
              <NodeOptionGroup onAdd={addOptionOnPrimaryClick} options={activeCategory.imageOptions} title="生图节点" />
            </div>
          ) : (
            <div className="flex min-h-[132px] items-center justify-center rounded-[12px] border border-dashed border-line bg-white text-[13px] font-semibold text-secondary">
              平面设计节点预留中
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NodeOptionGroup({ onAdd, options, title }: { onAdd: (event: ReactMouseEvent<HTMLButtonElement>, kind: NodeKind) => void; options: AddNodeOption[]; title: string }) {
  return (
    <div className="min-h-[132px] rounded-[12px] bg-white p-3 shadow-[inset_0_0_0_1px_rgba(226,232,240,0.9)]">
      <div className="mb-2 px-1 text-[12px] font-bold leading-4 text-[#8A94A6]">{title}</div>
      {options.length ? (
        <div className="grid gap-1">
          {options.map(({ kind, label, description }) => (
            <button
              className="h-[54px] rounded-[10px] px-2 text-left transition hover:bg-[#FBFCFE] hover:shadow-[0_7px_18px_rgba(15,23,42,0.08)]"
              key={kind}
              onClick={(event) => onAdd(event, kind)}
              type="button"
            >
              <span className="block truncate text-[14px] font-bold leading-5 text-primary">{label}</span>
              <span className="block truncate text-[13px] leading-[18px] text-secondary">{description}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex h-[94px] items-center justify-center rounded-[10px] border border-dashed border-line text-[13px] font-semibold text-secondary">
          预留
        </div>
      )}
    </div>
  );
}
