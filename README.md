# pytorch-agents-learning

A multi-agent pipeline that automatically identifies, triages, and validates contributor-fixable bugs in [pytorch/pytorch](https://github.com/pytorch/pytorch).

The pipeline scans open GitHub issues, applies domain filtering, scores each finding with a confidence model, and produces structured JSON ready for a contributor to act on.

---

## Results (current run)

| stat | count |
|---|---|
| Issues analyzed | 1,120 |
| Total findings | 55 |
| **Actionable** (confidence ≥ 0.75) | **21** |
| Needs human review (0.40–0.74) | 25 |
| Rejected | 9 |
| Abandoned PRs to revive | 12 |

**By bug class:**
- Silent correctness bugs (`module: correctness (silent)`) — 32
- Performance regressions — 12
- Missing fast paths — 9

**Top findings:**

| confidence | finding | action |
|---|---|---|
| 1.00 | [matmul returns uninitialized memory for int64 (zero inner dim)](findings/validated/pytorch_71774.json) | revive_abandoned_pr |
| 0.95 | [linalg.slogdet does not propagate NaN in CUDA](findings/validated/pytorch_173638.json) | file_pr |
| 0.95 | [baddbmm on CPU wrong results under certain conditions](findings/validated/pytorch_136299.json) | revive_abandoned_pr |
| 0.90 | [linalg.lstsq triggers UBSan RuntimeError (albanD: "we'll accept a simple PR")](findings/validated/pytorch_88941.json) | file_pr |
| 0.90 | [SDPA wrong results with sliding window attention](findings/validated/pytorch_162362.json) | file_pr |
| 0.90 | [CUDA MultiheadAttention + bool mask + dropout → NaNs](findings/validated/pytorch_152028.json) | file_pr |

All validated findings include a `contribution_path` field with step-by-step instructions for reviving the fix.

---

## Pipeline

```
GitHub issues corpus
       │
       ▼
 ┌─────────────┐
 │ surface     │  triage-only, no API calls
 │ agent       │  domain filter → raw findings JSON
 └─────────────┘
       │  findings/raw/*.json
       ▼
 ┌─────────────┐
 │ validator   │  live gh CLI investigation
 │ agent       │  confidence scoring, PR archaeology
 └─────────────┘
       │
       ├── findings/validated/     confidence ≥ 0.75
       ├── findings/needs_review/  confidence 0.40–0.74
       └── findings/rejected/      confidence < 0.40 or hard blocker
```

### Surface agent ([`agents/surface.md`](agents/surface.md))

Reads issue metadata (title, labels, body preview) and applies:

1. **D1 hard exclusions** — distributions, RNN, dataloader, optimizer, ONNX, mobile, Android, iOS
2. **D2 inclusion gate** — must carry CUDA/linalg labels, or have kernel terms in the title (`cuda`, `matmul`, `conv`, `gemm`, `sdpa`, …), or be a `correctness (silent)` bug in a linear algebra op
3. **Priority tiers** — P1 (`correctness (silent)`), P2 (quantified regression), P3 (perf + repro), P4 (actionable label)

Output: raw finding JSON with `stage: "raw"` and `confidence: null`.

### Validator agent ([`agents/validator.md`](agents/validator.md))

Takes a raw finding and runs live `gh` CLI queries:

1. Fetch full issue body and comments
2. Classify maintainer signals (`approved_fix`, `blocked_action`, `wont_fix`, `by_design`, …)
3. Search for linked PRs; fetch merge status, reviews, abandoned reason
4. Detect hard blockers (`maintainer_blocked_action`, `already_fixed`, `maintainer_wont_fix`)
5. Score confidence (base 0.50, additive adjustments, clamped to [0.0, 1.0])
6. Assign `recommended_action` (`file_pr`, `revive_abandoned_pr`, `contribute_to_active_pr`, `reject`)
7. Generate `contribution_path` steps for `revive_abandoned_pr` findings

**Hard blocker examples** (force reject regardless of score):
- `maintainer_blocked_action` — "the problem is within MAGMA and we don't have control over it"
- `already_fixed` — collaborator confirmed fixed on main
- `maintainer_wont_fix` — explicit rejection

---

## Schema

Every finding is a JSON object validated against [`schema/finding.schema.json`](schema/finding.schema.json) (JSON Schema draft-07). The schema enforces staged validation:

- `stage: "raw"` → `confidence` must be `null`
- `stage: "validated" | "needs_review" | "rejected"` → all Layer 2/3 fields required

See [`schema/finding_example.json`](schema/finding_example.json) for a fully populated example (issue #71774, the ground truth positive case).

### Key fields

```jsonc
{
  "finding_id": "pytorch_71774",
  "confidence": 0.92,                  // [0.0, 1.0] or null if raw
  "recommended_action": "revive_abandoned_pr",
  "stage": "validated",
  "linked_prs": [...],                 // PR number, state, merged, abandoned_reason
  "maintainer_signals": [...],         // author, role, signal_type, quote
  "blocking_signals": [...],           // free-text list of what prevents action
  "contribution_path": [               // only on revive_abandoned_pr findings
    { "step": 1, "title": "...", "description": "...", "link": "...", "warning": "..." },
    ...
  ]
}
```

---

## Data files

| path | description |
|---|---|
| `public/data/findings.json` | All validated + needs_review findings merged, sorted by confidence |
| `public/data/summary.json` | Aggregate stats for the current run |
| `data/ground_truth.json` | 3 hand-verified anchor cases used to calibrate the classifier |

---

## Running the pipeline

The agents are system prompts for Claude — paste the contents of `agents/surface.md` or `agents/validator.md` as the system prompt, then provide the issue data as the user message.

**Surface agent** — provide a batch of issue metadata objects (title, labels, body preview):
```
Input:  issue list JSON
Output: findings/raw/*.json
```

**Validator agent** — provide a single raw finding JSON:
```
Input:  findings/raw/pytorch_NNNNN.json
Output: findings/{validated,needs_review,rejected}/pytorch_NNNNN.json
```

The validators can be run in parallel batches (5–7 findings per agent) without coordination — each writes to its own output file.

---

## Ground truth

Three manually verified anchor cases in [`data/ground_truth.json`](data/ground_truth.json):

| id | verdict | key signal |
|---|---|---|
| #71774 | **positive** | `correctness (silent)` + approved PR + uninitialized memory repro |
| #76962 | **noise** | CI test-disable tracker, not a fixable bug |
| #72408 | **ambiguous** | Real perf issue, but maintainer: "no real way to act on this" |
