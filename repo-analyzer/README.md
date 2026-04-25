# Repo Analyzer

Deterministic surface + validator pipeline for PyTorch issue triage, with user-readable findings and summary views.

## Requirements

- Node.js 20+
- A GitHub token for higher API limits:
	- `GITHUB_TOKEN` or `GH_TOKEN`

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create local environment file at `.env.local`:

```bash
GITHUB_TOKEN=your_token_here
ENABLE_CLAUDE_CLI=true
# Optional override. If omitted, app defaults to Haiku.
CLAUDE_CLI_MODEL=haiku
```

3. Start development server:

```bash
npm run dev
```

## Operator Workflow

1. Run Surface analysis in the UI.
2. Run Validator for a finding id.
3. Review Findings (User View) cards.
4. Review Findings Summary panel.
5. Export markdown report from `/api/findings/report`.

## Main Endpoints

- `POST /api/surface/run`
- `POST /api/validator/run`
- `GET /api/findings/list?limit=30`
- `GET /api/findings/summary`
- `GET /api/findings/report`

## Hardening Included

- Validator output schema validation against `schema/finding.schema.json`
- Confidence sanity checks that auto-route suspicious outputs to `needs_review`
- User-readable presenter layer for findings cards
- Deterministic summary aggregation and markdown export

## Notes

- Findings are stored outside this app folder in workspace-level directories:
	- `findings/raw`
	- `findings/validated`
	- `findings/needs_review`
	- `findings/rejected`
