"use client";

import type { RunState } from "@/lib/nodeTypes";

const statusLabels: Record<RunState, string> = {
  completed: "已完成",
  failed: "失败",
  idle: "就绪",
  running: "运行中"
};

const statusClasses: Record<RunState, string> = {
  completed: "border-[rgba(36,138,61,0.18)] bg-[rgba(36,138,61,0.08)] text-[var(--success)]",
  failed: "border-[rgba(215,0,21,0.16)] bg-[rgba(215,0,21,0.07)] text-danger",
  idle: "border-[var(--node-border)] bg-[var(--surface-subtle)] text-secondary",
  running: "border-[rgba(108,99,255,0.18)] bg-[var(--selected-soft)] text-selected"
};

export function NodeStatusBadge({ runState }: { runState?: RunState }) {
  const state = runState ?? "idle";

  return (
    <span className={`inline-flex h-[22px] cursor-inherit items-center rounded-full border px-2.5 text-[11px] font-semibold leading-[14px] tracking-[0.01em] ${statusClasses[state]}`}>
      {statusLabels[state]}
    </span>
  );
}
