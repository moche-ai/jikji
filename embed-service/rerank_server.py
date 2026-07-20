#!/usr/bin/env python3
"""jikji-rerank — cross-encoder reranker service (GPU, loopback).

Serves the reranker behind Jikji's HttpReranker interface. Two backends:
  - CrossEncoder models (e.g. Alibaba-NLP/gte-reranker-modernbert-base) via sentence-transformers.
  - Qwen3-Reranker-* (causal-LM yes/no) via transformers, when JIKJI_RERANK_KIND=qwen3.

Contract (matches jikji/rerank.mjs HttpReranker):
  POST /rerank  {"query": "...", "documents": ["...", ...]}  ->  {"scores": [float, ...]}
  GET  /healthz                                              ->  {"ok": true, "model": "...", "kind": "..."}
"""
import os
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

MODEL_ID = os.environ.get("JIKJI_RERANK_MODEL", "Alibaba-NLP/gte-reranker-modernbert-base")
KIND = os.environ.get("JIKJI_RERANK_KIND", "cross-encoder")   # cross-encoder | qwen3
HOST = os.environ.get("JIKJI_RERANK_HOST", "127.0.0.1")
PORT = int(os.environ.get("JIKJI_RERANK_PORT", "8111"))
device = "cuda" if torch.cuda.is_available() else "cpu"

print(f"[jikji-rerank] loading {MODEL_ID} ({KIND}) on {device} ...", flush=True)

if KIND == "qwen3":
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tok = AutoTokenizer.from_pretrained(MODEL_ID, padding_side="left")
    lm = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.float16).to(device).eval()
    _yes = tok.convert_tokens_to_ids("yes")
    _no = tok.convert_tokens_to_ids("no")
    PREFIX = "<|im_start|>system\nJudge whether the Document meets the Query. Answer only \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n"
    SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

    def score(query, docs):
        out = []
        for d in docs:
            text = f"{PREFIX}<Query>: {query}\n<Document>: {d}{SUFFIX}"
            ids = tok(text, return_tensors="pt", truncation=True, max_length=2048).to(device)
            with torch.inference_mode():
                logits = lm(**ids).logits[0, -1]
            yn = torch.tensor([logits[_no], logits[_yes]])
            out.append(float(torch.softmax(yn, 0)[1]))
        return out
else:
    from sentence_transformers import CrossEncoder
    ce = CrossEncoder(MODEL_ID, device=device, trust_remote_code=True)

    def score(query, docs):
        return [float(s) for s in ce.predict([(query, d) for d in docs])]

print(f"[jikji-rerank] ready — model={MODEL_ID} kind={KIND} device={device}", flush=True)


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
            return self._send(200, {"ok": True, "model": MODEL_ID, "kind": KIND, "device": device})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/rerank":
            return self._send(404, {"error": "not_found"})
        n = int(self.headers.get("content-length", 0) or 0)
        if n > 5_000_000:
            return self._send(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad_json"})
        query = body.get("query")
        docs = body.get("documents")
        if not isinstance(query, str) or not isinstance(docs, list) or not docs:
            return self._send(422, {"error": "query_and_documents_required"})
        if len(docs) > 100:
            return self._send(413, {"error": "too_many"})
        self._send(200, {"scores": score(query, docs), "model": MODEL_ID})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"[jikji-rerank] http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
