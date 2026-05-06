# IssueSignal
Rank GitHub issues by relevance, quality, and contributor fit. 

# What does it do?
It is a multi-agent pipeline that automatically identifies, triages, and validates contributor-fixable bugs in any GitHub repository. It clusters open issues into topic groups, surfaces the highest-signal candidates, and validates each one with live GitHub data and an LLM — then presents the results in a browser UI.

---

## Quick start

```bash
# Prerequisites: Python 3, Claude Code CLI (`claude`), GitHub CLI (`gh`) authenticated
gh auth login          # if not already done
python3 server.py      # serves at http://localhost:8080
```

Open **http://localhost:8080**, enter a GitHub repository URL (e.g. `https://github.com/pytorch/pytorch`), and the pipeline will fetch issues and discover topic groups automatically.

---

## Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser  http://localhost:8080                                      │
│                                                                      │
│  ① Repo input ──────────────────────────────────────────────────►  │
│                         POST /api/discover  (SSE)                   │
│                                │                                     │
│                   ┌────────────▼────────────┐                       │
│                   │  01_discover_topics.sh   │                       │
│                   │  • gh issue list         │                       │
│                   │  • Jaccard clustering    │                       │
│                   │  • Haiku: name groups    │                       │
│                   └────────────┬────────────┘                       │
│                                │ topic_groups.json                   │
│                                ▼                                     │
│  ② Topic sidebar loads  ◄──────────────────────────────────────    │
│     (custom search box available)                                    │
│                                                                      │
│  ③ Click group / enter custom term ──────────────────────────────► │
│                         POST /api/run/<group_id>  (SSE)             │
│                                │                                     │
│              ┌─────────────────▼──────────────────┐                │
│              │  02_surface.sh                       │                │
│              │  • corpus pre-score (no LLM)         │                │
│              │  • gh issue view (top N bodies)      │                │
│              │  • write findings/raw/*.json         │                │
│              └─────────────────┬──────────────────┘                │
│                                │                                     │
│              ┌─────────────────▼──────────────────┐                │
│              │  03_validate.sh  (parallel)          │                │
│              │  ┌────────────────────────────────┐  │               │
│              │  │ per finding:                   │  │               │
│              │  │  precheck_issue.py  (no LLM)   │  │               │
│              │  │  gh search prs + timeline      │  │               │
│              │  │  validate_issue.py             │  │               │
│              │  │   └─ Haiku: classify comments  │  │               │
│              │  │   └─ Python: confidence score  │  │               │
│              │  │  → validated/ if score ≥ 0.75  │  │               │
│              │  └────────────────────────────────┘  │               │
│              └─────────────────┬──────────────────┘                │
│                                │ findings_<group_id>.json           │
│                                ▼                                     │
│  ④ Results render  ◄───────────────────────────────────────────    │
│     flat cards, sorted by confidence then recency                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Full workflow

### 1 — Discover topic groups  (`tools/01_discover_topics.sh --repo owner/repo`)

Fetches up to 10,000 open issues from any GitHub repository and clusters them by label co-occurrence into named topic areas. The corpus is cached per-repo so re-runs are instant unless `--fresh` is passed.

```
data/corpus_<owner>_<repo>.json    cached issue index
data/topics.json                   per-label stats
data/topic_groups.json             merged, named groups with open-issue counts
```

Clustering uses Jaccard similarity with a size-balance penalty so large label sets don't snowball into one giant group. Groups are named by a single Haiku call. Results are stable across runs for the same corpus.

### 2 — Surface raw findings  (`tools/02_surface.sh <group_id> [--top N] [--repo owner/repo]`)

Scores every open issue in the selected group against domain rules without LLM calls. The top-N issues by score are written as raw finding JSON.

```
findings/raw/<repo_slug>_<issue_number>.json
```

File naming uses the repo slug (`pytorch`, `transformers`, etc.) so findings from different repos never collide.

### 3 — Validate findings  (`tools/03_validate.sh [issue_numbers…]`)

Runs a hybrid validator on each raw finding in parallel:

1. **Precheck** (`scripts/precheck_issue.py`) — fast pattern-match for hard blockers with no LLM call.
2. **Pre-fetch** — fetches full issue data, linked PRs via `gh search prs`, and cross-reference timeline via GitHub API.
3. **Haiku classification** (`scripts/validate_issue.py`) — classifies maintainer comments into signal types (`approved_fix`, `wont_fix`, `fixed_elsewhere`, `scoped_bug`, …).
4. **Python scoring** — deterministic confidence formula (see table below). Hard blockers force a skip.
5. **Output routing** — findings with confidence ≥ 0.75 written to `findings/validated/`; rest skipped.

### 4 — Browse results (web UI)

`server.py` is a single-file dev server (Python stdlib only) that:

- Serves static files from `public/`
- Streams `POST /api/discover` — runs topic discovery for any repo as SSE
- Streams `POST /api/run/<group_id>` — runs the surface + validate pipeline as SSE
- Writes per-group result files (`public/data/findings_<group_id>.json`) so results from different groups persist independently

The UI lets you:
- Enter any GitHub repo URL to fetch and cluster its issues
- Browse all topic groups in a sidebar with finding counts
- Type a custom label search (e.g. `cuda`) to surface issues matching that term
- Run the pipeline for any group and watch live progress
- View flat issue cards sorted by confidence then recency, showing labels, hw/repro chips, and maintainer signal summary

---

## Architecture

```
server.py                       Dev server + SSE pipeline endpoints
├── tools/
│   ├── 01_discover_topics.sh   Fetch corpus + cluster labels + name groups
│   ├── 02_surface.sh           Score + filter issues → raw findings
│   └── 03_validate.sh          Parallel validation + aggregation
├── scripts/
│   ├── discover_topics.py      Jaccard clustering + Haiku naming
│   ├── score_issues.py         Domain scoring rules (no LLM)
│   ├── precheck_issue.py       Fast pre-filter (no LLM)
│   └── validate_issue.py       Haiku comment classification + Python scorer
├── public/
│   ├── index.html              Single-file browser UI (vanilla JS)
│   └── data/
│       ├── findings_index.json         Which groups have results
│       └── findings_<group_id>.json    Per-group validated findings
├── findings/
│   ├── raw/                    Surfaced candidates (cleared each run)
│   ├── validated/              Validated findings (confidence ≥ 0.75)
│   └── cache/                  Validation cache keyed by issue + labels
└── data/
    ├── corpus_<owner>_<repo>.json   Cached issue index per repo
    ├── topic_groups.json            Source of truth for group list
    └── selected_topics.json         Active group selection
```

---

## Validation cache

Validated findings are cached in `findings/cache/`. On subsequent runs, if a cached finding's issue labels haven't changed and the cache version matches, the validator is skipped. This saves API calls when re-running the same group.

Cache is invalidated when any of the issue's labels change or `CACHE_VERSION` in `server.py` is bumped.

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

Hard blockers (`already_fixed`, `maintainer_wont_fix`, `maintainer_blocked_action`, `fixed_elsewhere`) cause the finding to be skipped regardless of score. Inclusion threshold: **0.75**.

---

## Prerequisites

| tool | purpose |
|---|---|
| Python 3.10+ | server, scripts |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | Haiku classification in validator |
| [GitHub CLI](https://cli.github.com/) (`gh`) | Issue/PR fetching, authentication |

```bash
gh auth login      # authenticate once
python3 server.py  # start the server
```

No pip dependencies — everything uses the standard library or the tools above.
