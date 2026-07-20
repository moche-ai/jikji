# Serving & performance

Retrieval runs the reranker on **every** query (single quality tier), so serving latency is a
first-class concern. Target: search p99 < 500 ms end-to-end.

## GPU note

Deployed on **RTX PRO 6000 Blackwell (sm_120, workstation GB202)** — not datacenter Blackwell
(sm_100/B200). Most frameworks' "Blackwell support" targets datacenter first; sm_120 lags. Our models
are **dense causal GQA LMs (head_dim=128)**, which routes around the fragile sm_120 paths (MLA / MoE /
datacenter-NVFP4 kernels). On sm_120, **no framework has an optimized Blackwell prefill kernel yet**
(all fall back to FA2), so no serving framework has a structural kernel advantage here.

## Framework choice — vLLM

| framework | sm_120 | embed + rerank | verdict |
|---|---|---|---|
| **vLLM** | mature | native `/v1/embeddings` (`--runner pooling`) + `/score` / `/rerank` | **chosen** |
| SGLang | works (≥0.5.13, pin FlashInfer/Triton backend) | `/v1/score` + `label_token_ids` (yes/no) | on par; RadixAttention only reuses the short shared query prefix (docs dominate) → not worth switching |
| TensorRT-LLM | immature on sm_120 | not a first-class embed/rerank path | disqualified for this workload |
| TEI | experimental `120` image | best for embeddings at batch-1; reranker path still an unmerged PR | candidate for the **embedder** later |

Reusing the platform's existing vLLM reranker already meets the SLO (~137 ms for 20 docs, zero extra GPU).

## The real latency levers (bigger than the framework)

1. **Reranker as sequence-classification, not causal-LM.** The raw Qwen3-Reranker is a causal LM that
   scores via yes/no token logits — a full ~151k-vocab projection per document. Converting it to a
   `Qwen3ForSequenceClassification` head (1 output) drops that projection: **~3× faster, accuracy-neutral.**
   Use a pre-converted checkpoint (`tomaarsen/Qwen3-Reranker-8B-seq-cls`, vLLM `--runner pooling` /
   `task=score`). `rerank_server.py` supports this via `JIKJI_RERANK_KIND=qwen3-seqcls`.
2. **FP8 (E4M3)** on native Blackwell FP8 tensor cores — ~2× BF16, ~lossless on Qwen3-8B. **Not INT4/AWQ**:
   a 20-doc rerank is prefill/compute-bound, so weight-only INT4 is a VRAM play that can *slow* it.
   (Exclude the tiny score head from FP8 quantization — the seq-cls head trips the FP8+`size_n=1` bug.)
3. vLLM tuning: `--enable-prefix-caching` (shared query prefix), `--attention-backend flashinfer`
   (≥0.6.15 with the `120f` arch, or pin 0.6.12), CUDA graphs (no `--enforce-eager`),
   `--kv-cache-dtype fp8` (safe at head_dim=128), batch all candidates in one request.

## Reranker model

Keep **Qwen3-Reranker-8B**. On the Korean instructkr benchmark (seq-cls heads) it leads: 8B NDCG@1
0.755 > bge-reranker-v2-m3 0.734 > 4B 0.727 > 0.6B 0.620 — matching our blind A/B (8B → top-1 1.0;
small English-centric rerankers hurt Korean). **Qwen3-Reranker-4B** is the fallback if latency overruns
(retains ~97% of Korean NDCG@10); `bge-reranker-v2-m3` (0.6B) is the strongest quality-preserving
downgrade to A/B against a Korean golden set if ever needed.

## Batching (implemented)

`rerank_server.py` batches all candidate (query, doc) pairs into one forward pass instead of scoring
them sequentially — the first and largest local win (measured ~4× on the naive server). Production
serving (vLLM + seq-cls + FP8) is the path to sub-100 ms; the existing vLLM reranker already clears the
SLO today.
