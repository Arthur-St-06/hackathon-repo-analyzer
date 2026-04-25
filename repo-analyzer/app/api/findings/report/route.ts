import { generateFindingsMarkdownReport } from "@/lib/findings/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const markdown = await generateFindingsMarkdownReport();

    return new Response(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": "inline; filename=findings-summary-report.md",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate report.";
    return new Response(message, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}
