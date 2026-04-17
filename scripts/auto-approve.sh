#!/bin/bash
# Auto-approve permission prompts for a tmux-run Claude bot.
# Captures the session's last few lines every INTERVAL seconds and sends "1"
# when a known permission prompt pattern is detected.
#
# Usage: bash scripts/auto-approve.sh <tmux-session-name>

SESSION="$1"
INTERVAL=10

while true; do
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        exit 0
    fi

    OUTPUT=$(tmux capture-pane -t "$SESSION" -p -S -5 2>/dev/null)

    # Known permission-prompt patterns:
    #   - "Do you want to proceed?"         (MCP server approval)
    #   - "Allow once" / "Yes, allow"       (tool approval dialogs)
    #   - "❯ 1."                             (numeric select prompts)
    if echo "$OUTPUT" | grep -qE "Do you want to proceed|Allow once|❯ 1\.|Yes, allow|Allow for this session"; then
        tmux send-keys -t "$SESSION" "1" Enter
        sleep 3  # avoid double-sending into the same prompt
    fi

    sleep "$INTERVAL"
done
