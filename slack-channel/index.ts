#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { App } from '@slack/bolt'
import { WebClient } from '@slack/web-api'

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN!
const APP_TOKEN = process.env.SLACK_APP_TOKEN!
const BOT_NAME = process.env.BOT_NAME || 'bot'

const web = new WebClient(BOT_TOKEN)

// MCP Channel Server — bridges Slack ↔ Claude Code
const mcp = new Server(
  { name: `slack-${BOT_NAME}`, version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      `Slack messages arrive as <channel source="slack-${BOT_NAME}" ...> tags. ` +
      `Always respond using the reply tool. Use the channel and thread_ts from the tag. ` +
      `Do not use Markdown headers or **bold** syntax — use plain text or Slack mrkdwn.`,
  },
)

// reply tool: post a message back to the Slack thread
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message to the Slack thread',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel ID' },
        thread_ts: { type: 'string', description: 'Thread timestamp' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['channel', 'thread_ts', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { channel, thread_ts, text } = req.params.arguments as {
      channel: string
      thread_ts: string
      text: string
    }
    await web.chat.postMessage({ channel, thread_ts, text })
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Slack file download helper — files saved to /tmp, cleaned up by OS
async function buildFileAnnotations(files: any[]): Promise<string> {
  if (!files?.length) return ''
  const parts: string[] = []
  for (const file of files) {
    const url = file.url_private_download || file.url_private
    if (!url) continue
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } })
      if (!res.ok) continue
      const ext = file.filetype || 'bin'
      const tmpPath = `/tmp/slack_file_${file.id}.${ext}`
      await Bun.write(tmpPath, await res.arrayBuffer())
      parts.push(`[attachment: ${file.name} (${file.mimetype}) → ${tmpPath}]`)
    } catch {
      // ignore download failures
    }
  }
  return parts.length ? '\n' + parts.join('\n') : ''
}

await mcp.connect(new StdioServerTransport())

// Slack Socket Mode app (logger writes to stderr — stdout is reserved for MCP stdio)
const slack = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  logger: {
    debug: (...msgs) => process.stderr.write(`[debug] ${msgs.join(' ')}\n`),
    info: (...msgs) => process.stderr.write(`[info] ${msgs.join(' ')}\n`),
    warn: (...msgs) => process.stderr.write(`[warn] ${msgs.join(' ')}\n`),
    error: (...msgs) => process.stderr.write(`[error] ${msgs.join(' ')}\n`),
    setLevel: () => {},
    getLevel: () => 'info' as any,
  },
})

// Receive app_mention → include thread history → push to Claude
slack.event('app_mention', async ({ event }) => {
  // acknowledge receipt with 👀
  web.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {})

  const threadTs = (event as any).thread_ts || event.ts

  // fetch thread history
  let history = ''
  try {
    const result = await web.conversations.replies({
      channel: event.channel,
      ts: threadTs,
    })
    const messages = result.messages ?? []
    const historyParts = await Promise.all(
      messages.map(async (m: any) => {
        const fileAnnotations = await buildFileAnnotations(m.files ?? [])
        return `[${m.user ?? 'bot'}]: ${m.text}${fileAnnotations}`
      })
    )
    history = historyParts.join('\n')
  } catch (e) {
    process.stderr.write(`[warn] thread history fetch failed: ${e}\n`)
  }

  const currentFileAnnotations = await buildFileAnnotations((event as any).files ?? [])
  const currentMessage = `${(event as any).text}${currentFileAnnotations}`

  const content = history
    ? `[Thread History]\n${history}\n\n[Current Message]\n${currentMessage}`
    : currentMessage

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        channel: event.channel,
        thread_ts: threadTs,
        user: (event as any).user,
        ts: event.ts,
      },
    },
  })
})

await slack.start()
