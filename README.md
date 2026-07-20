# Jikji (직지)

**Your memory, owned by you, portable across every AI.**

Jikji is a Korean-first personal memory layer for AI agents — a structured memory core that any AI
tool can share through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

> Named after *Jikji*, the world's oldest extant book printed with movable metal type
> (Korea, 1377) — the original technology for making memory permanent.

## What it does

- **One memory, every agent** — Claude Code, Cursor, custom agents and workflows share a single
  personal memory through MCP (gateway & framework adapters are on the roadmap).
- **Structured recall** — the retrieval path is built for hybrid search (BM25 + dense + graph +
  reranker) with scope-aware disambiguation across multiple projects.
- **Multimodal memory** — store images (`memory_write_image`) alongside text. Images embed into the
  **same vector space** as text (Qwen3-VL), so a text query retrieves a matching image cross-modally
  (and vice versa), in Korean and English.
- **Trust by design** — training use is **off by default**, memories are reviewable before they go
  live, fully exportable, and deletion cascades to every derivative.
- **Korean-first** — retrieval quality is measured on a Korean long-term-memory benchmark; English is
  first-class, CJK is the edge.

## Architecture — core ≠ entry point

The memory core is one embeddable module; MCP / gateway / adapters are thin entry points over it.

| File | Role |
|---|---|
| `core.mjs` | **MemoryCore** (entry-agnostic): typed ops + policy enforcement (no-train, tenant isolation / IDOR, review, deletion, injection quarantine) + audit + telemetry. |
| `store.mjs` | `node:sqlite` physical model — `facts` / `fact_revisions` / `moderation` (validity ≠ moderation as separate axes), transactional outbox, split deletion state, composite `(namespace_id, id)` keys, `BEGIN IMMEDIATE`, optimistic head CAS. Exposes a **repository capability only** (never the raw DB handle). |
| `embed.mjs` | `Embedder` interface + `LexicalEmbedder` (deterministic, GPU-free scaffold fallback — honestly low quality; a real embedder swaps in behind the same interface) + `VlPoolingEmbedder` (multimodal: text **and** images in one unified space via a vLLM Qwen3-VL `/pooling` endpoint). |
| `telemetry.mjs` | Fire-and-forget forward to a configurable sink (no content, pseudonymous actor, notional cost — never mixed with real billing). |
| `protocol.mjs` | Usage-protocol strings (MCP `instructions` + tool descriptions, EN/KO) — a **non-binding hint** per the MCP spec. |
| `server.mjs` | **MCP entry point** — official `@modelcontextprotocol/sdk`, Streamable HTTP, API-key auth, Origin allowlist, loopback-only. |

The retrieval pipeline (cosine over stored vectors) is identical whether the scaffold embedder or a
real model is behind it — only the `Embedder` implementation changes.

## Run (loopback only)

```bash
npm install
JIKJI_DB=/abs/path/jikji.db JIKJI_PORT=8107 node server.mjs
curl http://127.0.0.1:8107/healthz
```

Environment:

| Var | Meaning |
|---|---|
| `JIKJI_DB` | **required** — absolute DB path (no cwd fallback). |
| `JIKJI_PORT` | default `8107`. |
| `JIKJI_HOST` | default `127.0.0.1` (non-loopback bind is refused unless `JIKJI_ALLOW_NONLOOPBACK=1`). |
| `JIKJI_API_HMAC_SECRET` | required in production (`JIKJI_ENV=production`) — fail-closed if missing. |
| `JIKJI_TELEMETRY_SECRET` | HMAC secret for pseudonymous telemetry actor labels. |
| `INFRA_TELEMETRY` | set to `off` to disable telemetry; `INFRA_TELEMETRY_URL` sets the sink. |

## Test

```bash
INFRA_TELEMETRY=off node --test
```

The suite is the increment-1 **security evidence**: cross-tenant IDOR denial, injection quarantine,
secret-content rejection (with zero-width evasion), post-`forget` zero-reference purge across every
active store, write-time + approval CAS, canonical idempotency, idempotent outbox lease, official MCP
SDK round-trip, and production fail-closed.

## Status

Early development — a working local (loopback) MVP:

- **Memory core** — revisioned facts, dedup, temporal supersede, pending review, contradiction
  detection (flagged), Markdown import/export.
- **Retrieval** — hybrid BM25 + dense + RRF with an optional reranker tier, measured by a Korean
  long-term-memory eval with a no-regression gate (`eval/`).
- **MCP** — official SDK Streamable HTTP with scoped API keys, plus Claude Code / Cursor rule packs.
- **Dashboard** — a small local UI to list, search, review, delete, import/export, see KPIs, and a
  **memory map** (graph of related memories).
- **Gateway** — an OpenAI-compatible proxy (`base_url` swap) that auto-retrieves memories with
  cache-aware injection (fail-open) and opt-in async auto-write; plus a LangGraph adapter.
- **Real embedder** — a KURE-v1 (MIT) service (`embed-service/`) behind the `HttpEmbedder` interface,
  measured against the eval: on a Korean semantic set, top-1 rises from a lexical 0.25 to **1.00**.

Retrieval defaults to KURE-v1 when the embed service is configured, and to an honest lexical scaffold
otherwise; the reranker (Qwen3) is a feature flag. External exposure, any paid tier, and beta invites
are deliberately user-gated. Closed beta planned; watch this repo.

### Roadmap

On-device mode, richer graph/temporal queries, and streaming auto-write in the gateway — developed
alongside the closed beta.

## License

Apache-2.0 (see `LICENSE`). Model-license clearance is a pre-download gate; see `PROVENANCE.md`.
