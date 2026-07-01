export function getAutoDisplayScale(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;

  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);

  if (longest >= 3600 || shortest >= 2000) return 1.35;
  if (longest >= 3000 || shortest >= 1700) return 1.24;
  if (longest >= 2400 || shortest >= 1350) return 1.12;
  return 1;
}

export function getReadableZoomFloor(displayScale: number) {
  if (displayScale >= 1.3) return 0.42;
  if (displayScale >= 1.2) return 0.34;
  if (displayScale > 1) return 0.26;
  return 0;
}
