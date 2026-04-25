import fs from "node:fs/promises";
import path from "node:path";

type FindingStage = "validated" | "needs_review" | "rejected";

type RawFindingRecord = {
  finding_id: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  issue_labels?: string[];
  surface_reasoning?: string;
  recommended_action?: string;
  confidence?: number;
  still_reproducible?: string;
  blocking_signals?: string[];
  linked_prs?: unknown[];
  updated_at?: string;
};

export type PresentedFinding = {
  findingId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  stage: FindingStage;
  confidence: number | null;
  confidenceLabel: "High" | "Medium" | "Low" | "Unknown";
  recommendedAction: string | null;
  actionNow: string;
  whyThisMatters: string;
  keyEvidence: string[];
  blockers: string[];
  updatedAt: string | null;
};

export type FindingsPresentationResult = {
  items: PresentedFinding[];
  total: number;
  byStage: {
    validated: number;
    needs_review: number;
    rejected: number;
  };
};

function getWorkspaceRoot(): string {
  return path.resolve(process.cwd(), "..");
}

function toConfidenceLabel(value: number | null): PresentedFinding["confidenceLabel"] {
  if (value === null || Number.isNaN(value)) {
    return "Unknown";
  }
  if (value >= 0.75) {
    return "High";
  }
  if (value >= 0.4) {
    return "Medium";
  }
  return "Low";
}

function toActionNow(action: string | undefined): string {
  switch (action) {
    case "file_pr":
      return "Draft a fix PR.";
    case "file_issue":
      return "Open or refine issue scope before coding.";
    case "revive_abandoned_pr":
      return "Revive and finish an abandoned PR path.";
    case "needs_human_review":
      return "Escalate to human triage for decision.";
    case "reject":
      return "Do not pursue for contributor work right now.";
    default:
      return "No recommended action yet.";
  }
}

function summarizeWhyThisMatters(record: RawFindingRecord): string {
  const reasoning = String(record.surface_reasoning ?? "").trim();
  if (reasoning) {
    return reasoning;
  }
  return "Validator finding with limited reasoning text.";
}

function buildEvidence(record: RawFindingRecord): string[] {
  const evidence: string[] = [];
  const labels = Array.isArray(record.issue_labels) ? record.issue_labels : [];
  const topLabels = labels.slice(0, 3);
  if (topLabels.length > 0) {
    evidence.push(`Top labels: ${topLabels.join(", ")}`);
  }

  const repro = String(record.still_reproducible ?? "unknown");
  evidence.push(`Repro status: ${repro}`);

  const linkedPrCount = Array.isArray(record.linked_prs) ? record.linked_prs.length : 0;
  evidence.push(`Linked PRs: ${linkedPrCount}`);

  return evidence;
}

function presentRecord(record: RawFindingRecord, stage: FindingStage): PresentedFinding {
  const confidence = typeof record.confidence === "number" ? record.confidence : null;

  return {
    findingId: record.finding_id,
    repo: record.repo,
    issueNumber: record.issue_number,
    issueTitle: record.issue_title,
    issueUrl: record.issue_url,
    stage,
    confidence,
    confidenceLabel: toConfidenceLabel(confidence),
    recommendedAction: typeof record.recommended_action === "string" ? record.recommended_action : null,
    actionNow: toActionNow(record.recommended_action),
    whyThisMatters: summarizeWhyThisMatters(record),
    keyEvidence: buildEvidence(record),
    blockers: Array.isArray(record.blocking_signals) ? record.blocking_signals : [],
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

async function readStageFindings(stage: FindingStage): Promise<PresentedFinding[]> {
  const dirPath = path.join(getWorkspaceRoot(), "findings", stage);
  const fileNames = await fs.readdir(dirPath);

  const items = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) => {
        const fullPath = path.join(dirPath, fileName);
        const text = await fs.readFile(fullPath, "utf8");
        const record = JSON.parse(text) as RawFindingRecord;
        return presentRecord(record, stage);
      }),
  );

  return items;
}

function sortByUpdated(items: PresentedFinding[]): PresentedFinding[] {
  return [...items].sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });
}

function stageRank(stage: FindingStage): number {
  switch (stage) {
    case "needs_review":
      return 3;
    case "validated":
      return 2;
    case "rejected":
      return 1;
    default:
      return 0;
  }
}

function dedupeByFindingId(items: PresentedFinding[]): PresentedFinding[] {
  const byId = new Map<string, PresentedFinding>();

  for (const item of items) {
    const existing = byId.get(item.findingId);
    if (!existing) {
      byId.set(item.findingId, item);
      continue;
    }

    const existingTime = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
    const incomingTime = item.updatedAt ? Date.parse(item.updatedAt) : 0;

    if (incomingTime > existingTime) {
      byId.set(item.findingId, item);
      continue;
    }

    if (incomingTime === existingTime && stageRank(item.stage) > stageRank(existing.stage)) {
      byId.set(item.findingId, item);
    }
  }

  return Array.from(byId.values());
}

export async function getPresentedFindings(limit = 25): Promise<FindingsPresentationResult> {
  const [validated, needsReview, rejected] = await Promise.all([
    readStageFindings("validated"),
    readStageFindings("needs_review"),
    readStageFindings("rejected"),
  ]);

  const all = sortByUpdated(dedupeByFindingId([...validated, ...needsReview, ...rejected]));
  const safeLimit = Math.max(1, Math.min(200, Number(limit || 25)));
  const items = all.slice(0, safeLimit);

  const byStage = {
    validated: all.filter((item) => item.stage === "validated").length,
    needs_review: all.filter((item) => item.stage === "needs_review").length,
    rejected: all.filter((item) => item.stage === "rejected").length,
  };

  return {
    items,
    total: all.length,
    byStage,
  };
}
