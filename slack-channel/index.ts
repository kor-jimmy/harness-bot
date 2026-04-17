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

// Sliding reply timeout — if the bot stays silent for X minutes after
// receiving a mention, post a fallback message so the user isn't left hanging.
const REPLY_TIMEOUT_MS = 5 * 60 * 1000
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resetReplyTimer(channel: string, thread_ts: string) {
  const key = `${channel}:${thread_ts}`
  const existing = pendingTimers.get(key)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    pendingTimers.delete(key)
    process.stderr.write(`[warn] reply timeout: ${key}\n`)
    await web.chat.postMessage({
      channel,
      thread_ts,
      text: 'The bot is taking longer than expected. Please mention it again in a moment.',
    }).catch(() => {})
  }, REPLY_TIMEOUT_MS)

  pendingTimers.set(key, timer)
}

function clearReplyTimer(channel: string, thread_ts: string) {
  const key = `${channel}:${thread_ts}`
  const existing = pendingTimers.get(key)
  if (existing) {
    clearTimeout(existing)
    pendingTimers.delete(key)
  }
}

// MCP channel server
const mcp = new Server(
  { name: `slack-${BOT_NAME}`, version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      `Slack messages arrive as <channel source="slack-${BOT_NAME}" ...> blocks. ` +
      `Always respond with the reply tool. Copy the channel and thread_ts from the tag verbatim. ` +
      `Use Slack mrkdwn (*bold*, _italic_, \`code\`) — not standard Markdown (**bold**). ` +
      `For multi-step work, send a short "working on it" reply first, then a final reply when done.`,
  },
)

// reply tool — post into the Slack thread
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message to the Slack thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel ID' },
        thread_ts: { type: 'string', description: 'Thread timestamp' },
        text: { type: 'string', description: 'Message body' },
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
    clearReplyTimer(channel, thread_ts)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Allowed MIME types for Slack file attachments
const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/csv',
])
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024   // 10MB (non-image)
const MAX_IMAGE_SIZE_BYTES = 3 * 1024 * 1024   // 3MB (image — base64-encoded payload stays under the Claude API 5MB cap)

// Slack file helper — download into /tmp and pass the path to Claude (OS cleans it up)
async function buildFileAnnotations(files: any[]): Promise<string> {
  if (!files?.length) return ''
  const parts: string[] = []
  for (const file of files) {
    const mime = file.mimetype || ''
    const size = file.size || 0

    if (!ALLOWED_MIME_TYPES.has(mime)) {
      process.stderr.write(`[security] blocked file type: ${file.name} (${mime})\n`)
      parts.push(`[attachment blocked: ${file.name} — unsupported type (${mime})]`)
      continue
    }

    const isImage = mime.startsWith('image/')
    const sizeLimit = isImage ? MAX_IMAGE_SIZE_BYTES : MAX_FILE_SIZE_BYTES
    if (size > sizeLimit) {
      const limitMB = Math.round(sizeLimit / 1024 / 1024)
      process.stderr.write(`[security] file too large: ${file.name} (${size} bytes, limit ${limitMB}MB)\n`)
      parts.push(`[attachment blocked: ${file.name} — too large (${Math.round(size / 1024 / 1024)}MB, max ${limitMB}MB)]`)
      continue
    }

    const url = file.url_private_download || file.url_private
    if (!url) continue
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } })
      if (!res.ok) continue

      // Verify the actual downloaded size (file.size from Slack can be missing or stale)
      const buffer = await res.arrayBuffer()
      const actualSize = buffer.byteLength
      if (actualSize > sizeLimit) {
        const limitMB = Math.round(sizeLimit / 1024 / 1024)
        process.stderr.write(`[security] downloaded file too large: ${file.name} (${actualSize} bytes, limit ${limitMB}MB)\n`)
        parts.push(`[attachment blocked: ${file.name} — too large (${Math.round(actualSize / 1024 / 1024)}MB, max ${limitMB}MB)]`)
        continue
      }

      const ext = (file.filetype || 'bin').replace(/[^a-zA-Z0-9]/g, '')
      const tmpPath = `/tmp/slack_file_${file.id}.${ext}`
      await Bun.write(tmpPath, buffer)
      parts.push(`[attachment: ${file.name} (${mime}) → ${tmpPath}]`)
    } catch {
      // ignore download failures
    }
  }
  return parts.length ? '\n' + parts.join('\n') : ''
}

await mcp.connect(new StdioServerTransport())

// Slack Socket Mode (logger writes to stderr — stdout is reserved for MCP stdio)
const slack = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  logger: {
    debug: (...msgs) => process.stderr.write(`[debug] ${msgs.join(' ')}\n`),
    info:  (...msgs) => process.stderr.write(`[info]  ${msgs.join(' ')}\n`),
    warn:  (...msgs) => process.stderr.write(`[warn]  ${msgs.join(' ')}\n`),
    error: (...msgs) => process.stderr.write(`[error] ${msgs.join(' ')}\n`),
    setLevel: () => {},
    getLevel: () => 'info' as any,
  },
})

// Mention handler → include thread history, then forward to Claude
slack.event('app_mention', async ({ event }) => {
  // Acknowledge with an eyes emoji so the user sees the bot noticed
  web.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {})

  const threadTs = (event as any).thread_ts || event.ts

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
        const sender = m.bot_id ? `bot:${m.username ?? m.bot_id}` : (m.user ?? 'unknown')
        return `[${sender}]: ${m.text}${fileAnnotations}`
      })
    )
    history = historyParts.join('\n')
  } catch (e) {
    process.stderr.write(`[warn] thread history fetch failed: ${e}\n`)
  }

  const currentFileAnnotations = await buildFileAnnotations((event as any).files ?? [])
  const currentMessage = `${(event as any).text}${currentFileAnnotations}`

  const content = history
    ? `[thread history]\n${history}\n\n[current message]\n${currentMessage}`
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

  resetReplyTimer(event.channel, threadTs)
})

await slack.start()

// Health check — every 60s, call auth.test(); after 3 consecutive failures,
// exit so the watchdog can restart the process.
const HEALTH_CHECK_INTERVAL_MS = 60_000
const MAX_FAILURES = 3
let consecutiveFailures = 0

setInterval(async () => {
  try {
    await web.auth.test()
    if (consecutiveFailures > 0) {
      process.stderr.write(`[info] slack health check recovered after ${consecutiveFailures} failure(s)\n`)
    }
    consecutiveFailures = 0
  } catch (e) {
    consecutiveFailures++
    process.stderr.write(`[warn] slack health check failed (${consecutiveFailures}/${MAX_FAILURES}): ${e}\n`)
    if (consecutiveFailures >= MAX_FAILURES) {
      process.stderr.write(`[error] slack health check failed ${MAX_FAILURES} times — exiting for restart\n`)
      process.exit(1)
    }
  }
}, HEALTH_CHECK_INTERVAL_MS)
