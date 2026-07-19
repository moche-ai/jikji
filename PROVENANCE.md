# Jikji PROVENANCE — clean-room boundary

Jikji's memory core is an **independent design**. This document records what was permissible to
reference and which decisions were made independently, so the provenance is auditable.

## Permitted references (nothing else)
- **Concept vocabulary**: fact lifecycle (confirm/invalidate), graph relations (related/path/impact) —
  industry-standard ideas, not any single implementation.
- **Public, versioned REST contracts**: only the externally observable request/response shapes of
  public memory-service APIs.
- **Public research**: field unions from LangFuse / LangSmith / OpenInference / OTel GenAI, and public
  long-term-memory evaluation methodology.

## Prohibited (enforced in CI)
- No access, reading, or import of any **internal/proprietary memory-service** code, database,
  migrations, or paths.
- Internal table/column names of any such service are **not** copied.

## Independent design decisions (derived from standards, not from any product)
- **bi-temporal revisions** (`facts`/`fact_revisions`, `valid_from/to` + `recorded/retracted`) — the
  standard bi-temporal database model (Snodgrass).
- **validity status ≠ moderation state** as separate axes — an independent decision for this project.
- **transactional outbox + head CAS + idempotency** — standard outbox / optimistic-concurrency patterns.
- **RRF hybrid retrieval + tiered reranking** — standard IR (Cormack RRF).
- All field/table names use this project's own domain vocabulary (no attempt to match any other schema).

## Verification
- Behaviour is pinned by the schema and contract tests in `test/` — verified against observable
  contracts, not by comparison against any proprietary code.
- Model licenses (gated before download): KURE-v1 (MIT), bge-m3 (MIT), Qwen3-Reranker-8B (Apache-2.0).
