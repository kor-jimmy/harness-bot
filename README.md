# harness-bot

Run a team of role-based Claude Code bots in Slack — each bot is a persistent Claude Code session with its own persona, memory, and permissions.

Built on the principles from [OpenAI's Harness Engineering](https://openai.com/index/harness-engineering/) and [Anthropic's Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps).

> 📖 [Building Persistent Claude Code Bots with MCP and Slack](https://medium.com/p/16a24c22771b) — blog post covering the design, memory system, watchdog, and dashboard.

## How It Works

```
Slack mention
  -> slack-channel (MCP channel server)
  -> Claude Code session (bot's working directory)
  -> reply tool
  -> Slack thread
```

Each bot runs as an independent `claude` process in a tmux session. The `slack-channel` MCP server bridges Slack Socket Mode events into Claude Code's context window. Bots share the same channel server binary but have completely isolated contexts.

> **Note:** This project uses Claude Code's `experimental.claude/channel` MCP capability to deliver events into the context window. As the name implies, this is an experimental feature — the API may change in future Claude Code releases. See the [Channels Reference](https://code.claude.com/docs/en/channels-reference) for the current spec.

## Project Structure

```
harness-bot/
  CLAUDE.md                       # shared rules for all bots
  manage.py                       # bot lifecycle manager (start/stop/restart/attach/watch)
  .env.example                    # root env (alert webhook etc.)
  .claude/
    commands/
      add-bot.md                  # /add-bot slash command
    auto-commit.sh                # PostToolUse hook — auto-commits knowledge/docs/log edits
  scripts/
    start-cli.sh                  # shared launcher (reads bot .env, starts tmux + claude)
    auto-approve.sh               # background watcher that auto-clicks permission prompts
  slack-channel/
    index.ts                      # MCP channel server (Slack <-> Claude Code bridge)
    package.json
  dashboard/
    server.js                     # web dashboard (bot status, logs, Slack activity)
    public/
  bots/
    example-bot-cli/              # template — copy this (or run /add-bot) to make a bot
      CLAUDE.md                   # persona, responsibilities
      .env.example
      .mcp.json.example
      .claude/settings.json       # per-bot tool permissions
      docs/memory.md              # mid-term memory
      knowledge/                  # bot-specific domain knowledge
      log/                        # daily activity logs (YYYY-MM-DD.md)
      mcp/                        # optional: custom MCP server implementations
      tmp/                        # scratch (gitignored)
  knowledge/
    context.md                    # product/team context (fill this in)
    safety_rules.md               # shared response principles
    corrections.md                # shared, append-only correction log
  logs/                           # watchdog logs (auto-generated, gitignored)
```

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI installed and authenticated
- [Bun](https://bun.sh) runtime
- tmux
- Python 3.10+
- A Slack app with Socket Mode enabled

## Slack App Setup

1. Create a new app at https://api.slack.com/apps
2. Enable **Socket Mode** and generate an App-Level Token (`xapp-...`) with `connections:write` scope
3. Under **OAuth & Permissions**, add Bot Token Scopes:

   | Scope | Purpose |
   |-------|---------|
   | `app_mentions:read` | Receive mention events |
   | `channels:read`     | List public channels |
   | `channels:history`  | Read public channel messages |
   | `chat:write`        | Send messages |
   | `reactions:write`   | Add emoji reactions |
   | `files:read`        | Read file attachments |
   | `users:read`        | Resolve user names |

   Optional (for private channels):
   | Scope            | Purpose                            |
   |------------------|------------------------------------|
   | `groups:read`    | List private channels              |
   | `groups:history` | Read private channel messages      |

4. Under **Event Subscriptions > Subscribe to bot events**, add `app_mention`
5. Install the app to your workspace and copy the Bot Token (`xoxb-...`)
6. Invite each bot to the channels where it should listen: `/invite @your-bot`

## Installation

```bash
# 1. Install slack-channel dependencies
cd slack-channel
bun install

# 2. (Optional) Set up root .env for watchdog alerts
cp .env.example .env
# Edit .env and fill in ALERT_WEBHOOK_URL if you want crash notifications
```

## Adding a New Bot

The fastest path is the `/add-bot` slash command inside Claude Code. It verifies prerequisites, validates Slack tokens against the real API, copies the template, writes `.env` + `.mcp.json`, and optionally creates a `bot/<name>` git branch.

```
claude                            # launch Claude Code in the harness-bot root
> /add-bot
```

The command walks you through:
1. Prerequisite check (Python, tmux, Bun, dependencies — offers auto-install)
2. Bot name + description
3. Slack Bot Token + App Token (validated against the Slack API)
4. Claude model selection
5. Optional auto-commit hook (knowledge/docs/log edits)
6. Optional auto-approve for permission prompts
7. Optional `bot/<name>` git branch
8. Confirmation → scaffold + commit

### Manual path

If you'd rather do it by hand:

1. `cp -r bots/example-bot-cli bots/your-bot`
2. Edit `bots/your-bot/CLAUDE.md` — persona, responsibilities.
3. `cp bots/your-bot/.env.example bots/your-bot/.env` and fill in tokens.
4. `cp bots/your-bot/.mcp.json.example bots/your-bot/.mcp.json` (or rely on the `--dangerously-load-development-channels` flag that `scripts/start-cli.sh` already sets).
5. `python3 manage.py start your-bot`

## Usage

```bash
# Start all bots + dashboard + watchdog
python3 manage.py start

# Start a single bot
python3 manage.py start your-bot

# Check status
python3 manage.py status

# Attach to a bot's tmux session
python3 manage.py attach your-bot

# Restart
python3 manage.py restart

# Stop everything (bots, dashboard, watchdog)
python3 manage.py stop

# Watchdog — auto-restart crashed bots (logs to logs/watchdog-YYYY-MM-DD.log)
python3 manage.py watch --interval 30
```

`python3 manage.py start` boots the dashboard (`http://localhost:3001`) and the watchdog automatically. A bot you stopped manually (`stop <bot>`) leaves a `.tmp/<bot>.stopped` flag so the watchdog won't bring it back; `start <bot>` clears it.

### Attaching to a bot

```bash
# Through manage.py (recommended)
python3 manage.py attach your-bot

# Or directly
tmux attach -t harness-your-bot

# Detach (the bot keeps running)
# Ctrl+B then D
```

## Dashboard

A web dashboard for monitoring bot status, activity logs, Slack conversations, and settings.

Starts automatically with `python3 manage.py start`. Or run standalone:

```bash
node dashboard/server.js
# Open http://localhost:3001
```

Features:
- **Status** — real-time bot status (running / stopped / warning)
- **Bot Logs** — daily activity logs per bot (`log/YYYY-MM-DD.md`)
- **Watchdog Logs** — auto-restart event history (separate from bot logs)
- **Settings** — browse all CLAUDE.md, knowledge, and memory files
- **Git** — recent commit history
- **Slack** — browse channels, threads, and conversations where bots were mentioned

## Permissions

Each bot has its own `.claude/settings.json` (permission allowlist + denylist). The template in `bots/example-bot-cli/.claude/settings.json` is a conservative starting point — read-heavy, no destructive git operations. Adjust per bot.

```json
{
  "permissions": {
    "allow": [
      "mcp__slack-channel__*",
      "Read(*)",
      "Bash(git log:*)",
      "Bash(curl:*)",
      "Write(bots/my-bot/log/*)",
      "Write(bots/my-bot/docs/*)"
    ],
    "deny": [
      "Bash(git commit:*)",
      "Bash(git push:*)"
    ]
  }
}
```

## External MCP Servers

Add more MCP servers to a bot's `.mcp.json` (in addition to `slack-channel`), then extend `.claude/settings.json` with `mcp__<name>__*` permissions.

```json
{
  "mcpServers": {
    "slack-channel": {
      "command": "bun",
      "args": ["run", "../../slack-channel/index.ts"]
    },
    "sentry": {
      "command": "python3",
      "args": ["bots/my-bot/mcp/mcp-sentry/server.py"],
      "env": { "SENTRY_DSN": "https://..." }
    }
  }
}
```

Custom MCP servers can live in `bots/<bot>/mcp/mcp-<service>/server.py` — plain FastMCP works:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("sentry")

@mcp.tool()
def get_latest_errors(project: str, limit: int = 10) -> str:
    ...
    return "result"

if __name__ == "__main__":
    mcp.run()
```

## Memory System

Each bot maintains a 3-layer memory:

| Layer      | Location                        | Lifespan                       |
|------------|---------------------------------|--------------------------------|
| Long-term  | `CLAUDE.md` + `knowledge/`      | Permanent (version controlled) |
| Mid-term   | `docs/memory.md`                | Persistent (updated each session) |
| Short-term | Claude's context window         | Current session only           |

Bots auto-update `docs/memory.md` when the user changes direction, confirms a pattern, or when a mistake occurs. Mistakes are also appended to the shared `knowledge/corrections.md`.

## Bot Collaboration

Bots can mention each other in Slack threads. Each mentioned bot reads the full thread history and picks up where the previous one left off.

```
User     -> @alice: review this PR
Alice    -> analyzes and replies
User     -> @bob:   do we have data supporting this approach?
Bob      -> reads the thread, adds data analysis
```

See the **Handoff Protocol** section in `CLAUDE.md` for how bots close their turn before passing control.

## Branching Strategy

```
master          — shared skeleton (infrastructure, common rules, template bot)
  └─ bot/alice  — alice bot (persona, knowledge, permissions)
  └─ bot/bob    — bob bot
```

**master (shared):**
- `manage.py`, `slack-channel/`, `scripts/`, `dashboard/`
- `knowledge/` (baseline rules — bot branches extend it)
- `bots/example-bot-cli/` (template only)

**Bot branches:** real bot directories (`bots/alice/` etc.), bot-specific knowledge, persona.

Don't add real bots to master. Pull infrastructure updates into bot branches via `git merge master`.

## Design Philosophy

This project is built on **harness engineering** — the idea that an LLM's performance is determined as much by the quality of its runtime environment (context, memory, permissions, tools) as by the model itself.

Key principles:
- **Progressive Disclosure** — CLAUDE.md is an index, not a manual. Details load on demand.
- **Permanent Correction** — Mistakes become rules via `knowledge/corrections.md`.
- **Role Isolation** — Each bot has a focused context. No bot knows everything.
- **Shared Infrastructure, Isolated Context** — All bots share the channel server; none share their working memory.

## References

- [OpenAI: Harness Engineering](https://openai.com/index/harness-engineering/)
- [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Claude Code: Channels Reference](https://code.claude.com/docs/en/channels-reference)

## License

[MIT](LICENSE)
