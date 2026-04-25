"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type DryRunResponse = {
  ok: boolean;
  mode?: "deterministic" | "claude-cli" | "claude-api";
  repo?: string;
  maxIssues?: number;
  fetched?: number;
  uniqueLabels?: number;
  candidatesAfterPrefilter?: number;
  rejected?: number;
  previewPath?: string;
  estimatedTokens?: number;
  previewText?: string;
  timingsMs?: {
    fetch: number;
    prefilter: number;
    serialize: number;
    total: number;
  };
  claude?: {
    requested: boolean;
    enabled: boolean;
    status: "disabled" | "not_implemented" | "cli";
    reason: string;
    model?: string;
    maxOutputTokens?: number;
    estimatedMaxTotalTokens?: number;
    estimatedInputTokens?: number | null;
    actualInputTokens?: number | null;
    estimatedOutputTokens?: number | null;
    actualOutputTokens?: number | null;
    actualTotalTokens?: number | null;
    durationMs?: number | null;
    outputText?: string | null;
  };
  error?: string;
};

type ValidatorResponse = {
  ok: boolean;
  findingId?: string;
  inputPath?: string;
  outputPath?: string;
  stage?: "validated" | "needs_review" | "rejected";
  confidence?: number;
  recommendedAction?: "file_pr" | "file_issue" | "revive_abandoned_pr" | "needs_human_review" | "reject";
  blockingSignals?: string[];
  linkedPrCount?: number;
  maintainerSignalCount?: number;
  error?: string;
};

type PresentedFinding = {
  findingId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  stage: "validated" | "needs_review" | "rejected";
  confidence: number | null;
  confidenceLabel: "High" | "Medium" | "Low" | "Unknown";
  actionNow: string;
  whyThisMatters: string;
  keyEvidence: string[];
  blockers: string[];
  updatedAt: string | null;
};

type FindingsListResponse = {
  ok: boolean;
  items?: PresentedFinding[];
  total?: number;
  byStage?: {
    validated: number;
    needs_review: number;
    rejected: number;
  };
  error?: string;
};

type FindingsSummaryPayload = {
  generatedAt: string;
  total: number;
  byStage: {
    validated: number;
    needs_review: number;
    rejected: number;
  };
  confidenceBands: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  actionCounts: {
    file_pr: number;
    file_issue: number;
    revive_abandoned_pr: number;
    needs_human_review: number;
    reject: number;
    unknown: number;
  };
  topActionable: Array<{
    findingId: string;
    issueNumber: number;
    issueTitle: string;
    issueUrl: string;
    confidence: number | null;
    stage: "validated" | "needs_review";
    actionNow: string;
  }>;
  commonBlockers: Array<{
    blocker: string;
    count: number;
  }>;
};

type FindingsSummaryResponse = {
  ok: boolean;
  summary?: FindingsSummaryPayload;
  error?: string;
};

export default function Home() {
  const maxAdditionalInstructionsChars = 800;
  const [repo, setRepo] = useState("pytorch/pytorch");
  const [maxIssues, setMaxIssues] = useState(50);
  const [findingId, setFindingId] = useState("pytorch_113956");
  const [useClaude, setUseClaude] = useState(false);
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [validatorLoading, setValidatorLoading] = useState(false);
  const [result, setResult] = useState<DryRunResponse | null>(null);
  const [validatorResult, setValidatorResult] = useState<ValidatorResponse | null>(null);
  const [surfaceLastSuccessAt, setSurfaceLastSuccessAt] = useState<string | null>(null);
  const [findingsLoading, setFindingsLoading] = useState(true);
  const [findingsResult, setFindingsResult] = useState<FindingsListResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryResult, setSummaryResult] = useState<FindingsSummaryResponse | null>(null);
  const surfaceReady = Boolean(result?.ok);
  const surfaceLastSuccessLabel = surfaceLastSuccessAt ? new Date(surfaceLastSuccessAt).toLocaleString() : "Not run yet";

  async function refreshFindingsData() {
    setFindingsLoading(true);
    setSummaryLoading(true);
    try {
      const [listResponse, summaryResponse] = await Promise.all([
        fetch("/api/findings/list?limit=30"),
        fetch("/api/findings/summary"),
      ]);
      const [listJson, summaryJson] = (await Promise.all([
        listResponse.json(),
        summaryResponse.json(),
      ])) as [FindingsListResponse, FindingsSummaryResponse];

      setFindingsResult(listJson);
      setSummaryResult(summaryJson);
    } catch {
      setFindingsResult({ ok: false, error: "Failed to load findings list." });
      setSummaryResult({ ok: false, error: "Failed to load findings summary." });
    } finally {
      setFindingsLoading(false);
      setSummaryLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadInitialFindingsData() {
      try {
        const [listResponse, summaryResponse] = await Promise.all([
          fetch("/api/findings/list?limit=30"),
          fetch("/api/findings/summary"),
        ]);
        const [listJson, summaryJson] = (await Promise.all([
          listResponse.json(),
          summaryResponse.json(),
        ])) as [FindingsListResponse, FindingsSummaryResponse];

        if (!active) {
          return;
        }

        setFindingsResult(listJson);
        setSummaryResult(summaryJson);
      } catch {
        if (!active) {
          return;
        }
        setFindingsResult({ ok: false, error: "Failed to load findings list." });
        setSummaryResult({ ok: false, error: "Failed to load findings summary." });
      } finally {
        if (!active) {
          return;
        }
        setFindingsLoading(false);
        setSummaryLoading(false);
      }
    }

    void loadInitialFindingsData();

    return () => {
      active = false;
    };
  }, []);

  const summaryLines = useMemo(() => {
    if (!result?.ok) {
      return [];
    }

    return [
      `Repo: ${result.repo}`,
      `Max issues: ${result.maxIssues}`,
      `Fetched: ${result.fetched}`,
      `Unique labels: ${result.uniqueLabels}`,
      `Candidates after prefilter: ${result.candidatesAfterPrefilter}`,
      `Rejected: ${result.rejected}`,
      `Surface input preview saved: ${result.previewPath}`,
      `Estimated Claude input tokens: ${result.estimatedTokens?.toLocaleString()}`,
      `Estimated Claude output token cap: ${result.claude?.maxOutputTokens?.toLocaleString() ?? "n/a"}`,
      `Estimated Claude max total tokens: ${result.claude?.estimatedMaxTotalTokens?.toLocaleString() ?? "n/a"}`,
      `Claude CLI estimated input tokens: ${result.claude?.estimatedInputTokens?.toLocaleString() ?? "n/a"}`,
      `Claude CLI estimated output tokens: ${result.claude?.estimatedOutputTokens?.toLocaleString() ?? "n/a"}`,
      `Actual Claude input tokens: ${result.claude?.actualInputTokens?.toLocaleString() ?? "n/a"}`,
      `Actual Claude output tokens: ${result.claude?.actualOutputTokens?.toLocaleString() ?? "n/a"}`,
      `Actual Claude total tokens: ${result.claude?.actualTotalTokens?.toLocaleString() ?? "n/a"}`,
      `Claude run duration: ${result.claude?.durationMs ?? "n/a"}ms`,
      `Timing (total): ${result.timingsMs?.total ?? 0}ms`,
      `Pipeline mode: ${result.mode ?? "deterministic"}`,
      `Claude status: ${result.claude?.status ?? "disabled"}`,
      `Claude note: ${result.claude?.reason ?? "Claude call: disabled"}`,
    ];
  }, [result]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/surface/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // Optional extra constraints for Claude CLI/API prompt shaping.
        body: JSON.stringify({ repo, maxIssues, useClaude, additionalInstructions }),
      });

      const json = (await response.json()) as DryRunResponse;
      setResult(json);
      if (json.ok) {
        setSurfaceLastSuccessAt(new Date().toISOString());
      }
    } catch {
      setResult({ ok: false, error: "Failed to call dry-run endpoint." });
    } finally {
      setLoading(false);
    }
  }

  async function onRunValidator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidatorLoading(true);
    setValidatorResult(null);

    try {
      const response = await fetch("/api/validator/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ findingId }),
      });

      const json = (await response.json()) as ValidatorResponse;
      setValidatorResult(json);
      if (json.ok) {
        await refreshFindingsData();
      }
    } catch {
      setValidatorResult({ ok: false, error: "Failed to call validator endpoint." });
    } finally {
      setValidatorLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-100 px-6 py-8 text-zinc-900">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">Surface Dry-Run</h1>

        <section className="grid gap-2 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Workflow</h2>
          <div className="flex items-center gap-2 text-sm">
            <span className={`rounded-full px-2 py-1 text-xs font-medium ${surfaceReady ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-700"}`}>
              {surfaceReady ? "Surface complete" : "Surface pending"}
            </span>
            <span className="text-zinc-600">Last successful run: {surfaceLastSuccessLabel}</span>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-700">
            <li>Run Surface analysis first.</li>
            <li>Confirm Surface completed successfully.</li>
            <li>Run Validator on a finding ID.</li>
          </ol>
          <p className="text-xs text-zinc-500">
            Validator is enabled only after Surface succeeds in this session.
          </p>
        </section>

        <form onSubmit={onSubmit} className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <label className="grid gap-1">
            <span className="text-sm font-medium">Repository</span>
            <input
              id="repo"
              type="text"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repo or GitHub URL"
              className="rounded-md border border-zinc-300 px-3 py-2 outline-none ring-zinc-300 focus:ring-2"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Max issues</span>
            <input
              id="maxIssues"
              type="number"
              min={1}
              max={500} // set to 500 for larger scale runs, and set to 1000 for full data dumps (note: Claude token limits may require smaller batches)
              value={maxIssues}
              onChange={(event) => setMaxIssues(Number(event.target.value) || 50)}
              className="w-40 rounded-md border border-zinc-300 px-3 py-2 outline-none ring-zinc-300 focus:ring-2"
            />
          </label>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              id="useClaude"
              type="checkbox"
              checked={useClaude}
              onChange={(event) => setUseClaude(event.target.checked)}
              className="h-4 w-4"
            />
            Request Claude path
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Additional constraints/instructions for Claude</span>
            <textarea
              id="additionalInstructions"
              value={additionalInstructions}
              onChange={(event) => {
                const value = event.target.value;
                setAdditionalInstructions(value.slice(0, maxAdditionalInstructionsChars));
              }}
              maxLength={maxAdditionalInstructionsChars}
              rows={4}
              placeholder="Example: prioritize CUDA correctness bugs with reproducible steps; keep suggestions under 5 bullets."
              className="rounded-md border border-zinc-300 px-3 py-2 outline-none ring-zinc-300 focus:ring-2"
            />
            <span className="text-xs text-zinc-500">
              {additionalInstructions.length}/{maxAdditionalInstructionsChars} characters
            </span>
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-fit rounded-md bg-zinc-900 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Running..." : "Run surface analysis"}
          </button>
        </form>

        {result?.ok && (
          <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Summary</h2>
            <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 text-sm">{summaryLines.join("\n")}</pre>
            <h3 className="text-base font-semibold">Surface Input Preview</h3>
            <pre className="max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 text-xs leading-relaxed">{result.previewText}</pre>
            <h3 className="text-base font-semibold">Phase Timings</h3>
            <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 text-sm">
{`fetch: ${result.timingsMs?.fetch ?? 0}ms
prefilter: ${result.timingsMs?.prefilter ?? 0}ms
serialize: ${result.timingsMs?.serialize ?? 0}ms
total: ${result.timingsMs?.total ?? 0}ms`}
            </pre>
            {result.claude?.outputText && (
              <>
                <h3 className="text-base font-semibold">Claude Output</h3>
                <pre className="max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 text-xs leading-relaxed">{result.claude.outputText}</pre>
              </>
            )}
          </section>
        )}

        {result && !result.ok && (
          <section className="rounded-xl border border-red-300 bg-red-50 p-4 text-red-700">
            {result.error ?? "Unknown error."}
          </section>
        )}

        <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Validator</h2>
          <p className="text-sm text-zinc-600">
            Status: {surfaceReady ? "Ready" : "Locked - run Surface first"}
            {surfaceReady ? ` (surface passed at ${surfaceLastSuccessLabel})` : ""}
          </p>
          <form onSubmit={onRunValidator} className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-sm font-medium">Finding ID</span>
              <input
                id="findingId"
                type="text"
                value={findingId}
                onChange={(event) => setFindingId(event.target.value)}
                placeholder="pytorch_113956"
                className="rounded-md border border-zinc-300 px-3 py-2 outline-none ring-zinc-300 focus:ring-2"
              />
            </label>

            <button
              type="submit"
              disabled={validatorLoading || !surfaceReady || findingId.trim().length === 0}
              className="w-fit rounded-md bg-zinc-900 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {validatorLoading ? "Running validator..." : surfaceReady ? "Run validator" : "Run Surface first"}
            </button>
          </form>

          {validatorResult?.ok && (
            <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 text-sm">
{`Finding ID: ${validatorResult.findingId}
Input file: ${validatorResult.inputPath}
Output file: ${validatorResult.outputPath}
Stage: ${validatorResult.stage}
Confidence: ${validatorResult.confidence}
Recommended action: ${validatorResult.recommendedAction}
Linked PRs: ${validatorResult.linkedPrCount}
Maintainer signals: ${validatorResult.maintainerSignalCount}
Blocking signals: ${(validatorResult.blockingSignals ?? []).join(" | ") || "none"}`}
            </pre>
          )}

          {validatorResult && !validatorResult.ok && (
            <section className="rounded-md border border-red-300 bg-red-50 p-3 text-red-700">
              {validatorResult.error ?? "Unknown validator error."}
            </section>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Findings (User View)</h2>
          {findingsLoading && <p className="text-sm text-zinc-600">Loading findings...</p>}

          {findingsResult?.ok && (
            <>
              <p className="text-sm text-zinc-600">
                Showing {findingsResult.items?.length ?? 0} of {findingsResult.total ?? 0} findings. Stage counts: validated {findingsResult.byStage?.validated ?? 0}, needs_review {findingsResult.byStage?.needs_review ?? 0}, rejected {findingsResult.byStage?.rejected ?? 0}.
              </p>

              <div className="grid gap-3">
                {(findingsResult.items ?? []).map((item, index) => (
                  <article key={`${item.findingId}-${item.stage}-${item.updatedAt ?? "na"}-${index}`} className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={item.issueUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-zinc-900 underline">
                        #{item.issueNumber} {item.issueTitle}
                      </a>
                      <span className="rounded-full bg-zinc-200 px-2 py-1 text-xs uppercase tracking-wide text-zinc-700">{item.stage}</span>
                      <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs uppercase tracking-wide text-emerald-800">
                        Confidence {item.confidenceLabel}
                      </span>
                    </div>

                    <p className="text-sm text-zinc-700">{item.whyThisMatters}</p>
                    <p className="text-sm font-medium text-zinc-900">Action now: {item.actionNow}</p>

                    <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-700">
                      {item.keyEvidence.map((evidence) => (
                        <li key={`${item.findingId}-${evidence}`}>{evidence}</li>
                      ))}
                    </ul>

                    {item.blockers.length > 0 && (
                      <p className="text-xs text-amber-800">Blockers: {item.blockers.join(" | ")}</p>
                    )}

                    <p className="text-xs text-zinc-500">Updated: {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "Unknown"}</p>
                  </article>
                ))}
              </div>
            </>
          )}

          {findingsResult && !findingsResult.ok && (
            <section className="rounded-md border border-red-300 bg-red-50 p-3 text-red-700">
              {findingsResult.error ?? "Unknown findings error."}
            </section>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Findings Summary</h2>
          <p className="text-sm text-zinc-600">
            <a className="underline" href="/api/findings/report" target="_blank" rel="noreferrer">
              Open markdown export
            </a>
          </p>
          {summaryLoading && <p className="text-sm text-zinc-600">Loading summary...</p>}

          {summaryResult?.ok && summaryResult.summary && (
            <>
              <p className="text-sm text-zinc-600">
                Generated: {new Date(summaryResult.summary.generatedAt).toLocaleString()}.
              </p>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md bg-zinc-50 p-3 text-sm">
                  <p className="text-zinc-500">Total findings</p>
                  <p className="text-lg font-semibold">{summaryResult.summary.total}</p>
                </div>
                <div className="rounded-md bg-zinc-50 p-3 text-sm">
                  <p className="text-zinc-500">Validated</p>
                  <p className="text-lg font-semibold">{summaryResult.summary.byStage.validated}</p>
                </div>
                <div className="rounded-md bg-zinc-50 p-3 text-sm">
                  <p className="text-zinc-500">Needs review</p>
                  <p className="text-lg font-semibold">{summaryResult.summary.byStage.needs_review}</p>
                </div>
                <div className="rounded-md bg-zinc-50 p-3 text-sm">
                  <p className="text-zinc-500">Rejected</p>
                  <p className="text-lg font-semibold">{summaryResult.summary.byStage.rejected}</p>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <article className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <h3 className="text-sm font-semibold">Confidence Distribution</h3>
                  <p className="mt-2 text-sm text-zinc-700">
                    High: {summaryResult.summary.confidenceBands.high} | Medium: {summaryResult.summary.confidenceBands.medium} | Low: {summaryResult.summary.confidenceBands.low} | Unknown: {summaryResult.summary.confidenceBands.unknown}
                  </p>
                </article>

                <article className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <h3 className="text-sm font-semibold">Action Mix</h3>
                  <p className="mt-2 text-sm text-zinc-700">
                    file_pr: {summaryResult.summary.actionCounts.file_pr} | file_issue: {summaryResult.summary.actionCounts.file_issue} | revive_abandoned_pr: {summaryResult.summary.actionCounts.revive_abandoned_pr} | needs_human_review: {summaryResult.summary.actionCounts.needs_human_review} | reject: {summaryResult.summary.actionCounts.reject}
                  </p>
                </article>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <article className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <h3 className="text-sm font-semibold">Top Actionable</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700">
                    {summaryResult.summary.topActionable.map((item, index) => (
                      <li key={`${item.findingId}-${item.stage}-${item.issueNumber}-${index}`}>
                        <a href={item.issueUrl} target="_blank" rel="noreferrer" className="underline">
                          #{item.issueNumber} {item.issueTitle}
                        </a>
                        {` (${item.stage}, confidence ${item.confidence ?? "n/a"}) - ${item.actionNow}`}
                      </li>
                    ))}
                    {summaryResult.summary.topActionable.length === 0 && <li>No actionable findings yet.</li>}
                  </ul>
                </article>

                <article className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <h3 className="text-sm font-semibold">Common Blockers</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700">
                    {summaryResult.summary.commonBlockers.map((item) => (
                      <li key={item.blocker}>
                        {item.blocker}: {item.count}
                      </li>
                    ))}
                    {summaryResult.summary.commonBlockers.length === 0 && <li>No blocker trends yet.</li>}
                  </ul>
                </article>
              </div>
            </>
          )}

          {summaryResult && !summaryResult.ok && (
            <section className="rounded-md border border-red-300 bg-red-50 p-3 text-red-700">
              {summaryResult.error ?? "Unknown summary error."}
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
