#!/usr/bin/env bash
# Deprecated: this was an initial dry run to test the data fetching and prompt formatting.
# See run-claude-surface.sh for the actual surface triage run.
set -euo pipefail

REPO="${1:-pytorch/pytorch}"
MAX_ISSUES="${2:-50}"

mkdir -p data debug

FETCH_OUT="data/${REPO//\//_}_open_issues_${MAX_ISSUES}_metadata.json"
CAND_OUT="data/candidates.json"
REJ_OUT="data/rejected.json"
PREVIEW_OUT="debug/surface_input_preview.txt"

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

PAGES=$(( (MAX_ISSUES + 99) / 100 + 2 ))

RESPONSES=""
for ((p=1; p<=PAGES; p++)); do
  RESPONSES+="$(curl -sL "https://api.github.com/repos/${OWNER}/${NAME}/issues?state=open&per_page=100&page=${p}")"
  RESPONSES+=$'\n'
done

printf "%s" "$RESPONSES" | jq -s --argjson max "$MAX_ISSUES" '
  [ .[] | if type=="array" then .[] else empty end ]
  | [ .[]
      | select(.pull_request|not)
      | {
          number,
          title,
          labels: (.labels | map(.name)),
          state: (.state | ascii_upcase),
          createdAt: .created_at,
          url: .html_url
        }
    ][0:$max]
' > "$FETCH_OUT"

jq '
  def lc: ascii_downcase;
  def labels_lc: (.labels // [] | map(lc));
  def title_lc: (.title // "" | lc);
  def is_open: ((.state // "" | lc) == "open");
  def disabled_title: (title_lc | startswith("disabled"));
  def skipped_label: (labels_lc | any(. | contains("skipped")));
  def label_signal: (labels_lc | any(. | test("bug|correctness|regression|performance")));
  def title_signal: (title_lc | test("bug|incorrect|wrong|regression|slow|slower|performance|crash|assert|runtimeerror|fails|failure|diverge|nan|inf|uninitialized"));
  map(select(is_open and (disabled_title|not) and (skipped_label|not) and (label_signal or title_signal)))
' "$FETCH_OUT" > "$CAND_OUT"

jq '
  def lc: ascii_downcase;
  def labels_lc: (.labels // [] | map(lc));
  def title_lc: (.title // "" | lc);
  def is_open: ((.state // "" | lc) == "open");
  def disabled_title: (title_lc | startswith("disabled"));
  def skipped_label: (labels_lc | any(. | contains("skipped")));
  def label_signal: (labels_lc | any(. | test("bug|correctness|regression|performance")));
  def title_signal: (title_lc | test("bug|incorrect|wrong|regression|slow|slower|performance|crash|assert|runtimeerror|fails|failure|diverge|nan|inf|uninitialized"));
  map(select((is_open and (disabled_title|not) and (skipped_label|not) and (label_signal or title_signal)) | not))
' "$FETCH_OUT" > "$REJ_OUT"

./scripts/serialize-candidates.sh "$CAND_OUT" "$PREVIEW_OUT" >/dev/null

FETCHED_COUNT="$(jq 'length' "$FETCH_OUT")"
UNIQUE_LABELS="$(jq '[ .[] | .labels[]? ] | unique | length' "$FETCH_OUT")"
CANDIDATE_COUNT="$(jq 'length' "$CAND_OUT")"
REJECTED_COUNT="$(jq 'length' "$REJ_OUT")"
ESTIMATED_TOKENS="$(tail -n 1 "$PREVIEW_OUT" | sed -E 's/.*: *([0-9]+).*/\1/' | awk '{printf "%\047d", $1}')"

echo "Repo: $REPO"
echo "Max issues: $MAX_ISSUES"
echo "Fetched: $FETCHED_COUNT"
echo "Unique labels: $UNIQUE_LABELS"
echo "Candidates after prefilter: $CANDIDATE_COUNT"
echo "Rejected: $REJECTED_COUNT"
echo "Surface input preview saved: $PREVIEW_OUT"
echo "Estimated Claude input tokens: $ESTIMATED_TOKENS"
echo "Claude call: disabled"
