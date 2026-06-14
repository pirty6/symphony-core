#!/usr/bin/env bash
# PostToolUse hook: stop the agent session if a terminal command exits non-zero.
# VS Code pipes a JSON object into stdin with tool_name, tool_input, tool_response, etc.
# We only care about run_in_terminal results that contain a non-zero exit code.

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")

# Only inspect terminal tool calls
if [[ "$TOOL_NAME" != "run_in_terminal" ]]; then
  echo '{}'
  exit 0
fi

TOOL_RESPONSE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_response',''))" 2>/dev/null || echo "")

# Check for non-zero exit code patterns in the terminal output.
# VS Code typically includes "Exit Code: N" in the tool response.
if echo "$TOOL_RESPONSE" | grep -qiE '(exit code: [1-9]|exit code: [0-9]{2,}|exited with code [1-9]|non-zero exit)'; then
  cat <<EOF
{
  "continue": false,
  "stopReason": "Terminal command failed with a non-zero exit code. Session stopped to prevent the agent from attempting recovery. Review the error and re-run manually."
}
EOF
  exit 0
fi

# No error detected — continue normally
echo '{}'
exit 0
