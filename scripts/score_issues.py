#!/usr/bin/env python3
"""
score_issues.py — Score and rank open issues by fix likelihood.

Reads:  data/selected_topics.json   — user's topic selection
        data/corpus_full.json       — issue index (title + labels + dates, no body)
Writes: data/scored_issues.json     — ranked issues with scores and feature flags

Two-pass approach:
  Pass 1 (corpus, no API): apply exclusion rules + label-only pre-score
  Pass 2 (GitHub API):     fetch body+comments for top-N candidates in parallel, re-score

Usage:
  python3 scripts/score_issues.py [--repo pytorch/pytorch] [--top N]
"""

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT   = Path(__file__).parent.parent
SEL_FILE    = REPO_ROOT / "data" / "selected_topics.json"
CORPUS_FILE = REPO_ROOT / "data" / "corpus_full.json"
OUT_FILE    = REPO_ROOT / "data" / "scored_issues.json"

HIGH_TRUST = {"COLLABORATOR", "MEMBER", "OWNER"}

BOT_AUTHORS = {
    "pytorch-bot", "facebook-github-bot", "pytorchmergebot",
    "pytorch-probot", "github-actions", "codecov",
}

DEFAULT_TOP_N   = 150   # fetch full body+comments for top N pre-scored issues
FETCH_WORKERS   = 20    # parallel gh issue view calls

_MPS_BACKENDS = {"module: cuda", "module: cpu", "module: rocm", "module: xpu", "module: hip"}
_META_TITLE   = re.compile(
    r"\btracker\b|\bmigration\b|\bumbrella\b|\bRFC\b|\bmeta[- ]issue\b|\bmeta[- ]bug\b",
    re.IGNORECASE,
)

# ── Exclusion rules ───────────────────────────────────────────────────────────

def is_excluded(issue: dict) -> tuple[bool, str]:
    title  = issue.get("title", "")
    labels = set(issue.get("labels", []))

    if title.startswith("DISABLED"):
        return True, "E1: DISABLED title"
    if "skipped" in labels:
        return True, "E2: skipped label"
    if "module: flaky-tests" in labels:
        return True, "E3: flaky-tests"
    if "module: ci" in labels:
        return True, "E4: ci label"
    if "module: build" in labels:
        return True, "E5: build label"
    if "feature" in labels and "module: correctness (silent)" not in labels:
        return True, "E6: feature request"
    if "needs design" in labels:
        return True, "E7: needs design"
    if ("enhancement" in labels
            and "module: correctness (silent)" not in labels
            and "module: regression" not in labels):
        return True, "E8: enhancement"
    if issue.get("state", "").upper() == "CLOSED":
        return True, "E9: closed"
    if ("module: docs" in labels
            and "module: correctness (silent)" not in labels
            and "module: regression" not in labels):
        return True, "E10: docs"
    if "oncall: releng" in labels:
        return True, "E11: releng"
    # Q1: MPS-only (no cross-platform backend — requires Apple hardware)
    if "module: mps" in labels and not (labels & _MPS_BACKENDS):
        return True, "Q1: MPS-only"
    # Q3: meta / tracker / umbrella issues — not a single fixable bug
    if _META_TITLE.search(title):
        return True, "Q3: meta/tracker title"

    return False, ""


# ── Feature detectors ─────────────────────────────────────────────────────────

_REPRO_MARKERS = re.compile(
    r"to reproduce|repro\s*:|steps to reproduce|minimal.*example"
    r"|minimum reproducible|mre\b|reproduc",
    re.IGNORECASE,
)
_CODE_BLOCK = re.compile(r"```(?:python)?(.*?)```", re.DOTALL)
_FILE_REF   = re.compile(r"\b\w[\w/]*\.(?:py|cpp|cu|cuh|h)\b")

_MAINTAINER_YES = re.compile(
    r"feel free to (?:submit|open|send|make) a pr"
    r"|(?:a |would welcome a? |happy to accept a? )pr"
    r"|pr(?:s)? (?:is|are|would be) welcome"
    r"|please (?:submit|open|send) a pr"
    r"|good first issue"
    r"|would be great if someone (?:could|would) fix"
    r"|we should fix this"
    r"|we('d| would) (?:accept|take|merge) (?:a )?(?:fix|pr)"
    r"|contributions? welcome",
    re.IGNORECASE,
)


def detect_repro(body: str) -> bool:
    if _REPRO_MARKERS.search(body):
        return True
    for block in _CODE_BLOCK.finditer(body):
        code = block.group(1)
        if "import torch" in code or "torch." in code:
            return True
    return False


def detect_single_file(title: str, body: str) -> bool:
    files = _FILE_REF.findall(title + " " + body[:800])
    unique = {f.split("/")[-1] for f in files}
    return len(unique) == 1


def detect_maintainer_yes(comments: list[dict]) -> bool:
    for c in comments:
        if c.get("authorAssociation") not in HIGH_TRUST:
            continue
        if (c.get("author") or {}).get("login", "") in BOT_AUTHORS:
            continue
        if _MAINTAINER_YES.search(c.get("body") or ""):
            return True
    return False


def detect_maintainer_engaged(comments: list[dict]) -> bool:
    return any(
        c.get("authorAssociation") in HIGH_TRUST
        and (c.get("author") or {}).get("login", "") not in BOT_AUTHORS
        for c in comments
    )


# ── Scorer ────────────────────────────────────────────────────────────────────

def score_issue(issue: dict, has_body: bool = False) -> tuple[float, dict]:
    """Returns (score, feature_flags). Score typically 0.0–1.5."""
    labels   = set(issue.get("labels", []))
    body     = issue.get("body") or ""
    comments = issue.get("comments") or []
    created  = issue.get("createdAt") or ""
    title    = issue.get("title") or ""

    flags: dict = {}
    score = 0.50

    # ── Label signals ─────────────────────────────────────────────────────────
    flags["good_first_issue"] = "good first issue" in labels
    if flags["good_first_issue"]:
        score += 0.25

    flags["help_wanted"] = "help wanted" in labels
    if flags["help_wanted"]:
        score += 0.20

    flags["triaged"] = "triaged" in labels
    if flags["triaged"]:
        score += 0.10

    flags["actionable"] = "actionable" in labels
    if flags["actionable"]:
        score += 0.10

    flags["high_priority"] = "high priority" in labels
    if flags["high_priority"]:
        score += 0.08

    flags["correctness_silent"] = "module: correctness (silent)" in labels
    if flags["correctness_silent"]:
        score += 0.12

    flags["needs_repro"] = "needs reproduction" in labels
    if flags["needs_repro"]:
        score -= 0.15

    # ── Age signal ────────────────────────────────────────────────────────────
    age_days: int | None = None
    if created:
        try:
            t = datetime.fromisoformat(created.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - t).days
        except ValueError:
            pass

    flags["age_days"] = age_days
    if age_days is not None:
        if age_days < 180:
            score += 0.10
        elif age_days < 540:
            score += 0.05
        elif age_days > 730:
            score -= 0.10

    # ── Body + comment signals (only when body was fetched) ───────────────────
    if has_body:
        flags["has_repro"]          = detect_repro(body)
        flags["single_file"]        = detect_single_file(title, body)
        flags["maintainer_yes"]     = detect_maintainer_yes(comments)
        flags["maintainer_engaged"] = detect_maintainer_engaged(comments)

        if flags["has_repro"]:
            score += 0.15
        if flags["single_file"]:
            score += 0.08
        if flags["maintainer_yes"]:
            score += 0.20
        elif flags["maintainer_engaged"]:
            score += 0.05
    else:
        flags["has_repro"]          = None
        flags["single_file"]        = None
        flags["maintainer_yes"]     = None
        flags["maintainer_engaged"] = None

    return round(score, 3), flags


# ── GitHub fetch (single issue, used in parallel) ─────────────────────────────

def fetch_issue(number: int, repo: str) -> dict | None:
    result = subprocess.run(
        [
            "gh", "issue", "view", str(number),
            "--repo", repo,
            "--json", "number,title,url,body,labels,createdAt,comments",
        ],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
        data["labels"] = [
            lbl.get("name", str(lbl)) if isinstance(lbl, dict) else str(lbl)
            for lbl in data.get("labels", [])
        ]
        return data
    except json.JSONDecodeError:
        return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo",  default="pytorch/pytorch")
    parser.add_argument("--top",   type=int, default=DEFAULT_TOP_N,
                        help="Number of top pre-scored issues to fetch full bodies for")
    args = parser.parse_args()

    # ── Load inputs ───────────────────────────────────────────────────────────
    if not SEL_FILE.exists():
        print(f"ERROR: {SEL_FILE} not found. Run 01_discover_topics.sh first.", file=sys.stderr)
        sys.exit(1)

    with open(SEL_FILE) as f:
        sel = json.load(f)
    selected_labels = {t["label"] for t in sel.get("selected_topics", [])}

    with open(CORPUS_FILE) as f:
        corpus = json.load(f)

    print(f"Repo:            {args.repo}")
    print(f"Selected topics: {', '.join(sorted(selected_labels))}")
    print()

    # ── Pass 1: corpus filter + label-only pre-score (no API) ────────────────
    print("Pass 1 — Pre-scoring from corpus (no API)...")

    candidates: list[dict] = []
    n_excluded = 0
    for issue in corpus:
        if issue.get("state", "").upper() != "OPEN":
            continue
        labels = set(issue.get("labels", []))
        if not (labels & selected_labels):
            continue

        excluded, _ = is_excluded(issue)
        if excluded:
            n_excluded += 1
            continue

        pre_score, flags = score_issue(issue, has_body=False)
        candidates.append({
            "score":      pre_score,
            "number":     issue["number"],
            "title":      issue.get("title", ""),
            "url":        issue.get("url", f"https://github.com/{args.repo}/issues/{issue['number']}"),
            "labels":     issue.get("labels", []),
            "created_at": issue.get("createdAt", ""),
            "flags":      flags,
            "_issue":     issue,   # keep for fallback scoring
        })

    candidates.sort(key=lambda r: -r["score"])
    print(f"  Corpus:   {len(corpus)} total issues")
    print(f"  In scope: {len(candidates)} open issues passing exclusion rules")
    print(f"  Excluded: {n_excluded}")
    print()

    # ── Pass 2: fetch body+comments for top N only, in parallel ──────────────
    top_n = min(args.top, len(candidates))
    to_fetch = candidates[:top_n]
    numbers  = [r["number"] for r in to_fetch]

    print(f"Pass 2 — Fetching top {top_n} issues in parallel ({FETCH_WORKERS} workers)...")

    fetched: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = {pool.submit(fetch_issue, num, args.repo): num for num in numbers}
        done = 0
        for future in as_completed(futures):
            num = futures[future]
            data = future.result()
            if data:
                fetched[num] = data
            done += 1
            if done % 25 == 0 or done == top_n:
                print(f"  {done}/{top_n} fetched...", end="\r", flush=True)

    print(f"  {len(fetched)}/{top_n} fetched successfully         ")
    print()

    # ── Re-score fetched issues with full body+comments ───────────────────────
    print("Scoring issues...")

    results = []

    for r in candidates:
        num = r["number"]
        if num in fetched:
            issue = fetched[num]
            score, flags = score_issue(issue, has_body=True)
            results.append({
                "score":      score,
                "number":     num,
                "title":      issue.get("title", r["title"]),
                "url":        issue.get("url", r["url"]),
                "labels":     issue.get("labels", r["labels"]),
                "created_at": issue.get("createdAt", r["created_at"]),
                "flags":      flags,
            })
        else:
            # not in top-N or fetch failed — use pre-score
            results.append({k: v for k, v in r.items() if k != "_issue"})

    results.sort(key=lambda r: -r["score"])

    # ── Write output ──────────────────────────────────────────────────────────
    output = {
        "generated_at":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo":            args.repo,
        "selected_topics": list(selected_labels),
        "total_scored":    len(results),
        "issues":          results,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    print(f"  Scored {len(results)} issues → {OUT_FILE}")
    print()

    # ── Summary table ─────────────────────────────────────────────────────────
    print(f"Top 20 issues by score")
    print(f"{'Score':>6}  {'#':>7}  {'GFI':>3}  {'HW':>3}  {'TRI':>3}  "
          f"{'Repro':>5}  {'M?':>3}  {'1F':>3}  Title")
    print("-" * 110)

    for r in results[:20]:
        f    = r["flags"]
        gfi  = "✓" if f.get("good_first_issue") else ""
        hw   = "✓" if f.get("help_wanted") else ""
        tri  = "✓" if f.get("triaged") else ""
        repro = "✓" if f.get("has_repro") else ("?" if f.get("has_repro") is None else "")
        myes  = "✓" if f.get("maintainer_yes") else ("?" if f.get("maintainer_yes") is None else "")
        sf    = "✓" if f.get("single_file") else ("?" if f.get("single_file") is None else "")
        title = r["title"][:60]
        print(f"{r['score']:>6.3f}  #{r['number']:>6}  {gfi:>3}  {hw:>3}  {tri:>3}  "
              f"{repro:>5}  {myes:>3}  {sf:>3}  {title}")

    print()
    print(f"Columns: GFI=good first issue, HW=help wanted, TRI=triaged, "
          f"Repro=repro script, M?=maintainer said yes, 1F=single file")
    print(f"?=not yet fetched  ✓=true  blank=false")
    print()

    bands = [
        (0.90, float("inf"), "Excellent (≥0.90)"),
        (0.75, 0.90,         "Strong   (0.75–0.89)"),
        (0.60, 0.75,         "Good     (0.60–0.74)"),
        (0.00, 0.60,         "Weak     (<0.60)"),
    ]
    print("Score distribution:")
    for lo, hi, label in bands:
        count = sum(1 for r in results if lo <= r["score"] < hi)
        print(f"  {label}: {count}")


if __name__ == "__main__":
    main()
