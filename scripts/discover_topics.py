#!/usr/bin/env python3
"""
discover_topics.py — Pure-Python topic discovery + Haiku group naming.

  1. Read corpus_full.json
  2. Compute per-label stats          → data/topics.json      (~0.03s, Python)
  3. Jaccard co-occurrence clustering → raw groups            (~0.03s, Python)
  4. Single Haiku call to name groups → data/topic_groups.json (~15s)

Usage:
  python3 scripts/discover_topics.py
"""

import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT   = Path(__file__).parent.parent
CORPUS      = REPO_ROOT / "data" / "corpus_full.json"
TOPICS_OUT  = REPO_ROOT / "data" / "topics.json"
GROUPS_OUT  = REPO_ROOT / "data" / "topic_groups.json"
HAIKU_MODEL = "claude-haiku-4-5-20251001"

DISPLAY_OVERRIDES = {
    "module: cuda":                          "CUDA",
    "module: mkl":                           "MKL",
    "module: mkldnn":                        "MKL-DNN",
    "module: ddp":                           "DistributedDataParallel",
    "module: nccl":                          "NCCL",
    "module: c10d":                          "c10d (distributed backend)",
    "module: fft":                           "FFT",
    "module: rnn":                           "RNN",
    "module: amp (automated mixed precision)":"Automatic Mixed Precision",
    "module: mps":                           "MPS (Apple Silicon)",
    "module: rocm":                          "ROCm",
    "module: sdpa":                          "Scaled Dot-Product Attention",
    "module: cublas":                        "cuBLAS",
    "module: cudnn":                         "cuDNN",
    "module: triton":                        "Triton",
    "module: linear algebra":                "Linear Algebra",
    "module: correctness (silent)":          "Correctness (Silent)",
    "module: xpu":                           "XPU",
}


def get_labels(issue: dict) -> list[str]:
    return [l if isinstance(l, str) else l.get("name", "") for l in issue.get("labels", [])]


def make_slug(label: str) -> str:
    s = label.removeprefix("module: ")
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def make_display(label: str) -> str:
    if label in DISPLAY_OVERRIDES:
        return DISPLAY_OVERRIDES[label]
    s = label.removeprefix("module: ")
    return " ".join(w.capitalize() for w in s.split())


def actionability(label: str, open_count: int) -> str:
    score = 0
    if open_count >= 50:  score += 1
    if open_count >= 200: score += 1
    if any(k in label for k in ("correctness", "linear algebra", "cuda", "performance", "regression")):
        score += 1
    if not any(b in label for b in ("ci", "build", "docs", "mobile", "android", "ios")):
        score += 1
    return "high" if score >= 3 else "medium" if score == 2 else "low"


# ── Stage 1: per-label stats ──────────────────────────────────────────────────

def compute_topics(issues: list[dict]) -> list[dict]:
    label_issues: dict[str, list] = defaultdict(list)
    label_open:   dict[str, list] = defaultdict(list)
    label_recent: dict[str, list] = defaultdict(list)

    issue_created = {i["number"]: i.get("createdAt", "") for i in issues}

    for iss in issues:
        num     = iss["number"]
        is_open = iss.get("state", "") == "OPEN"
        recent  = iss.get("createdAt", "") >= "2023-01-01"
        for lbl in get_labels(iss):
            if not lbl.startswith("module:"):
                continue
            label_issues[lbl].append(num)
            if is_open:
                label_open[lbl].append(num)
                if recent:
                    label_recent[lbl].append(num)

    topics = []
    for label in label_issues:
        total = len(label_issues[label])
        open_ = sorted(label_open[label], key=lambda n: issue_created.get(n, ""))
        topics.append({
            "label":              label,
            "slug":               make_slug(label),
            "display_name":       make_display(label),
            "issue_count":        total,
            "open_count":         len(open_),
            "open_pct":           round(len(open_) / total, 2) if total else 0.0,
            "recent_open_count":  len(label_recent[label]),
            "actionability_hint": actionability(label, len(open_)),
            "description":        f"Bugs in the {make_display(label)} module.",
            "sample_issues":      open_[:5],
        })

    topics.sort(key=lambda t: -t["open_count"])
    return topics


# ── Stage 2: Jaccard co-occurrence clustering ─────────────────────────────────

def cluster_labels(issues: list[dict], topics: list[dict],
                   min_open: int = 10, target: int = 20) -> list[list[str]]:
    eligible = {t["label"] for t in topics if t["open_count"] >= min_open}

    co:   dict[tuple, int] = defaultdict(int)
    solo: dict[str, int]   = defaultdict(int)
    for iss in issues:
        lbls = [l for l in get_labels(iss) if l in eligible]
        for l in lbls:
            solo[l] += 1
        for i, a in enumerate(lbls):
            for b in lbls[i + 1:]:
                co[(min(a, b), max(a, b))] += 1

    def jaccard(a: str, b: str) -> float:
        inter = co[(min(a, b), max(a, b))]
        union = solo[a] + solo[b] - inter
        return inter / union if union > 0 else 0.0

    clusters: list[set[str]] = [{lbl} for lbl in eligible]

    while len(clusters) > target:
        best, bi, bj = -1.0, 0, 1
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                sims = [jaccard(a, b) for a in clusters[i] for b in clusters[j]]
                avg  = sum(sims) / len(sims) if sims else 0.0
                if avg > best:
                    best, bi, bj = avg, i, j
        if best < 0.02:
            break
        merged = clusters[bi] | clusters[bj]
        clusters = [c for k, c in enumerate(clusters) if k not in (bi, bj)]
        clusters.append(merged)

    return [sorted(c) for c in clusters]


# ── Stage 3: name clusters with one Haiku call ────────────────────────────────

def name_clusters(clusters: list[list[str]], by_label: dict) -> list[dict]:
    blocks = []
    for i, cluster in enumerate(clusters):
        members = "\n".join(
            f"  - {by_label[l]['display_name']} ({by_label[l]['open_count']} open)"
            for l in cluster if l in by_label
        )
        open_total = sum(by_label[l]["open_count"] for l in cluster if l in by_label)
        blocks.append(f"GROUP {i} ({open_total} open issues total):\n{members}")

    prompt = (
        "Name each group of PyTorch issue labels for a contributor-facing bug research tool.\n"
        "Return ONLY a JSON array — no markdown, no explanation.\n"
        "Each element: {\"group\": <index>, \"display_name\": \"<3-6 words>\", "
        "\"description\": \"<one sentence>\", \"actionability\": \"high|medium|low\"}\n\n"
        + "\n\n".join(blocks)
    )

    result = subprocess.run(
        ["claude", "--print", "--model", HAIKU_MODEL,
         "--dangerously-skip-permissions", "-p", prompt],
        capture_output=True, text=True, timeout=90,
    )

    name_map: dict[int, dict] = {}
    if result.returncode == 0:
        m = re.search(r"\[.*\]", result.stdout.strip(), re.DOTALL)
        if m:
            try:
                name_map = {item["group"]: item for item in json.loads(m.group())}
            except (json.JSONDecodeError, KeyError):
                pass

    groups = []
    for i, cluster in enumerate(clusters):
        info       = name_map.get(i, {})
        open_total = sum(by_label[l]["open_count"] for l in cluster if l in by_label)
        raw_name   = info.get("display_name") or by_label.get(cluster[0], {}).get("display_name", f"Group {i}")
        group_id   = re.sub(r"[^a-z0-9]+", "_", raw_name.lower()).strip("_")[:40]
        groups.append({
            "group_id":          group_id,
            "display_name":      raw_name,
            "description":       info.get("description", ""),
            "actionability":     info.get("actionability", "medium"),
            "labels":            cluster,
            "label_count":       len(cluster),
            "total_open_issues": open_total,
        })

    groups.sort(key=lambda g: -g["total_open_issues"])
    return groups


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Reading corpus...", end=" ", flush=True)
    with open(CORPUS) as f:
        issues = json.load(f)
    print(f"{len(issues)} issues")

    print("Computing per-label stats...", end=" ", flush=True)
    topics    = compute_topics(issues)
    by_label  = {t["label"]: t for t in topics}
    now       = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    topics_payload = {
        "generated_at": now,
        "corpus_file":  "data/corpus_full.json",
        "total_issues": len(issues),
        "topics":       topics,
    }
    TOPICS_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(TOPICS_OUT, "w") as f:
        json.dump(topics_payload, f, indent=2); f.write("\n")
    print(f"{len(topics)} labels → {TOPICS_OUT.name}")

    print("Clustering labels...", end=" ", flush=True)
    clusters = cluster_labels(issues, topics)
    print(f"{len(clusters)} clusters")

    print("Naming clusters via Haiku...", end=" ", flush=True)
    groups = name_clusters(clusters, by_label)
    print(f"done")

    # Low-volume labels that didn't make it into any cluster
    clustered    = {l for c in clusters for l in c}
    other_labels = [t["label"] for t in topics if t["label"] not in clustered]
    if other_labels:
        groups.append({
            "group_id":          "other",
            "display_name":      "Other / Low Volume",
            "description":       "Labels with fewer than 10 open issues.",
            "actionability":     "low",
            "labels":            other_labels,
            "label_count":       len(other_labels),
            "total_open_issues": sum(by_label[l]["open_count"] for l in other_labels),
        })

    groups_payload = {
        "generated_at": now,
        "corpus_file":  "data/corpus_full.json",
        "total_groups": len(groups),
        "groups":       groups,
    }
    with open(GROUPS_OUT, "w") as f:
        json.dump(groups_payload, f, indent=2); f.write("\n")
    print(f"{len(groups)} groups → {GROUPS_OUT.name}")


if __name__ == "__main__":
    main()
