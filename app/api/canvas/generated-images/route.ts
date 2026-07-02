import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    format: "ai-canvas-generated-images",
    images: [],
    mode: "browser-local",
    savedAt: new Date().toISOString(),
    version: 1
  });
}

export async function POST() {
  return NextResponse.json({ ok: true, mode: "browser-local" });
}

export async function DELETE() {
  return NextResponse.json({ ok: true, mode: "browser-local" });
}

export async function PUT() {
  return NextResponse.json({ ok: true, mode: "browser-local" });
}
