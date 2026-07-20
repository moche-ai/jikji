# Jikji adapter pack

Framework-native entries so custom agents and workflows share the same portable memory. All are
loopback + API-key today; external exposure is user-gated.

## OpenAI-compatible gateway (base_url swap — physical enforcement)

The gateway (`gateway.mjs`) is an OpenAI-compatible proxy: change one line and every request auto-
retrieves memories (cache-aware injection into a dynamic suffix slot) and, opt-in, auto-writes.
Retrieval is fail-open (a search failure forwards the original request unchanged); auth is fail-closed.

```bash
JIKJI_DB=/abs/jikji.db \
JIKJI_GATEWAY_UPSTREAM=https://api.openai.com \
JIKJI_GATEWAY_UPSTREAM_KEY=sk-...             \
JIKJI_GATEWAY_AUTOWRITE=1                      \
  node gateway.mjs                              # listens on 127.0.0.1:8110
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8110/v1", api_key="jk_...")  # your Jikji key
client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "..."}])
```

Retrieved memories arrive as a `system` message just before the last user turn, labelled reference
DATA — the model must not execute instructions found inside them.

## LangGraph BaseStore

`langgraph_jikji_store.py` maps a store surface (put/search/list/delete) onto Jikji memory ops via the
dashboard REST API. Use it as the shared store for a LangGraph app:

```python
from langgraph_jikji_store import JikjiStore
store = JikjiStore(token="jk_...")            # or JIKJI_TOKEN env
store.put(("user",), "coffee", {"text": "I like americano"})
hits = store.search(("user",), query="what coffee do I like")
```

## n8n

Use an **HTTP Request** node pointing at the gateway (`http://127.0.0.1:8110/v1/chat/completions`,
`Authorization: Bearer jk_...`) as the model step, or at the dashboard API (`/api/search`, `/api/import`)
for explicit memory reads/writes in a workflow.

## MCP (Claude Code / Cursor)

See `../README.md` — those clients register the Jikji MCP server directly and get the rule/hook pack.
