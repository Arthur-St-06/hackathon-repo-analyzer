#!/usr/bin/env bash
set -euo pipefail

# Preferred entrypoint for deterministic surface analysis.
# Legacy compatibility is preserved by delegating to run-surface-dry-run.sh.
./scripts/run-surface-dry-run.sh "$@"
