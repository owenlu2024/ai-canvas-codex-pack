import { getHandlePortType } from "@/lib/nodeTypes";

export function isSameColorConnection(sourceHandle?: string | null, targetHandle?: string | null) {
  const sourceType = getHandlePortType(sourceHandle);
  const targetType = getHandlePortType(targetHandle);
  return Boolean(sourceType && targetType && sourceType === targetType);
}
