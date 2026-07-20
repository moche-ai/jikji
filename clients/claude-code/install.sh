#!/usr/bin/env bash
# Jikji — one-line Claude Code client install.
# Registers the jikji MCP server (project .mcp.json) and appends the SessionStart/Stop nudge hooks.
# Does NOT handle the token value: .mcp.json references ${JIKJI_TOKEN}, expanded by Claude Code at
# connect time. Export JIKJI_TOKEN in your shell yourself (mint it with bin/mint-key.mjs).
#
# Usage:
#   JIKJI_URL=https://mcp.moche.ai/mcp bash clients/claude-code/install.sh [target_project_dir]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$PWD}"
URL="${JIKJI_URL:-https://mcp.moche.ai/mcp}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
mkdir -p "$TARGET/.claude"

# 1) .mcp.json — register/replace only the 'jikji' server entry (leaves other servers intact).
MCP="$TARGET/.mcp.json"
[ -f "$MCP" ] || echo '{"mcpServers":{}}' > "$MCP"
jq --arg url "$URL" \
   '.mcpServers.jikji = {"type":"http","url":$url,"headers":{"Authorization":"Bearer ${JIKJI_TOKEN}"}}' \
   "$MCP" > "$MCP.tmp" && mv "$MCP.tmp" "$MCP"

# 2) hooks — APPEND jikji hooks to the existing SessionStart/Stop arrays (never replace the user's).
#    Idempotent: first drop any prior jikji entries (command under $HERE), then append fresh ones.
SETTINGS="$TARGET/.claude/settings.json"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
SS="$HERE/hooks/session-start.sh"
STOP="$HERE/hooks/stop.sh"
jq --arg here "$HERE" --arg ss "$SS" --arg stop "$STOP" '
  def strip($cmd): map(select([.hooks[]?.command] | index($cmd) | not));
  .hooks = (.hooks // {}) |
  .hooks.SessionStart = ((.hooks.SessionStart // []) | strip($ss)) + [ { "matcher":"startup|resume", "hooks":[ {"type":"command","command":$ss,"timeout":8} ] } ] |
  .hooks.Stop        = ((.hooks.Stop        // []) | strip($stop)) + [ { "hooks":[ {"type":"command","command":$stop,"timeout":5} ] } ]
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

chmod +x "$HERE/hooks/"*.sh

echo "✓ jikji installed into $TARGET"
echo "  - $MCP (server 'jikji')"
echo "  - $SETTINGS (SessionStart/Stop hooks appended)"
echo "  Before launching Claude Code, export your minted token (its value is never written to disk):"
echo "    export JIKJI_TOKEN=<your minted token>"
