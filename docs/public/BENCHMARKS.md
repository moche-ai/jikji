# Benchmarks & numbers

Real, reproducible numbers — measured on this repo, not marketing. Where a number is an estimate,
the method and assumptions are stated so you can plug in your own. Hardware: one workstation GPU
(RTX PRO 6000, sm_120), shared with other services. Models: **8B embedder (4096-dim) + 8B reranker**.

> Honesty note: the retrieval eval sets below are small **smoke tests** — they check correctness and
> guard regressions, not headroom. On these easy sets even the GPU-free lexical scaffold passes, so
> they do **not** by themselves prove the 8B embedder's edge (that shows on paraphrase / true
> cross-lingual retrieval; a harder public benchmark is on the roadmap). Latency and token numbers
> are measured/derived and stand on their own.

---

## 1. Latency & throughput (measured)

One `memory_search` = query embed (8B) → BM25 + dense cosine → RRF → 8B reranker. End-to-end,
warm, on the shared GPU:

| concurrent searches | p50 | p95 | throughput |
|---:|---:|---:|---:|
| 1 | **223 ms** | 223 ms | 4.5 /s |
| 4 | 808 ms | 809 ms | 4.9 /s |
| 8 | 965 ms | 1,255 ms | 5.2 /s |
| 16 | 1,540 ms | 2,234 ms | 7.1 /s |
| 32 | 2,649 ms | 3,025 ms | 10.3 /s |

- **Single-query latency: ~223 ms** end-to-end (well under a 500 ms SLO).
- **Sustained ceiling: ~10 searches/sec** — reranker-bound (the 8B reranker on shared GPU). Keep
  simultaneous in-flight ≤ ~8 for p95 < ~1.3 s.
- No per-call external API tax: embeddings + reranking run locally, so latency doesn't ride a
  third-party round-trip.

**Concurrent-user capacity** (agents are bursty — a search per task, not per second): the target
closed beta (10–20) is trivial; **~50–100 lightly-active users** before latency degrades under bursts.
The throughput lever is the reranker (dedicated instance + seq-cls + FP8 ≈ 3× per `SERVING.md`).

## 2. Token economics (derived)

Memory recall cost is **flat and small**; carrying history to retain the same facts **grows without
bound**. Measured memory size in these datasets: **~15–40 tokens per memory**; a default top-8 recall
set ≈ **~130–320 tokens** (call it ~200), *independent of how long the session is*.

To keep the same facts available **without** a memory layer you re-carry the conversation. At a rough
~150 tokens per message:

| session length | full history carried (tokens) | Jikji recall (top-8, flat) | fewer tokens for recall |
|---:|---:|---:|---:|
| 10 messages | ~1,500 | ~200 | **~7×** |
| 25 messages | ~3,750 | ~200 | **~19×** |
| 50 messages | ~7,500 | ~200 | **~37×** |

- Jikji injects **only the relevant memories** (a small ranked set), not the whole transcript — and
  the cost **stays flat** while full-context keeps growing every turn.
- Second axis: **recall a confirmed fact instead of re-establishing it.** Each avoided
  re-explanation saves the tokens you'd spend re-typing/re-deriving it; the dashboard's
  `saved_tokens_estimate` counts confirmed reuses.
- *Assumptions:* ~150 tokens/message, ~200-token top-8 recall, Korean-heavy text. Your ratio scales
  with message size and how much your agents currently re-explain — plug in your own numbers.

## 3. Retrieval quality (eval gate)

Every change must clear a **no-regression gate** on a Korean long-term-memory eval spanning 8
categories that break naive memory: **honorifics, relative/lunar dates, family/work relations,
homonyms, preference changes, negation, Korean-English mixing, new-vs-old conflict.**

- Metric: **top-1 accuracy** — the correct memory must rank #1 past injected distractor noise, and a
  contradicting memory must **not** appear (contamination = 0).
- Current: **top-1 = 1.00** across all categories, floor **0.85** (`eval/run.mjs`). Contamination 0.
- These are small hand-built sets (10–14 cases each) — a correctness/regression guard, not a headroom
  benchmark (see the honesty note above).

## 4. Regression prevention — remembering mistakes (worked example)

Jikji stores **failures**, not just facts — so an agent doesn't repeat a mistake a past session (or a
different agent) already made. This is enforced by [`AGENTS.md`](../../AGENTS.md) rule 3 ("when you
were wrong → write the correction, loudly").

```text
Session 1 (Mon) — the agent hits a wall
  Tries:  npm run build   → fails: native module (better-sqlite3) won't build on Node 18.
  Fixes it on Node 20, then records the lesson so it can't recur:

    memory_write({
      kind: "procedural",
      text: "이 레포 빌드는 Node 20+ 필요 — Node 18에서 네이티브 모듈 빌드 실패. `nvm use 20` 먼저."
    })

Session 2 (next week, fresh session / a different agent, different tool) — same task
  Before starting, per protocol:

    memory_search({ need: "이 레포 빌드하는 법" })
      → top-1 (reranked): "이 레포 빌드는 Node 20+ 필요 … nvm use 20 먼저."

  The agent uses Node 20 from the start. The Node-18 mistake never happens again.

Self-correcting — if the lesson later goes stale (say the repo moves to Node 22):
    memory_update(...)      // supersede with the new fact (keeps lineage)
    memory_invalidate(...)  // or retract it outright
  so the memory never hands out advice that's no longer true.
```

Why this matters: naive "chat memory" stores what happened; it doesn't capture *"don't do X, it fails —
do Y instead"* as a first-class, retrievable, correctable record. Jikji does — the mistake is written
once (`kind: "procedural"`), retrieved before the next attempt, and CRUD-maintained so it stays true.
The dashboard surfaces the count of such procedural lessons and confirmed reuses.

## 5. Model & serving facts

| | |
|---|---|
| Embedder | 8B class, **4096-dim** (native max for the 8B backbone) |
| Reranker | 8B (Qwen3-VL-Reranker), **BF16 / not quantized** (precision-sensitive final ordering) |
| Embedder quantization | FP8 (E4M3) on native Blackwell tensor cores — ~2× BF16, ~lossless |
| Multimodal | text **and** images in one unified 4096-dim space (cross-modal recall, KO/EN) |
| Retrieval | BM25 (CJK char-bigram) + dense cosine → RRF fusion → reranker on **every** query |
| Store | `node:sqlite`, WAL, one file — no external vector/graph DB |

---

*Reproduce:* latency via a concurrent-search driver over `core.search`; eval via
`INFRA_TELEMETRY=off node eval/run.mjs --dataset eval/dataset-*.json`; token figures from the formula
above with your own message sizes.
