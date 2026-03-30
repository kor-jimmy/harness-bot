# harness-bot

Run a team of role-based Claude Code bots in Slack — each bot is a persistent Claude Code session with its own persona, memory, and permissions.

## How It Works

```
Slack mention
  → slack-channel (MCP channel server)
  → Claude Code session (bot's working directory)
  → reply tool
  → Slack thread
```

Each bot runs as an independent `claude` process in a tmux session. The `slack-channel` MCP server bridges Slack Socket Mode events into Claude Code's context window. Bots share the same channel server binary but have completely isolated contexts.

## Project Structure

```
harness-bot/
  CLAUDE.md              # shared rules for all bots
  manage.py              # bot lifecycle manager (start/stop/restart/watch)
  .env.example           # environment variables template
  slack-channel/
    index.ts             # MCP channel server (Slack ↔ Claude Code bridge)
    package.json
  bots/
    engineer/            # example: engineer bot
      CLAUDE.md          # persona, responsibilities, rules
      .claude/
        settings.json    # tool permissions
      start.sh           # tmux session launcher
      docs/
        memory.md        # mid-term memory (updated by bot during sessions)
    marketer/            # example: marketer bot
    researcher/          # example: researcher bot
  knowledge/
    context.md           # product/team context (fill this in)
    safety_rules.md      # shared response principles
```

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI installed and authenticated
- [Bun](https://bun.sh) runtime
- tmux
- A Slack app with Socket Mode enabled

## Slack App Setup

1. Create a new app at https://api.slack.com/apps
2. Enable **Socket Mode** → generate an App-Level Token (`xapp-...`) with `connections:write` scope
3. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `reactions:write`, `channels:history`, `groups:history`
4. Under **Event Subscriptions → Subscribe to bot events**, add `app_mention`
5. Install the app to your workspace → copy the Bot Token (`xoxb-...`)
6. Invite each bot to the channels where it should listen: `/invite @your-bot`

## Installation

```bash
# 1. Install slack-channel dependencies
cd slack-channel
bun install

# 2. Set up environment
cp .env.example .env
# Edit .env with your SLACK_BOT_TOKEN and SLACK_APP_TOKEN
```

> Each bot's working directory inherits `.env` automatically via Bun's built-in loader.
> If bots use different Slack apps, place separate `.env` files in each `bots/<name>/` directory.

## Usage

```bash
# Start all bots
python3 manage.py start

# Start a single bot
python3 manage.py start engineer

# Check status
python3 manage.py status

# Restart all
python3 manage.py restart

# Watchdog — auto-restart crashed bots
python3 manage.py watch
```

## Adding a New Bot

1. Copy an existing bot directory: `cp -r bots/engineer bots/your-role`
2. Update `bots/your-role/CLAUDE.md` — persona, responsibilities, rules
3. Update `bots/your-role/start.sh` — change `SESSION` and `BOT_NAME`
4. Add the bot to `manage.py` BOTS dict
5. Create a Slack app (or reuse one) and update `.env`
6. Run `python3 manage.py start your-role`

## Memory System

Each bot maintains a 3-layer memory:

| Layer | Location | Lifespan |
|---|---|---|
| Long-term | `CLAUDE.md` + `knowledge/` | Permanent (version controlled) |
| Mid-term | `docs/memory.md` | Persistent (updated each session) |
| Short-term | Claude's context window | Current session only |

Bots auto-update `docs/memory.md` when the user changes direction, confirms a pattern, or when a mistake occurs.

## Bot Collaboration

Bots can mention each other in Slack threads. Each mentioned bot reads the full thread history and picks up where the previous one left off.

```
User → @engineer: review this PR
Engineer → analyzes and replies
User → @researcher: do we have data supporting this approach?
Researcher → reads the thread, adds data analysis
```

## Design Philosophy

This project is built on **harness engineering** — the idea that an LLM's performance is determined as much by the quality of its runtime environment (context, memory, permissions, tools) as by the model itself.

Key principles:
- **Progressive Disclosure**: CLAUDE.md is an index, not a manual. Details load on demand.
- **Permanent Correction**: Mistakes become rules via `knowledge/corrections.md`.
- **Role Isolation**: Each bot has a focused context. No bot knows everything.
- **Shared Infrastructure, Isolated Context**: All bots share the channel server; none share their working memory.
