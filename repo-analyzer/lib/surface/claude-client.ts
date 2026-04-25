import { IssueMetadata } from "@/lib/surface/types";
import { spawn } from "node:child_process";

export type ClaudeClientConfig = {
  apiKey: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type ClaudeSurfaceRequest = {
  repo: string;
  maxIssues: number;
  previewText: string;
  candidates: IssueMetadata[];
};

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ClaudeSurfaceResponse = {
  summary: string;
  findings: Array<{
    issueNumber: number;
    classification: "correctness_silent" | "performance_regression" | "missing_fast_path" | "unknown";
    rationale: string;
  }>;
  usage: ClaudeUsage;
};

export type ClaudeIntegrationStatus = "disabled" | "not_implemented";

export type ClaudeUsageSnapshot = {
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualTotalTokens: number | null;
};

export type ClaudeCliResult = {
  outputText: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  durationMs: number;
  model: string | null;
};

export function validateClaudeConfig(config: Partial<ClaudeClientConfig>): ClaudeClientConfig {
  const apiKey = config.apiKey?.trim();
  const model = config.model?.trim();

  if (!apiKey) {
    throw new Error("Missing Claude API key.");
  }

  if (!model) {
    throw new Error("Missing Claude model name.");
  }

  return {
    apiKey,
    model,
    maxInputTokens: config.maxInputTokens ?? 12000,
    maxOutputTokens: config.maxOutputTokens ?? 1500,
    timeoutMs: config.timeoutMs ?? 45000,
  };
}

export function estimateMaxTotalTokens(inputTokens: number, maxOutputTokens: number): number {
  return Math.max(0, inputTokens) + Math.max(0, maxOutputTokens);
}

export function mapAnthropicUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
}): ClaudeUsageSnapshot {
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  const total = input !== null && output !== null ? input + output : null;

  return {
    actualInputTokens: input,
    actualOutputTokens: output,
    actualTotalTokens: total,
  };
}

function buildSurfacePrompt(previewText: string, additionalInstructions?: string): string {
  const trimmedInstructions = additionalInstructions?.trim();

  return [
    "You are a surface triage assistant for GitHub issues.",
    "",
    "Task:",
    "- Read the compact issue preview below.",
    "- Return contributor-friendly suggestions.",
    "- Keep output concise and actionable.",
    "",
    "Output format:",
    "1. Top 5 candidate issues (best first)",
    "   - issue number",
    "   - 1-sentence rationale",
    "   - one suggested next step",
    "2. 3 quick triage rules to improve deterministic filtering",
    "3. 3 risks or blind spots in this candidate set",
    "",
    "Constraints:",
    "- No markdown tables",
    "- Max 2 sentences per bullet",
    "- Prefer concrete next steps over background explanation",
    ...(trimmedInstructions
      ? [
          "",
          "Additional user constraints:",
          trimmedInstructions,
        ]
      : []),
    "",
    "=== SURFACE INPUT PREVIEW START ===",
    previewText,
    "=== SURFACE INPUT PREVIEW END ===",
  ].join("\n");
}

async function runClaudeCommand(args: string[], stdinText: string | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        const suffix = stderr.trim() ? ` ${stderr.trim()}` : "";
        reject(new Error(`Claude CLI failed with exit code ${code}.${suffix}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (stdinText !== null) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

export async function runClaudeSurfaceCli(
  previewText: string,
  timeoutMs = 120000,
  additionalInstructions?: string,
): Promise<ClaudeCliResult> {
  const prompt = buildSurfacePrompt(previewText, additionalInstructions);
  const estimatedInputTokens = Math.ceil(prompt.length / 4);
  const configuredModel = process.env.CLAUDE_CLI_MODEL?.trim() || "haiku";
  const modelArgs = configuredModel ? ["--model", configuredModel] : [];

  const startedAt = Date.now();

  let outputText = "";
  try {
    outputText = await runClaudeCommand([...modelArgs, "-p", prompt], null, timeoutMs);
  } catch {
    outputText = await runClaudeCommand(modelArgs, prompt, timeoutMs);
  }

  const durationMs = Date.now() - startedAt;

  return {
    outputText,
    estimatedInputTokens,
    estimatedOutputTokens: Math.ceil(outputText.length / 4),
    durationMs,
    model: configuredModel,
  };
}

export async function callClaudeSurface(
  _config: ClaudeClientConfig,
  _request: ClaudeSurfaceRequest,
): Promise<ClaudeSurfaceResponse> {
  void _config;
  void _request;

  // TODO(claude-api): implement provider call using the official SDK or HTTP client.
  // TODO(claude-api): enforce timeout, retries with backoff, and status-specific errors.
  // TODO(claude-api): pass deterministic previewText as compact prompt context.
  // TODO(claude-api): request strict JSON output and validate before returning.
  // TODO(claude-api): map provider usage fields into ClaudeUsage.
  throw new Error("Claude API integration is not implemented yet.");
}
