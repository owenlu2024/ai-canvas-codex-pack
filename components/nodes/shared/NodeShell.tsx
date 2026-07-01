"use client";

import type { ReactNode } from "react";
import type { NodeMotionState } from "@/lib/nodeTypes";

interface NodeShellProps {
  children: ReactNode;
  height: number;
  motionState?: NodeMotionState;
  portLayer?: ReactNode;
  running: boolean;
  selected: boolean;
  width: number;
}

export function NodeShell({ children, height, motionState, portLayer, running, selected, width }: NodeShellProps) {
  const runningBorderInset = 0.75;
  const runningBorderPath = [
    `M ${18} ${runningBorderInset}`,
    `H ${width - 18}`,
    `Q ${width - runningBorderInset} ${runningBorderInset} ${width - runningBorderInset} ${18}`,
    `V ${height - 18}`,
    `Q ${width - runningBorderInset} ${height - runningBorderInset} ${width - 18} ${height - runningBorderInset}`,
    `H ${18}`,
    `Q ${runningBorderInset} ${height - runningBorderInset} ${runningBorderInset} ${height - 18}`,
    `V ${18}`,
    `Q ${runningBorderInset} ${runningBorderInset} ${18} ${runningBorderInset}`
  ].join(" ");

  return (
    <article
      className={`ai-node-shell relative rounded-[18px] border bg-white shadow-node transition ${
        running ? "ai-node-running shadow-[0_10px_30px_rgba(108,99,255,0.11)]" : ""
      } ${motionState ? `ai-node-${motionState}` : ""} ${selected ? "ai-node-selected border-selected" : "border-line hover:border-[#D9DEEA] hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]"}`}
      style={{ height, width }}
    >
      {running ? (
        <svg aria-hidden="true" className="ai-node-running-border" viewBox={`0 0 ${width} ${height}`}>
          <path d={runningBorderPath} pathLength="100" />
        </svg>
      ) : null}
      {portLayer}
      {selected ? (
        <span className="absolute -right-[11px] -top-[11px] z-10 grid h-6 w-6 place-items-center rounded-full bg-selected text-[13px] font-bold text-white shadow-sm">
          ✓
        </span>
      ) : null}
      {children}
    </article>
  );
}
