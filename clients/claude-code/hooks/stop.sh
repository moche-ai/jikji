#!/usr/bin/env bash
# Jikji Stop hook — plain stdout is NOT surfaced on Stop, so emit JSON.
# additionalContext feeds a reminder to the model as the turn ends (non-blocking).
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "[Jikji] If this turn established a new durable fact (a decision, preference, name, or state), save it with memory_write so it is available to future sessions and other agents."
  }
}
JSON
