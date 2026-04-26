#!/usr/bin/env bash
# 01_discover_topics.sh — Fetch issue corpus and run topic discovery
#
# Usage:
#   ./tools/01_discover_topics.sh [--repo owner/repo] [--fresh]
#
# Options:
#   --repo owner/repo   Repository to analyze (default: pytorch/pytorch)
#   --fresh             Re-fetch corpus even if it already exists
#
# Produces:
#   data/corpus_full.json  — issue index fetched from GitHub
#   data/topics.json       — per-label statistics
#   data/topic_groups.json — clustered groups with display names
#   public/data/topic_groups.json — copy served to the UI

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOPICS_OUT="$REPO_ROOT/data/topics.json"
GROUPS_OUT="$REPO_ROOT/data/topic_groups.json"

# ── Argument parsing ───────────────────────────────────────────────────────────

REPO="pytorch/pytorch"
FRESH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)  REPO="$2";  shift 2 ;;
    --fresh) FRESH=true; shift   ;;
    *)       echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

CORPUS="$REPO_ROOT/data/corpus_${REPO//\//_}.json"

echo "Repository: $REPO"
echo ""

# ── Fetch corpus ───────────────────────────────────────────────────────────────

if [[ ! -f "$CORPUS" || "$FRESH" == "true" ]]; then
  echo "Fetching issue corpus from GitHub (this may take a minute)..."
  mkdir -p "$REPO_ROOT/data"

  # gh issue list paginates automatically up to --limit
  gh issue list \
    --repo "$REPO" \
    --state all \
    --json number,title,labels,state,createdAt \
    --limit 10000 \
    > "$CORPUS"

  COUNT=$(python3 -c "import json; print(len(json.load(open('$CORPUS'))))")
  echo "Fetched $COUNT issues → $CORPUS"
  echo ""
else
  COUNT=$(python3 -c "import json; print(len(json.load(open('$CORPUS'))))")
  echo "Corpus: $COUNT issues in $CORPUS (use --fresh to re-fetch)"
  echo ""
fi

# ── Run Python + Haiku pipeline ────────────────────────────────────────────────

python3 "$REPO_ROOT/scripts/discover_topics.py" \
  --repo "$REPO" \
  --corpus "$CORPUS" \
  || { echo "ERROR: discover_topics.py failed" >&2; exit 1; }

# ── Verify output ──────────────────────────────────────────────────────────────

echo ""

if [[ ! -f "$TOPICS_OUT" ]]; then
  echo "ERROR: $TOPICS_OUT was not written." >&2
  exit 1
fi

echo "Output: $TOPICS_OUT ✓"

if [[ -f "$GROUPS_OUT" ]]; then
  echo "Output: $GROUPS_OUT ✓"

  # Make topic groups available to the frontend
  mkdir -p "$REPO_ROOT/public/data"
  cp "$GROUPS_OUT" "$REPO_ROOT/public/data/topic_groups.json"
  echo "Output: public/data/topic_groups.json ✓"
  echo ""
  echo "=== Topic Groups ==="
  python3 - <<PYEOF
import json
with open('$GROUPS_OUT') as f:
    data = json.load(f)
groups = [g for g in data['groups'] if g.get('group_id','') not in ('other','')]
if not groups:
    print("  (no groups found)")
else:
    name_key = 'display_name' if 'display_name' in groups[0] else 'name'
    print(f"{'#':<3} {'group_id':<32} {'name':<38} {'open':>5}")
    print("-"*80)
    for i,g in enumerate(groups,1):
        print(f"{i:<3} {g['group_id']:<32} {g[name_key]:<38} {g['total_open_issues']:>5}")
PYEOF
else
  echo ""
  echo "=== Topics (top 20) ==="
  python3 - <<PYEOF
import json
with open('$TOPICS_OUT') as f:
    data = json.load(f)
print(f"Total issues: {data['total_issues']}  |  Labels: {len(data['topics'])}")
print()
print(f"{'label':<44} {'open':>6}  {'hint'}")
print("-"*60)
for t in data['topics'][:20]:
    print(f"{t['label']:<44} {t['open_count']:>6}  {t['actionability_hint']}")
PYEOF
fi

echo ""
echo "Next: run ./tools/02_surface.sh <group_id> --repo $REPO"
