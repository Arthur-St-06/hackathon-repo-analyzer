import fs from "node:fs/promises";
import path from "node:path";
import { DryRunResult, IssueMetadata, PrefilterResult } from "@/lib/surface/types";

type IssueCacheEntry = {
  expiresAt: number;
  issues: IssueMetadata[];
};

const ISSUE_CACHE_TTL_MS = Number(process.env.GITHUB_ISSUE_CACHE_TTL_MS ?? 5 * 60 * 1000);
const issueCache = new Map<string, IssueCacheEntry>();
const issueFetchInFlight = new Map<string, Promise<IssueMetadata[]>>();

export class SurfacePipelineError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SurfacePipelineError";
    this.statusCode = statusCode;
  }
}

const TITLE_SIGNALS = [
  "bug",
  "incorrect",
  "wrong",
  "regression",
  "slow",
  "slower",
  "performance",
  "crash",
  "assert",
  "runtimeerror",
  "fails",
  "failure",
  "diverge",
  "nan",
  "inf",
  "uninitialized",
];

const LABEL_SIGNALS = ["bug", "correctness", "regression", "performance"];

function normalizeRepoInput(raw: string): string {
  const input = raw.trim();
  if (!input) {
    throw new Error("Repository is required.");
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const parsed = new URL(input);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("Repository URL must include owner and repo.");
    }
    return `${parts[0]}/${parts[1]}`;
  }

  const parts = input.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Repository must use owner/repo format.");
  }

  return `${parts[0]}/${parts[1]}`;
}

function toMetadata(item: Record<string, unknown>): IssueMetadata {
  const labels = Array.isArray(item.labels)
    ? item.labels
        .map((label) => (typeof label === "object" && label && "name" in label ? String((label as { name: unknown }).name) : ""))
        .filter(Boolean)
    : [];

  return {
    number: Number(item.number),
    title: String(item.title ?? ""),
    labels,
    state: String(item.state ?? "").toUpperCase(),
    createdAt: String(item.created_at ?? ""),
    url: String(item.html_url ?? ""),
  };
}

function hasSignalTitle(issue: IssueMetadata): boolean {
  const title = issue.title.toLowerCase();
  return TITLE_SIGNALS.some((signal) => title.includes(signal));
}

function hasSignalLabel(issue: IssueMetadata): boolean {
  const labels = issue.labels.map((label) => label.toLowerCase());
  return labels.some((label) => LABEL_SIGNALS.some((signal) => label.includes(signal)));
}

function shouldReject(issue: IssueMetadata): boolean {
  if (String(issue.state).toUpperCase() !== "OPEN") {
    return true;
  }

  if (issue.title.trimStart().toUpperCase().startsWith("DISABLED")) {
    return true;
  }

  const hasSkipped = issue.labels.some((label) => label.toLowerCase().includes("skipped"));
  if (hasSkipped) {
    return true;
  }

  return !(hasSignalLabel(issue) || hasSignalTitle(issue));
}

function prefilterIssues(issues: IssueMetadata[]): PrefilterResult {
  const candidates: IssueMetadata[] = [];
  const rejected: IssueMetadata[] = [];

  for (const issue of issues) {
    if (shouldReject(issue)) {
      rejected.push(issue);
    } else {
      candidates.push(issue);
    }
  }

  return { candidates, rejected };
}

function issueSignalCodes(issue: IssueMetadata): string {
  const labelText = issue.labels.join(" ").toLowerCase();
  const titleText = issue.title.toLowerCase();
  const signals: string[] = [];

  const isBug = /bug|correctness/.test(labelText) || /bug|incorrect|wrong|fails|failure|crash|assert|runtimeerror|nan|inf|uninitialized/.test(titleText);
  const isRegression = /regression/.test(labelText) || /regression|regress/.test(titleText);
  const isPerformance = /performance/.test(labelText) || /slow|slower|slowdown|performance|throughput|latency/.test(titleText);

  if (isBug) {
    signals.push("B");
  }
  if (isRegression) {
    signals.push("REG");
  }
  if (isPerformance) {
    signals.push("PERF");
  }

  return signals.length > 0 ? signals.join(",") : "-";
}

function buildPreviewText(candidates: IssueMetadata[]): string {
  const header = [
    "LABELS:",
    "B = bug",
    "REG = regression",
    "PERF = performance",
    "",
    "ISSUES:",
  ];

  const lines = candidates.map((issue) => {
    const year = (issue.createdAt || "").slice(0, 4);
    return `${issue.number} | ${year} | ${issue.state} | ${issueSignalCodes(issue)} | ${issue.title}`;
  });

  return [...header, ...lines].join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// TODO(claude-api): add a dedicated prompt packer that takes deterministic
// candidates and builds a compact provider payload. Keep prompt construction
// isolated from fetch/prefilter logic so it can be tested independently.
//
// TODO(claude-api): track both input and output token budgets.
// Example placeholders for future config:
// - CLAUDE_MODEL
// - CLAUDE_MAX_INPUT_TOKENS
// - CLAUDE_MAX_OUTPUT_TOKENS
// - CLAUDE_TIMEOUT_MS

async function fetchIssueMetadata(repo: string, maxIssues: number): Promise<IssueMetadata[]> {
  const [owner, name] = repo.split("/");
  const maxPages = 50;
  const issues: IssueMetadata[] = [];
  const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const authMode = githubToken ? "auth" : "unauth";
  const cacheKey = `${repo}::${maxIssues}::${authMode}`;
  const now = Date.now();

  const cached = issueCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.issues.slice(0, maxIssues);
  }

  const inFlight = issueFetchInFlight.get(cacheKey);
  if (inFlight) {
    const inFlightResult = await inFlight;
    return inFlightResult.slice(0, maxIssues);
  }

  const fetchPromise = (async () => {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `https://api.github.com/repos/${owner}/${name}/issues?state=open&per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "repo-analyzer-dry-run",
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
        cache: "no-store",
      });

      if (response.status === 422) {
        // GitHub can return 422 when paging beyond allowed bounds; treat this as end-of-data.
        break;
      }

      if (!response.ok) {
        let responseMessage = "";
        try {
          const errorPayload = (await response.json()) as { message?: unknown };
          responseMessage = typeof errorPayload.message === "string" ? errorPayload.message : "";
        } catch {
          // ignore parse failures and fall back to status-only messaging
        }

        if (response.status === 403) {
          const remaining = response.headers.get("x-ratelimit-remaining");
          const reset = response.headers.get("x-ratelimit-reset");
          const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
          const rateLimited = remaining === "0";

          if (rateLimited) {
            const guidance = githubToken
              ? "GitHub API rate limit reached for the provided token."
              : "GitHub API unauthenticated rate limit reached. Set GITHUB_TOKEN (or GH_TOKEN) and retry.";
            const resetSuffix = resetAt ? ` Rate limit resets at ${resetAt}.` : "";
            throw new SurfacePipelineError(`${guidance}${resetSuffix}`, 429);
          }

          const detail = responseMessage || "Forbidden";
          throw new SurfacePipelineError(`GitHub fetch failed (403): ${detail}.`, 403);
        }

        if (response.status === 404) {
          throw new SurfacePipelineError("GitHub repository not found. Check owner/repo and token access.", 404);
        }

        if (response.status === 401) {
          throw new SurfacePipelineError("GitHub authentication failed (401). Check GITHUB_TOKEN/GH_TOKEN.", 401);
        }

        const detail = responseMessage ? `: ${responseMessage}` : "";
        throw new SurfacePipelineError(`GitHub fetch failed (${response.status})${detail}.`, response.status);
      }

      const payload = (await response.json()) as Array<Record<string, unknown>>;
      const nonPrIssues = payload
        .filter((item) => !("pull_request" in item))
        .map((item) => toMetadata(item));

      issues.push(...nonPrIssues);

      if (issues.length >= maxIssues || payload.length === 0) {
        break;
      }
    }

    const trimmed = issues.slice(0, maxIssues);
    issueCache.set(cacheKey, {
      expiresAt: Date.now() + ISSUE_CACHE_TTL_MS,
      issues: trimmed,
    });
    return trimmed;
  })();

  issueFetchInFlight.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    issueFetchInFlight.delete(cacheKey);
  }
}

export async function runSurfaceDryRun(inputRepo: string, maxIssues: number): Promise<DryRunResult> {
  const totalStart = Date.now();
  const repo = normalizeRepoInput(inputRepo);

  const fetchStart = Date.now();
  const fetchedIssues = await fetchIssueMetadata(repo, maxIssues);
  const fetchMs = Date.now() - fetchStart;

  const uniqueLabels = new Set(fetchedIssues.flatMap((issue) => issue.labels)).size;

  const prefilterStart = Date.now();
  const { candidates, rejected } = prefilterIssues(fetchedIssues);
  const previewText = buildPreviewText(candidates);
  const estimatedTokens = estimateTokens(previewText);
  const prefilterMs = Date.now() - prefilterStart;

  // TODO(claude-api): provider handoff point.
  // Proposed sequence:
  // 1) Build compact prompt text from `previewText`.
  // 2) Call Claude with strict output schema instructions.
  // 3) Validate/parse model response.
  // 4) Persist model output alongside deterministic artifacts for auditing.

  const debugDir = path.join(process.cwd(), "debug");
  await fs.mkdir(debugDir, { recursive: true });
  const previewPath = path.join(debugDir, "surface_input_preview.txt");
  const candidatesPath = path.join(debugDir, "candidates.json");
  const rejectedPath = path.join(debugDir, "rejected.json");

  const serializeStart = Date.now();
  await Promise.all([
    fs.writeFile(previewPath, `${previewText}\n\nESTIMATED_TOKENS: ${estimatedTokens}\n`, "utf8"),
    fs.writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8"),
    fs.writeFile(rejectedPath, `${JSON.stringify(rejected, null, 2)}\n`, "utf8"),
  ]);
  const serializeMs = Date.now() - serializeStart;

  const totalMs = Date.now() - totalStart;

  return {
    repo,
    maxIssues,
    fetched: fetchedIssues.length,
    uniqueLabels,
    candidatesAfterPrefilter: candidates.length,
    rejected: rejected.length,
    previewPath: "debug/surface_input_preview.txt",
    estimatedTokens,
    previewText,
    timingsMs: {
      fetch: fetchMs,
      prefilter: prefilterMs,
      serialize: serializeMs,
      total: totalMs,
    },
  };
}
