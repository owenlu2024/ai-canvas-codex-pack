"use client";

import { PortDot } from "@/components/nodes/PortDot";
import { portsByNode, type NodeKind } from "@/lib/nodeTypes";

export function NodePortLayer({ hiddenAutoImageInputCount, kind, nodeId }: { hiddenAutoImageInputCount: number; kind: NodeKind; nodeId: string }) {
  const ports = portsByNode[kind];
  const inputs = ports.filter((port) => port.direction === "input");
  const outputs = ports.filter((port) => port.direction === "output");

  return (
    <>
      {inputs.map((port, index) => (
        <PortDot index={index} key={port.id} kind={kind} nodeId={nodeId} port={port} />
      ))}
      {hiddenAutoImageInputCount ? <CollapsedAutoImageHint count={hiddenAutoImageInputCount} /> : null}
      {outputs.map((port, index) => (
        <PortDot index={index} key={port.id} kind={kind} nodeId={nodeId} port={port} />
      ))}
    </>
  );
}

function CollapsedAutoImageHint({ count }: { count: number }) {
  const pathCount = Math.min(3, Math.max(1, count));
  const paths = pathCount === 1
    ? ["M 6 43 C 18 43 29 43 42 43"]
    : pathCount === 2
      ? ["M 8 29 C 19 31 29 38 42 43", "M 8 57 C 19 55 29 48 42 43"]
      : ["M 8 24 C 18 29 29 38 42 43", "M 6 43 C 18 43 29 43 42 43", "M 8 62 C 18 57 29 48 42 43"];

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-[-44px] top-1/2 z-0 -translate-y-1/2"
      height="86"
      viewBox="0 0 48 86"
      width="48"
    >
      {paths.map((path, index) => (
        <path
          d={path}
          fill="none"
          key={path}
          opacity="0.78"
          stroke="#C5CCD8"
          strokeDasharray="2.6 5"
          strokeLinecap="round"
          strokeWidth={index === 1 || pathCount < 3 ? 1.9 : 1.7}
        />
      ))}
    </svg>
  );
}
