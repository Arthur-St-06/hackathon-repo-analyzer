import { getPresentedFindings, PresentedFinding } from "@/lib/findings/presenter";

export type FindingsSummaryResult = {
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

function blockerBucket(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    return trimmed.toLowerCase();
  }
  return trimmed.slice(0, separator).trim().toLowerCase();
}

function compareActionable(a: PresentedFinding, b: PresentedFinding): number {
  const aConfidence = typeof a.confidence === "number" ? a.confidence : -1;
  const bConfidence = typeof b.confidence === "number" ? b.confidence : -1;
  if (bConfidence !== aConfidence) {
    return bConfidence - aConfidence;
  }

  const aUpdated = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bUpdated = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return bUpdated - aUpdated;
}

export async function getFindingsSummary(): Promise<FindingsSummaryResult> {
  const presented = await getPresentedFindings(200);
  const items = presented.items;

  const confidenceBands = {
    high: items.filter((item) => item.confidenceLabel === "High").length,
    medium: items.filter((item) => item.confidenceLabel === "Medium").length,
    low: items.filter((item) => item.confidenceLabel === "Low").length,
    unknown: items.filter((item) => item.confidenceLabel === "Unknown").length,
  };

  const actionCounts: FindingsSummaryResult["actionCounts"] = {
    file_pr: 0,
    file_issue: 0,
    revive_abandoned_pr: 0,
    needs_human_review: 0,
    reject: 0,
    unknown: 0,
  };

  for (const item of items) {
    switch (item.recommendedAction) {
      case "file_pr":
        actionCounts.file_pr += 1;
        break;
      case "file_issue":
        actionCounts.file_issue += 1;
        break;
      case "revive_abandoned_pr":
        actionCounts.revive_abandoned_pr += 1;
        break;
      case "needs_human_review":
        actionCounts.needs_human_review += 1;
        break;
      case "reject":
        actionCounts.reject += 1;
        break;
      default:
        actionCounts.unknown += 1;
        break;
    }
  }

  const blockerCounts = new Map<string, number>();
  for (const item of items) {
    for (const blocker of item.blockers) {
      const key = blockerBucket(blocker);
      blockerCounts.set(key, (blockerCounts.get(key) ?? 0) + 1);
    }
  }

  const commonBlockers = Array.from(blockerCounts.entries())
    .map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const topActionable = items
    .filter((item) => item.stage !== "rejected")
    .sort(compareActionable)
    .slice(0, 5)
    .map((item) => ({
      findingId: item.findingId,
      issueNumber: item.issueNumber,
      issueTitle: item.issueTitle,
      issueUrl: item.issueUrl,
      confidence: item.confidence,
      stage: item.stage,
      actionNow: item.actionNow,
    }));

  return {
    generatedAt: new Date().toISOString(),
    total: presented.total,
    byStage: presented.byStage,
    confidenceBands,
    actionCounts,
    topActionable,
    commonBlockers,
  };
}
