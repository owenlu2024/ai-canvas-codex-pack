import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ error: "当前为浏览器本地模式，服务器不保存工作区。" }, { status: 404 });
}

export async function POST() {
  return NextResponse.json({ ok: true, mode: "browser-local" });
}
