"use client";

import { useEffect, useState } from "react";
import { getAutoDisplayScale } from "@/lib/displayScale";

function getCurrentDisplayScale() {
  if (typeof window === "undefined") return 1;
  const visualViewport = window.visualViewport;
  const width = Math.max(1, visualViewport?.width ?? window.innerWidth);
  const height = Math.max(1, visualViewport?.height ?? window.innerHeight);
  return getAutoDisplayScale(width, height);
}

export function useDisplayScale() {
  const [displayScale, setDisplayScale] = useState(getCurrentDisplayScale);

  useEffect(() => {
    const update = () => setDisplayScale(getCurrentDisplayScale());
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  return displayScale;
}
