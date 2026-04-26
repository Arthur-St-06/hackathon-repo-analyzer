#!/usr/bin/env python3
"""
precheck_issue.py — Fast hard-blocker screen before running the validator.

Fetches issue body + comments via gh CLI, applies pattern matching for:
  - already_fixed:            any mention of a merged PR that fixes this
  - maintainer_wont_fix:      explicit rejection language from maintainers
  - maintainer_blocked_action: explicit "no way to act" language from maintainers

Exits:
  0  PASS   — no hard blockers found; writes pre-fetched issue to /tmp/precheck_N.json
  1  REJECT — hard blocker found; prints reason to stdout

Usage:
  python3 scripts/precheck_issue.py <issue_number> <raw_json_path>
"""

import json
import re
import subprocess
import sys
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

_ALREADY_FIXED = re.compile(
    r"fixed (?:in|by)\s+#\d+"
    r"|this (?:is|was|has been) (?:now )?fixed"
    r"|landed in\s+#\d+"
    r"|merged (?:in|as)\s+[#0-9a-f]+"
    r"|superseded by\s+#\d+"
    r"|closing in favor of\s+#\d+"
    r"|resolved (?:in|by)\s+#\d+"
    r"|duplicate of\s+#\d+",
    re.IGNORECASE,
)

_WONT_FIX = re.compile(
    r"won'?t fix|wontfix|by design|working as intended"
    r"|this is intentional|not going to (?:fix|merge|change)"
    r"|not the right (?:fix|approach)|wrong approach"
    r"|closing this\b|we won'?t (?:take|accept|merge) this"
    r"|not what we want|this is by design",
    re.IGNORECASE,
)

_BLOCKED_ACTION = re.compile(
    r"no (?:real |good |easy )?way to (?:act|fix|address|resolve) this"
    r"|not (?:really )?actionable"
    r"|nothing (?:we can|to be) done"
    r"|fundamentally limited|hardware limitation|not fixable",
    re.IGNORECASE,
)


def fetch_issue(number: int, repo: str) -> dict:
    result = subprocess.run(
        [
            "gh", "issue", "view", str(number),
            "--repo", repo,
            "--json", "title,state,body,labels,comments,createdAt",
        ],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return {}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}


def check_blockers(issue: dict) -> tuple[str | None, str | None]:
    """Returns (blocker_type, reason) or (None, None) if clean."""
    comments = issue.get("comments") or []

    for c in comments:
        body = c.get("body") or ""
        m = _ALREADY_FIXED.search(body)
        if m:
            login = (c.get("author") or {}).get("login", "?")
            return "already_fixed", f"{login}: {m.group()!r}"

    for c in comments:
        assoc = c.get("authorAssociation", "")
        if assoc not in HIGH_TRUST:
            continue
        login = (c.get("author") or {}).get("login", "")
        if login in BOT_AUTHORS:
            continue
        body = c.get("body") or ""
        m = _WONT_FIX.search(body)
        if m:
            return "maintainer_wont_fix", f"{login}: {m.group()!r}"
        m = _BLOCKED_ACTION.search(body)
        if m:
            return "maintainer_blocked_action", f"{login}: {m.group()!r}"

    return None, None


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <issue_number> <raw_json_path>", file=sys.stderr)
        sys.exit(2)

    issue_number = int(sys.argv[1])
    raw_path     = Path(sys.argv[2])

    # Read repo from the raw finding JSON
    try:
        with open(raw_path) as f:
            raw = json.load(f)
        repo = raw.get("repo", "pytorch/pytorch")
    except Exception:
        repo = "pytorch/pytorch"

    issue = fetch_issue(issue_number, repo)
    if not issue:
        print("PASS")
        sys.exit(0)

    blocker_type, reason = check_blockers(issue)

    if blocker_type:
        print(f"REJECT: {blocker_type}: {reason}")
        sys.exit(1)

    print("PASS")
    tmp = Path(f"/tmp/precheck_{issue_number}.json")
    with open(tmp, "w") as f:
        json.dump(issue, f)

    sys.exit(0)


if __name__ == "__main__":
    main()
