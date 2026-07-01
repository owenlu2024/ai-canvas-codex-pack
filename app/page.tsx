"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { AiCanvas } from "@/components/canvas/Canvas";
import { DisplayScaleController } from "@/components/layout/DisplayScaleController";
import { GeneratedImagesPanel } from "@/components/layout/GeneratedImagesPanel";
import { LeftToolbar } from "@/components/layout/LeftToolbar";
import { SettingsPanel } from "@/components/layout/SettingsPanel";
import { TopBar } from "@/components/layout/TopBar";
import { ZoomControl } from "@/components/layout/ZoomControl";

export default function Page() {
  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-canvas"
      style={{
        position: "relative",
        isolation: "isolate",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "var(--canvas-background)"
      }}
    >
      <ReactFlowProvider>
        <DisplayScaleController />
        <AiCanvas />
        <div
          className="pointer-events-none fixed inset-0 z-[2147483000]"
          style={{ inset: 0, pointerEvents: "none", position: "fixed", zIndex: 2147483000 }}
        >
          <TopBar />
          <LeftToolbar />
        </div>
        <GeneratedImagesPanel />
        <SettingsPanel />
        <ZoomControl />
      </ReactFlowProvider>
    </main>
  );
}
