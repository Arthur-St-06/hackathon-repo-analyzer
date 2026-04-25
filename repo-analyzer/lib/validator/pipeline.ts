import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { EnrichedFinding, LinkedPr, MaintainerSignal, RawFinding, ValidatorRunResult } from "@/lib/validator/types";

type GitHubIssueComment = {
  body?: string | null;
  user?: { login?: string | null } | null;
  author_association?: string | null;
  created_at?: string | null;
};

type GitHubIssue = {
  body?: string | null;
  labels?: Array<{ name?: string | null }>;
  comments?: number;
};

type GitHubPrReview = {
  state?: string | null;
  user?: { login?: string | null } | null;
};

type GitHubPr = {
  number: number;
  title?: string | null;
  html_url?: string | null;
  state?: string | null;
  merged_at?: string | null;
  body?: string | null;
};

type GitHubSearchResult = {
  items?: Array<{ number?: number }>;
};

const MAINTAINER_ROLES = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
let findingSchemaValidator: ((data: unknown) => boolean) | null = null;

export class ValidatorPipelineError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ValidatorPipelineError";
    this.statusCode = statusCode;
  }
}

function getWorkspaceRoot(): string {
  return path.resolve(process.cwd(), "..");
}

async function getFindingSchemaValidator(): Promise<(data: unknown) => boolean> {
  if (findingSchemaValidator) {
    return findingSchemaValidator;
  }

  const schemaPath = path.join(getWorkspaceRoot(), "schema", "finding.schema.json");
  const schemaText = await fs.readFile(schemaPath, "utf8");
  const schema = JSON.parse(schemaText) as object;
  findingSchemaValidator = ajv.compile(schema);
  return findingSchemaValidator;
}

async function assertValidFindingSchema(record: EnrichedFinding): Promise<void> {
  const validate = await getFindingSchemaValidator();
  if (validate(record)) {
    return;
  }

  const errors = (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "<root>"} ${error.message ?? "schema error"}`)
    .join("; ");

  throw new ValidatorPipelineError(`Schema validation failed for enriched finding: ${errors}`, 500);
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hasReproScript(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("```") || (lower.includes("import torch") && lower.includes("torch."));
}

function getGitHubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "repo-analyzer-validator",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchGitHubJson<T>(apiPath: string): Promise<T> {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: getGitHubHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string") {
        detail = payload.message;
      }
    } catch {
      // ignore parse errors
    }

    const suffix = detail ? `: ${detail}` : "";
    throw new ValidatorPipelineError(`GitHub validator fetch failed (${response.status})${suffix}.`, response.status);
  }

  return (await response.json()) as T;
}

function detectSignalType(commentBody: string): MaintainerSignal["signal_type"] | null {
  const text = commentBody.toLowerCase();

  if (text.includes("@pytorchbot merge") || text.includes("merge this")) {
    return "requested_merge";
  }
  if (text.includes("approved") && text.includes("fix")) {
    return "approved_fix";
  }
  if (text.includes("no real way to fix") || text.includes("no way to act") || text.includes("not actionable")) {
    return "blocked_action";
  }
  if (text.includes("won't fix") || text.includes("wont fix") || text.includes("by design and won't")) {
    return "wont_fix";
  }
  if (text.includes("by design") || text.includes("intentional")) {
    return "by_design";
  }
  if (text.includes("minimal repro") || text.includes("needs repro") || text.includes("more details")) {
    return "needs_more_info";
  }
  if (text.includes("only happens") || text.includes("only on") || text.includes("scoped")) {
    return "scoped_bug";
  }
  if (text.includes("partial fix") || text.includes("fixes part")) {
    return "partial_fix";
  }

  return null;
}

function summarizeReviews(reviews: GitHubPrReview[]): string {
  const approvedBy = reviews
    .filter((review) => (review.state ?? "").toUpperCase() === "APPROVED")
    .map((review) => review.user?.login)
    .filter((login): login is string => Boolean(login));
  const changesRequestedBy = reviews
    .filter((review) => (review.state ?? "").toUpperCase() === "CHANGES_REQUESTED")
    .map((review) => review.user?.login)
    .filter((login): login is string => Boolean(login));

  if (approvedBy.length === 0 && changesRequestedBy.length === 0) {
    return "No explicit approvals or change requests recorded.";
  }

  const approvals = approvedBy.length > 0 ? `Approved by: ${approvedBy.join(", ")}.` : "No approvals.";
  const changes =
    changesRequestedBy.length > 0 ? ` Changes requested by: ${changesRequestedBy.join(", ")}.` : " No change requests.";
  return `${approvals}${changes}`;
}

function inferFixScope(raw: RawFinding, linkedPrs: LinkedPr[], maintainerSignals: MaintainerSignal[]): EnrichedFinding["fix_scope"] {
  if (maintainerSignals.some((signal) => signal.signal_type === "blocked_action")) {
    return "unknown";
  }

  const moduleLabels = raw.issue_labels.filter((label) => label.toLowerCase().startsWith("module:"));
  if (moduleLabels.length >= 3) {
    return "cross_cutting";
  }
  if (linkedPrs.some((pr) => pr.title.toLowerCase().includes("fix") && pr.title.toLowerCase().includes(" for "))) {
    return "single_function";
  }
  if (moduleLabels.length >= 1) {
    return "single_module";
  }
  return "unknown";
}

function inferAffectedHardware(raw: RawFinding, issueBody: string, comments: GitHubIssueComment[]): string[] {
  const out = new Set<string>();
  const blob = `${raw.issue_labels.join(" ")} ${issueBody} ${comments.map((comment) => comment.body ?? "").join(" ")}`.toLowerCase();

  if (blob.includes("module: cuda") || blob.includes(" cuda")) {
    out.add("cuda");
  }
  if (blob.includes("module: cpu") || blob.includes(" cpu")) {
    out.add("cpu");
  }
  if (blob.includes("module: mps") || blob.includes(" mps")) {
    out.add("mps");
  }
  if (blob.includes("module: rocm") || blob.includes(" rocm")) {
    out.add("rocm");
  }

  ["a100", "h100", "b200", "v100"].forEach((gpu) => {
    if (blob.includes(gpu)) {
      out.add(gpu.toUpperCase());
    }
  });

  return Array.from(out);
}

function inferStillReproducible(linkedPrs: LinkedPr[], reproPresent: boolean): EnrichedFinding["still_reproducible"] {
  if (linkedPrs.some((pr) => pr.merged)) {
    return "unlikely";
  }
  if (reproPresent) {
    return "likely";
  }
  return "unknown";
}

function hasHardBlocker(blockingSignals: string[]): boolean {
  return blockingSignals.some(
    (signal) =>
      signal.startsWith("maintainer_wont_fix:") ||
      signal.startsWith("maintainer_blocked_action:") ||
      signal.startsWith("already_fixed:"),
  );
}

function collectSanitySignals(input: {
  confidence: number;
  linkedPrs: LinkedPr[];
  maintainerSignals: MaintainerSignal[];
  fixScope: EnrichedFinding["fix_scope"];
  stillReproducible: EnrichedFinding["still_reproducible"];
}): string[] {
  const signals: string[] = [];

  if (input.confidence >= 0.9 && input.linkedPrs.length === 0 && input.maintainerSignals.length === 0) {
    signals.push("sanity_check: high_confidence_without_maintainer_or_pr_evidence");
  }

  if (input.confidence >= 0.9 && input.fixScope === "cross_cutting") {
    signals.push("sanity_check: very_high_confidence_with_cross_cutting_scope");
  }

  if (input.confidence >= 0.75 && input.stillReproducible === "unlikely") {
    signals.push("sanity_check: high_confidence_but_marked_unlikely_reproducible");
  }

  return signals;
}

function scoreConfidence(input: {
  raw: RawFinding;
  maintainerSignals: MaintainerSignal[];
  blockingSignals: string[];
  fixScope: EnrichedFinding["fix_scope"];
  stillReproducible: EnrichedFinding["still_reproducible"];
  reproScriptPresent: boolean;
}): { confidence: number; justification: string } {
  const steps: string[] = [];
  let score = 0.5;

  const apply = (reason: string, delta: number) => {
    score += delta;
    const sign = delta >= 0 ? "+" : "";
    steps.push(`${reason} -> ${sign}${delta.toFixed(2)}. Running total: ${score.toFixed(2)}.`);
  };

  if (input.raw.issue_labels.some((label) => label.toLowerCase() === "module: correctness (silent)")) {
    apply("module: correctness (silent) label", 0.25);
  }
  if (input.maintainerSignals.some((signal) => signal.signal_type === "approved_fix")) {
    apply("maintainer approved_fix signal", 0.2);
  }
  if (input.maintainerSignals.some((signal) => signal.signal_type === "requested_merge")) {
    apply("maintainer requested_merge signal", 0.2);
  }
  if (input.reproScriptPresent) {
    apply("repro script detected", 0.15);
  }
  if (input.raw.issue_labels.some((label) => label.toLowerCase() === "triaged")) {
    apply("triaged label", 0.1);
  }
  if (input.fixScope === "single_function" || input.fixScope === "single_file") {
    apply("fix scope is narrow", 0.1);
  }

  if (input.blockingSignals.some((signal) => signal.startsWith("maintainer_wont_fix:"))) {
    apply("maintainer_wont_fix blocking signal", -0.4);
  }
  if (input.blockingSignals.some((signal) => signal.startsWith("maintainer_blocked_action:"))) {
    apply("maintainer_blocked_action blocking signal", -0.4);
  }
  if (input.blockingSignals.some((signal) => signal.startsWith("pr_rejected:"))) {
    apply("pr_rejected blocking signal", -0.25);
  }
  if (input.blockingSignals.some((signal) => signal.startsWith("already_fixed:"))) {
    apply("already_fixed blocking signal", -0.45);
  }
  if (input.blockingSignals.some((signal) => signal.startsWith("scope_too_large:"))) {
    apply("scope_too_large blocking signal", -0.15);
  }
  if (input.stillReproducible === "unlikely") {
    apply("still_reproducible is unlikely", -0.1);
  }
  if (input.blockingSignals.some((signal) => signal.startsWith("stale_no_activity:"))) {
    apply("stale_no_activity blocking signal", -0.05);
  }
  if (input.raw.issue_labels.some((label) => label.toLowerCase() === "module: needs reproduction")) {
    apply("module: needs reproduction label", -0.05);
  }

  const clamped = clampConfidence(score);
  steps.push(`Final: ${clamped.toFixed(2)}.`);

  return {
    confidence: clamped,
    justification: steps.join("\n"),
  };
}

function chooseRecommendedAction(input: {
  confidence: number;
  blockingSignals: string[];
  linkedPrs: LinkedPr[];
  reproScriptPresent: boolean;
}): EnrichedFinding["recommended_action"] {
  if (hasHardBlocker(input.blockingSignals)) {
    return "reject";
  }

  const hasApprovedAbandonedPr = input.linkedPrs.some(
    (pr) => pr.state === "closed" && !pr.merged && pr.reviews_summary.toLowerCase().includes("approved"),
  );

  if (input.confidence >= 0.75 && hasApprovedAbandonedPr) {
    return "revive_abandoned_pr";
  }
  if (input.confidence >= 0.75 && !input.reproScriptPresent) {
    return "file_issue";
  }
  if (input.confidence >= 0.75) {
    return "file_pr";
  }
  if (input.confidence >= 0.4) {
    return "needs_human_review";
  }
  return "reject";
}

function chooseStage(confidence: number, blockingSignals: string[]): EnrichedFinding["stage"] {
  if (hasHardBlocker(blockingSignals) || confidence < 0.4) {
    return "rejected";
  }
  if (confidence >= 0.75) {
    return "validated";
  }
  return "needs_review";
}

function chooseGroundTruth(raw: RawFinding, hardBlocker: boolean): {
  closest: EnrichedFinding["closest_ground_truth"];
  delta: string;
} {
  if (raw.initial_classification === "ci_noise" || raw.initial_classification === "maintainer_task") {
    return {
      closest: "noise_76962",
      delta: "This finding matches CI or maintainer-task characteristics more than contributor-fixable bug signals.",
    };
  }

  if (hardBlocker) {
    return {
      closest: "ambiguous_72408",
      delta: "This finding has a hard blocker from maintainer or merge state, making it less actionable for contributors.",
    };
  }

  return {
    closest: "positive_71774",
    delta: "This finding resembles an actionable bug profile with no hard blocker and contributor-path viability.",
  };
}

async function loadRawFinding(findingId: string): Promise<{ finding: RawFinding; inputPath: string }> {
  const inputPath = path.join(getWorkspaceRoot(), "findings", "raw", `${findingId}.json`);
  const content = await fs.readFile(inputPath, "utf8");
  const finding = JSON.parse(content) as RawFinding;

  if (!finding.finding_id || finding.finding_id !== findingId) {
    throw new ValidatorPipelineError(`Raw finding id mismatch for ${findingId}.`, 400);
  }

  return { finding, inputPath };
}

async function collectMaintainerSignals(repo: string, issueNumber: number): Promise<{ signals: MaintainerSignal[]; comments: GitHubIssueComment[] }> {
  const comments = await fetchGitHubJson<GitHubIssueComment[]>(`/repos/${repo}/issues/${issueNumber}/comments?per_page=100`);

  const signals = comments
    .map((comment) => {
      const role = String(comment.author_association ?? "").toUpperCase();
      if (!MAINTAINER_ROLES.has(role)) {
        return null;
      }

      const body = String(comment.body ?? "").trim();
      if (!body) {
        return null;
      }

      const signalType = detectSignalType(body);
      if (!signalType) {
        return null;
      }

      return {
        author: String(comment.user?.login ?? "unknown"),
        role: role as MaintainerSignal["role"],
        signal_type: signalType,
        quote: body.slice(0, 200),
      } satisfies MaintainerSignal;
    })
    .filter((value): value is MaintainerSignal => value !== null);

  return { signals, comments };
}

async function collectLinkedPrs(repo: string, issueNumber: number): Promise<LinkedPr[]> {
  const search = await fetchGitHubJson<GitHubSearchResult>(`/search/issues?q=repo:${encodeURIComponent(repo)}+type:pr+${issueNumber}&per_page=20`);
  const prNumbers = (search.items ?? [])
    .map((item) => item.number)
    .filter((value): value is number => typeof value === "number");

  const uniqueNumbers = Array.from(new Set(prNumbers));

  const linkedPrs = await Promise.all(
    uniqueNumbers.map(async (prNumber) => {
      const pr = await fetchGitHubJson<GitHubPr>(`/repos/${repo}/pulls/${prNumber}`);
      const reviews = await fetchGitHubJson<GitHubPrReview[]>(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
      const merged = Boolean(pr.merged_at);
      const state = String(pr.state ?? "open").toLowerCase() === "closed" ? "closed" : "open";

      let abandonedReason: string | null = null;
      if (state === "closed" && !merged) {
        abandonedReason = "Closed without merge; review context did not confirm landing.";
      }

      return {
        number: pr.number,
        title: String(pr.title ?? `PR #${prNumber}`),
        url: String(pr.html_url ?? `https://github.com/${repo}/pull/${prNumber}`),
        state,
        merged,
        merged_at: pr.merged_at ?? null,
        abandoned_reason: abandonedReason,
        reviews_summary: summarizeReviews(reviews),
      } satisfies LinkedPr;
    }),
  );

  return linkedPrs;
}

function buildBlockingSignals(input: {
  maintainerSignals: MaintainerSignal[];
  linkedPrs: LinkedPr[];
  raw: RawFinding;
}): string[] {
  const out: string[] = [];

  const wontFixSignal = input.maintainerSignals.find((signal) => signal.signal_type === "wont_fix");
  if (wontFixSignal) {
    out.push(`maintainer_wont_fix: ${wontFixSignal.quote.slice(0, 120)}`);
  }

  const blockedSignal = input.maintainerSignals.find((signal) => signal.signal_type === "blocked_action");
  if (blockedSignal) {
    out.push(`maintainer_blocked_action: ${blockedSignal.quote.slice(0, 120)}`);
  }

  const mergedPr = input.linkedPrs.find((pr) => pr.merged);
  if (mergedPr) {
    out.push(`already_fixed: #${mergedPr.number} merged at ${mergedPr.merged_at ?? "unknown"}`);
    return out;
  }

  const hasMaintainerActivity = input.maintainerSignals.length > 0;
  const createdAtMs = Date.parse(input.raw.issue_created_at);
  const ageYears = Number.isNaN(createdAtMs) ? 0 : (Date.now() - createdAtMs) / (1000 * 60 * 60 * 24 * 365);
  if (ageYears >= 3 && !hasMaintainerActivity) {
    out.push(`stale_no_activity: ${Math.floor(ageYears)} years open, last maintainer comment never`);
  }

  return out;
}

export async function runValidator(findingId: string): Promise<ValidatorRunResult> {
  const { finding: rawFinding, inputPath } = await loadRawFinding(findingId);

  const [issue, maintainerData, linkedPrs] = await Promise.all([
    fetchGitHubJson<GitHubIssue>(`/repos/${rawFinding.repo}/issues/${rawFinding.issue_number}`),
    collectMaintainerSignals(rawFinding.repo, rawFinding.issue_number),
    collectLinkedPrs(rawFinding.repo, rawFinding.issue_number),
  ]);

  const issueBody = String(issue.body ?? "");
  const commentsText = maintainerData.comments.map((comment) => comment.body ?? "").join("\n");
  const reproScriptPresent = hasReproScript(`${rawFinding.body_preview}\n${issueBody}\n${commentsText}`);

  let blockingSignals = buildBlockingSignals({
    maintainerSignals: maintainerData.signals,
    linkedPrs,
    raw: rawFinding,
  });

  const fixScope = inferFixScope(rawFinding, linkedPrs, maintainerData.signals);
  const affectedHardware = inferAffectedHardware(rawFinding, issueBody, maintainerData.comments);
  const stillReproducible = inferStillReproducible(linkedPrs, reproScriptPresent);

  const { confidence, justification } = scoreConfidence({
    raw: rawFinding,
    maintainerSignals: maintainerData.signals,
    blockingSignals,
    fixScope,
    stillReproducible,
    reproScriptPresent,
  });

  const sanitySignals = collectSanitySignals({
    confidence,
    linkedPrs,
    maintainerSignals: maintainerData.signals,
    fixScope,
    stillReproducible,
  });

  if (sanitySignals.length > 0) {
    blockingSignals = [...blockingSignals, ...sanitySignals];
  }

  let recommendedAction = chooseRecommendedAction({
    confidence,
    blockingSignals,
    linkedPrs,
    reproScriptPresent,
  });

  let stage = chooseStage(confidence, blockingSignals);
  if (sanitySignals.length > 0 && !hasHardBlocker(blockingSignals)) {
    stage = "needs_review";
    recommendedAction = "needs_human_review";
  }

  const groundTruth = chooseGroundTruth(rawFinding, hasHardBlocker(blockingSignals));

  const enriched: EnrichedFinding = {
    finding_id: rawFinding.finding_id,
    repo: rawFinding.repo,
    issue_number: rawFinding.issue_number,
    issue_title: rawFinding.issue_title,
    issue_url: rawFinding.issue_url,
    issue_state: rawFinding.issue_state,
    issue_created_at: rawFinding.issue_created_at,
    issue_labels: rawFinding.issue_labels,
    body_preview: rawFinding.body_preview,
    initial_classification: rawFinding.initial_classification,
    surface_reasoning: rawFinding.surface_reasoning,
    linked_prs: linkedPrs,
    maintainer_signals: maintainerData.signals,
    blocking_signals: blockingSignals,
    fix_scope: fixScope,
    affected_hardware: affectedHardware,
    still_reproducible: stillReproducible,
    confidence,
    confidence_justification: justification,
    recommended_action: recommendedAction,
    closest_ground_truth: groundTruth.closest,
    ground_truth_delta: groundTruth.delta,
    stage,
    created_at: rawFinding.created_at ?? nowIso(),
    updated_at: nowIso(),
  };

  await assertValidFindingSchema(enriched);

  const targetDirName = stage === "validated" ? "validated" : stage === "needs_review" ? "needs_review" : "rejected";
  const outputPathAbs = path.join(getWorkspaceRoot(), "findings", targetDirName, `${findingId}.json`);

  await fs.mkdir(path.dirname(outputPathAbs), { recursive: true });
  await fs.writeFile(outputPathAbs, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");

  return {
    findingId,
    inputPath: path.relative(getWorkspaceRoot(), inputPath),
    outputPath: path.relative(getWorkspaceRoot(), outputPathAbs),
    stage,
    confidence,
    recommendedAction,
    blockingSignals,
    linkedPrCount: linkedPrs.length,
    maintainerSignalCount: maintainerData.signals.length,
  };
}
