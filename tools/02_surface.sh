#!/usr/bin/env bash
# 02_surface.sh — Score and triage open issues for a selected topic group
#
# Usage:
#   ./tools/02_surface.sh <group_id> [--repo owner/repo] [--top N]
#
# Options:
#   --repo owner/repo   Repository (default: read from topic_groups.json, fallback pytorch/pytorch)
#   --top N             Maximum raw findings to write (default: 50)
#
# Produces:
#   data/selected_topics.json  — the user's selection
#   data/scored_issues.json    — all eligible issues ranked by score
#   findings/raw/*.json        — one raw finding per triaged issue

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROUPS_FILE="$REPO_ROOT/data/topic_groups.json"
SELECTED_FILE="$REPO_ROOT/data/selected_topics.json"
SCORED_FILE="$REPO_ROOT/data/scored_issues.json"
RAW_DIR="$REPO_ROOT/findings/raw"

# ── Argument parsing ───────────────────────────────────────────────────────────

GROUP_ID=""
REPO=""
MAX_FINDINGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2";         shift 2 ;;
    --top)  MAX_FINDINGS="$2"; shift 2 ;;
    -*)     echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$GROUP_ID" ]]; then GROUP_ID="$1"
      elif [[ -z "$MAX_FINDINGS" ]]; then MAX_FINDINGS="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$GROUP_ID" ]]; then
  echo "Usage: $0 <group_id> [--repo owner/repo] [--top N]" >&2
  echo ""
  if [[ -f "$GROUPS_FILE" ]]; then
    echo "Available groups:"
    python3 -c "
import json
with open('$GROUPS_FILE') as f:
    data = json.load(f)
for g in data['groups']:
    if g['group_id'] == 'other': continue
    print(f\"  {g['group_id']:<32}  {g['total_open_issues']:>4} open  {g['display_name']}\")
"
  fi
  exit 1
fi

# ── Resolve repo ───────────────────────────────────────────────────────────────

if [[ -z "$REPO" && -f "$GROUPS_FILE" ]]; then
  REPO=$(python3 -c "
import json, sys
with open('$GROUPS_FILE') as f:
    d = json.load(f)
print(d.get('repo', 'pytorch/pytorch'))
" 2>/dev/null || echo "pytorch/pytorch")
fi
REPO="${REPO:-pytorch/pytorch}"

# Derive corpus path and short slug for file naming
CORPUS="$REPO_ROOT/data/corpus_${REPO//\//_}.json"
REPO_SLUG="${REPO##*/}"          # "transformers" from "huggingface/transformers"
REPO_SLUG="${REPO_SLUG//-/_}"   # normalise hyphens to underscores

echo "Repo:  $REPO"
echo "Group: $GROUP_ID"

# ── Prerequisites ──────────────────────────────────────────────────────────────

if [[ ! -f "$GROUPS_FILE" ]]; then
  echo "ERROR: $GROUPS_FILE not found. Run 01_discover_topics.sh first." >&2
  exit 1
fi

if [[ ! -f "$CORPUS" ]]; then
  echo "ERROR: $CORPUS not found. Run 01_discover_topics.sh --repo $REPO first." >&2
  exit 1
fi

# Validate group_id exists
VALID=$(python3 -c "
import json,sys
with open('$GROUPS_FILE') as f:
    data = json.load(f)
ids = [g['group_id'] for g in data['groups']]
print('yes' if '$GROUP_ID' in ids else 'no')
")
if [[ "$VALID" != "yes" ]]; then
  echo "ERROR: group '$GROUP_ID' not found in $GROUPS_FILE" >&2
  exit 1
fi

# ── Clear existing raw findings ────────────────────────────────────────────────

mkdir -p "$RAW_DIR"
VAL_DIR="$REPO_ROOT/findings/validated"
mkdir -p "$VAL_DIR"

RAW_COUNT=$(find "$RAW_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
if [[ "$RAW_COUNT" -gt 0 ]]; then
  rm -f "$RAW_DIR"/*.json
fi

VAL_COUNT=$(find "$VAL_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
if [[ "$VAL_COUNT" -gt 0 ]]; then
  rm -f "$VAL_DIR"/*.json
  echo "Cleared $VAL_COUNT validated finding(s) from previous run."
fi

# ── Write selected_topics.json ────────────────────────────────────────────────

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

python3 - <<PYEOF
import json
from datetime import datetime, timezone

with open('$GROUPS_FILE') as f:
    groups_data = json.load(f)
with open('$REPO_ROOT/data/topics.json') as f:
    topics_data = json.load(f)
with open('$CORPUS') as f:
    all_issues = json.load(f)

label_meta = {t['label']: t for t in topics_data['topics']}
group = next(g for g in groups_data['groups'] if g['group_id'] == '$GROUP_ID')
selected_labels = group['labels']
name_key = 'display_name' if 'display_name' in group else 'name'
group_name = group[name_key]

def get_labels(issue):
    return [l if isinstance(l,str) else l.get('name','') for l in issue.get('labels',[])]

open_count = sum(
    1 for i in all_issues
    if i['state'] in ('OPEN', 'open') and any(l in selected_labels for l in get_labels(i))
)

out = {
    'created_at': '$TIMESTAMP',
    'repo': '$REPO',
    'corpus_file': '$CORPUS',
    'selected_group': {
        'group_id': group['group_id'],
        'display_name': group_name,
        'description': group.get('description',''),
        'actionability': group.get('actionability',''),
    },
    'selected_topics': [
        {
            'label': l,
            'slug': label_meta[l]['slug'],
            'display_name': label_meta[l]['display_name'],
            'open_count': label_meta[l]['open_count'],
            'issue_count': label_meta[l]['issue_count'],
            'actionability_hint': label_meta[l]['actionability_hint'],
        }
        for l in selected_labels if l in label_meta
    ],
    'total_open_in_scope': open_count,
}
with open('$SELECTED_FILE','w') as f:
    json.dump(out,f,indent=2); f.write('\n')

print(f"Group: {group_name}")
print(f"Labels: {len(selected_labels)}")
print(f"Open issues in scope: {open_count}")
PYEOF

TOP_N="${MAX_FINDINGS:-50}"

# ── Score issues ───────────────────────────────────────────────────────────────

echo ""
echo "Scoring issues..."
python3 "$REPO_ROOT/scripts/score_issues.py" \
  --repo "$REPO" \
  --corpus "$CORPUS" \
  || { echo "ERROR: score_issues.py failed" >&2; exit 1; }

if [[ ! -f "$SCORED_FILE" ]]; then
  echo "ERROR: $SCORED_FILE was not written by score_issues.py" >&2
  exit 1
fi

TOTAL_SCORED=$(python3 -c "import json; d=json.load(open('$SCORED_FILE')); print(d['total_scored'])")
echo "Scored $TOTAL_SCORED issues → $SCORED_FILE"

echo ""
echo "Writing top $TOP_N issues as raw findings..."

# ── Write raw findings (no LLM) ───────────────────────────────────────────────

python3 - <<PYEOF
import json, os, re
from datetime import datetime, timezone

with open('$SCORED_FILE') as f:
    data = json.load(f)

issues        = data['issues']
selected      = data.get('selected_topics', [])
now           = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
raw_dir       = '$RAW_DIR'
top_n         = int('$TOP_N')
repo          = '$REPO'
repo_slug     = '$REPO_SLUG'

os.makedirs(raw_dir, exist_ok=True)

def classify(labels):
    s = set(labels)
    if 'module: correctness (silent)' in s:
        return 'correctness_silent'
    if s & {'module: performance'} and s & {'module: regression'}:
        return 'performance_regression'
    # Generic classification for non-PyTorch repos
    if any('bug' in l.lower() for l in s):
        return 'bug'
    if any('regression' in l.lower() for l in s):
        return 'regression'
    return 'unknown'

written = 0
for iss in issues[:top_n]:
    cls        = classify(iss.get('labels', []))
    finding_id = f"{repo_slug}_{iss['number']}"
    finding = {
        'finding_id':               finding_id,
        'repo':                     repo,
        'issue_number':             iss['number'],
        'issue_title':              iss['title'],
        'issue_url':                iss.get('url', f"https://github.com/{repo}/issues/{iss['number']}"),
        'issue_state':              'OPEN',
        'issue_created_at':         iss.get('created_at', ''),
        'issue_labels':             iss.get('labels', []),
        'body_preview':             '',
        'initial_classification':   cls,
        'surface_reasoning':        f"Score {iss['score']:.3f}. Auto-selected from ranked corpus.",
        'stage':                    'raw',
        'linked_prs':               None,
        'maintainer_signals':       None,
        'blocking_signals':         None,
        'fix_scope':                None,
        'affected_hardware':        None,
        'still_reproducible':       None,
        'confidence':               None,
        'confidence_justification': None,
        'recommended_action':       None,
        'closest_ground_truth':     None,
        'ground_truth_delta':       None,
        'selected_topics':          selected,
        'corpus_version':           'full_v1',
        'created_at':               now,
        'updated_at':               now,
    }
    out = os.path.join(raw_dir, f"{finding_id}.json")
    with open(out, 'w') as f:
        json.dump(finding, f, indent=2); f.write('\n')
    written += 1

print(f"SURFACE_COMPLETE: {written} findings written")
PYEOF

# ── Verify and report ──────────────────────────────────────────────────────────

echo ""
RAW_WRITTEN=$(find "$RAW_DIR" -name "*.json" | wc -l | tr -d ' ')
echo "=== Surface Results ==="
echo "Raw findings written: $RAW_WRITTEN"

if [[ "$RAW_WRITTEN" -gt 0 ]]; then
  python3 - <<PYEOF
import json, glob
files = sorted(glob.glob('$RAW_DIR/*.json'))
by_class = {}
for fp in files:
    with open(fp) as f:
        d = json.load(f)
    c = d.get('initial_classification','unknown')
    by_class[c] = by_class.get(c,0)+1
print()
for cls,count in sorted(by_class.items(),key=lambda x:-x[1]):
    print(f"  {cls:<28} {count}")
print()
print("Files:")
for fp in files:
    with open(fp) as f:
        d = json.load(f)
    print(f"  {fp.split('/')[-1]}  [{d['initial_classification']}]  {d['issue_title'][:60]}")
PYEOF
fi

echo ""
echo "Next: run ./tools/03_validate.sh to validate each finding."
