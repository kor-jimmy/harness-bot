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

// 슬라이딩 타임아웃 — 마지막 reply 이후 X분간 침묵이면 fallback 전송
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
      text: '응답이 지연되고 있습니다. 잠시 후 다시 멘션해 주세요.',
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

// MCP 채널 서버
const mcp = new Server(
  { name: `slack-${BOT_NAME}`, version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      `Slack 메시지가 <channel source="slack-${BOT_NAME}" ...> 형태로 옵니다. ` +
      `반드시 reply 툴로 응답하세요. channel과 thread_ts를 태그에서 그대로 가져와 사용합니다. ` +
      `텔레그램 마크다운 문법(**bold**)은 사용하지 말고, 일반 텍스트로 응답합니다.`,
  },
)

// reply 툴: Slack 스레드로 응답
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Slack 스레드에 메시지를 보냅니다',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '슬랙 채널 ID' },
        thread_ts: { type: 'string', description: '스레드 timestamp' },
        text: { type: 'string', description: '보낼 메시지' },
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

// Slack 파일 다운로드 헬퍼 — /tmp에 저장 후 경로를 Claude에 전달 (OS가 정리)
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
      parts.push(`[첨부파일: ${file.name} (${file.mimetype}) → ${tmpPath}]`)
    } catch {
      // 파일 다운로드 실패는 무시
    }
  }
  return parts.length ? '\n' + parts.join('\n') : ''
}

await mcp.connect(new StdioServerTransport())

// Slack Socket Mode 앱 (logger를 stderr로 — stdout은 MCP stdio 전용)
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

// 멘션 이벤트 수신 → 스레드 히스토리 포함해서 Claude에 전달
slack.event('app_mention', async ({ event }) => {
  // 수신 확인 이모지
  web.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {})

  const threadTs = (event as any).thread_ts || event.ts

  // 스레드 히스토리 가져오기
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
    ? `[스레드 히스토리]\n${history}\n\n[현재 메시지]\n${currentMessage}`
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
