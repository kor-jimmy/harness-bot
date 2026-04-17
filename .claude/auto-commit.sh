#!/bin/bash
# PostToolUse hook — auto-commit edits to knowledge/, docs/, log/, CLAUDE.md
#
# Wire this in a bot's .claude/settings.json:
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Edit|Write",
#           "hooks": [{ "type": "command", "command": "bash .claude/auto-commit.sh" }]
#         }
#       ]
#     }
#   }
#
# Opt out per bot by setting AUTO_COMMIT=false in the bot's .env.

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Parse the edited file path from the hook payload on stdin.
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('tool_input', {}).get('file_path', ''))
" 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# Walk up from the edited file looking for a bot-level .env.
# If AUTO_COMMIT=false is set there, skip the commit.
BOT_DIR=$(dirname "$FILE_PATH")
while [ "$BOT_DIR" != "/" ] && [ "$BOT_DIR" != "." ]; do
    if [ -f "$BOT_DIR/.env" ]; then
        AUTO_COMMIT=$(grep "^AUTO_COMMIT=" "$BOT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d "'" | tr -d '"')
        if [ "$AUTO_COMMIT" = "false" ]; then
            exit 0
        fi
        break
    fi
    BOT_DIR=$(dirname "$BOT_DIR")
done

# Only auto-commit files in the supported path patterns.
case "$FILE_PATH" in
  */knowledge/*.md|*/docs/*.md|*/log/*.md|*/CLAUDE.md|*/corrections.md|*/safety_rules.md)
    ;;
  *)
    exit 0
    ;;
esac

cd "$REPO" || exit 0
git rev-parse --git-dir > /dev/null 2>&1 || exit 0

REL_PATH="${FILE_PATH#$REPO/}"
git add "$REL_PATH" 2>/dev/null || exit 0
git diff --cached --quiet && exit 0

FILENAME=$(basename "$FILE_PATH")
git commit -m "docs: update $FILENAME

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" --quiet
