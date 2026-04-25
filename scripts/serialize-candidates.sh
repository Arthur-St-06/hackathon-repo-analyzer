#!/usr/bin/env bash
set -euo pipefail

INPUT_PATH="${1:-data/candidates.json}"
OUTPUT_PATH="${2:-debug/surface_input_preview.txt}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

ISSUE_LINES="$(jq -r '
  def lc: ascii_downcase;
  def labels_lc: (.labels // [] | map(lc));
  def title_lc: (.title // "" | lc);

  def has_bug:
    (labels_lc | any(test("bug|correctness")))
    or (title_lc | test("bug|incorrect|wrong|fails|failure|crash|assert|runtimeerror|nan|inf|uninitialized"));

  def has_reg:
    (labels_lc | any(contains("regression")))
    or (title_lc | test("regression|regress"));

  def has_perf:
    (labels_lc | any(contains("performance")))
    or (title_lc | test("slow|slower|slowdown|performance|throughput|latency"));

  def signal_codes:
    [
      if has_bug then "B" else empty end,
      if has_reg then "REG" else empty end,
      if has_perf then "PERF" else empty end
    ]
    | if length == 0 then "-" else join(",") end;

  .[]
  | "\(.number) | \((.createdAt // "")[0:4]) | \(.state) | \(signal_codes) | \(.title)"
' "$INPUT_PATH")"

{
  echo "LABELS:"
  echo "B = bug"
  echo "REG = regression"
  echo "PERF = performance"
  echo
  echo "ISSUES:"
  printf "%s\n" "$ISSUE_LINES"
} > "$OUTPUT_PATH"

CHAR_COUNT="$(wc -c < "$OUTPUT_PATH" | tr -d '[:space:]')"
ESTIMATED_TOKENS=$(( (CHAR_COUNT + 3) / 4 ))

echo >> "$OUTPUT_PATH"
echo "ESTIMATED_TOKENS: $ESTIMATED_TOKENS" >> "$OUTPUT_PATH"

echo "wrote: $OUTPUT_PATH"
echo "characters: $CHAR_COUNT"
echo "estimated tokens: $ESTIMATED_TOKENS"
