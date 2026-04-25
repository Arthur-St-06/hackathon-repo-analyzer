#!/usr/bin/env bash
# 01_discover_topics.sh — Run the topic discovery agent against the corpus
#
# Produces:
#   data/topics.json       — per-label statistics
#   data/topic_groups.json — clustered groups with display names
#
# The agent reads data/corpus_full.json, computes co-occurrence clusters,
# and writes both output files. Prints a summary table when done.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="$REPO_ROOT/data/corpus_full.json"
TOPICS_OUT="$REPO_ROOT/data/topics.json"
GROUPS_OUT="$REPO_ROOT/data/topic_groups.json"

# ── Prerequisites ──────────────────────────────────────────────────────────────

if [[ ! -f "$CORPUS" ]]; then
  echo "ERROR: $CORPUS not found. Build the corpus first." >&2
  exit 1
fi

ISSUE_COUNT=$(python3 -c "import json; d=json.load(open('$CORPUS')); print(len(d))")
echo "Corpus: $ISSUE_COUNT issues in $CORPUS"
echo ""

# ── Run Python + Haiku pipeline ────────────────────────────────────────────────

python3 "$REPO_ROOT/scripts/discover_topics.py" \
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
name_key = 'display_name' if 'display_name' in groups[0] else 'name'
print(f"{'#':<3} {'group_id':<32} {'name':<38} {'open':>5}  {'labels':>6}")
print("-"*88)
for i,g in enumerate(groups,1):
    action = g.get('actionability', g.get('hint',''))
    print(f"{i:<3} {g['group_id']:<32} {g[name_key]:<38} {g['total_open_issues']:>5}  {g.get('label_count', len(g.get('labels',[]))) :>6}")
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
