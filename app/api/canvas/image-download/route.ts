import { NextRequest, NextResponse } from "next/server";
import { isProbablyPrivateHost, parseHttpUrl, sanitizeDownloadFilename } from "@/lib/urlSafety";

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  const filename = sanitizeDownloadFilename(request.nextUrl.searchParams.get("filename") ?? "image.png");

  try {
    const parsedUrl = parseHttpUrl(url);
    if (isProbablyPrivateHost(parsedUrl.hostname)) {
      return NextResponse.json({ error: "Private network image URLs are not allowed." }, { status: 400 });
    }

    const response = await fetch(parsedUrl, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      return NextResponse.json({ error: `Image request failed: ${response.status}` }, { status: response.status });
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "URL did not return an image." }, { status: 400 });
    }

    return new NextResponse(response.body, {
      headers: {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Type": contentType
      }
    });
  } catch {
    return NextResponse.json({ error: "Unable to download image." }, { status: 500 });
  }
}
