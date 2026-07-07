"use client";

import { useEffect } from "react";
import { getAutoDisplayScale } from "@/lib/displayScale";

function getViewportSize() {
  const visualViewport = window.visualViewport;
  const width = visualViewport?.width ?? window.innerWidth;
  const height = visualViewport?.height ?? window.innerHeight;
  return {
    height: Math.max(1, height),
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: Math.max(1, width)
  };
}

export function DisplayScaleController() {
  useEffect(() => {
    const update = () => {
      const size = getViewportSize();
      document.documentElement.style.setProperty("--ui-scale", String(getAutoDisplayScale(size.width, size.height)));
      document.documentElement.style.setProperty("--visual-viewport-left", `${size.left}px`);
      document.documentElement.style.setProperty("--visual-viewport-top", `${size.top}px`);
      document.documentElement.style.setProperty("--visual-viewport-width", `${size.width}px`);
      document.documentElement.style.setProperty("--visual-viewport-height", `${size.height}px`);
    };

    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.visualViewport?.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--ui-scale");
      document.documentElement.style.removeProperty("--visual-viewport-left");
      document.documentElement.style.removeProperty("--visual-viewport-top");
      document.documentElement.style.removeProperty("--visual-viewport-width");
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  return null;
}
