#!/bin/bash
SESSION="harness-researcher"
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLACK_CHANNEL_DIR="$(cd "$BOT_DIR/../../slack-channel" && pwd)"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running"
    tmux attach -t "$SESSION"
    exit 0
fi

export BOT_NAME="researcher"

tmux new-session -d -s "$SESSION" -c "$BOT_DIR"
tmux send-keys -t "$SESSION" "claude --model claude-sonnet-4-5 --dangerously-load-development-channels server:$SLACK_CHANNEL_DIR" Enter

echo "Started: $SESSION"
echo "Attach:  tmux attach -t $SESSION"
