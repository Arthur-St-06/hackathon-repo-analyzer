export type RawFinding = {
  finding_id: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  issue_state: "OPEN" | "CLOSED" | string;
  issue_created_at: string;
  issue_labels: string[];
  body_preview: string;
  initial_classification:
    | "correctness_silent"
    | "performance_regression"
    | "missing_fast_path"
    | "ci_noise"
    | "maintainer_task"
    | "unknown"
    | string;
  surface_reasoning: string;
  stage: "raw" | "enriched" | "validated" | "needs_review" | "rejected";
  linked_prs?: unknown;
  maintainer_signals?: unknown;
  blocking_signals?: unknown;
  fix_scope?: unknown;
  affected_hardware?: unknown;
  still_reproducible?: unknown;
  confidence?: unknown;
  confidence_justification?: unknown;
  recommended_action?: unknown;
  closest_ground_truth?: unknown;
  ground_truth_delta?: unknown;
  created_at?: string;
  updated_at?: string;
};

export type MaintainerSignal = {
  author: string;
  role: "COLLABORATOR" | "MEMBER" | "OWNER";
  signal_type:
    | "approved_fix"
    | "requested_merge"
    | "blocked_action"
    | "wont_fix"
    | "by_design"
    | "needs_more_info"
    | "scoped_bug"
    | "partial_fix";
  quote: string;
};

export type LinkedPr = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  abandoned_reason: string | null;
  reviews_summary: string;
};

export type EnrichedFinding = Omit<RawFinding, "linked_prs" | "maintainer_signals" | "blocking_signals" | "fix_scope" | "affected_hardware" | "still_reproducible" | "confidence" | "confidence_justification" | "recommended_action" | "closest_ground_truth" | "ground_truth_delta" | "updated_at" | "stage"> & {
  linked_prs: LinkedPr[];
  maintainer_signals: MaintainerSignal[];
  blocking_signals: string[];
  fix_scope: "single_function" | "single_file" | "single_module" | "cross_cutting" | "requires_external_lib" | "unknown";
  affected_hardware: string[];
  still_reproducible: "confirmed" | "likely" | "unknown" | "unlikely";
  confidence: number;
  confidence_justification: string;
  recommended_action: "file_pr" | "file_issue" | "revive_abandoned_pr" | "needs_human_review" | "reject";
  closest_ground_truth: "positive_71774" | "noise_76962" | "ambiguous_72408";
  ground_truth_delta: string;
  stage: "validated" | "needs_review" | "rejected";
  updated_at: string;
};

export type ValidatorRunResult = {
  findingId: string;
  inputPath: string;
  outputPath: string;
  stage: "validated" | "needs_review" | "rejected";
  confidence: number;
  recommendedAction: "file_pr" | "file_issue" | "revive_abandoned_pr" | "needs_human_review" | "reject";
  blockingSignals: string[];
  linkedPrCount: number;
  maintainerSignalCount: number;
};
