#!/usr/bin/env bash
# 03_validate.sh — Run the validator agent on each raw finding
#
# Usage:
#   ./tools/03_validate.sh              # validate all findings/raw/*.json
#   ./tools/03_validate.sh 113956       # validate a single issue number
#   ./tools/03_validate.sh 113956 165987 173638  # validate specific issues
#
# For each raw finding the agent:
#   1. Pre-checks for hard blockers without LLM (fast path)
#   2. Pre-fetches issue data and PR search results
#   3. Classifies maintainer signals and hard blockers
#   4. Scores confidence and assigns recommended_action
#   5. Writes to findings/validated/ if confidence >= 0.75; otherwise skips
#
# All validators run in parallel.
# After all validations, regenerates public/data/findings.json and summary.json.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW_DIR="$REPO_ROOT/findings/raw"
VAL_DIR="$REPO_ROOT/findings/validated"

# ── Prerequisites ──────────────────────────────────────────────────────────────

if ! gh auth status &>/dev/null; then
  echo "ERROR: Not authenticated with gh CLI. Run: gh auth login" >&2
  exit 1
fi

RAW_COUNT=$(find "$RAW_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$RAW_COUNT" -eq 0 ]]; then
  echo "ERROR: No raw findings in $RAW_DIR. Run 02_surface.sh first." >&2
  exit 1
fi

# ── Build target file list ─────────────────────────────────────────────────────

if [[ $# -gt 0 ]]; then
  # One or more issue numbers provided as arguments — find matching raw files
  RAW_FILES=()
  for arg in "$@"; do
    TARGET=$(find "$RAW_DIR" -name "*_${arg}.json" 2>/dev/null | head -1)
    if [[ -z "$TARGET" ]]; then
      echo "ERROR: No raw finding for issue #${arg} in $RAW_DIR." >&2
      exit 1
    fi
    RAW_FILES+=("$TARGET")
  done
else
  mapfile -t RAW_FILES < <(find "$RAW_DIR" -name "*.json" | sort)
fi

echo "Validator agent — ${#RAW_FILES[@]} finding(s) to process"
echo ""

# ── Run the validator agent on each finding ────────────────────────────────────

TOTAL=${#RAW_FILES[@]}

# ── Worker function — runs one validation in a subshell ───────────────────────

validate_one() {
  local raw_file="$1"
  local issue_num
  issue_num=$(python3 -c "import json; print(json.load(open('$raw_file'))['issue_number'])" 2>/dev/null)
  if [[ -z "$issue_num" ]]; then
    issue_num=$(basename "$raw_file" .json | grep -oE '[0-9]+$')
  fi
  local log="/tmp/validator_output_${issue_num}.txt"

  echo "[#$issue_num] pre-checking..."

  # ── Fast pre-check: pattern-match for hard blockers without LLM ────────────
  local precheck_tmp="/tmp/precheck_${issue_num}.json"
  rm -f "$precheck_tmp"

  local precheck_result
  precheck_result=$(python3 "$REPO_ROOT/scripts/precheck_issue.py" \
    "$issue_num" "$raw_file" 2>/tmp/precheck_err_$issue_num.txt)
  local precheck_exit=$?

  if [[ $precheck_exit -eq 1 ]]; then
    echo "[#$issue_num] PRECHECK REJECT: $precheck_result"
    echo "PRECHECK_REJECT" > "$log"
    return 0
  fi

  # ── Pre-fetch PR search + timeline so Claude doesn't need to ───────────────
  echo "[#$issue_num] fetching linked PRs..."

  # Read repo from raw finding
  local repo
  repo=$(python3 -c "import json; print(json.load(open('$raw_file')).get('repo','pytorch/pytorch'))" 2>/dev/null || echo "pytorch/pytorch")

  gh search prs --repo "$repo" "$issue_num" \
    --json number,title,url,state,closedAt --limit 10 \
    > "/tmp/pr_search_${issue_num}.json" 2>/dev/null || echo '[]' > "/tmp/pr_search_${issue_num}.json"

  gh api "repos/$repo/issues/$issue_num/timeline" \
    --jq '[.[] | select(.event == "cross-referenced") | {source_pr: .source.issue.number}]' \
    > "/tmp/timeline_${issue_num}.json" 2>/dev/null || echo '[]' > "/tmp/timeline_${issue_num}.json"

  echo "[#$issue_num] running validator..."

  echo "[#$issue_num] running hybrid validator (Haiku + Python)..."

  python3 "$REPO_ROOT/scripts/validate_issue.py" \
    "$issue_num" "$raw_file" \
    --issue-data "$precheck_tmp" \
    --pr-search  "/tmp/pr_search_${issue_num}.json" \
    --timeline   "/tmp/timeline_${issue_num}.json" \
    --val-dir    "$VAL_DIR" \
    > "$log" 2>"/tmp/validator_err_${issue_num}.txt" || true

  grep -E "VALIDATED:|SKIP:" "$log" || echo "[#$issue_num] WARNING: no result line in output"
}

# ── Launch all validators in parallel ─────────────────────────────────────────

echo "Launching $TOTAL validator(s) in parallel..."
echo ""

declare -a PIDS=()
for raw_file in "${RAW_FILES[@]}"; do
  validate_one "$raw_file" &
  PIDS+=($!)
done

# Wait for all background jobs and collect exit codes
FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=$((FAILED+1))
done

echo ""
echo "All validators finished."
echo ""

# Count results
PROCESSED=0
SKIPPED=0
for raw_file in "${RAW_FILES[@]}"; do
  issue_num=$(python3 -c "import json; print(json.load(open('$raw_file'))['issue_number'])" 2>/dev/null \
    || basename "$raw_file" .json | grep -oE '[0-9]+$')
  log="/tmp/validator_output_${issue_num}.txt"

  if grep -qE "PRECHECK_REJECT|SKIP:" "$log" 2>/dev/null; then
    SKIPPED=$((SKIPPED+1))
  elif [[ -f "$VAL_DIR/$(basename "$raw_file")" ]]; then
    PROCESSED=$((PROCESSED+1))
  else
    echo "WARNING: No output file for #$issue_num"
    FAILED=$((FAILED+1))
  fi
done

# ── Regenerate public/data/findings.json and summary.json ─────────────────────

echo "Aggregating results..."

python3 - <<PYEOF
import json, glob, os
from datetime import datetime, timezone

REPO_ROOT = '$REPO_ROOT'
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

findings = []
for fp in sorted(glob.glob(os.path.join(REPO_ROOT, 'findings/validated/*.json'))):
    with open(fp) as f:
        findings.append(json.load(f))

findings.sort(key=lambda x: (x.get('confidence') or 0), reverse=True)

# Read selected topics
try:
    with open(os.path.join(REPO_ROOT,'data','selected_topics.json')) as f:
        sel = json.load(f)
    group_name = sel.get('selected_group',{}).get('display_name','')
    selected_labels = [t['label'] for t in sel.get('selected_topics',[])]
except Exception:
    group_name = ''
    selected_labels = []

by_class = {}
for fi in findings:
    c = fi.get('initial_classification','unknown')
    by_class[c] = by_class.get(c,0)+1

os.makedirs(os.path.join(REPO_ROOT,'public','data'), exist_ok=True)

output = {
    'metadata': {
        'generated_at':    now,
        'group':           group_name,
        'selected_topics': selected_labels,
        'corpus_version':  'full_v1',
    },
    'findings': findings,
}
with open(os.path.join(REPO_ROOT,'public','data','findings.json'),'w') as f:
    json.dump(output, f, indent=2); f.write('\n')

summary = {
    'group':              group_name,
    'selected_topics':    selected_labels,
    'corpus_version':     'full_v1',
    'total_raw_findings': int('$RAW_COUNT'),
    'total_validated':    len(findings),
    'by_classification':  by_class,
    'last_updated':       now,
}
with open(os.path.join(REPO_ROOT,'public','data','summary.json'),'w') as f:
    json.dump(summary, f, indent=2); f.write('\n')

print(f"Wrote public/data/findings.json  ({len(findings)} findings)"  )
print(f"Wrote public/data/summary.json")
print()
print("=== Validated Findings ===")
print(f"  Total: {len(findings)}")
print()
if findings:
    print(f"{'#':>8}  {'conf':>5}  {'action':<22}  {'url':<55}  title")
    print("-"*130)
    for fi in findings:
        num    = fi.get('issue_number','?')
        conf   = fi.get('confidence') or 0
        action = fi.get('recommended_action','?') or '?'
        url    = fi.get('issue_url','')
        title  = fi.get('issue_title','')[:45]
        print(f"#{num:>7}  {conf:>5.2f}  {action:<22}  {url:<55}  {title}")
PYEOF

echo ""
echo "Done. $PROCESSED LLM-validated, $SKIPPED precheck-rejected, $FAILED failed."
echo "See public/data/findings.json for the full output."
