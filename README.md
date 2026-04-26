# PyTorch Bug Research Pipeline

A multi-agent pipeline that automatically identifies, triages, and validates contributor-fixable bugs in [pytorch/pytorch](https://github.com/pytorch/pytorch). It clusters open issues into topic groups, surfaces the highest-signal candidates, and validates each one with live GitHub data and an LLM — then presents the results in a browser UI.

---

## Quick start

```bash
# Prerequisites: Python 3, Claude Code CLI (`claude`), GitHub CLI (`gh`) authenticated
gh auth login          # if not already done
python3 server.py      # serves at http://localhost:8080
```

Open **http://localhost:8080**, click **Load Topics**, pick a group, click **Run Analysis**.

---

## Full workflow

### 1 — Discover topic groups (`tools/01_discover_topics.sh`)

Fetches open issues from `pytorch/pytorch` and clusters them by label co-occurrence into named topic areas (e.g. "CUDA and Distributed", "CPU Performance", "Autograd and Correctness").

```
data/topics.json            raw label clusters
data/topic_groups.json      merged, named groups with open-issue counts
public/data/topic_groups.json  copy served to the UI
```

This step runs once and is reused until you re-run it. The UI loads this file to populate the sidebar.

### 2 — Surface raw findings (`tools/02_surface.sh <group_id> [limit]`)

Scores every open issue in the selected group against a set of domain rules (exclusion filters, inclusion gates, priority tiers) without making any LLM calls. The top-N issues by score are written as raw finding JSON.

```
findings/raw/pytorch_<N>.json     one file per candidate issue
```

Hard exclusions (distributions, RNN, dataloader, mobile, ONNX, …) are applied first. Inclusion criteria: CUDA/linalg labels, kernel terms in title, or `correctness (silent)` label. Issues are ranked by a scoring formula and the top candidates are kept.

### 3 — Validate findings (`tools/03_validate.sh [issue_numbers…]`)

Runs a hybrid validator on each raw finding in parallel:

1. **Precheck** (`scripts/precheck_issue.py`) — fast pattern-match for hard blockers without any LLM call (closed issue, spam, duplicate, etc.).
2. **Pre-fetch** — fetches full issue data, linked PRs via `gh search prs`, and cross-reference timeline via the GitHub API.
3. **Haiku classification** (`scripts/validate_issue.py`) — sends maintainer comments to `claude-haiku` with a focused system prompt; classifies each into a `signal_type` (`approved_fix`, `wont_fix`, `fixed_elsewhere`, `blocked_action`, …).
4. **Python scoring** — deterministic confidence formula (base 0.50, additive adjustments for repro script, triaged label, maintainer signals, PR status, issue age). Hard blockers (`already_fixed`, `maintainer_wont_fix`, `fixed_elsewhere`) force a skip regardless of score.
5. **Output routing** — findings with confidence ≥ 0.75 are written to `findings/validated/`; everything else is skipped.

After all validators finish, the script aggregates `findings/validated/*.json` into `public/data/findings.json`.

### 4 — Browse results (web UI)

`server.py` is a single-file dev server (Python stdlib only) that:

- Serves static files from `public/`
- Exposes `POST /api/run/<group_id>` which streams the full pipeline (stages 2 + 3) as Server-Sent Events (SSE)
- Writes per-group result files (`public/data/findings_<group_id>.json`) so results from different groups persist independently

The UI lets you:
- Browse all topic groups in a sidebar with finding counts
- Run the pipeline for any group and watch live progress
- Switch between groups without losing previously loaded results
- Expand any issue card for full detail: confidence breakdown, maintainer signals, linked PRs, recommended action

---

## Architecture

```
server.py                   Dev server + SSE pipeline endpoint
├── tools/
│   ├── 01_discover_topics.sh   Fetch + cluster open issues
│   ├── 02_surface.sh           Score + filter to raw findings
│   ├── 03_validate.sh          Parallel validation + aggregation
│   └── run_pipeline.sh         CLI wrapper for all three stages
├── scripts/
│   ├── discover_topics.py      Label co-occurrence clustering
│   ├── score_issues.py         Domain scoring rules
│   ├── precheck_issue.py       Fast pre-filter (no LLM)
│   └── validate_issue.py       Haiku classification + Python scorer
├── public/
│   ├── index.html              Single-file browser UI
│   └── data/
│       ├── topic_groups.json           Sidebar data
│       ├── findings_index.json         Which groups have been run
│       ├── findings_<group_id>.json    Per-group validated findings
│       └── findings.json               Latest run (also kept for compat)
├── findings/
│   ├── raw/                    Surfaced candidates (cleared each run)
│   ├── validated/              Validated findings (confidence ≥ 0.75)
│   └── cache/                  Validation cache keyed by issue + labels
└── data/
    ├── topic_groups.json       Source of truth for group list
    └── selected_topics.json    Active group selection
```

---

## Validation cache

Validated findings are cached in `findings/cache/` keyed by issue number. On subsequent runs, if a cached finding's issue labels haven't changed and the cache version matches, the validator is skipped and the cached result is used directly. This saves API calls and time when re-running the same group.

Cache is invalidated when:
- Any of the issue's labels change
- `CACHE_VERSION` in `server.py` is bumped

---

## Confidence scoring

| signal | adjustment |
|---|---|
| `correctness (silent)` label | +0.25 |
| maintainer `approved_fix` or `requested_merge` | +0.20 each |
| repro script present | +0.15 |
| `triaged` label | +0.10 |
| fix scope is single file | +0.10 |
| issue open ≥ 2 years | +0.05 |
| already fixed (merged PR) | −0.45 |
| `wont_fix` or `blocked_action` signal | −0.40 |
| open PR exists (active work) | −0.40 per PR |
| abandoned PR | −0.25 per PR |
| `by_design` signal | −0.15 |
| stale with no maintainer comment (≥ 3 years) | −0.05 |

Hard blockers (`already_fixed`, `maintainer_wont_fix`, `maintainer_blocked_action`, `fixed_elsewhere`) cause the finding to be skipped regardless of score. Threshold for inclusion: **0.75**.

---

## Running from the CLI

```bash
# Full pipeline for a group
./tools/run_pipeline.sh cuda_and_distributed

# Just surface (no validation)
./tools/run_pipeline.sh cpu_performance --surface-only

# Re-validate without re-surfacing
./tools/run_pipeline.sh cpu_performance --validate-only

# Validate specific issue numbers
bash tools/03_validate.sh 113956 152028 173638
```

Available group IDs are printed when you run `run_pipeline.sh` with no arguments (requires `data/topic_groups.json` to exist).

---

## Prerequisites

| tool | purpose |
|---|---|
| Python 3.10+ | server, scripts |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Haiku classification in validator |
| [GitHub CLI](https://cli.github.com/) (`gh`) | Issue/PR fetching, authentication |

```bash
gh auth login   # authenticate once
python3 server.py
```

No pip dependencies — everything uses the standard library or tools above.
