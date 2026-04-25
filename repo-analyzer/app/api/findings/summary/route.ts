import { NextResponse } from "next/server";
import { getFindingsSummary } from "@/lib/findings/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getFindingsSummary();
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate findings summary.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
