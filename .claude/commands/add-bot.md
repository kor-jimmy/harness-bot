Add a new bot interactively. Work through the steps below in order. If a step fails, explain why and let the user retry that step.

## Step 1: Prerequisite check

Check each tool in order. If a tool is missing and can be installed automatically, offer the install as a choice. Anything that *can't* be auto-installed aborts the flow with a clear instruction.

**Python 3:**
- Check: `which python3`
- Missing:
  ```
  Python 3 is not installed. Install it?
    ☐ 1. Yes (brew install python3)
    ☐ 2. No (install manually, then rerun)
  ```

**tmux:**
- Check: `which tmux`
- Missing:
  ```
  tmux is not installed. Install it?
    ☐ 1. Yes (brew install tmux)
    ☐ 2. No (install manually, then rerun)
  ```

**Bun:**
- Check: `which bun`
- Missing:
  ```
  Bun is not installed. Install it?
    ☐ 1. Yes (curl -fsSL https://bun.sh/install | bash)
    ☐ 2. No (install manually, then rerun)
  ```

**slack-channel dependencies:**
- Check: `slack-channel/node_modules` exists
- Missing:
  ```
  slack-channel dependencies are missing. Install them?
    ☐ 1. Yes (cd slack-channel && bun install)
    ☐ 2. No
  ```

**Project layout (cannot auto-install — abort if missing):**
- `slack-channel/` must exist. If not: "slack-channel/ not found. Run this command from the harness-bot project root."
- `bots/example-bot-cli/` must exist. If not: "example-bot-cli template missing. Check the master branch."

## Step 2: Bot name

Ask for the bot name.

Validation:
- Lowercase letters, digits, and hyphens only. Regex: `^[a-z][a-z0-9-]*[a-z0-9]$`, minimum 2 characters.
- Reserved names: `example-bot-cli`, `example-bot-sdk`, `template`, `test`, `all`.
- `bots/{name}` must not already exist.

On failure, explain why and re-prompt.

## Step 3: Description

Ask for a one-line description of the bot's role. Empty input is not allowed.

## Step 4: Slack Bot Token

Ask for the Slack Bot Token (`xoxb-...`).
- Prefix check: must start with `xoxb-`.
- Min length: 20 characters.
- On failure: "Slack Bot Token must start with 'xoxb-'." and re-prompt.

## Step 5: Slack App Token

Ask for the Slack App-Level Token (`xapp-...`).
- Prefix check: must start with `xapp-`.
- Min length: 20 characters.
- On failure: "Slack App Token must start with 'xapp-'. Check that Socket Mode is enabled." and re-prompt.

## Step 6: Slack token validation

Verify both tokens actually work via the Slack API.

**Bot Token:**
```bash
curl -s -H "Authorization: Bearer {xoxb-token}" https://slack.com/api/auth.test
```
- `ok: true` → success. Print the bot username (`user`) and workspace (`team`).
- `ok: false` → print the error reason and go back to Step 4.

**App Token:**
```bash
curl -s -X POST -H "Authorization: Bearer {xapp-token}" https://slack.com/api/apps.connections.open
```
- `ok: true` → success. Print "Socket Mode connection verified."
- `ok: false` → print the error and go back to Step 5.
- `not_allowed_token_type` → "Socket Mode is not enabled. Enable it at https://api.slack.com/apps ."

On network failure: "Could not reach the Slack API." Ask whether to retry or skip.

Both tokens must pass before continuing.

## Step 7: Claude model

Ask which model to use:

```
Select a Claude model:
  ☐ 1. claude-sonnet-4-6         (default — recommended)
  ☐ 2. claude-opus-4-6           (stronger, slower)
  ☐ 3. claude-haiku-4-5-20251001 (lighter, faster)
  ☐ 4. custom (enter a model ID)

Selection (default: 1):
```

## Step 8: Auto-commit hook

Ask whether to auto-commit edits under `knowledge/`, `docs/`, `log/`, and `CLAUDE.md`:

```
Auto-commit edits to knowledge/, docs/, log/ files?
  ☐ 1. Yes (recommended)
  ☐ 2. No

Selection (default: 1):
```

- Yes → add a PostToolUse hook to the bot's `.claude/settings.json`.
- No → skip.

Hook snippet (the script lives at the harness root, so reference it from the bot cwd):
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "bash ../../.claude/auto-commit.sh" }
        ]
      }
    ]
  }
}
```

## Step 9: Permission auto-approve

Ask whether to auto-approve permission prompts:

```
Auto-approve tool permission prompts?
  ☐ 1. No  (default — approve each prompt manually)
  ☐ 2. Yes (adds --dangerously-skip-permissions + background watcher)

Selection (default: 1):
```

- No → default behavior.
- Yes → add `BOT_SKIP_PERMISSION=true` to the bot's `.env`. The `scripts/start-cli.sh` launcher then adds the `--dangerously-skip-permissions` flag and starts `scripts/auto-approve.sh` in the background.

## Step 10: Git branch

Ask whether to create a dedicated bot branch:

```
Create a dedicated Git branch for this bot? (bot/{name})
  ☐ 1. Yes (recommended)
  ☐ 2. No

Selection (default: 1):
```

- Yes → branch is created first in the execution phase so all subsequent files land on the bot branch.
- No → work on the current branch.

## Step 11: Confirmation

Show the collected values and ask for final confirmation:

```
Summary:
- Name:           {name}
- Description:    {description}
- Model:          {model}
- Auto-commit:    {enabled|disabled}
- Auto-approve:   {enabled|disabled}
- Branch:         bot/{name} (or "skipped")

Proceed?
  ☐ 1. Yes, create the bot
  ☐ 2. No, cancel

Selection (default: 1):
```

## Execution

Run the steps in order. Print progress after each.

**[1/6] Git branch (if selected)**
- `git checkout -b bot/{name}`
- Warn about uncommitted changes before switching; offer stash/commit.

**[2/6] Copy template**
- `cp -r bots/example-bot-cli bots/{name}`
- Do not copy `.env.example` or `.mcp.json.example`.

**[3/6] Create .env**
- `bots/{name}/.env`:
  ```
  SLACK_BOT_TOKEN={bot token}
  SLACK_APP_TOKEN={app token}
  BOT_NAME={name}
  CLAUDE_MODEL={model}
  BOT_SKIP_PERMISSION={true|false}
  AUTO_COMMIT={true|false}
  ```

**[4/6] Create .mcp.json**
- Resolve `which bun` for the absolute path to bun.
- Resolve the absolute path to `slack-channel/index.ts`.
- Write `bots/{name}/.mcp.json`:
  ```json
  {
    "mcpServers": {
      "slack-channel": {
        "command": "{absolute bun path}",
        "args": ["run", "{absolute slack-channel/index.ts path}"]
      }
    }
  }
  ```

**[5/6] Customize CLAUDE.md**
- In `bots/{name}/CLAUDE.md`, replace:
  - `[Bot Name]` → `{name}`
  - `[One-line definition of this bot's role and persona.]` → `{description}`

**[6/6] Commit**
- Stage the bot's files (exclude `.env` and `.mcp.json`).
- Commit with message: `feat: scaffold bot {name}`

## Done

```
Bot `{name}` is ready.

Start:  python3 manage.py start {name}
Status: python3 manage.py status
```
