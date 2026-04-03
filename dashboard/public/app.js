/* ── Harness Bot Dashboard — Client ─────────────────────────────── */

const API = "";
let slackPollTimer = null;
let statusPollTimer = null;
let currentChannel = null;
let slackUsers = {};

async function loadSlackUsers() {
  try {
    const data = await api("/api/slack/users");
    slackUsers = data.users || {};
  } catch {}
}

function resolveUser(userId) {
  if (!userId) return "unknown";
  return slackUsers[userId] || userId;
}

function parseSlackText(text) {
  if (!text) return "";
  return text.replace(/<@(U[A-Z0-9]+)>/g, (_, id) => `@${resolveUser(id)}`);
}

// ── Cache ───────────────────────────────────────────────────────────
const cache = {};

function isCacheValid(tab, maxAge = 60000) {
  const c = cache[tab];
  return c && (Date.now() - c.loadedAt < maxAge);
}

function setCache(tab) {
  cache[tab] = { loadedAt: Date.now() };
}

function updateTimestamp(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Tab Navigation ──────────────────────────────────────────────────
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.add("active");
    onTabActivate(tab);
  });
});

function onTabActivate(tab) {
  if (tab !== "slack" && slackPollTimer) { clearInterval(slackPollTimer); slackPollTimer = null; }

  switch (tab) {
    case "status":   loadStatus(); break;
    case "logs":     loadLogs(); break;
    case "watchdog": loadWatchdogLogs(); break;
    case "settings": loadSettings(); break;
    case "git":      loadGit(); break;
    case "slack":    loadSlackChannels(); break;
  }
}

// ── Fetch helper ────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderMd(md) {
  if (typeof marked !== "undefined") return marked.parse(md);
  return `<pre>${esc(md)}</pre>`;
}

function formatTs(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  return d.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

// ── Sidebar Bots ────────────────────────────────────────────────────
function renderSidebarBots(bots) {
  const el = document.getElementById("sidebarBots");
  if (!bots.length) {
    el.innerHTML = `<span class="status-badge">No bots</span>`;
    return;
  }
  el.innerHTML = bots.map((b) => `
    <div class="sidebar-bot-item" onclick="showBotProfile('${esc(b.name)}')">
      ${b.avatar ? `<img src="${esc(b.avatar)}" class="sidebar-bot-avatar" />` : `<span class="sidebar-bot-icon">&#x25C9;</span>`}
      <span class="sidebar-bot-name">${esc(b.name)}</span>
      <span class="status-badge ${b.status}">${
        b.status === "running" ? "running" : "stopped"
      }</span>
    </div>
  `).join("");
}

function showBotProfile(name) {
  const bots = window._botsData || [];
  const bot = bots.find((b) => b.name === name);
  if (!bot) return;

  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('[data-tab="status"]').classList.add("active");
  document.getElementById("tab-status").classList.add("active");

  const el = document.getElementById("statusContent");
  el.innerHTML = `
    <div class="bot-profile">
      ${bot.avatar
        ? `<img src="${esc(bot.avatar)}" class="bot-profile-avatar" />`
        : `<div class="bot-profile-placeholder">&#x25C9;</div>`}
      <div class="bot-profile-info">
        <h3 class="bot-profile-name">${esc(bot.name)}</h3>
        <span class="bot-card-status ${bot.status}">${esc(bot.raw)}</span>
        <div class="bot-profile-session">${esc(bot.session)}</div>
      </div>
    </div>
    <div style="margin-top:20px">
      <button class="refresh-btn" onclick="loadStatus(true)" style="width:auto;padding:6px 14px;font-size:12px">&larr; All bots</button>
    </div>`;
}

// ── Status ──────────────────────────────────────────────────────────
async function loadStatus(force = false) {
  if (!force && isCacheValid("status", 30000)) return;
  const el = document.getElementById("statusContent");
  try {
    const data = await api("/api/status");

    if (!data.bots || data.bots.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>No bots registered</p></div>`;
      renderSidebarBots([]);
      return;
    }

    window._botsData = data.bots;
    renderSidebarBots(data.bots);

    el.innerHTML = `<div class="bot-status-grid">${data.bots.map((b) => `
      <div class="bot-card" onclick="showBotProfile('${esc(b.name)}')" style="cursor:pointer">
        <div class="bot-card-header">
          ${b.avatar ? `<img src="${esc(b.avatar)}" class="bot-card-avatar" />` : ""}
          <span class="bot-card-name">${esc(b.name)}</span>
          <span class="bot-card-status ${b.status}">${esc(b.raw)}</span>
        </div>
        <div class="bot-card-session">${esc(b.session)}</div>
      </div>
    `).join("")}</div>`;
    setCache("status");
    updateTimestamp("statusUpdated");
  } catch (e) {
    el.innerHTML = `<div class="error-msg">Failed to load status: ${esc(e.message)}</div>`;
  }
}

statusPollTimer = setInterval(() => loadStatus(true), 30000);

// ── Bot Logs ────────────────────────────────────────────────────────
async function loadLogs(force = false) {
  if (!force && isCacheValid("logs")) return;
  const list = document.getElementById("logList");
  try {
    const data = await api("/api/logs");
    if (!data.logs.length) {
      list.innerHTML = `<div class="empty-state"><p>No bot logs yet</p></div>`;
      return;
    }
    list.innerHTML = data.logs.map((l) => `
      <div class="list-item" onclick="loadLogDetail('${esc(l.bot)}','${esc(l.date)}', this)">
        <div>${esc(l.date)}</div>
        <div class="item-sub">${esc(l.bot)}</div>
      </div>
    `).join("");
    setCache("logs");
    updateTimestamp("logsUpdated");
  } catch (e) {
    list.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function loadLogDetail(bot, date, el) {
  if (el) {
    document.querySelectorAll("#logList .list-item").forEach((i) => i.classList.remove("active"));
    el.classList.add("active");
  }
  const detail = document.getElementById("logDetail");
  detail.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const data = await api(`/api/logs/${bot}/${date}`);
    detail.innerHTML = `<div class="md-content">${renderMd(data.content)}</div>`;
  } catch (e) {
    detail.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// ── Watchdog Logs ───────────────────────────────────────────────────
async function loadWatchdogLogs(force = false) {
  if (!force && isCacheValid("watchdog")) return;
  const list = document.getElementById("watchdogList");
  try {
    const data = await api("/api/watchdog-logs");
    if (!data.logs.length) {
      list.innerHTML = `<div class="empty-state"><p>No watchdog logs yet</p></div>`;
      return;
    }
    list.innerHTML = data.logs.map((l) => `
      <div class="list-item" onclick="loadWatchdogDetail('${esc(l.date)}', this)">
        <div>${esc(l.date)}</div>
        <div class="item-sub">watchdog</div>
      </div>
    `).join("");
    setCache("watchdog");
    updateTimestamp("watchdogUpdated");
  } catch (e) {
    list.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function loadWatchdogDetail(date, el) {
  if (el) {
    document.querySelectorAll("#watchdogList .list-item").forEach((i) => i.classList.remove("active"));
    el.classList.add("active");
  }
  const detail = document.getElementById("watchdogDetail");
  detail.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const data = await api(`/api/watchdog-logs/${date}`);
    // watchdog 로그는 plain text이므로 pre로 렌더링
    detail.innerHTML = `<pre class="watchdog-log-content">${esc(data.content)}</pre>`;
  } catch (e) {
    detail.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// ── Settings ────────────────────────────────────────────────────────
function buildTree(files) {
  const root = {};
  for (const fp of files) {
    const parts = fp.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (i === parts.length - 1) {
        node[key] = fp;
      } else {
        if (!node[key] || typeof node[key] === "string") node[key] = {};
        node = node[key];
      }
    }
  }
  return root;
}

function renderTree(node, depth = 0) {
  let html = "";
  const entries = Object.entries(node).sort(([a], [b]) => {
    const aDir = typeof node[a] === "object";
    const bDir = typeof node[b] === "object";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });

  for (const [name, value] of entries) {
    if (typeof value === "object") {
      html += `
        <div class="tree-folder" style="padding-left:${depth * 14}px">
          <div class="tree-folder-header" onclick="toggleFolder(this)">
            <span class="tree-arrow">&#x25B6;</span>
            <span class="tree-folder-name">${esc(name)}</span>
          </div>
          <div class="tree-children collapsed">
            ${renderTree(value, depth + 1)}
          </div>
        </div>`;
    } else {
      html += `
        <div class="list-item tree-file" style="padding-left:${(depth * 14) + 20}px"
             onclick="showSetting(this, '${esc(value)}')" data-file="${esc(value)}">
          ${esc(name)}
        </div>`;
    }
  }
  return html;
}

function toggleFolder(header) {
  const children = header.nextElementSibling;
  const arrow = header.querySelector(".tree-arrow");
  children.classList.toggle("collapsed");
  arrow.classList.toggle("open");
}

async function loadSettings(force = false) {
  if (!force && isCacheValid("settings")) return;
  const list = document.getElementById("settingsList");
  try {
    const data = await api("/api/settings");
    const files = Object.keys(data.files).sort();
    if (!files.length) {
      list.innerHTML = `<div class="empty-state"><p>No settings files</p></div>`;
      return;
    }

    const tree = buildTree(files);
    list.innerHTML = renderTree(tree);
    window._settingsData = data.files;

    list.querySelectorAll(":scope > .tree-folder > .tree-folder-header").forEach((h) => toggleFolder(h));
    setCache("settings");
    updateTimestamp("settingsUpdated");
  } catch (e) {
    list.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function showSetting(el, file) {
  document.querySelectorAll("#settingsList .list-item").forEach((i) => i.classList.remove("active"));
  el.classList.add("active");
  const detail = document.getElementById("settingsDetail");
  const content = window._settingsData?.[file] || "File content not found";
  detail.innerHTML = `<div class="md-content">${renderMd(content)}</div>`;
}

// ── Git ─────────────────────────────────────────────────────────────
async function loadGit(force = false) {
  if (!force && isCacheValid("git")) return;
  const el = document.getElementById("gitContent");
  try {
    const data = await api("/api/git");
    if (!data.commits.length) {
      el.innerHTML = `<div class="empty-state"><p>No commits</p></div>`;
      return;
    }
    el.innerHTML = `<div class="commit-list">${data.commits.map((c) => `
      <div class="commit-row">
        <span class="commit-hash">${esc(c.short)}</span>
        <span class="commit-msg">${esc(c.message)}</span>
        <span class="commit-date">${esc(c.relative)}</span>
      </div>
    `).join("")}</div>`;
    setCache("git");
    updateTimestamp("gitUpdated");
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// ── Slack ────────────────────────────────────────────────────────────
async function loadSlackChannels(force = false) {
  if (!force && isCacheValid("slack")) return;
  const el = document.getElementById("slackChannels");
  try {
    const data = await api("/api/slack/channels");
    if (!data.channels.length) {
      el.innerHTML = `<div class="empty-state"><p>No channels</p></div>`;
      return;
    }
    el.innerHTML = data.channels.map((c) => `
      <div class="list-item" onclick="selectChannel('${esc(c.id)}', '${esc(c.name)}', this)">
        <div># ${esc(c.name)}</div>
        <div class="item-sub">${c.memberCount || 0} members</div>
      </div>
    `).join("");
    setCache("slack");
    updateTimestamp("slackUpdated");
  } catch (e) {
    el.innerHTML = `<div class="error-msg">Slack connection failed: ${esc(e.message)}</div>`;
  }
}

async function selectChannel(id, name, el) {
  if (el) {
    document.querySelectorAll("#slackChannels .list-item").forEach((i) => i.classList.remove("active"));
    el.classList.add("active");
  }
  currentChannel = id;
  await loadSlackThreads(id);

  if (slackPollTimer) clearInterval(slackPollTimer);
  slackPollTimer = setInterval(() => loadSlackThreads(currentChannel), 5000);
}

function initDateFilter() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("filterFrom").value = today;
  document.getElementById("filterTo").value = today;
}

function applyDateFilter() {
  if (currentChannel) loadSlackThreads(currentChannel);
}

function getDateFilterParams() {
  const from = document.getElementById("filterFrom")?.value;
  const to = document.getElementById("filterTo")?.value;
  if (!from || !to) return "";
  const oldest = Math.floor(new Date(from).getTime() / 1000);
  const latest = Math.floor(new Date(to).getTime() / 1000) + 86400;
  return `?oldest=${oldest}&latest=${latest}`;
}

async function loadSlackThreads(channel) {
  const el = document.getElementById("slackThreads");
  try {
    const data = await api(`/api/slack/threads/${channel}${getDateFilterParams()}`);
    if (!data.messages.length) {
      el.innerHTML = `<div class="empty-state"><p>No messages</p></div>`;
      return;
    }
    el.innerHTML = data.messages.map((m) => `
      <div class="list-item" onclick="loadSlackReplies('${channel}', '${m.ts}', this)">
        <div class="thread-sender">${esc(resolveUser(m.user))}</div>
        <div>${esc(truncate(parseSlackText(m.text), 60))}</div>
        <div class="item-sub">${formatTs(m.ts)}${m.replyCount ? ` / ${m.replyCount} replies` : ""}</div>
      </div>
    `).join("");
  } catch (e) {
    el.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function loadSlackReplies(channel, ts, el) {
  if (el) {
    document.querySelectorAll("#slackThreads .list-item").forEach((i) => i.classList.remove("active"));
    el.classList.add("active");
  }
  const detail = document.getElementById("slackMessages");
  detail.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const data = await api(`/api/slack/replies/${channel}/${ts}`);
    detail.innerHTML = data.messages.map((m) => `
      <div class="slack-msg">
        <div class="slack-msg-header">
          <span class="slack-msg-user">${esc(resolveUser(m.user))}</span>
          <span class="slack-msg-time">${formatTs(m.ts)}</span>
        </div>
        <div class="slack-msg-text">${esc(parseSlackText(m.text))}</div>
      </div>
    `).join("");
  } catch (e) {
    detail.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// ── Init ────────────────────────────────────────────────────────────
loadSlackUsers();
initDateFilter();
loadStatus();
