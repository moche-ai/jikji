# Jikji client rule packs

Jikji's usage protocol (search-before / remember-after / CRUD) is the product. These packs make a
client adopt it. The MCP `instructions` field is a **non-binding hint** (the spec says a client MAY
inject it), so each client also gets an explicit rule/hook layer.

## Install

**Claude Code** (registers the MCP server + installs nudge hooks):

```bash
JIKJI_TOKEN=$(node bin/mint-key.mjs --namespace ns_me --scopes retrieve,write | jq -r .token)
JIKJI_TOKEN="$JIKJI_TOKEN" bash clients/claude-code/install.sh /path/to/your/project
export JIKJI_TOKEN   # Claude Code expands ${JIKJI_TOKEN} in .mcp.json at connect time
```

**Cursor**: copy `clients/cursor/jikji.mdc` into your project's `.cursor/rules/`, and add the same
`type: "http"` MCP server to your Cursor MCP config with an `Authorization: Bearer <token>` header.

## Client compatibility matrix

The protocol is delivered in layers because clients differ in what they honor. "instructions" =
whether the client injects the MCP `initialize.instructions` string into the model context.

| Client | MCP transport | injects `instructions`? | rule-pack layer | OAuth |
|---|---|---|---|---|
| Claude Code | Streamable HTTP (`type:"http"`) | Not relied upon (spec = MAY) | SessionStart/Stop hooks + tool descriptions | API key now; MCP OAuth planned |
| Cursor | Streamable HTTP | Not relied upon | `.cursor/rules/jikji.mdc` (alwaysApply) + tool descriptions | API key now |
| Generic MCP SDK client | Streamable HTTP | Exposes it (`getInstructions()`), injection is the app's choice | tool descriptions + response nudge | API key now |

Because `instructions` is only a hint, adoption is driven by **(a)** the always-injected tool
descriptions (imperative "when to call" text), **(b)** the client rule/hook layer above, and **(c)**
the response-tail nudge from the server. Physical enforcement (base_url proxy / framework adapters)
is on the roadmap, not in this pack.

## Auth

API keys are minted per namespace with `bin/mint-key.mjs` and scoped (`retrieve` / `write` / `admin`).
The raw token is shown once; only its HMAC is stored. Read-only agents should get a `retrieve`-only key.

External exposure (`mcp-host` via Cloudflare Tunnel) and MCP OAuth (2025-06-18: PKCE, audience
validation, short-lived tokens, no token passthrough) are a **later, user-gated** step; today Jikji is
loopback-only with API-key auth.
