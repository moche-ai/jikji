# jikji-embed

The real dense embedder behind Jikji's `HttpEmbedder` interface — KURE-v1 (MIT), a Korean-tuned
BGE-M3, served over loopback HTTP. Jikji's Node server points at it via `JIKJI_EMBED_URL`; document
vectors are produced by the background outbox worker, so the request path is never blocked.

Weights and the virtualenv are local (gitignored). This directory holds the public-safe server code.

## Run (loopback, low-priority GPU slot)

```bash
# create venv + deps (torch CUDA + sentence-transformers)
uv venv .venv && uv pip install -p .venv/bin/python torch sentence-transformers

# pick a low-priority serving GPU (never the protected training/product GPUs); models cache under /data/ai-models
CUDA_VISIBLE_DEVICES=1 HF_HOME=/data/ai-models/.hf-cache \
  nice -n 19 .venv/bin/python server.py
curl http://127.0.0.1:8108/healthz
```

Then start the Jikji MCP server with:

```bash
JIKJI_EMBED_URL=http://127.0.0.1:8108/embed JIKJI_EMBED_DIM=1024 node ../server.mjs
```

## Contract

- `POST /embed {"model": "...", "input": ["text", ...]}` → `{"embeddings": [[float, ...], ...], "dim": 1024}`
- `GET /healthz` → `{"ok": true, "model": "...", "dim": 1024, "device": "cuda"}`

Loading real models is gated by the GPU admission controller (`../gpu.mjs`) and must clear the Korean
long-term-memory eval floor before it becomes the default embedder.
