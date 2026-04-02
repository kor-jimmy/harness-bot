#!/usr/bin/env node
/**
 * Nursely Harness Dashboard — lightweight HTTP server + API
 *
 * Usage:  node dashboard/server.js
 * Env:    DASHBOARD_PORT (default 3001)
 *         HARNESS_ROOT   (default ..)
 *
 * Required Slack Bot Token Scopes:
 *   - app_mentions:read    멘션 이벤트 수신
 *   - channels:read        공개 채널 목록 조회
 *   - channels:history     공개 채널 메시지 히스토리
 *   - chat:write           봇 메시지 전송
 *   - reactions:write       이모지 반응
 *   - files:read           첨부파일 조회
 *   - users:read           유저 정보 조회
 *
 * Optional (비공개 채널 지원 시):
 *   - groups:read          비공개 채널 목록 조회
 *   - groups:history       비공개 채널 메시지 히스토리
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.DASHBOARD_PORT || "3001", 10);
const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, ".."));
const PUBLIC = path.join(__dirname, "public");

// .env 로드 (Slack 토큰용)
function loadEnv() {
  const candidates = [];
  // 봇별 .env
  const botsDir = path.join(ROOT, "bots");
  if (fs.existsSync(botsDir)) {
    for (const dir of fs.readdirSync(botsDir)) {
      const envFile = path.join(botsDir, dir, ".env");
      if (fs.existsSync(envFile)) candidates.push(envFile);
    }
  }
  candidates.push(path.join(ROOT, ".env"));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const m = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      break; // 첫 번째 발견된 .env만 로드
    }
  }
}
loadEnv();

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

// ── Bot discovery ───────────────────────────────────────────────────
// Discovers bots from bots/ directory automatically.
// Session name: harness-{botName} (matches manage.py convention)
function discoverBotDirs() {
  const dirs = [];
  const botsDir = path.join(ROOT, "bots");
  if (fs.existsSync(botsDir)) {
    for (const name of fs.readdirSync(botsDir)) {
      const fullPath = path.join(botsDir, name);
      if (fs.statSync(fullPath).isDirectory()) {
        dirs.push({ name, dir: `bots/${name}`, session: `harness-${name}` });
      }
    }
  }
  return dirs;
}

// ── helpers ─────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

function safe(fn) {
  return async (req, res, params) => {
    try {
      await fn(req, res, params);
    } catch (e) {
      console.error("[API error]", e.message);
      err(res, e.message);
    }
  };
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8", timeout: 10000, ...opts }).trim();
}

// ── Slack API helper ────────────────────────────────────────────────
async function slackApi(method, params = {}) {
  if (!SLACK_TOKEN) throw new Error("SLACK_BOT_TOKEN not configured");

  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`);
  return data;
}

// ── API routes ──────────────────────────────────────────────────────

// GET /api/status — 봇 상태
const apiStatus = safe(async (_req, res) => {
  let output = "";
  try {
    output = run("python3 manage.py status");
  } catch {
    output = "manage.py 실행 실패";
  }

  const bots = [];
  const knownNames = new Set();
  const lines = output.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s+(\w+)\s+(harness-\S+)\s+(.+)$/);
    if (m) {
      knownNames.add(m[1]);
      bots.push({
        name: m[1],
        session: m[2],
        status: m[3].includes("실행 중") || m[3].includes("running") ? "running"
          : m[3].includes("꺼짐") || m[3].includes("stopped") ? "stopped"
          : "warning",
        raw: m[3].trim(),
      });
    }
  }

  // 봇별 아바타 이미지 존재 확인
  for (const bot of bots) {
    const imgExts = [".jpeg", ".jpg", ".png"];
    bot.avatar = null;
    const botDirs = [path.join(ROOT, bot.name), path.join(ROOT, "bots", bot.name)];
    for (const botDir of botDirs) {
      for (const ext of imgExts) {
        const imgPath = path.join(botDir, `${bot.name}${ext}`);
        if (fs.existsSync(imgPath)) {
          bot.avatar = `/avatar/${bot.name}${ext}`;
          break;
        }
      }
      if (bot.avatar) break;
    }
  }

  json(res, { bots, raw: output });
});

// GET /api/logs — 봇 활동 로그 목록 (log/YYYY-MM-DD.md)
const apiLogs = safe(async (_req, res) => {
  const logs = [];
  const botDirs = discoverBotDirs();

  for (const bot of botDirs) {
    const logDir = path.join(ROOT, bot.dir, "log");
    if (!fs.existsSync(logDir)) continue;
    for (const file of fs.readdirSync(logDir)) {
      if (file.endsWith(".md")) {
        logs.push({ bot: bot.name, file, date: file.replace(".md", "") });
      }
    }
  }
  logs.sort((a, b) => b.date.localeCompare(a.date));
  json(res, { logs });
});

// GET /api/logs/:bot/:date — 특정 로그 내용
const apiLogDetail = safe(async (_req, res, params) => {
  // 양쪽 구조 모두 탐색
  const candidates = [
    path.join(ROOT, params.bot, "log", `${params.date}.md`),
    path.join(ROOT, "bots", params.bot, "log", `${params.date}.md`),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return json(res, { bot: params.bot, date: params.date, content });
    }
  }
  return err(res, "Log not found", 404);
});

// GET /api/watchdog-logs — 워치독 로그 목록
const apiWatchdogLogs = safe(async (_req, res) => {
  const logDir = path.join(ROOT, "logs");
  const logs = [];
  if (fs.existsSync(logDir)) {
    for (const file of fs.readdirSync(logDir)) {
      if (file.startsWith("watchdog-") && file.endsWith(".log")) {
        logs.push({ file, date: file.replace("watchdog-", "").replace(".log", "") });
      }
    }
  }
  logs.sort((a, b) => b.date.localeCompare(a.date));
  json(res, { logs });
});

// GET /api/watchdog-logs/:date — 워치독 로그 상세
const apiWatchdogLogDetail = safe(async (_req, res, params) => {
  const filePath = path.join(ROOT, "logs", `watchdog-${params.date}.log`);
  if (!fs.existsSync(filePath)) return err(res, "Watchdog log not found", 404);
  const content = fs.readFileSync(filePath, "utf-8");
  json(res, { date: params.date, content });
});

// GET /api/settings — 설정 파일 내용
const apiSettings = safe(async (_req, res) => {
  const files = {};

  // 루트 레벨 설정 파일
  const rootFiles = ["CLAUDE.md", "README.md"];
  for (const name of rootFiles) {
    const fp = path.join(ROOT, name);
    if (fs.existsSync(fp)) files[name] = fs.readFileSync(fp, "utf-8");
  }

  // 루트 knowledge/
  const rootKnowledge = path.join(ROOT, "knowledge");
  if (fs.existsSync(rootKnowledge)) {
    for (const f of fs.readdirSync(rootKnowledge)) {
      const fp = path.join(rootKnowledge, f);
      if (fs.statSync(fp).isFile()) {
        files[`knowledge/${f}`] = fs.readFileSync(fp, "utf-8");
      }
    }
  }

  // 봇별 CLAUDE.md + knowledge/ + docs/
  const botDirs = discoverBotDirs();
  for (const bot of botDirs) {
    const botDir = path.join(ROOT, bot.dir);

    const botClaude = path.join(botDir, "CLAUDE.md");
    if (fs.existsSync(botClaude)) {
      files[`${bot.dir}/CLAUDE.md`] = fs.readFileSync(botClaude, "utf-8");
    }

    for (const subDir of ["knowledge", "docs"]) {
      const sub = path.join(botDir, subDir);
      if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
        for (const f of fs.readdirSync(sub)) {
          const fp = path.join(sub, f);
          if (fs.statSync(fp).isFile()) {
            files[`${bot.dir}/${subDir}/${f}`] = fs.readFileSync(fp, "utf-8");
          }
        }
      }
    }
  }

  json(res, { files });
});

// GET /api/git — 최근 커밋
const apiGit = safe(async (_req, res) => {
  let commits = [];
  try {
    const log = run('git log --pretty=format:"%H||%h||%s||%an||%ar||%ai" -30');
    commits = log.split("\n").filter(Boolean).map((line) => {
      const [hash, short, message, author, relative, date] = line.split("||");
      return { hash, short, message, author, relative, date };
    });
  } catch {}
  json(res, { commits });
});

// GET /api/slack/users — knowledge/team.md 파싱
const apiSlackUsers = safe(async (_req, res) => {
  const users = {};
  const teamFile = path.join(ROOT, "knowledge", "team.md");
  if (fs.existsSync(teamFile)) {
    const lines = fs.readFileSync(teamFile, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/\|\s*(U[A-Z0-9]+)\s*\|\s*([^|]+?)\s*\|/);
      if (m) users[m[1]] = m[2].trim();
    }
  }
  json(res, { users });
});

// GET /api/slack/channels — 봇이 참여한 채널
const apiSlackChannels = safe(async (_req, res) => {
  // public_channel만 조회. 비공개 채널도 포함하려면 "public_channel,private_channel"로 변경
  // 단, groups:read 스코프 필요 (Slack App > OAuth & Permissions > Bot Token Scopes)
  const data = await slackApi("users.conversations", {
    types: "public_channel",
    limit: "100",
  });
  const channels = (data.channels || []).map((c) => ({
    id: c.id,
    name: c.name,
    topic: c.topic?.value || "",
    memberCount: c.num_members,
  }));
  json(res, { channels });
});

// GET /api/slack/threads/:channel — 봇 멘션 스레드
const apiSlackThreads = safe(async (req, res, params) => {
  const url = new URL(req.url, `http://localhost`);
  const now = Math.floor(Date.now() / 1000);
  const oldest = url.searchParams.get("oldest") || String(now - 86400);
  const latest = url.searchParams.get("latest") || String(now);

  const data = await slackApi("conversations.history", {
    channel: params.channel,
    oldest,
    latest,
    limit: "200",
  });

  // 봇이 답글을 달았거나 멘션된 메시지 필터
  const messages = (data.messages || [])
    .filter((m) => m.reply_users?.length || (m.text && m.text.includes("<@")))
    .slice(0, 30)
    .map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      threadTs: m.thread_ts,
      replyCount: m.reply_count || 0,
    }));

  json(res, { channel: params.channel, messages });
});

// GET /api/slack/replies/:channel/:ts — 스레드 답글
const apiSlackReplies = safe(async (_req, res, params) => {
  const data = await slackApi("conversations.replies", {
    channel: params.channel,
    ts: params.ts,
    limit: "50",
  });
  const messages = (data.messages || []).map((m) => ({
    ts: m.ts,
    user: m.user,
    text: m.text,
  }));
  json(res, { channel: params.channel, threadTs: params.ts, messages });
});

// ── router ──────────────────────────────────────────────────────────
function match(method, pattern, url) {
  if (method !== "GET") return null;
  const parts = pattern.split("/");
  const urlParts = url.split("/");
  if (parts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (parts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

const routes = [
  ["GET", "/api/status", apiStatus],
  ["GET", "/api/logs", apiLogs],
  ["GET", "/api/logs/:bot/:date", apiLogDetail],
  ["GET", "/api/watchdog-logs", apiWatchdogLogs],
  ["GET", "/api/watchdog-logs/:date", apiWatchdogLogDetail],
  ["GET", "/api/settings", apiSettings],
  ["GET", "/api/git", apiGit],
  ["GET", "/api/slack/users", apiSlackUsers],
  ["GET", "/api/slack/channels", apiSlackChannels],
  ["GET", "/api/slack/threads/:channel", apiSlackThreads],
  ["GET", "/api/slack/replies/:channel/:ts", apiSlackReplies],
];

// ── server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // API routing
  for (const [method, pattern, handler] of routes) {
    const params = match(req.method, pattern, pathname);
    if (params !== null) return handler(req, res, params);
  }

  // 봇 아바타 이미지 서빙
  const avatarMatch = pathname.match(/^\/avatar\/([\w-]+\.(jpeg|jpg|png))$/);
  if (avatarMatch) {
    const filename = avatarMatch[1];
    const botName = filename.replace(/\.(jpeg|jpg|png)$/, "");
    const candidates = [
      path.join(ROOT, botName, filename),
      path.join(ROOT, "bots", botName, filename),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const ext = path.extname(p);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        return res.end(fs.readFileSync(p));
      }
    }
  }

  // Static files
  let filePath = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
  filePath = path.normalize(filePath);

  // path traversal 방지
  if (!filePath.startsWith(PUBLIC)) return err(res, "Forbidden", 403);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("Not Found");
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Harness Dashboard running at http://0.0.0.0:${PORT}\n`);
  console.log(`  Root: ${ROOT}`);
  console.log(`  Slack: ${SLACK_TOKEN ? "configured" : "not configured"}\n`);
});
