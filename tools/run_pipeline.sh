#!/usr/bin/env bash
# run_pipeline.sh — Run all three pipeline stages in sequence
#
# Usage:
#   ./tools/run_pipeline.sh <group_id>           # full run
#   ./tools/run_pipeline.sh <group_id> --surface-only
#   ./tools/run_pipeline.sh <group_id> --validate-only
#
# Stages:
#   1. 01_discover_topics.sh   — fetch corpus, cluster into topic groups
#   2. 02_surface.sh <group>   — score + triage raw findings
#   3. 03_validate.sh          — hybrid validate (Haiku + Python), write findings/validated/
#
# Available group IDs are printed when 01_discover_topics.sh has been run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <group_id> [--surface-only | --validate-only]" >&2
  echo ""
  if [[ -f "$REPO_ROOT/data/topic_groups.json" ]]; then
    echo "Available groups:"
    python3 -c "
import json
with open('$REPO_ROOT/data/topic_groups.json') as f:
    data = json.load(f)
for g in data['groups']:
    if g['group_id'] == 'other': continue
    print(f\"  {g['group_id']:<32}  {g['total_open_issues']:>4} open  {g['display_name']}\")
"
  else
    echo "  (run 01_discover_topics.sh first to see available groups)"
  fi
  exit 1
fi

GROUP_ID="$1"
SURFACE_ONLY=false
VALIDATE_ONLY=false

for arg in "${@:2}"; do
  case "$arg" in
    --surface-only)  SURFACE_ONLY=true ;;
    --validate-only) VALIDATE_ONLY=true ;;
  esac
done

echo "════════════════════════════════════════════════════════════"
echo " Pipeline: $GROUP_ID"
echo "════════════════════════════════════════════════════════════"
echo ""

if [[ "$VALIDATE_ONLY" == "false" ]]; then
  echo "── Stage 1: Topic Discovery ─────────────────────────────────"
  bash "$REPO_ROOT/tools/01_discover_topics.sh"
  echo ""

  echo "── Stage 2: Surface ─────────────────────────────────────────"
  bash "$REPO_ROOT/tools/02_surface.sh" "$GROUP_ID"
  echo ""
fi

if [[ "$SURFACE_ONLY" == "false" ]]; then
  echo "── Stage 3: Validate ────────────────────────────────────────"
  bash "$REPO_ROOT/tools/03_validate.sh"
  echo ""
fi

echo "════════════════════════════════════════════════════════════"
echo " Done. Results in findings/validated/ and public/data/"
echo "════════════════════════════════════════════════════════════"
