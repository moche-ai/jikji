#!/usr/bin/env python3
"""jikji-embed — KURE-v1 dense embedding service (GPU, loopback).

Reference implementation of the real embedder behind Jikji's HttpEmbedder interface.
Loopback-only by default; GPU is chosen via CUDA_VISIBLE_DEVICES (a low-priority serving slot).
Weights/venv are local (gitignored) — this file is the public-safe server code.

Contract (matches jikji/embed.mjs HttpEmbedder):
  POST /embed  {"model": "...", "input": ["text", ...]}  ->  {"embeddings": [[float,...], ...], "dim": N}
  GET  /healthz                                           ->  {"ok": true, "model": "...", "dim": N, "device": "..."}
"""
import os
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get("JIKJI_EMBED_MODEL", "nlpai-lab/KURE-v1")
HOST = os.environ.get("JIKJI_EMBED_HOST", "127.0.0.1")
PORT = int(os.environ.get("JIKJI_EMBED_PORT", "8108"))
MAX_BATCH = int(os.environ.get("JIKJI_EMBED_MAX_BATCH", "256"))

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[jikji-embed] loading {MODEL_ID} on {device} ...", flush=True)
model = SentenceTransformer(MODEL_ID, device=device)
model.max_seq_length = int(os.environ.get("JIKJI_EMBED_MAX_SEQ", "512"))
DIM = model.get_sentence_embedding_dimension()
print(f"[jikji-embed] ready — dim={DIM} device={device}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": True, "model": MODEL_ID, "dim": DIM, "device": device})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/embed":
            return self._send(404, {"error": "not_found"})
        n = int(self.headers.get("content-length", 0) or 0)
        if n > 5_000_000:
            return self._send(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad_json"})
        texts = body.get("input")
        if not isinstance(texts, list) or not texts:
            return self._send(422, {"error": "input_required"})
        if len(texts) > MAX_BATCH:
            return self._send(413, {"error": "too_many"})
        if not all(isinstance(t, str) for t in texts):
            return self._send(422, {"error": "input_must_be_strings"})
        # case-appropriate embedding: a query instruction (Qwen3-Embedding instruction-tuning).
        # Applied to QUERIES only; documents (indexing) send no instruction, per Qwen3-Embedding practice.
        instruction = body.get("instruction")
        enc = texts
        if isinstance(instruction, str) and instruction:
            enc = [f"Instruct: {instruction}\nQuery: {t}" for t in texts]
        with torch.inference_mode():
            embs = model.encode(enc, normalize_embeddings=True, batch_size=32, convert_to_numpy=True)
        self._send(200, {"embeddings": [e.tolist() for e in embs], "model": MODEL_ID, "dim": DIM})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"[jikji-embed] http://{HOST}:{PORT} (model={MODEL_ID})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
