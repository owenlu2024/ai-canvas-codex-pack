import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({
    images: [],
    mode: "browser-local",
    recovered: 0,
    tasks: []
  });
}
