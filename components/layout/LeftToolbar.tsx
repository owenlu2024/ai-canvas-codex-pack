"use client";

import { useState } from "react";
import { CirclePlus, Images, MousePointer2, Settings, Trash2 } from "lucide-react";
import type { ComponentType } from "react";
import { useCanvasStore } from "@/store/canvasStore";

type ToolbarIconProps = {
  size?: number | string;
  strokeWidth?: number | string;
};

function ModuleGroupIcon({ size = 22 }: ToolbarIconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <rect height="16" rx="4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" width="16" x="4" y="4" />
      <rect height="5.2" rx="1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" width="5.2" x="7" y="7" />
      <rect height="5.2" rx="1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" width="5.2" x="11.8" y="11.8" />
      <path d="M12.2 9.6H14.4V11.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function ModuleUngroupIcon({ size = 22 }: ToolbarIconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <path d="M9.2 4H7.2C5.4 4 4 5.4 4 7.2V9.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M14.8 4H16.8C18.6 4 20 5.4 20 7.2V9.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M9.2 20H7.2C5.4 20 4 18.6 4 16.8V14.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M14.8 20H16.8C18.6 20 20 18.6 20 16.8V14.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <rect height="5.2" rx="1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" width="5.2" x="6.2" y="6.2" />
      <rect height="5.2" rx="1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" width="5.2" x="12.6" y="12.6" />
    </svg>
  );
}

const tools = [
  { label: "选择", icon: MousePointer2, active: true },
  { label: "添加节点", icon: CirclePlus, add: true },
  { label: "群组", icon: ModuleGroupIcon },
  { label: "取消群组", icon: ModuleUngroupIcon },
  { label: "删除", icon: Trash2, delete: true }
] satisfies {
  label: string;
  icon: ComponentType<ToolbarIconProps>;
  active?: boolean;
  add?: boolean;
  delete?: boolean;
}[];

function ToolbarTip({ label, visible }: { label: string; visible: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 54,
        top: "50%",
        zIndex: 50,
        display: visible ? "block" : "none",
        transform: "translateY(-50%)",
        whiteSpace: "nowrap",
        borderRadius: 999,
        background: "var(--selected)",
        padding: "8px 14px",
        color: "#fff",
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1,
        boxShadow: "0 10px 24px rgba(108, 99, 255, 0.24)"
      }}
    >
      {label}
    </span>
  );
}

export function LeftToolbar() {
  const [hoveredTool, setHoveredTool] = useState<string | null>(null);
  const [pressedTool, setPressedTool] = useState<string | null>(null);
  const openAddMenu = useCanvasStore((state) => state.openAddMenu);
  const deleteSelected = useCanvasStore((state) => state.deleteSelected);
  const groupSelected = useCanvasStore((state) => state.groupSelected);
  const ungroupSelected = useCanvasStore((state) => state.ungroupSelected);
  const nodes = useCanvasStore((state) => state.nodes);
  const generatedImagesPanelOpen = useCanvasStore((state) => state.generatedImagesPanelOpen);
  const toggleGeneratedImagesPanel = useCanvasStore((state) => state.toggleGeneratedImagesPanel);
  const settingsPanelOpen = useCanvasStore((state) => state.settingsPanelOpen);
  const toggleSettingsPanel = useCanvasStore((state) => state.toggleSettingsPanel);

  const flashPressed = (label: string) => {
    setPressedTool(label);
    window.setTimeout(() => setPressedTool((current) => (current === label ? null : current)), 150);
  };

  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNonGroupCount = selectedNodes.filter((node) => node.data.kind !== "group").length;
  const selectedHasGroup = selectedNodes.some((node) => node.data.kind === "group");

  return (
    <aside
      aria-label="画布工具"
      className="pointer-events-auto fixed left-4 top-1/2 z-[2147483001] flex w-[58px] -translate-y-1/2 flex-col items-center rounded-[29px] border border-line bg-white/95 px-[7px] py-3 shadow-soft"
      style={{
        position: "fixed",
        left: 16,
        top: "50%",
        transform: "translateY(-50%) scale(var(--ui-scale, 1))",
        transformOrigin: "left center",
        zIndex: 2147483001,
        display: "flex",
        width: 58,
        flexDirection: "column",
        alignItems: "center",
        borderRadius: 29,
        border: "1px solid var(--node-border)",
        background: "rgba(255, 255, 255, 0.95)",
        padding: "12px 7px",
        boxShadow: "0 18px 42px rgba(15, 23, 42, 0.10)"
      }}
    >
      {tools.map(({ label, icon: Icon, active: isActiveTool, add, delete: isDelete }) => {
        const disabled = (label === "群组" && selectedNonGroupCount < 2) ||
          (label === "取消群组" && !selectedHasGroup) ||
          (isDelete && selectedNodes.length < 1);
        const active = Boolean(isActiveTool) || pressedTool === label;
        const hovered = hoveredTool === label;
        const background = active && !disabled ? "var(--selected)" : hovered && !disabled ? "#F4F6FA" : "transparent";
        const color = disabled ? "#B8C0CC" : active ? "#fff" : "#374151";

        return (
          <button
            aria-label={label}
            aria-pressed={isActiveTool ? true : undefined}
            disabled={disabled}
            className="group relative mb-2 grid h-11 w-11 place-items-center rounded-full text-primary transition"
            style={{
              position: "relative",
              display: "grid",
              width: 44,
              height: 44,
              placeItems: "center",
              marginBottom: 8,
              padding: 0,
              border: 0,
              borderRadius: 999,
              background,
              color,
              boxShadow: active && !disabled ? "0 10px 24px rgba(108, 99, 255, 0.26)" : "none",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.72 : 1,
              transform: pressedTool === label && !disabled ? "scale(0.94)" : "scale(1)",
              transition: "background 140ms ease, color 140ms ease, transform 120ms ease, box-shadow 140ms ease"
            }}
            key={label}
            onMouseEnter={() => setHoveredTool(label)}
            onMouseLeave={() => setHoveredTool(null)}
            onMouseDown={() => setPressedTool(label)}
            onMouseUp={() => setPressedTool(null)}
            onClick={() => {
              if (disabled) return;
              flashPressed(label);
              if (add) {
                openAddMenu({ x: 112, y: 188 });
              }
              if (isDelete) deleteSelected();
              if (label === "群组") groupSelected();
              if (label === "取消群组") ungroupSelected();
            }}
            type="button"
          >
            <span className="grid h-full w-full place-items-center rounded-full">
              <Icon size={22} strokeWidth={active ? 2.15 : 1.95} />
            </span>
            <ToolbarTip label={label} visible={hovered} />
          </button>
        );
      })}
      <div className="my-2 h-px w-8 bg-line" style={{ width: 32, height: 1, margin: "8px 0", background: "var(--node-border)" }} />
      <button
        aria-label="AI 返图备份"
        aria-pressed={generatedImagesPanelOpen}
        className="group relative mb-2 grid h-11 w-11 place-items-center rounded-full text-primary transition"
        onClick={() => {
          flashPressed("AI 返图备份");
          toggleGeneratedImagesPanel();
        }}
        onMouseEnter={() => setHoveredTool("AI 返图备份")}
        onMouseLeave={() => setHoveredTool(null)}
        onMouseDown={() => setPressedTool("AI 返图备份")}
        onMouseUp={() => setPressedTool(null)}
        style={{
          position: "relative",
          display: "grid",
          width: 44,
          height: 44,
          placeItems: "center",
          marginBottom: 8,
          padding: 0,
          border: 0,
          borderRadius: 999,
          background: generatedImagesPanelOpen || pressedTool === "AI 返图备份" ? "var(--selected)" : hoveredTool === "AI 返图备份" ? "#F4F6FA" : "transparent",
          color: generatedImagesPanelOpen || pressedTool === "AI 返图备份" ? "#fff" : "#374151",
          boxShadow: generatedImagesPanelOpen || pressedTool === "AI 返图备份" ? "0 10px 24px rgba(108, 99, 255, 0.26)" : "none",
          transform: pressedTool === "AI 返图备份" ? "scale(0.94)" : "scale(1)",
          transition: "background 140ms ease, color 140ms ease, transform 120ms ease, box-shadow 140ms ease"
        }}
        type="button"
      >
        <Images size={22} strokeWidth={generatedImagesPanelOpen || pressedTool === "AI 返图备份" ? 2.15 : 1.95} />
        <ToolbarTip label="AI 返图备份" visible={hoveredTool === "AI 返图备份"} />
      </button>
      <button
        aria-label="设置"
        className="group relative grid h-11 w-11 place-items-center rounded-full text-primary transition hover:bg-[#F4F6FA]"
        onClick={() => {
          flashPressed("设置");
          toggleSettingsPanel();
        }}
        style={{
          position: "relative",
          display: "grid",
          width: 44,
          height: 44,
          placeItems: "center",
          padding: 0,
          border: 0,
          borderRadius: 999,
          background: settingsPanelOpen || pressedTool === "设置" ? "var(--selected)" : hoveredTool === "设置" ? "#F4F6FA" : "transparent",
          color: settingsPanelOpen || pressedTool === "设置" ? "#fff" : "#374151",
          boxShadow: settingsPanelOpen || pressedTool === "设置" ? "0 10px 24px rgba(108, 99, 255, 0.26)" : "none",
          transform: pressedTool === "设置" ? "scale(0.94)" : "scale(1)",
          transition: "background 140ms ease, transform 120ms ease"
        }}
        onMouseEnter={() => setHoveredTool("设置")}
        onMouseLeave={() => setHoveredTool(null)}
        onMouseDown={() => setPressedTool("设置")}
        onMouseUp={() => setPressedTool(null)}
        type="button"
      >
        <span className="grid h-full w-full place-items-center rounded-full">
          <Settings size={22} strokeWidth={settingsPanelOpen || pressedTool === "设置" ? 2.15 : 1.95} />
        </span>
        <ToolbarTip label="设置" visible={hoveredTool === "设置"} />
      </button>
    </aside>
  );
}
