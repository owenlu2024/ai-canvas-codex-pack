import net from "net";

const privateIpv4Ranges = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^0\./
];

export function sanitizeDownloadFilename(value: string) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "image.png";
}

export function parseHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  return url;
}

export function normalizeHttpBaseUrl(value: string, mode: "root" | "v1") {
  const url = parseHttpUrl(value.trim());
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (mode === "root") {
    url.pathname = url.pathname.replace(/\/v1$/, "");
  } else if (!url.pathname.endsWith("/v1")) {
    url.pathname = `${url.pathname}/v1`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/$/, "");
}

export function isProbablyPrivateHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "[::1]") return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return privateIpv4Ranges.some((range) => range.test(normalized));
  if (ipVersion === 6) return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  return false;
}

export function assertSafeRemoteFetchUrl(value: string) {
  const url = parseHttpUrl(value);
  if (isProbablyPrivateHost(url.hostname)) {
    throw new Error("Private network URLs are not allowed.");
  }
  return url.toString();
}
