# Model evaluation & selection

Jikji selects retrieval models by **blind A/B on a held-out eval**, single quality tier for everyone
(no per-price or per-difficulty quality differentiation; the reranker runs on every query). The eval
sets live in `eval/` and the gate is `eval/run.mjs` (run it locally / in your own CI).

## Eval sets

| set | what it tests |
|---|---|
| `dataset-v0.json` | Korean exact-token recall (lexical baseline; the regression floor) |
| `dataset-semantic.json` | Korean paraphrase / synonym / hypernym (meaning ≠ surface tokens) |
| `dataset-hard.json` | Korean discriminative: honorific resolution, homonyms, double negation, idioms, slang, euphemism (with same-topic hard distractors) |
| `dataset-en.json` | English semantic (the "English first-class" claim) |
| `dataset-crosslingual.json` | query and memory in different languages (EN↔KO, +JA/ZH/ES) — multilingual alignment |

Metric: top-1 accuracy (the answer ranked #1 above distractors + noise), plus recall@k.
Run any config with `eval/ab.mjs`: `JIKJI_EMBED_URL=… JIKJI_RERANK_URL=… node eval/ab.mjs <set>`.

## A/B results (2026-07-20)

**Embedder, standalone (top-1):**

| embedder | EN | cross-lingual | KO-hard | KO-semantic |
|---|---|---|---|---|
| lexical scaffold | — | — | 0.50 | 0.25 |
| KURE-v1 (MIT, 0.6B) | 0.67 | 0.70 | 0.64 | 1.00 |
| BGE-M3 (MIT, 0.6B) | 0.75 | 0.70 | 0.64 | 1.00 |
| **Qwen3-Embedding-8B (Apache-2.0)** | **0.92** | **0.90** | **0.71** | 1.00 |

KURE-v1 is Korean-specialised and weaker on English/cross-lingual; **Qwen3-Embedding-8B is strongest
in every language** (better candidate recall globally).

**Reranker (rerank-all, on top of the embedder):**

- **Qwen3-Reranker-8B (Apache-2.0)** is the dominant lever: it lifts every stack to **1.00** on KO / EN /
  cross-lingual (even the small KURE-v1). It is sharp — e.g. a relevant/irrelevant pair scores 0.99 vs 0.06.
- `gte-reranker-modernbert` **hurts** Korean (0.64 → 0.43): English-centric ModernBERT mis-ranks Korean nuance. **Excluded.**

## Selection

- **Reranker: Qwen3-Reranker-8B** — unambiguous winner, multilingual, applied to every query.
- **Embedder: Qwen3-Embedding-8B** for the global-first product — strictly ≥ the alternatives across all
  languages standalone, so it feeds the reranker the best candidate pool. KURE-v1 remains a much cheaper
  Korean-leaning alternative that the reranker makes competitive on measured sets.

**Cost / GPU:** Qwen3-Embedding-8B + Qwen3-Reranker-8B ≈ 32 GB VRAM per instance (both bf16/fp16); on a
97 GB serving GPU (low-priority slots 1/3) that leaves ample headroom without touching protected
services. The reranker runs on every query, so per-query reranker latency (and batching it) is the main
throughput cost — an engineering item, not a quality trade-off.

Model selection here is a technical result; **activating a dedicated production serving stack, external
exposure, and any paid tier remain user-gated.**
