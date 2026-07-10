export type NodeKind = "image" | "prompt" | "imageChat" | "sceneDirector" | "taobaoPageDirector" | "industrial_designer" | "product_poster" | "visual_director" | "multiGenerate" | "generateImage" | "hdRedraw" | "hdRedraw2" | "rhinoTest" | "textImageLayout" | "gridImage" | "sceneImage" | "industrialDesignImage" | "productRemix" | "group";
export type PortType = "image" | "text";
export type PortDirection = "input" | "output";
export type RunState = "idle" | "running" | "completed" | "failed";
export type NodeMotionState = "entering" | "duplicating" | "deleting";

export interface Port {
  id: string;
  type: PortType;
  direction: PortDirection;
  color: string;
}

export interface CanvasNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  imageUrl?: string;
  imageNumber?: number;
  prompt?: string;
  promptTextColor?: string;
  promptRichHtml?: string;
  modelId?: string;
  modelParams?: Record<string, string>;
  runState?: RunState;
  errorMessage?: string;
  generationId?: string;
  generatedBy?: string;
  motionState?: NodeMotionState;
  zIndex: number;
}

export const NODE_SIZE = {
  width: 320,
  height: 260
};

export const portsByNode: Record<NodeKind, Port[]> = {
  image: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  prompt: [
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  imageChat: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  sceneDirector: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  taobaoPageDirector: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  industrial_designer: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  product_poster: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  visual_director: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  multiGenerate: [
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  generateImage: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  hdRedraw: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" },
    { id: "text-out", type: "text", direction: "output", color: "#FFC928" }
  ],
  hdRedraw2: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  rhinoTest: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  textImageLayout: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  gridImage: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  sceneImage: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  industrialDesignImage: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  productRemix: [
    { id: "image-in", type: "image", direction: "input", color: "#2ECC71" },
    { id: "text-in", type: "text", direction: "input", color: "#FFC928" },
    { id: "image-out", type: "image", direction: "output", color: "#2ECC71" }
  ],
  group: []
};

export const nodeLabels: Record<NodeKind, string> = {
  image: "Image",
  prompt: "Prompt",
  imageChat: "AI Prompt",
  sceneDirector: "Scene Director",
  taobaoPageDirector: "Taobao Page Director",
  industrial_designer: "Industrial Designer",
  product_poster: "产品海报导演",
  visual_director: "Visual Director",
  multiGenerate: "Multi Generate",
  generateImage: "Generate Image",
  hdRedraw: "高清重绘1",
  hdRedraw2: "高清重绘2",
  rhinoTest: "Rhino 测试",
  textImageLayout: "Text Image Layout",
  gridImage: "Generate Grid Image",
  sceneImage: "Scene Image",
  industrialDesignImage: "ID Image",
  productRemix: "产品 Remix 合成器",
  group: "Group"
};

export function getHandlePortType(handleId?: string | null): PortType | null {
  if (!handleId) return null;
  if (handleId.startsWith("image")) return "image";
  if (handleId.startsWith("text")) return "text";
  return null;
}
