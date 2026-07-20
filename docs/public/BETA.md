# Beta & plans

Jikji runs a small closed beta first (10–20 testers), then opens up. Quality is a **single tier** for
everyone — plans differ only by **quantity** (memory count, monthly calls), never by retrieval quality.

## Plans (`plans.mjs`)

| plan | price | max memories | max calls / month |
|---|---|---|---|
| Free | ₩0 / $0 | 2,000 | 2,000 |
| Basic | ₩4,900 / $4.99 | 20,000 | 50,000 |
| Pro | ₩19,900 / $14.99 | 200,000 | 500,000 |
| Beta | free (beta) | 200,000 | 500,000 |

Caps are enforced in the core: `memory_write` past the memory cap → `402`, any metered call past the
monthly cap → `429`. Prices are placeholders — **payment integration and final pricing are user-gated.**
Per-namespace caps can be overridden by the operator (`policy.max_memories` / `max_calls_per_month`).

## Onboarding a beta tester

```bash
# 1) create an invite scoped to a namespace, on the Beta plan
node bin/invite.mjs --create --namespace ns_tester1 --scopes retrieve,write
node bin/feedback.mjs --plan ns_tester1 beta        # assign the Beta plan

# 2) the tester redeems the invite → gets a scoped API key (shown once)
node bin/invite.mjs --redeem <code>
```

Sending invites to real people is user-gated; the mechanism is here, the send is not automated.

## Usage & per-user status

- `memory_usage` (MCP) / `GET /api/usage` (dashboard): the user's plan, current-month calls/searches/
  writes, memory count, and remaining caps.
- Telemetry (`source=jikji`, content-free): every op emits an event (`memory.*`, `rate-limit`,
  `feedback`, `gateway.*`) with a pseudonymous actor, namespace hash, latency, cost-notional, and plan
  tier — so usage/business KPIs (adoption, re-search, retention, tier mix) aggregate centrally. The
  events are OTel/OTLP-friendly (structured attributes); an OTLP exporter can consume the same stream.

## Feature requests & bug reports (direct)

- Users report via `memory_feedback` (MCP) or `POST /api/feedback` (dashboard): `{ type: bug|feature|
  other, text }`. Stored per-namespace and emitted as a `feedback` telemetry event so operators see it
  immediately.
- Operators review with `bin/feedback.mjs --list [--open] [--type bug]`, resolve with
  `--resolve <namespace> <id>`, and can push a summary of open items to a channel with `--notify`
  (`JIKJI_SIGNAL_CMD` env — the alert command path stays out of the repo).
