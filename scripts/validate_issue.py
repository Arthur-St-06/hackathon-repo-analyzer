#!/usr/bin/env python3
"""
validate_issue.py — Hybrid validator: deterministic Python scoring + Haiku for maintainer signals.

Haiku does ONE focused task: classify maintainer comments → signal_type.
Python handles everything else: PR status, scoring formula, output routing.

Usage:
  python3 scripts/validate_issue.py <issue_number> <raw_json_path>
    --issue-data /tmp/precheck_N.json
    --pr-search  /tmp/pr_search_N.json
    --timeline   /tmp/timeline_N.json
    [--val-dir   findings/validated]

Prints:
  VALIDATED: <finding_id> → validated (confidence=<score>)
  SKIP: <finding_id> — <reason>
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT   = Path(__file__).parent.parent
HIGH_TRUST  = {"COLLABORATOR", "MEMBER", "OWNER"}
BOT_AUTHORS = {
    # generic
    "github-actions", "github-actions[bot]", "dependabot", "dependabot[bot]",
    "codecov", "codecov-io", "stale[bot]", "allcontributors",
    # pytorch-specific (harmless on other repos)
    "pytorch-bot", "facebook-github-bot", "pytorchmergebot", "pytorch-probot",
}
HAIKU_MODEL = "claude-haiku-4-5-20251001"

HAIKU_SYSTEM = """\
Classify GitHub maintainer comments for a bug issue.
Return ONLY a valid JSON array — no markdown, no explanation.
Each element: {"author": "<login>", "role": "<COLLABORATOR|MEMBER|OWNER>", "signal_type": "<type>", "quote": "<verbatim ≤200 chars>"}

signal_type must be exactly one of:
  approved_fix      — maintainer approved a linked PR or confirmed the fix is correct
  requested_merge   — maintainer wrote @pytorchbot merge or explicitly asked for PR merge
  fixed_elsewhere   — maintainer said the bug is fixed or will be fixed by a specific PR, nightly, or another version
  blocked_action    — maintainer said there is no feasible path to fix this right now
  wont_fix          — maintainer said this is by design and will not be changed
  by_design         — behavior is intentional but future change not ruled out
  needs_more_info   — maintainer asked for repro, details, or minimal example
  scoped_bug        — maintainer narrowed root cause to a specific backend/path
  partial_fix       — fix addresses only part of the issue

Classify COLLABORATOR, MEMBER, or OWNER comments only. Skip bots and regular users.
If no qualifying comments, return [].
"""

_CODE_BLOCK     = re.compile(r"```(?:python)?(.*?)```", re.DOTALL)
_REPRO_MARKERS  = re.compile(
    r"to reproduce|repro\s*:|steps to reproduce|minimal.*example"
    r"|minimum reproducible|mre\b|reproduc",
    re.IGNORECASE,
)
_FILE_REF       = re.compile(r"\b\w[\w/]*\.(?:py|cpp|cu|cuh|h)\b")
_GITHUB_PR_URL  = re.compile(r'github\.com/[\w.\-]+/[\w.\-]+/pull/(\d+)')
_FIX_LANG       = re.compile(
    r'\b(?:fix(?:ed|es)?|solv(?:ed|es)?|resolv(?:ed|es)?|address(?:ed|es)?|merg(?:ed|es)?)\b',
    re.IGNORECASE,
)


# ── Haiku call ────────────────────────────────────────────────────────────────

def classify_maintainer_comments(comments: list[dict]) -> list[dict]:
    maintainer = [
        c for c in comments
        if c.get("authorAssociation") in HIGH_TRUST
        and (c.get("author") or {}).get("login", "") not in BOT_AUTHORS
    ]
    if not maintainer:
        return []

    lines = []
    for c in maintainer:
        login = (c.get("author") or {}).get("login", "?")
        assoc = c.get("authorAssociation", "?")
        body  = (c.get("body") or "")[:500]
        lines.append(f"[{assoc}] {login}:\n{body}")

    prompt = "Classify these maintainer comments:\n\n" + "\n\n---\n\n".join(lines)

    result = subprocess.run(
        [
            "claude", "--print",
            "--model", HAIKU_MODEL,
            "--system-prompt", HAIKU_SYSTEM,
            "--dangerously-skip-permissions",
            "-p", prompt,
        ],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        print(f"  WARN: Haiku failed: {result.stderr[:80]}", file=sys.stderr)
        return []

    m = re.search(r"\[.*\]", result.stdout.strip(), re.DOTALL)
    if not m:
        return []
    try:
        signals = json.loads(m.group())
        return [s for s in signals if isinstance(s, dict) and "signal_type" in s]
    except json.JSONDecodeError:
        return []


# ── GitHub helpers ────────────────────────────────────────────────────────────

def fetch_pr(number: int, repo: str) -> dict:
    r = subprocess.run(
        ["gh", "pr", "view", str(number), "--repo", repo,
         "--json", "number,title,state,mergedAt,url,reviews,comments"],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except json.JSONDecodeError:
        return {}


# ── Feature detectors ─────────────────────────────────────────────────────────

def has_repro(body: str, comments: list[dict]) -> bool:
    text = body + " ".join(c.get("body", "") for c in comments)
    if _REPRO_MARKERS.search(text):
        return True
    for block in _CODE_BLOCK.finditer(text):
        code = block.group(1)
        if "import " in code or "." in code:
            return True
    return False


def infer_fix_scope(body: str) -> str:
    files = {f.split("/")[-1] for f in _FILE_REF.findall(body[:1000])}
    if len(files) == 1:
        return "single_file"
    return "unknown"


def infer_hardware(labels: set) -> list[str]:
    hw = []
    for label in labels:
        lower = label.lower()
        for keyword in ("cuda", "cpu", "mps", "rocm", "xpu", "hip"):
            if keyword in lower:
                hw.append(keyword)
                break
    return sorted(set(hw))


def extract_fix_pr_refs(comments: list[dict]) -> list[int]:
    """Find PR numbers mentioned near fix/merge language in any comment body."""
    found: set[int] = set()
    for c in comments:
        body = c.get("body") or ""
        for m in _GITHUB_PR_URL.finditer(body):
            start   = max(0, m.start() - 150)
            end     = min(len(body), m.end() + 150)
            if _FIX_LANG.search(body[start:end]):
                found.add(int(m.group(1)))
    return sorted(found)


def issue_age_years(created_at: str) -> float:
    if not created_at:
        return 0.0
    try:
        t = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).days / 365
    except ValueError:
        return 0.0


# ── Core scorer ───────────────────────────────────────────────────────────────

def score_finding(
    raw: dict,
    issue: dict,
    linked_prs: list[dict],
    maintainer_signals: list[dict],
) -> tuple[float, list[str], str]:
    """Returns (confidence, blocking_signals, confidence_justification)."""

    labels   = {(l if isinstance(l, str) else l.get("name", "")) for l in issue.get("labels", [])}
    body     = issue.get("body") or ""
    comments = issue.get("comments") or []
    created  = raw.get("issue_created_at") or issue.get("createdAt") or ""

    repro      = has_repro(body, comments)
    fix_scope  = infer_fix_scope(body)
    age_years  = issue_age_years(created)

    # ── Blocking signals ──────────────────────────────────────────────────────
    blocking: list[str] = []

    for pr in linked_prs:
        if pr.get("merged"):
            blocking.append(f"already_fixed: #{pr['number']} merged at {pr.get('merged_at', '?')}")

    for sig in maintainer_signals:
        st    = sig.get("signal_type", "")
        quote = (sig.get("quote") or "")[:120]
        if st == "wont_fix":
            blocking.append(f"maintainer_wont_fix: {quote}")
        elif st == "blocked_action":
            blocking.append(f"maintainer_blocked_action: {quote}")
        elif st == "fixed_elsewhere":
            blocking.append(f"fixed_elsewhere: {quote}")

    has_open_pr      = sum(1 for p in linked_prs if p.get("state") == "open")
    has_abandoned_pr = sum(1 for p in linked_prs if not p.get("merged") and p.get("state") != "open")

    maintainer_engaged = any(
        c.get("authorAssociation") in HIGH_TRUST
        and (c.get("author") or {}).get("login", "") not in BOT_AUTHORS
        for c in comments
    )
    if age_years >= 3 and not maintainer_engaged:
        blocking.append(f"stale_no_activity: {age_years:.1f} years, no maintainer comment")

    # ── Score ─────────────────────────────────────────────────────────────────
    score = 0.50
    steps: list[str] = ["Base: 0.50"]

    def adj(delta: float, note: str) -> None:
        nonlocal score
        score += delta
        steps.append(f"{note} → {delta:+.2f}, total {score:.2f}")

    if "module: correctness (silent)" in labels:
        adj(+0.25, "correctness (silent) label")

    for sig in maintainer_signals:
        st = sig.get("signal_type", "")
        if st == "approved_fix":
            adj(+0.20, f"approved_fix ({sig.get('author')})")
        elif st == "requested_merge":
            adj(+0.20, f"requested_merge ({sig.get('author')})")

    if repro:
        adj(+0.15, "repro script present")

    if "triaged" in labels:
        adj(+0.10, "triaged label")

    if fix_scope in ("single_function", "single_file"):
        adj(+0.10, f"fix_scope={fix_scope}")

    if age_years >= 2:
        adj(+0.05, f"open {age_years:.1f} years")

    # Negatives
    for bs in blocking:
        if bs.startswith("already_fixed:"):
            adj(-0.45, "already_fixed")
        elif bs.startswith("maintainer_wont_fix:"):
            adj(-0.40, "maintainer_wont_fix")
        elif bs.startswith("maintainer_blocked_action:"):
            adj(-0.40, "maintainer_blocked_action")

    if has_open_pr:
        adj(-0.40 * has_open_pr, f"{has_open_pr} open PR(s) — active work")
    if has_abandoned_pr:
        adj(-0.25 * has_abandoned_pr, f"{has_abandoned_pr} abandoned PR(s)")

    for sig in maintainer_signals:
        if sig.get("signal_type") == "by_design":
            adj(-0.15, f"by_design ({sig.get('author')})")

    if "module: needs reproduction" in labels:
        adj(-0.05, "needs reproduction label")
    if bs := next((b for b in blocking if b.startswith("stale_no_activity:")), None):
        adj(-0.05, "stale_no_activity")

    score = round(max(0.0, min(1.0, score)), 2)
    steps.append(f"Final: {score}")
    return score, blocking, ". ".join(steps)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("issue_number", type=int)
    ap.add_argument("raw_json_path", type=Path)
    ap.add_argument("--issue-data", type=Path, required=True)
    ap.add_argument("--pr-search",  type=Path, required=True)
    ap.add_argument("--timeline",   type=Path, required=True)
    ap.add_argument("--val-dir",    type=Path,
                    default=REPO_ROOT / "findings" / "validated")
    args = ap.parse_args()

    with open(args.raw_json_path) as f:
        raw = json.load(f)
    with open(args.issue_data) as f:
        issue = json.load(f)
    with open(args.pr_search) as f:
        pr_search_raw = json.load(f)
    with open(args.timeline) as f:
        timeline_raw = json.load(f)

    repo       = raw.get("repo", "pytorch/pytorch")
    finding_id = raw.get("finding_id", f"pytorch_{args.issue_number}")
    comments   = issue.get("comments") or []

    # ── Haiku: classify maintainer comments ───────────────────────────────────
    print(f"  [{finding_id}] Haiku: classifying {sum(1 for c in comments if c.get('authorAssociation') in HIGH_TRUST)} maintainer comment(s)...", file=sys.stderr)
    maintainer_signals = classify_maintainer_comments(comments)

    # ── Collect PR numbers ────────────────────────────────────────────────────
    pr_numbers: set[int] = set()
    for pr in pr_search_raw:
        pr_numbers.add(int(pr["number"]))
    for ref in timeline_raw:
        if ref.get("source_pr"):
            pr_numbers.add(int(ref["source_pr"]))
    # Also scan comment bodies for PR URLs mentioned near fix/merge language
    for num in extract_fix_pr_refs(comments):
        pr_numbers.add(num)

    # ── Fetch PR details ──────────────────────────────────────────────────────
    linked_prs: list[dict] = []
    for num in sorted(pr_numbers):
        print(f"  [{finding_id}] fetching PR #{num}...", file=sys.stderr)
        pr = fetch_pr(num, repo)
        if not pr:
            continue
        merged_at = pr.get("mergedAt")
        reviews   = pr.get("reviews") or []
        linked_prs.append({
            "number":           pr.get("number"),
            "title":            pr.get("title", ""),
            "url":              pr.get("url", f"https://github.com/{repo}/pull/{num}"),
            "state":            pr.get("state", ""),
            "merged":           bool(merged_at),
            "merged_at":        merged_at,
            "abandoned_reason": None if merged_at else "closed without merge",
            "reviews_summary":  ", ".join(
                f"{(r.get('author') or {}).get('login', '?')}:{r.get('state', '?')}"
                for r in reviews
            ) or "no reviews",
        })

    # ── Score ─────────────────────────────────────────────────────────────────
    confidence, blocking, justification = score_finding(raw, issue, linked_prs, maintainer_signals)

    # Hard blockers → skip
    for bs in blocking:
        if any(bs.startswith(p) for p in ("already_fixed:", "maintainer_wont_fix:", "maintainer_blocked_action:", "fixed_elsewhere:")):
            print(f"SKIP: {finding_id} — {bs}")
            return

    if confidence < 0.75:
        print(f"SKIP: {finding_id} — confidence {confidence} below threshold")
        return

    # ── Recommended action ────────────────────────────────────────────────────
    body   = issue.get("body") or ""
    repro  = has_repro(body, comments)
    action = "file_pr" if repro else "file_issue"

    # ── Write output ──────────────────────────────────────────────────────────
    now     = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out_dir = args.val_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    result = {
        **raw,
        "stage":                    "validated",
        "linked_prs":               linked_prs,
        "maintainer_signals":       maintainer_signals,
        "blocking_signals":         blocking,
        "fix_scope":                infer_fix_scope(body),
        "affected_hardware":        infer_hardware(
            {(l if isinstance(l, str) else l.get("name", ""))
             for l in issue.get("labels", [])}
        ),
        "still_reproducible":       (
            "unlikely" if any(p.get("merged") for p in linked_prs)
            else "likely" if repro
            else "unknown"
        ),
        "confidence":               confidence,
        "confidence_justification": justification,
        "recommended_action":       action,
        "closest_ground_truth":     None,
        "ground_truth_delta":       None,
        "updated_at":               now,
    }

    out_path = out_dir / f"{finding_id}.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")

    print(f"VALIDATED: {finding_id} → validated (confidence={confidence})")


if __name__ == "__main__":
    main()
