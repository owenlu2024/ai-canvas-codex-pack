export type AiModelKind = "image" | "text" | "video";

const videoModelHints = [
  "seedance", "veo", "sora", "kling", "runway", "hailuo", "minimax-video",
  "wan-video", "wan2", "vidu", "luma-ray", "dream-machine", "pika"
];

const imageModelHints = ["image", "img", "dall", "flux", "stable", "sd", "midjourney", "mj", "imagen"];

export function classifyAiModel(modelId: string): AiModelKind {
  const normalized = modelId.replace(/^\d{3}-/, "").toLowerCase();
  if (videoModelHints.some((hint) => normalized.includes(hint))) return "video";
  if (imageModelHints.some((hint) => normalized.includes(hint))) return "image";
  return "text";
}

export function isVideoModel(modelId: string) {
  return classifyAiModel(modelId) === "video";
}
