# Dogfooding Jikji

Jikji's first users are our own agent sessions. Run the loopback MCP server and point agents at it
**alongside** their existing memory — switch over only after the Korean long-term-memory benchmark
shows equal-or-better recall at acceptable latency.

## Run the server (loopback)

```bash
npm install
export JIKJI_DB=/abs/path/jikji.db
export JIKJI_API_HMAC_SECRET=<a strong secret>   # required outside dev
node server.mjs                                   # listens on 127.0.0.1:8107
curl http://127.0.0.1:8107/healthz
```

## Mint a key and connect an agent

```bash
node bin/mint-key.mjs --namespace ns_dogfood --scopes retrieve,write
# -> { "token": "jk_…", ... }   (shown once)
```

Then install the client pack (see `clients/README.md`) with that token. A read-only observer agent
should get a `--scopes retrieve` key.

## Protocol while dogfooding

- Search before a non-trivial task; write after; `memory_confirm` / `memory_invalidate` to keep facts
  correct; `memory_update` when something changed. This is the same discipline the rule pack injects.
- **Training is off by default** (no-train is the default policy) for dogfooding traffic too — usage is
  never a training signal unless a namespace explicitly opts in.
- Auto-extracted memories (author_type `assistant`) land in `pending_review`; approve them with
  `memory_review` (or set the namespace policy to `auto_approve`).

## What we watch

Telemetry (`source=jikji`, content-free) surfaces search adoption, re-search rate, write/approval
counts, and latency. Use these to decide whether Jikji is ready to become an agent's primary memory —
the bar is benchmark-verified recall parity, not a feature checklist.
