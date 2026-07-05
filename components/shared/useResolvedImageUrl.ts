"use client";

import { useEffect, useState } from "react";
import { resolveImageSpaceUrlForDisplay } from "@/lib/imageSpace";

export function useResolvedImageUrl(imageUrl?: string) {
  const [resolvedUrl, setResolvedUrl] = useState(imageUrl);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setResolvedUrl(imageUrl);
    if (!imageUrl?.startsWith("image-space://")) return undefined;

    resolveImageSpaceUrlForDisplay(imageUrl)
      .then((nextUrl) => {
        if (!active) {
          if (nextUrl?.startsWith("blob:")) URL.revokeObjectURL(nextUrl);
          return;
        }
        objectUrl = nextUrl?.startsWith("blob:") ? nextUrl : "";
        setResolvedUrl(nextUrl);
      })
      .catch(() => {
        if (active) setResolvedUrl(undefined);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageUrl]);

  return resolvedUrl;
}
