# Harness Bot — Shared Rules

## Harness Engineering Philosophy

> "The model is the CPU, the harness is the OS."
> Same LLM, but harness quality determines how well it performs.
> "Context is scarce — give the model a map, not a 1,000-page manual."

**3 Core Principles:**

1. **Progressive Disclosure** — This file is the index. Details live in `knowledge/`. Load only what's needed.
2. **Permanent Correction** — Mistakes go into `knowledge/corrections.md` as rules. Never repeat the same mistake.
3. **Single Source of Truth** — Domain knowledge lives only in `knowledge/`. Never copy it directly into CLAUDE.md.

## Knowledge Base

```
knowledge/
  context.md       # product overview, repo structure, tech stack
  safety_rules.md  # anti-hallucination, security, response principles
```

Bot-specific personas and responsibilities live in each bot's CLAUDE.md.

## Auto-Memory Rules

Update `docs/memory.md` immediately when any of the following occurs.
Do NOT record simple acknowledgements ("ok", "got it").

- User changes direction or corrects course → record adopted direction
- User repeats the same correction → record as a permanent rule
- A format, tone, or style is confirmed → record it
- A mistake occurs → record immediately in `knowledge/corrections.md`

## Shared Infrastructure

`slack-channel/` and `manage.py` are shared by all bots.
**Individual bots must never modify these files.**
If a change is needed, report it to the operator who manages the harness root.

## Available Commands

| Command | Description |
|---|---|
| `/reflect` | Summarize session learnings and update `docs/memory.md` |
| `/log-fix` | Record the latest correction in `knowledge/corrections.md` |

## Bot Team

| Bot | Role |
|---|---|
| engineer | Code review, bug analysis, architecture |
| marketer | Campaigns, copy, trend analysis |
| researcher | Data analysis, metrics, research |

To call another bot, mention it by Slack user ID: `<@UXXXXXXXXX>`.
The mentioned bot will read the thread history and continue from there.

## Response Principles

- Be concise and direct
- Mark uncertain information as "needs verification"
- Never include API keys, passwords, or PII in responses
- **Always use the `reply` tool to send results back to Slack after completing any task.**

## Slack Formatting Rules

Use Slack mrkdwn syntax. Standard Markdown does not render in Slack.

| Purpose | Correct | Wrong |
|---|---|---|
| Bold | `*text*` | `**text**` |
| Italic | `_text_` | `*text*` |
| Code | `` `code` `` | — |
| Code block | ` ```code``` ` | — |
| Quote | `> text` | — |
| List | `•` or `-` | `*` |

**Never use** `##` headers, `**bold**`, HTML tags, or markdown tables (`| col |`).
For tables, use bullet lists (≤3 items) or a fenced code block with fixed-width formatting.
