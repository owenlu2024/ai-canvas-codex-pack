"use client";

import { useEffect } from "react";
import { getAutoDisplayScale } from "@/lib/displayScale";

function getViewportSize() {
  const visualViewport = window.visualViewport;
  const width = visualViewport?.width ?? window.innerWidth;
  const height = visualViewport?.height ?? window.innerHeight;
  return {
    height: Math.max(1, height),
    width: Math.max(1, width)
  };
}

export function DisplayScaleController() {
  useEffect(() => {
    const update = () => {
      const size = getViewportSize();
      document.documentElement.style.setProperty("--ui-scale", String(getAutoDisplayScale(size.width, size.height)));
    };

    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--ui-scale");
    };
  }, []);

  return null;
}
