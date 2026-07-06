export function getImageDisplayUrl(imageUrl?: string | null, filename = "image-preview.png") {
  if (!imageUrl) return "";
  if (!/^https?:\/\//i.test(imageUrl)) return imageUrl;
  const params = new URLSearchParams({
    filename,
    url: imageUrl
  });
  return `/api/canvas/image-download?${params.toString()}`;
}
