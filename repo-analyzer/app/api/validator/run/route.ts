import { NextResponse } from "next/server";
import { runValidator } from "@/lib/validator/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  findingId?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const findingId = String(body.findingId ?? "pytorch_113956").trim();

    if (!findingId) {
      return NextResponse.json({ ok: false, error: "findingId is required." }, { status: 400 });
    }

    const result = await runValidator(findingId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run validator.";
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 400;

    return NextResponse.json({ ok: false, error: message }, { status: statusCode });
  }
}
