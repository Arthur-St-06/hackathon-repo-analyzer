import { NextResponse } from "next/server";
import { runSurfaceDryRun } from "@/lib/surface/pipeline";
import {
  estimateMaxTotalTokens,
  mapAnthropicUsage,
  runClaudeSurfaceCli,
  validateClaudeConfig,
} from "@/lib/surface/claude-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TODO(claude-api): add a provider integration branch in this route.
// Suggested approach:
// 1) Parse a `useClaude` boolean from request body.
// 2) Validate ANTHROPIC_API_KEY and fail fast with a clear 400/503 error.
// 3) Reuse deterministic prefilter output as input context for Claude.
// 4) Enforce max input/output token budget and timeout before provider call.
// 5) Return provider usage metrics (input/output/total tokens, latency).

type RequestBody = {
  repo?: string;
  maxIssues?: number;
  useClaude?: boolean;
  additionalInstructions?: string;
};

const MAX_ADDITIONAL_INSTRUCTIONS_CHARS = 800;
const MAX_SURFACE_ISSUES = 500;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const repo = body.repo ?? "pytorch/pytorch";
    const maxIssues = Math.max(1, Math.min(MAX_SURFACE_ISSUES, Number(body.maxIssues ?? 50)));
    const useClaude = Boolean(body.useClaude);
    const additionalInstructions = String(body.additionalInstructions ?? "").trim();

    if (additionalInstructions.length > MAX_ADDITIONAL_INSTRUCTIONS_CHARS) {
      return NextResponse.json(
        {
          ok: false,
          error: `Additional instructions exceed ${MAX_ADDITIONAL_INSTRUCTIONS_CHARS} characters.`,
        },
        { status: 400 },
      );
    }

    // TODO(claude-api): when useClaude=true, call Claude after deterministic
    // prefilter/serialization and keep this deterministic path as fallback.

    const result = await runSurfaceDryRun(repo, maxIssues);

    const claudeFeatureEnabled = process.env.ENABLE_CLAUDE_API === "true";
    const baseClaude = {
      requested: useClaude,
      enabled: false,
      status: "disabled" as const,
      reason: "Claude call: disabled",
      estimatedInputTokens: null,
      actualInputTokens: null,
      estimatedOutputTokens: null,
      actualOutputTokens: null,
      actualTotalTokens: null,
      durationMs: null,
      outputText: null,
    };

    if (!useClaude) {
      return NextResponse.json({ ok: true, mode: "deterministic", ...result, claude: baseClaude });
    }

    if (!claudeFeatureEnabled) {
      const claudeCliEnabled = process.env.ENABLE_CLAUDE_CLI === "true";
      if (claudeCliEnabled) {
        const cliTimeoutMs = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 120000);
        const cliResult = await runClaudeSurfaceCli(result.previewText, cliTimeoutMs, additionalInstructions);

        return NextResponse.json({
          ok: true,
          mode: "claude-cli",
          ...result,
          claude: {
            requested: true,
            enabled: true,
            status: "cli" as const,
            reason: "Claude CLI executed successfully.",
            model: cliResult.model ?? "default",
            estimatedInputTokens: cliResult.estimatedInputTokens,
            actualInputTokens: cliResult.estimatedInputTokens,
            estimatedOutputTokens: cliResult.estimatedOutputTokens,
            actualOutputTokens: cliResult.estimatedOutputTokens,
            actualTotalTokens: cliResult.estimatedInputTokens + cliResult.estimatedOutputTokens,
            durationMs: cliResult.durationMs,
            outputText: cliResult.outputText,
          },
        });
      }

      return NextResponse.json({
        ok: true,
        mode: "deterministic",
        ...result,
        claude: {
          ...baseClaude,
          reason: "Set ENABLE_CLAUDE_CLI=true (or ENABLE_CLAUDE_API=true) to enable Claude execution path.",
        },
      });
    }

    const config = validateClaudeConfig({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL ?? "claude-4-5-haiku-latest",
      maxInputTokens: Number(process.env.CLAUDE_MAX_INPUT_TOKENS ?? 12000),
      maxOutputTokens: Number(process.env.CLAUDE_MAX_OUTPUT_TOKENS ?? 1500),
      timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 45000),
    });

    // TODO(claude-api): replace this scaffold response with real provider call.
    const usageSnapshot = mapAnthropicUsage();

    return NextResponse.json({
      ok: true,
      mode: "claude-api",
      ...result,
      claude: {
        requested: true,
        enabled: true,
        status: "not_implemented" as const,
        reason: "Claude feature flag is enabled, but provider call is still scaffold-only.",
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        estimatedMaxTotalTokens: estimateMaxTotalTokens(result.estimatedTokens, config.maxOutputTokens),
        estimatedInputTokens: result.estimatedTokens,
        actualInputTokens: usageSnapshot.actualInputTokens,
        estimatedOutputTokens: config.maxOutputTokens,
        actualOutputTokens: usageSnapshot.actualOutputTokens,
        actualTotalTokens: usageSnapshot.actualTotalTokens,
        durationMs: null,
        outputText: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run dry-run pipeline.";
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
