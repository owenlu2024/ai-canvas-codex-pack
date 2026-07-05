"use client";

import type React from "react";
import { useResolvedImageUrl } from "@/components/shared/useResolvedImageUrl";

type ResolvedImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
};

export function ResolvedImage({ src, ...props }: ResolvedImageProps) {
  const resolvedSrc = useResolvedImageUrl(src);
  if (!resolvedSrc) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="" {...props} src={resolvedSrc} />;
}
