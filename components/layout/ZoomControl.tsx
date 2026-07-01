"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Grip, Minus, Plus } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { useDisplayScale } from "@/components/layout/useDisplayScale";

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

const controlWidth = 422;
const collapsedWidth = 52;
const zoomAnimationDuration = 180;

function AutoArrangeIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 20 20" width="20">
      <rect height="6" rx="2" stroke="currentColor" strokeWidth="2" width="6" x="2" y="2" />
      <rect height="6" rx="2" stroke="currentColor" strokeWidth="2" width="6" x="12" y="2" />
      <rect height="6" rx="2" stroke="currentColor" strokeWidth="2" width="6" x="2" y="12" />
      <path d="M13 12V18" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
      <path d="M17 12V18" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
  );
}

export function ZoomControl() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const zoom = useCanvasStore((state) => state.zoom);
  const setZoom = useCanvasStore((state) => state.setZoom);
  const gridEnabled = useCanvasStore((state) => state.gridEnabled);
  const setGridEnabled = useCanvasStore((state) => state.setGridEnabled);
  const showAutoImageLinks = useCanvasStore((state) => state.showAutoImageLinks);
  const toggleAutoImageLinks = useCanvasStore((state) => state.toggleAutoImageLinks);
  const autoArrangeSelected = useCanvasStore((state) => state.autoArrangeSelected);
  const nodes = useCanvasStore((state) => state.nodes);
  const reactFlow = useReactFlow();
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const canAutoArrange = selectedNodes.length >= 2 && !selectedNodes.some((node) => (
    (node.data.kind === "generateImage" || node.data.kind === "rhinoTest" || node.data.kind === "imageChat") &&
    node.data.runState === "running"
  ));
  const displayScale = useDisplayScale();

  const zoomTo = (value: number) => {
    const next = Math.min(4, Math.max(0.1, value));
    reactFlow.zoomTo(next, { duration: zoomAnimationDuration });
    window.setTimeout(() => setZoom(reactFlow.getZoom()), zoomAnimationDuration + 20);
  };

  const fitAll = useCallback(() => {
    reactFlow.fitView({ duration: 180, maxZoom: Math.max(1, displayScale), padding: 0.2 });
    window.setTimeout(() => setZoom(reactFlow.getZoom()), 190);
  }, [displayScale, reactFlow, setZoom]);

  const fitSelection = useCallback(() => {
    if (!selectedNodes.length) {
      fitAll();
      return;
    }
    reactFlow.fitView({ duration: 180, maxZoom: 1.4, nodes: selectedNodes, padding: 0.18 });
    window.setTimeout(() => setZoom(reactFlow.getZoom()), 190);
  }, [fitAll, reactFlow, selectedNodes, setZoom]);

  const runMenuAction = (action: () => void) => {
    action();
    setMenuOpen(false);
  };

  const collapse = () => {
    setMenuOpen(false);
    setCollapsed(true);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process" || isTextEditingTarget(event.target)) return;
      if (event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      fitSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fitSelection]);

  const iconButtonStyle = {
    display: "grid",
    width: 40,
    flex: "0 0 40px",
    height: 40,
    placeItems: "center",
    borderRadius: 999,
    border: "1px solid var(--node-border)",
    background: "#fff",
    color: "var(--primary-text)",
    transition: "background 140ms ease, transform 120ms ease, color 140ms ease"
  };

  return (
    <div
      className="fixed bottom-6 right-6 z-[2147483001]"
      ref={wrapperRef}
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 2147483001,
        transform: "scale(var(--ui-scale, 1))",
        transformOrigin: "bottom right"
      }}
    >
      {!collapsed && menuOpen ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            left: 62,
            bottom: 60,
            width: 260,
            borderRadius: 18,
            border: "1px solid var(--node-border)",
            background: "#fff",
            padding: "10px 0",
            boxShadow: "0 16px 36px rgba(15, 23, 42, 0.12)",
            color: "#334155"
          }}
        >
          {[
            { label: "缩放至 100%", action: () => zoomTo(1) },
            { label: "适合屏幕", action: fitAll },
            { label: "选中内容最大化 (Z)", action: fitSelection }
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => runMenuAction(item.action)}
              role="menuitem"
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                border: 0,
                background: "transparent",
                padding: "10px 18px",
                color: "#334155",
                fontSize: 16,
                fontWeight: 500,
                lineHeight: 1.25,
                textAlign: "left",
                transition: "background 140ms ease"
              }}
              type="button"
              onMouseEnter={(event) => {
                event.currentTarget.style.background = "#F7F8FB";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
        <div
          className="flex items-center"
          onClick={(event) => {
            if (!collapsed && event.target === event.currentTarget) collapse();
          }}
          style={{
            display: "flex",
            width: collapsed ? collapsedWidth : controlWidth,
            height: 52,
            alignItems: "center",
            gap: 8,
            overflow: "hidden",
            borderRadius: 26,
            border: "1px solid var(--node-border)",
            background: "rgba(255, 255, 255, 0.96)",
            padding: collapsed ? "0 5px" : "0 8px",
            boxShadow: "0 12px 30px rgba(15, 23, 42, 0.10)",
            transition: "width 260ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease"
          }}
        >
          <button
            aria-label={collapsed ? "展开缩放控制" : "收起缩放控制"}
            className="grid place-items-center border border-line bg-white text-primary transition hover:bg-[#F7F8FB] active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              if (collapsed) {
                setCollapsed(false);
                return;
              }
              collapse();
            }}
            style={iconButtonStyle}
            type="button"
          >
            {collapsed ? <ChevronLeft size={20} strokeWidth={2.1} /> : <ChevronRight size={20} strokeWidth={2.1} />}
          </button>
          <button
            className="grid place-items-center border border-line bg-white text-primary transition hover:bg-[#F7F8FB] active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              zoomTo(zoom - 0.1);
            }}
            style={iconButtonStyle}
            type="button"
          >
            <Minus size={18} strokeWidth={1.9} />
          </button>
          <button
            aria-expanded={menuOpen}
            className="flex items-center justify-center gap-2 border border-line bg-white font-medium text-primary"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((open) => !open);
            }}
            style={{
              display: "flex",
              width: 118,
              flex: "0 0 118px",
              height: 40,
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 999,
              border: "1px solid var(--node-border)",
              background: "#fff",
              padding: "0 15px",
              color: "var(--primary-text)",
              fontSize: 16,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              transition: "background 140ms ease, transform 120ms ease"
            }}
            type="button"
          >
            <span style={{ display: "inline-block", minWidth: 48, textAlign: "right" }}>{Math.round(zoom * 100)}%</span>
            <ChevronDown size={17} strokeWidth={2.1} />
          </button>
          <button
            className="grid place-items-center border border-line bg-white text-primary transition hover:bg-[#F7F8FB] active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              zoomTo(zoom + 0.1);
            }}
            style={iconButtonStyle}
            type="button"
          >
            <Plus size={18} strokeWidth={1.9} />
          </button>
          <button
            aria-label={showAutoImageLinks ? "隐藏自动代入图片连线" : "显示自动代入图片连线"}
            aria-pressed={showAutoImageLinks}
            className="grid place-items-center transition hover:bg-[#F7F8FB] active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              toggleAutoImageLinks();
            }}
            style={{
              ...iconButtonStyle,
              background: showAutoImageLinks ? "#fff" : "#F7F8FB",
              color: showAutoImageLinks ? "var(--primary-text)" : "var(--secondary-text)"
            }}
            title={showAutoImageLinks ? "隐藏自动代入图片连线" : "显示自动代入图片连线"}
            type="button"
          >
            {showAutoImageLinks ? <Eye size={20} strokeWidth={1.95} /> : <EyeOff size={20} strokeWidth={1.95} />}
          </button>
          <button
            aria-label="自动排列所选节点"
            className="grid place-items-center transition hover:bg-[#F7F8FB] active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!canAutoArrange}
            onClick={(event) => {
              event.stopPropagation();
              autoArrangeSelected();
            }}
            style={{
              ...iconButtonStyle,
              color: canAutoArrange ? "var(--primary-text)" : "#B8C0CC"
            }}
            title="自动排列所选节点"
            type="button"
          >
            <AutoArrangeIcon />
          </button>
          <button
            className={`grid place-items-center transition active:scale-95 ${gridEnabled ? "bg-[#EEF1FF] text-selected" : "bg-white text-secondary"}`}
            onClick={(event) => {
              event.stopPropagation();
              setGridEnabled(!gridEnabled);
            }}
            style={{
              ...iconButtonStyle,
              borderColor: "transparent",
              background: gridEnabled ? "#EEF1FF" : "#fff",
              color: gridEnabled ? "var(--selected)" : "var(--secondary-text)"
            }}
            title="网格"
            type="button"
          >
            <Grip size={18} strokeWidth={2.2} />
          </button>
        </div>
    </div>
  );
}
