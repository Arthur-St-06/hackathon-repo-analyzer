#!/usr/bin/env bash
set -euo pipefail

DEFAULT_APP_PREVIEW="repo-analyzer/debug/surface_input_preview.txt"
DEFAULT_ROOT_PREVIEW="debug/surface_input_preview.txt"
OUTPUT_DIR="repo-analyzer/debug/claude"

INPUT_PATH="${1:-}"

if [[ -z "$INPUT_PATH" ]]; then
  if [[ -f "$DEFAULT_APP_PREVIEW" ]]; then
    INPUT_PATH="$DEFAULT_APP_PREVIEW"
  elif [[ -f "$DEFAULT_ROOT_PREVIEW" ]]; then
    INPUT_PATH="$DEFAULT_ROOT_PREVIEW"
  else
    echo "error: no surface preview file found."
    echo "expected one of:"
    echo "  - $DEFAULT_APP_PREVIEW"
    echo "  - $DEFAULT_ROOT_PREVIEW"
    echo "or pass an explicit path: ./scripts/run-claude-surface.sh <preview-file>"
    exit 1
  fi
fi

if [[ ! -f "$INPUT_PATH" ]]; then
  echo "error: input file not found: $INPUT_PATH"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI is not installed or not on PATH."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

RUN_TS="$(date +%Y%m%d_%H%M%S)"
PROMPT_PATH="$OUTPUT_DIR/surface_prompt_${RUN_TS}.txt"
RESPONSE_PATH="$OUTPUT_DIR/surface_response_${RUN_TS}.md"

cat > "$PROMPT_PATH" <<'PROMPT_HEADER'
You are a surface triage assistant for GitHub issues.

Task:
- Read the compact issue preview below.
- Return contributor-friendly suggestions.
- Keep output concise and actionable.

Output format:
1. Top 5 candidate issues (best first)
   - issue number
   - 1-sentence rationale
   - one suggested next step
2. 3 quick triage rules to improve deterministic filtering
3. 3 risks or blind spots in this candidate set

Constraints:
- No markdown tables
- Max 2 sentences per bullet
- Prefer concrete next steps over background explanation

=== SURFACE INPUT PREVIEW START ===
PROMPT_HEADER

cat "$INPUT_PATH" >> "$PROMPT_PATH"

cat >> "$PROMPT_PATH" <<'PROMPT_FOOTER'
=== SURFACE INPUT PREVIEW END ===
PROMPT_FOOTER

if claude --help 2>/dev/null | grep -q -- "-p"; then
  claude -p "$(cat "$PROMPT_PATH")" | tee "$RESPONSE_PATH"
else
  cat "$PROMPT_PATH" | claude | tee "$RESPONSE_PATH"
fi

echo "prompt:   $PROMPT_PATH"
echo "response: $RESPONSE_PATH"
