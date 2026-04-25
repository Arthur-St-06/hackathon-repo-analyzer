#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "data/pytorch_open_issues_50_metadata.json";
const DEFAULT_CANDIDATES = "data/candidates.json";
const DEFAULT_REJECTED = "data/rejected.json";

const args = process.argv.slice(2);
const inputPath = args[0] ?? DEFAULT_INPUT;
const candidatesPath = args[1] ?? DEFAULT_CANDIDATES;
const rejectedPath = args[2] ?? DEFAULT_REJECTED;

const LABEL_SIGNALS = [
  "bug",
  "correctness",
  "regression",
  "performance",
  "crash",
  "high priority",
  "actionable",
];

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

function normalizeText(value) {
  return String(value ?? "").toLowerCase();
}

function isOpenIssue(issue) {
  return normalizeText(issue.state) === "open";
}

function startsWithDisabledTitle(issue) {
  const title = String(issue.title ?? "").trimStart().toLowerCase();
  return title.startsWith("disabled");
}

function hasSkippedLabel(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return labels.some((label) => normalizeText(label).includes("skipped"));
}

function isLikelyBug(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const title = normalizeText(issue.title);

  const labelMatch = labels.some((label) => {
    const normalizedLabel = normalizeText(label);
    return LABEL_SIGNALS.some((signal) => normalizedLabel.includes(signal));
  });

  const titleMatch = TITLE_SIGNALS.some((signal) => title.includes(signal));

  return labelMatch || titleMatch;
}

function evaluateIssue(issue) {
  if (!isOpenIssue(issue)) {
    return { keep: false, reason: "non_open" };
  }

  if (startsWithDisabledTitle(issue)) {
    return { keep: false, reason: "disabled_title" };
  }

  if (hasSkippedLabel(issue)) {
    return { keep: false, reason: "skipped_label" };
  }

  if (isLikelyBug(issue)) {
    return { keep: true };
  }

  return { keep: false, reason: "no_bug_signal" };
}

async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function main() {
  const raw = await fs.readFile(inputPath, "utf8");
  const issues = JSON.parse(raw);

  if (!Array.isArray(issues)) {
    throw new Error("Input JSON must be an array of issue metadata objects.");
  }

  const candidates = [];
  const rejected = [];

  for (const issue of issues) {
    const decision = evaluateIssue(issue);

    if (decision.keep) {
      candidates.push(issue);
      continue;
    }

    rejected.push({
      ...issue,
      rejectReason: decision.reason,
    });
  }

  await ensureParentDir(candidatesPath);
  await ensureParentDir(rejectedPath);

  await fs.writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8");
  await fs.writeFile(rejectedPath, `${JSON.stringify(rejected, null, 2)}\n`, "utf8");

  console.log(`total fetched: ${issues.length}`);
  console.log(`total candidates: ${candidates.length}`);
  console.log(`total rejected: ${rejected.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
