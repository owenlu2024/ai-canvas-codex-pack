function getDownloadUrl(imageUrl: string, filename: string) {
  return /^https?:\/\//.test(imageUrl)
    ? `/api/canvas/image-download?url=${encodeURIComponent(imageUrl)}&filename=${encodeURIComponent(filename)}`
    : imageUrl;
}

export async function downloadMediaToFile(mediaUrl: string, filename: string) {
  const response = await fetch(getDownloadUrl(mediaUrl, filename));
  if (!response.ok) {
    throw new Error(`文件下载失败 (${response.status})`);
  }

  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export async function downloadImageToFile(imageUrl: string, filename: string) {
  return downloadMediaToFile(imageUrl, filename);
}
