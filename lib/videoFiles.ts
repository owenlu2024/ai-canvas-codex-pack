export const acceptedVideoFileTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/ogg",
  "video/*"
].join(",");

const supportedVideoExtensions = ["mp4", "m4v", "webm", "mov", "ogv", "ogg"];

export function isSupportedVideoFile(file: File) {
  if (file.type.startsWith("video/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return Boolean(extension && supportedVideoExtensions.includes(extension));
}

export function getVideoFilenameExtension(videoName?: string, videoType?: string) {
  const sourceExtension = videoName?.split(".").pop()?.toLowerCase();
  if (sourceExtension && supportedVideoExtensions.includes(sourceExtension)) return sourceExtension;
  if (videoType === "video/webm") return "webm";
  if (videoType === "video/quicktime") return "mov";
  if (videoType === "video/x-m4v") return "m4v";
  if (videoType === "video/ogg") return "ogv";
  return "mp4";
}
