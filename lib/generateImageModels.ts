import { getBaseModelId } from "@/lib/clientAiSettings";

export type GenerateImageModelId = "gpt-image-2" | "gemini-3.1-flash-image-preview" | "gemini-3.1-flash-lite-image" | "gemini-3-pro-image-preview" | "agnes-image-2.1-flash";

export type GenerateImageParamKey = "aspectRatio" | "resolution" | "quality" | "imageCount" | "size";

export interface GenerateImageParamSpec {
  key: GenerateImageParamKey;
  label: string;
  options: string[];
  compact?: boolean;
  control?: "select";
}

export interface GenerateImageModelSpec {
  id: GenerateImageModelId;
  label: string;
  params: GenerateImageParamSpec[];
}

const aspectRatioParam: GenerateImageParamSpec = {
  key: "aspectRatio",
  label: "AR",
  options: [
    "Auto",
    "1:1 Square",
    "2:3 Portrait",
    "3:2 Landscape",
    "3:4 Portrait",
    "4:3 Landscape",
    "4:5 Portrait",
    "5:4 Landscape",
    "9:16 Phone Portrait",
    "16:9 Widescreen",
    "21:9 Ultrawide",
    "4:1 Superwide",
    "1:4 Supertall",
    "8:1 Extreme Wide",
    "1:8 Extreme Tall"
  ]
};

const gptResolutionParam: GenerateImageParamSpec = {
  key: "resolution",
  label: "Res",
  options: ["1K", "2K", "4K"]
};

const geminiResolutionParam: GenerateImageParamSpec = {
  key: "resolution",
  label: "Res",
  options: ["1K", "2K", "4K"]
};

const geminiFlashLiteResolutionParam: GenerateImageParamSpec = {
  key: "resolution",
  label: "Res",
  options: ["1K"]
};

const imageCountParam: GenerateImageParamSpec = {
  key: "imageCount",
  label: "Image Count",
  options: ["1", "2", "3", "4"],
  compact: true
};

const agnesSizeParam: GenerateImageParamSpec = {
  key: "size",
  label: "Size",
  options: ["2048x2048", "2048x1536", "1536x2048", "1024x1024", "1024x768", "768x1024"]
};

const agnesImageModelSpec: GenerateImageModelSpec = {
  id: "agnes-image-2.1-flash",
  label: "agnes-image-2.1-flash",
  params: [
    agnesSizeParam,
    imageCountParam
  ]
};

const geminiFlashLiteImageModelSpec: GenerateImageModelSpec = {
  id: "gemini-3.1-flash-lite-image",
  label: "gemini-3.1-flash-lite-image",
  params: [
    aspectRatioParam,
    geminiFlashLiteResolutionParam,
    imageCountParam
  ]
};

export const generateImageModelSpecs: GenerateImageModelSpec[] = [
  {
    id: "gpt-image-2",
    label: "gpt-image-2",
    params: [
      aspectRatioParam,
      gptResolutionParam,
      { key: "quality", label: "Quality", options: ["Auto", "Low", "Medium", "High"] },
      imageCountParam
    ]
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "gemini-3.1-flash-image-preview",
    params: [
      aspectRatioParam,
      geminiResolutionParam,
      imageCountParam
    ]
  },
  geminiFlashLiteImageModelSpec,
  {
    id: "gemini-3-pro-image-preview",
    label: "gemini-3-pro-image-preview",
    params: [
      aspectRatioParam,
      geminiResolutionParam,
      imageCountParam
    ]
  },
  agnesImageModelSpec
];

export const defaultGenerateImageModelId = generateImageModelSpecs[0].id;

export const gridImageModelSpecs: GenerateImageModelSpec[] = [
  {
    id: "gpt-image-2",
    label: "gpt-image-2",
    params: [
      aspectRatioParam,
      gptResolutionParam,
      { key: "quality", label: "Quality", options: ["Auto", "Low", "Medium", "High"] }
    ]
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "gemini-3.1-flash-image-preview",
    params: [
      aspectRatioParam,
      geminiResolutionParam
    ]
  },
  {
    ...geminiFlashLiteImageModelSpec,
    params: [aspectRatioParam, geminiFlashLiteResolutionParam]
  },
  {
    ...agnesImageModelSpec,
    params: [agnesSizeParam]
  }
];

export const defaultGridImageModelId = gridImageModelSpecs[0].id;

export const sceneImageModelSpecs: GenerateImageModelSpec[] = [
  {
    id: "gpt-image-2",
    label: "gpt-image-2",
    params: [
      aspectRatioParam,
      gptResolutionParam,
      imageCountParam
    ]
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "gemini-3.1-flash-image-preview",
    params: [
      aspectRatioParam,
      geminiResolutionParam,
      imageCountParam
    ]
  },
  geminiFlashLiteImageModelSpec,
  {
    id: "gemini-3-pro-image-preview",
    label: "gemini-3-pro-image-preview",
    params: [
      aspectRatioParam,
      geminiResolutionParam,
      imageCountParam
    ]
  },
  agnesImageModelSpec
];

export const defaultSceneImageModelId = sceneImageModelSpecs[0].id;

export const industrialDesignImageModelSpecs = sceneImageModelSpecs;

export const defaultIndustrialDesignImageModelId = industrialDesignImageModelSpecs[0].id;

export const productRemixModelSpecs = sceneImageModelSpecs;

export const defaultProductRemixModelId = productRemixModelSpecs[0].id;

export function getReferenceImageLimit(modelId?: string) {
  modelId = getBaseModelId(modelId);
  if (modelId === "gpt-image-2") return 5;
  if (modelId === "gemini-3.1-flash-image-preview") return 14;
  if (modelId === "gemini-3.1-flash-lite-image") return 14;
  if (modelId === "gemini-3-pro-image-preview") return 14;
  if (modelId === "agnes-image-2.1-flash") return 5;
  return 5;
}

export function isAgnesImageModel(modelId?: string) {
  modelId = getBaseModelId(modelId);
  return modelId === "agnes-image-2.1-flash";
}

export function getGenerateImageModelSpec(modelId?: string) {
  modelId = getBaseModelId(modelId);
  const fallback = generateImageModelSpecs[0];
  const matched = generateImageModelSpecs.find((model) => model.id === modelId);
  if (!fallback) throw new Error("Missing Generate Image model specs.");
  return matched ?? fallback;
}

export function getDefaultGenerateImageParams(modelId?: string): Record<string, string> {
  const spec = getGenerateImageModelSpec(modelId);
  return {
    ...Object.fromEntries(spec.params.map((param) => [param.key, param.options[0]])),
    gridEnabled: "false"
  };
}

export function getGridImageModelSpec(modelId?: string) {
  modelId = getBaseModelId(modelId);
  const fallback = gridImageModelSpecs[0];
  const matched = gridImageModelSpecs.find((model) => model.id === modelId);
  if (!fallback) throw new Error("Missing Generate Grid Image model specs.");
  return matched ?? fallback;
}

export function getDefaultGridImageParams(modelId?: string) {
  const spec = getGridImageModelSpec(modelId);
  return Object.fromEntries(spec.params.map((param) => [param.key, param.options[0]]));
}

export function getSceneImageModelSpec(modelId?: string) {
  modelId = getBaseModelId(modelId);
  const fallback = sceneImageModelSpecs[0];
  const matched = sceneImageModelSpecs.find((model) => model.id === modelId);
  if (!fallback) throw new Error("Missing Scene Image model specs.");
  return matched ?? fallback;
}

export function getDefaultSceneImageParams(modelId?: string): Record<string, string> {
  const spec = getSceneImageModelSpec(modelId);
  return {
    ...Object.fromEntries(spec.params.map((param) => [param.key, param.options[0]])),
    aspectRatio: "自动",
    gridEnabled: "false",
    quality: "Auto"
  };
}

export function getIndustrialDesignImageModelSpec(modelId?: string) {
  modelId = getBaseModelId(modelId);
  const fallback = industrialDesignImageModelSpecs[0];
  const matched = industrialDesignImageModelSpecs.find((model) => model.id === modelId);
  if (!fallback) throw new Error("Missing Industrial Design Image model specs.");
  return matched ?? fallback;
}

export function getDefaultIndustrialDesignImageParams(modelId?: string): Record<string, string> {
  return getDefaultSceneImageParams(modelId);
}

export function getProductRemixModelSpec(modelId?: string) {
  modelId = getBaseModelId(modelId);
  const fallback = productRemixModelSpecs[0];
  const matched = productRemixModelSpecs.find((model) => model.id === modelId);
  if (!fallback) throw new Error("Missing Product Remix model specs.");
  return matched ?? fallback;
}

export function getDefaultProductRemixParams(modelId?: string): Record<string, string> {
  const spec = getProductRemixModelSpec(modelId);
  const specDefaults = Object.fromEntries(spec.params.map((param) => [param.key, param.options[0]]));
  return {
    ...specDefaults,
    ...(specDefaults.aspectRatio ? { aspectRatio: "自动" } : {}),
    endRemix: "100",
    gridMode: "1",
    imageCount: "1",
    remix: "50",
    ...(specDefaults.resolution ? {
      resolution: spec.params.find((param) => param.key === "resolution")?.options.includes("2K") ? "2K" : specDefaults.resolution
    } : {}),
    startRemix: "0"
  };
}
