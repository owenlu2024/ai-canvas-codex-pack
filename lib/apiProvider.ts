export interface ImageGenerationRequest {
  prompt: string;
  images?: File[];
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  n?: number;
}

export interface ImageGenerationResult {
  images: Array<{ url?: string; b64_json?: string }>;
  revisedPrompt?: string;
}

export async function generateImage(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  throw new Error("Not implemented in v1 prototype");
}
