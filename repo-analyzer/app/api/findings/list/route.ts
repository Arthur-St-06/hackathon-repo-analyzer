import { NextResponse } from "next/server";
import { getPresentedFindings } from "@/lib/findings/presenter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get("limit") ?? "25");
    const result = await getPresentedFindings(limitParam);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list findings.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
