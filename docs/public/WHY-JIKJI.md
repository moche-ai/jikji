# Why Jikji

A clear, honest account of what Jikji does well — and why. Every claim here maps to something in
this repository (a module, a test, or a measured number), not to marketing. Where a number is a
measurement, its source is named; where a capability is on the roadmap, it says so.

Jikji is a **personal memory layer for AI agents**: one structured memory that any AI tool shares
over the [Model Context Protocol](https://modelcontextprotocol.io). The design goals, in order, are
**ownership, portability, accuracy, and trust** — not model size, not a walled garden.

---

## 1. Compatibility — works everywhere your agents do

| Surface | How | Status |
|---|---|---|
| MCP clients | Official `@modelcontextprotocol/sdk`, Streamable HTTP, scoped API keys | shipped |
| Claude Code / Cursor | MCP server + client rule packs that install the usage protocol | shipped |
| Any OpenAI-compatible framework | **Gateway** — swap `base_url`; retrieval is injected on the request path, writes on the response path | shipped (local) |
| LangGraph / custom agents | Gateway + a LangGraph adapter; more adapters on the roadmap | partial |
| Languages | Korean-first, English first-class, CJK the edge | shipped |

- **No infrastructure to stand up.** The store is pure Node.js `node:sqlite` — a single file. There is
  **no external database, no vector-DB service, no graph database** to run, secure, or pay for. Most
  memory stacks require a managed vector store (and sometimes a graph DB) alongside your app; Jikji is
  one process and one file.
- **Portable by construction.** Your memory is a single SQLite file you can copy, back up, or move.
  Full **Markdown export** is a first-class operation, so leaving is never a hostage situation.

## 2. Security & privacy — trust is the default, not a setting

Jikji treats memory as sensitive data and enforces it in code, with tests as evidence
(`node --test`).

- **No-train by default.** Training use is **off** unless a namespace explicitly opts in. Storing a
  memory and consenting to model improvement are **separate axes**.
- **Review before it goes live.** Assistant-extracted or risky content lands in a review queue and is
  **not indexed** until approved. Write and retrieval are independently controllable.
- **Secrets are refused, not stored.** API keys, tokens, private keys, JWTs and the like are detected
  (with NFKC + zero-width-evasion normalization) and **rejected at write time** — the agent is told to
  use a secret manager instead. Jikji never becomes a place credentials leak into.
- **Prompt injection is quarantined.** Untrusted content that looks like an instruction is flagged and
  held for review, never silently promoted into your trusted memory.
- **Tenant isolation is structural.** Every row is keyed by a composite `(namespace_id, id)`;
  cross-tenant reads/searches/graph/lineage are denied. The suite includes explicit **cross-tenant
  IDOR-denial** evidence.
- **Deletion actually deletes.** `forget` cascades to every derivative (revisions, vectors, images,
  outbox, moderation) and the suite verifies a **zero-reference purge across every active store** —
  no orphaned embeddings left behind.
- **Content-free telemetry.** Operational events carry a pseudonymous actor, a namespace hash, latency
  and a *notional* cost — never memory content, and never mixed with real billing.

## 3. Speed & performance — self-hosted, low-latency retrieval

- **Measured end-to-end `memory_search` ≈ 223 ms** (Korean embedder + reranker on every query),
  comfortably inside a **< 500 ms** SLO — see [`SERVING.md`](./SERVING.md) for the full breakdown.
- **No per-call external API tax.** Embeddings and reranking run on local GPU (FP8 on Blackwell tensor
  cores), so retrieval latency and cost don't ride on a third-party API round-trip per request.
- **A store built for hot-path reads.** `node:sqlite` with WAL, `BEGIN IMMEDIATE` transactions,
  prepared statements, and an async embedding **outbox** so writes never block on the model.

## 4. Retrieval quality — measured, not asserted

- **Hybrid retrieval:** BM25 (character-bigram, CJK-aware) **+** dense cosine **→ RRF fusion** **→** a
  cross-encoder **reranker on every query** (a single quality tier — quality is never traded for
  price). The reranker stays full-precision (BF16); only the embedder is quantized.
- **No "what to remember" guesswork at write time.** Facts are stored as revisioned records with
  explicit CRUD, not distilled by a write-time LLM that can silently drop the decisive detail.
- **Time and contradiction are first-class.** New facts **supersede** old ones with full lineage;
  conflicting facts are preserved as **disputed** (both kept) rather than one silently winning.
- **A no-regression gate.** Retrieval quality is scored on a Korean long-term-memory benchmark
  (honorifics, lunar/relative dates, family/work relations, homonyms, preference changes, negation,
  Korean-English mixing, new-vs-old conflicts). On a Korean semantic set, top-1 rises from a lexical
  scaffold's **0.25 to 1.00** with the real embedder; changes must clear a floor (`eval/`).

## 5. Token savings — recall instead of re-explaining

Jikji reduces prompt tokens on two axes:

- **Recall a confirmed fact instead of re-establishing it every session.** Once a preference, name, or
  decision is remembered, the agent retrieves it (a short structured record) rather than having you
  re-type it or re-derive it from a long transcript.
- **Retrieve the *relevant* memories, not the whole history.** Hybrid search + reranking returns a
  small, ranked set. The Gateway injects only those into the prompt — the opposite of stuffing an
  entire conversation back in as context on every turn.

The effect scales with how much your agents already re-explain today; the KPIs surface a
confirmed-reuse count so the saving is observable rather than a slogan.

## 6. Multimodal memory — a genuine differentiator

Jikji stores **images** (`memory_write_image`) in the **same vector space** as text (Qwen3-VL). A
text query retrieves a matching image cross-modally — and the reverse — verified in **Korean and
English**. General-purpose memory services are text-only; unified text↔image recall is a capability
they don't offer.

## 7. Ownership & portability — your memory, owned by you

- A single SQLite file you can hold, back up, and move.
- First-class Markdown **export** and **import** (onboarding from existing notes in one call).
- Lineage and an audit trail for every fact — explainable, correctable, deletable.
- **Apache-2.0.** Model-license clearance is a documented pre-download gate (`PROVENANCE.md`).

---

## Jikji vs. the common memory stack

Neutral, dimension-by-dimension — not a swipe at any specific product, just the trade-offs Jikji was
built to avoid.

| Dimension | Common status quo | Jikji |
|---|---|---|
| Infra to run | Managed vector DB (± graph DB) + service | One Node process, one SQLite file |
| Training on your data | Often on by default (esp. free tiers) | **Off by default**, consent separate from storage |
| What gets stored | Write-time LLM decides (can drop key facts) | Explicit revisioned facts + review queue |
| Retrieval | Vector-only, top-k dump | BM25 + dense + RRF + **reranker on every query** |
| Conflicting facts | One silently wins | **Both preserved** as disputed, with lineage |
| Deletion | Often leaves derived data | **Cascade + zero-reference purge (tested)** |
| Secrets in memory | Stored as-is | **Refused at write time** |
| Portability | Vendor export, if any | Single file + Markdown export, Apache-2.0 |
| Multimodal recall | Text-only | **Cross-modal text ↔ image** |
| Latency | Third-party API per call | Local GPU, **≈223 ms** end-to-end |

---

*Honesty note:* Jikji is in early development. Numbers above are from this repo's measurements and
tests; the lexical scaffold embedder is deliberately low-quality until a real embedder is configured
(the retrieval pipeline is identical behind either). External exposure, paid tiers, and beta invites
are user-gated. See [`EVAL.md`](./EVAL.md), [`SERVING.md`](./SERVING.md), and the test suite for the
underlying evidence.
