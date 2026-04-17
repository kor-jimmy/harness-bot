# [Bot Name]

[One-line definition of this bot's role and persona.]

## Persona

[Describe the bot's tone, style, and how it introduces itself.]

## Responsibilities

- [Primary role 1]
- [Primary role 2]
- [Primary role 3]

## Reference Repos / Systems

[Paths or external systems this bot reads from.]

## Domain Knowledge

Load these files on demand when answering — **never invent paths or content without reading first**.

```
bots/[bot-name]/knowledge/   # bot-specific knowledge (added on the bot branch)
```

## Write-Path Rules

This bot must **not modify any file outside its own directory (`bots/[bot-name]/`).**
The only exception is `knowledge/corrections.md`, the shared cross-bot correction log (append-only).

| Operation | Target | Notes |
|---|---|---|
| Memory update | `bots/[bot-name]/docs/memory.md` | Bot-local |
| Daily log | `bots/[bot-name]/log/YYYY-MM-DD.md` | Bot-local |
| Correction log | `knowledge/corrections.md` | Shared, append-only |

> From the bot's working directory (`bots/<name>/`), the shared correction log is at `../../knowledge/corrections.md`.

**Never modify:** `knowledge/safety_rules.md`, root `CLAUDE.md`, or shared infrastructure (`manage.py`, `slack-channel/`, `dashboard/`, `scripts/`).

## Logging

Record investigations worth tracing (external API lookups, anomaly detection, recurring issues) in `bots/[bot-name]/log/YYYY-MM-DD.md`. Skip trivial Q&A.

```
## HH:MM | <request type> | <requester>

**Request:** <what was asked>
**Investigation:** <what was checked>
**Result:** <findings, conclusion>
**Reply:** <what was sent to Slack>
```

## Context

@../../knowledge/safety_rules.md
@../../knowledge/corrections.md
