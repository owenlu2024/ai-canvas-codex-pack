"use client";

import { Play, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { RunState } from "@/lib/nodeTypes";
import { NodeStatusBadge } from "@/components/nodes/shared/NodeStatusBadge";

interface NodeHeaderProps {
  actions?: ReactNode;
  canRun: boolean;
  onRun: () => void;
  runState?: RunState;
  title: string;
}

export function NodeHeader({ actions, canRun, onRun, runState, title }: NodeHeaderProps) {
  const running = runState === "running";

  return (
    <div className="flex h-[54px] items-center gap-3 px-[18px]">
      <h2 className="min-w-0 flex-1 truncate text-[17px] font-bold leading-none text-primary" data-prompt-title-region="true">{title}</h2>
      <NodeStatusBadge runState={runState} />
      {canRun ? (
        <button
          className="inline-flex h-9 items-center gap-2 rounded-full bg-selected px-4 text-sm font-bold text-white transition hover:bg-[#5B54E8]"
          onClick={(event) => {
            event.stopPropagation();
            onRun();
          }}
          type="button"
        >
          {running ? <Square size={14} fill="currentColor" strokeWidth={2} /> : <Play size={14} fill="currentColor" strokeWidth={2} />}
          {running ? "停止" : "运行"}
        </button>
      ) : null}
      {actions}
    </div>
  );
}
