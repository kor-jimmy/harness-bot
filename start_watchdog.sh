#!/bin/bash
SESSION="harness-watchdog"
HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "watchdog already running"
    tmux attach -t "$SESSION"
    exit 0
fi

tmux new-session -d -s "$SESSION" -c "$HARNESS_DIR"
tmux send-keys -t "$SESSION" "python3 manage.py watch" Enter

echo "Started: $SESSION"
echo "Attach: tmux attach -t $SESSION"
