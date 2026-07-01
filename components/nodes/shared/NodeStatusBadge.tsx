"use client";

import type { RunState } from "@/lib/nodeTypes";

const statusLabels: Record<RunState, string> = {
  completed: "已完成",
  failed: "失败",
  idle: "就绪",
  running: "运行中"
};

const statusClasses: Record<RunState, string> = {
  completed: "border-[#BDEBD1] bg-[#F1FBF5] text-[#16834B]",
  failed: "border-[#FFD0D1] bg-[#FFF5F5] text-danger",
  idle: "border-[#E5E9F2] bg-[#F7F9FC] text-secondary",
  running: "border-[#D9D7FF] bg-[#F3F2FF] text-selected"
};

export function NodeStatusBadge({ runState }: { runState?: RunState }) {
  const state = runState ?? "idle";

  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-bold leading-none ${statusClasses[state]}`}>
      {statusLabels[state]}
    </span>
  );
}
