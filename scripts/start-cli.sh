#!/bin/bash
# Shared CLI-mode bot launcher.
# Usage: bash scripts/start-cli.sh bots/<name>
#
# Reads the bot's .env and starts `claude` inside a tmux session named
# `harness-<bot-name>`. If BOT_SKIP_PERMISSION=true, also launches the
# auto-approve watcher in the background.

set -e

BOT_DIR="$(cd "$1" && pwd)"
BOT_NAME="$(basename "$BOT_DIR")"
SESSION="harness-${BOT_NAME}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running"
    tmux attach -t "$SESSION"
    exit 0
fi

# Defaults
CLAUDE_MODEL="claude-sonnet-4-6"
BOT_SKIP_PERMISSION=""
ENV_EXPORTS=""

# Parse the bot's .env (if present) and collect exports + key knobs.
if [ -f "$BOT_DIR/.env" ]; then
    while IFS='=' read -r key value; do
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        ENV_EXPORTS+="export ${key}='${value}'; "

        case "$key" in
            CLAUDE_MODEL) CLAUDE_MODEL="$value" ;;
            BOT_SKIP_PERMISSION) BOT_SKIP_PERMISSION="$value" ;;
        esac
    done < "$BOT_DIR/.env"
fi
ENV_EXPORTS+="export BOT_NAME='${BOT_NAME}'; "

# Build Claude launch options
CLAUDE_OPTS="--model ${CLAUDE_MODEL} --dangerously-load-development-channels server:slack-channel"
if [ "$BOT_SKIP_PERMISSION" = "true" ]; then
    CLAUDE_OPTS="--dangerously-skip-permissions ${CLAUDE_OPTS}"
fi

# Use bash explicitly to avoid zsh autoenv plugins firing on .env files.
tmux new-session -d -s "$SESSION" -c "$BOT_DIR" "bash"
tmux send-keys -t "$SESSION" "${ENV_EXPORTS}claude ${CLAUDE_OPTS}" Enter

# Background watcher auto-accepts permission prompts when enabled.
if [ "$BOT_SKIP_PERMISSION" = "true" ]; then
    HARNESS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
    nohup bash "$HARNESS_DIR/scripts/auto-approve.sh" "$SESSION" > /dev/null 2>&1 &
fi

echo "Started: $SESSION"
echo "Attach:  tmux attach -t $SESSION"
