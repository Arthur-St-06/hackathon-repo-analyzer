export type IssueMetadata = {
  number: number;
  title: string;
  labels: string[];
  state: "OPEN" | "CLOSED" | string;
  createdAt: string;
  url: string;
};

export type PrefilterResult = {
  candidates: IssueMetadata[];
  rejected: IssueMetadata[];
};

export type DryRunResult = {
  repo: string;
  maxIssues: number;
  fetched: number;
  uniqueLabels: number;
  candidatesAfterPrefilter: number;
  rejected: number;
  previewPath: string;
  estimatedTokens: number;
  previewText: string;
  timingsMs: {
    fetch: number;
    prefilter: number;
    serialize: number;
    total: number;
  };
};
