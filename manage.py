#!/usr/bin/env python3
"""harness-bot — session manager

Usage:
    python3 manage.py status
    python3 manage.py start   [bot|all]
    python3 manage.py stop    [bot|all]
    python3 manage.py restart [bot|all]
    python3 manage.py attach  <bot>
    python3 manage.py watch   [--interval 30]

Behavior notes:
- `start` also boots the dashboard and watchdog (if not already running).
- `stop all` also tears down the dashboard and watchdog.
- `stop <bot>` writes a `.tmp/<bot>.stopped` flag so the watchdog leaves it
  alone; `start <bot>` clears the flag.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(HARNESS_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Bot discovery excludes template directories.
EXCLUDED_DIRS = {"example-bot-cli"}

# Optional manual overrides (session name, directory). Most bots don't need this.
BOTS_OVERRIDE: "dict[str, dict]" = {}

DASHBOARD_SESSION = "harness-dashboard"
DASHBOARD_SCRIPT = os.path.join(HARNESS_DIR, "dashboard", "server.js")
WATCHDOG_SESSION = "harness-watchdog"
STOPPED_DIR = os.path.join(HARNESS_DIR, ".tmp")


# ── root .env loader (alert webhook etc.) ────────────────────────────

def _load_root_env() -> None:
    env_path = os.path.join(HARNESS_DIR, ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


_load_root_env()
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")


def notify_slack(message: str) -> None:
    if not ALERT_WEBHOOK_URL:
        return
    try:
        data = json.dumps({"text": message}).encode()
        req = urllib.request.Request(
            ALERT_WEBHOOK_URL,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"  [warn] Slack notification failed: {e}", file=sys.stderr)


# ── bot discovery ──────────────────────────────────────────────────

def discover_bots() -> dict:
    """Scan bots/ for directories that have a .env file."""
    discovered: dict = {}
    bots_dir = os.path.join(HARNESS_DIR, "bots")
    if not os.path.isdir(bots_dir):
        return discovered
    for name in sorted(os.listdir(bots_dir)):
        if name in EXCLUDED_DIRS:
            continue
        bot_path = os.path.join(bots_dir, name)
        if not os.path.isdir(bot_path):
            continue
        if not os.path.exists(os.path.join(bot_path, ".env")):
            continue
        discovered[name] = {
            "session": f"harness-{name}",
            "dir": f"bots/{name}",
        }
    return discovered


BOTS = {**discover_bots(), **BOTS_OVERRIDE}
BOT_NAMES = list(BOTS.keys())


# ── utilities ──────────────────────────────────────────────────────

def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log_to_file(message: str) -> None:
    log_file = os.path.join(LOG_DIR, f"watchdog-{datetime.now().strftime('%Y-%m-%d')}.log")
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(log_file, "a") as f:
        f.write(f"[{ts}] {message}\n")


def is_alive(session: str) -> bool:
    r = subprocess.run(["tmux", "has-session", "-t", session], capture_output=True)
    return r.returncode == 0


def is_claude_alive(session: str) -> bool:
    """Return False if the Claude process has exited (shell prompt visible)."""
    r = subprocess.run(
        ["tmux", "capture-pane", "-t", session, "-p", "-S", "-10"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    if not lines:
        return True  # empty pane — still starting up
    last = lines[-1].strip()
    shell_patterns = ("➜", "❯", "$ ", "% ", "# ", "zsh", "bash")
    if any(last.startswith(p) or last.endswith(p) for p in shell_patterns):
        return False
    return True


def _get_pane_pid(session: str) -> str:
    r = subprocess.run(
        ["tmux", "list-panes", "-t", session, "-F", "#{pane_pid}"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else ""


# ── stopped flag (so watchdog respects manual stops) ───────────────

def _set_stopped(name: str) -> None:
    os.makedirs(STOPPED_DIR, exist_ok=True)
    with open(os.path.join(STOPPED_DIR, f"{name}.stopped"), "w") as f:
        f.write("")


def _clear_stopped(name: str) -> None:
    path = os.path.join(STOPPED_DIR, f"{name}.stopped")
    if os.path.exists(path):
        os.remove(path)


def _is_stopped(name: str) -> bool:
    return os.path.exists(os.path.join(STOPPED_DIR, f"{name}.stopped"))


# ── start / stop ───────────────────────────────────────────────────

def start_bot(name: str) -> bool:
    bot = BOTS[name]
    if is_alive(bot["session"]):
        # Session exists — give it a second to really be gone before giving up.
        for _ in range(5):
            time.sleep(1)
            if not is_alive(bot["session"]):
                break
        else:
            print(f"  [{now()}] {name}: already running")
            return False

    _clear_stopped(name)

    # Per-bot start.sh wins if present; otherwise fall back to the shared script.
    bot_script = os.path.join(HARNESS_DIR, bot["dir"], "start.sh")
    common_script = os.path.join(HARNESS_DIR, "scripts", "start-cli.sh")
    if os.path.exists(bot_script):
        cmd = ["bash", bot_script]
    else:
        cmd = ["bash", common_script, os.path.join(HARNESS_DIR, bot["dir"])]

    r = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ})
    if r.returncode != 0:
        print(f"  [{now()}] {name}: failed to start — {r.stderr.strip()}")
        return False

    # Auto-accept the first couple of MCP permission prompts.
    session = bot["session"]
    for _ in range(2):
        time.sleep(3)
        subprocess.run(["tmux", "send-keys", "-t", session, "1", ""], capture_output=True)

    print(f"  [{now()}] {name}: started")
    return True


def stop_bot(name: str) -> bool:
    bot = BOTS[name]
    if not is_alive(bot["session"]):
        print(f"  [{now()}] {name}: already stopped")
        return False

    pane_pid = _get_pane_pid(bot["session"])
    if pane_pid:
        child_pids = subprocess.run(
            ["pgrep", "-P", pane_pid], capture_output=True, text=True,
        ).stdout.strip().split()
        for cpid in child_pids:
            subprocess.run(
                ["pkill", "-P", cpid, "-f", "slack-channel"], capture_output=True,
            )

    subprocess.run(["tmux", "kill-session", "-t", bot["session"]], capture_output=True)
    _set_stopped(name)
    print(f"  [{now()}] {name}: stopped")
    return True


# ── dashboard ──────────────────────────────────────────────────────

def start_dashboard() -> None:
    if is_alive(DASHBOARD_SESSION):
        return
    if not os.path.exists(DASHBOARD_SCRIPT):
        return
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", DASHBOARD_SESSION, "-c", HARNESS_DIR, "bash"],
        capture_output=True,
    )
    subprocess.run(
        ["tmux", "send-keys", "-t", DASHBOARD_SESSION, f"node {DASHBOARD_SCRIPT}", "Enter"],
        capture_output=True,
    )
    print(f"  [{now()}] dashboard: started (http://localhost:3001)")


def stop_dashboard() -> None:
    if not is_alive(DASHBOARD_SESSION):
        return
    subprocess.run(["tmux", "kill-session", "-t", DASHBOARD_SESSION], capture_output=True)
    print(f"  [{now()}] dashboard: stopped")


# ── watchdog ───────────────────────────────────────────────────────

def start_watchdog(interval: int = 30) -> None:
    if is_alive(WATCHDOG_SESSION):
        return
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", WATCHDOG_SESSION, "-c", HARNESS_DIR, "bash"],
        capture_output=True,
    )
    subprocess.run(
        ["tmux", "send-keys", "-t", WATCHDOG_SESSION,
         f"python3 manage.py watch --interval {interval}", "Enter"],
        capture_output=True,
    )
    print(f"  [{now()}] watchdog: started (interval: {interval}s)")


def stop_watchdog() -> None:
    if not is_alive(WATCHDOG_SESSION):
        return
    subprocess.run(["tmux", "kill-session", "-t", WATCHDOG_SESSION], capture_output=True)
    print(f"  [{now()}] watchdog: stopped")


def pause_watchdog() -> bool:
    if is_alive(WATCHDOG_SESSION):
        subprocess.run(["tmux", "kill-session", "-t", WATCHDOG_SESSION], capture_output=True)
        return True
    return False


# ── status / commands ──────────────────────────────────────────────

def status_all() -> None:
    print(f"\n{'bot':<14} {'session':<24} {'status'}")
    print("─" * 60)
    for name, bot in BOTS.items():
        if not is_alive(bot["session"]):
            indicator = "○ stopped"
        elif not is_claude_alive(bot["session"]):
            indicator = "⚠ session alive (Claude exited)"
        else:
            indicator = "● running"
        print(f"  {name:<12} {bot['session']:<24} {indicator}")
    dash_status = "● running (http://localhost:3001)" if is_alive(DASHBOARD_SESSION) else "○ stopped"
    watch_status = "● running" if is_alive(WATCHDOG_SESSION) else "○ stopped"
    print(f"  {'dashboard':<12} {DASHBOARD_SESSION:<24} {dash_status}")
    print(f"  {'watchdog':<12} {WATCHDOG_SESSION:<24} {watch_status}")
    print()


def resolve_targets(target: str) -> "list[str]":
    if target == "all":
        return BOT_NAMES
    if target not in BOTS:
        print(f"unknown bot: {target}  (choices: {', '.join(BOT_NAMES)}, all)")
        sys.exit(1)
    return [target]


def wait_stopped(session: str, timeout: int = 10) -> bool:
    for _ in range(timeout):
        if not is_alive(session):
            return True
        time.sleep(1)
    return False


def cmd_status(_args):
    status_all()


def cmd_start(args):
    targets = resolve_targets(args.bot)
    print(f"\n[start] {', '.join(targets)}")
    for name in targets:
        start_bot(name)
    start_dashboard()
    start_watchdog()
    print()


def cmd_stop(args):
    targets = resolve_targets(args.bot)
    print(f"\n[stop] {', '.join(targets)}")
    for name in targets:
        stop_bot(name)
    if args.bot == "all":
        stop_watchdog()
        stop_dashboard()
    print()


def cmd_restart(args):
    targets = resolve_targets(args.bot)
    print(f"\n[restart] {', '.join(targets)}")

    watchdog_was_running = False
    if args.bot == "all":
        watchdog_was_running = pause_watchdog()
        if watchdog_was_running:
            print(f"  [{now()}] watchdog paused")

    for name in targets:
        stop_bot(name)
        if not wait_stopped(BOTS[name]["session"]):
            print(f"  [{now()}] {name}: stop timed out — proceeding anyway")
    for name in targets:
        _clear_stopped(name)
        start_bot(name)

    if watchdog_was_running:
        start_watchdog()
        print(f"  [{now()}] watchdog restarted")
    print()


def cmd_attach(args):
    name = args.bot
    if name not in BOTS:
        print(f"unknown bot: {name}  (choices: {', '.join(BOT_NAMES)})")
        sys.exit(1)
    session = BOTS[name]["session"]
    if not is_alive(session):
        print(f"{name} is not running.")
        sys.exit(1)
    os.execvp("tmux", ["tmux", "attach", "-t", session])


def cmd_watch(args):
    interval = args.interval
    print(f"\n[watchdog] monitoring bots — interval: {interval}s  (Ctrl+C to stop)\n")
    try:
        while True:
            for name, bot in BOTS.items():
                if _is_stopped(name):
                    continue
                session = bot["session"]
                if not is_alive(session):
                    msg = f"{name} session gone → restarting..."
                    print(f"  [{now()}] {msg}")
                    log_to_file(msg)
                    notify_slack(f"[watchdog] {msg}")
                    start_bot(name)
                    log_to_file(f"{name} restarted")
                elif not is_claude_alive(session):
                    msg = f"{name} Claude exited → restarting session..."
                    print(f"  [{now()}] {msg}")
                    log_to_file(msg)
                    notify_slack(f"[watchdog] {msg}")
                    stop_bot(name)
                    _clear_stopped(name)
                    time.sleep(1)
                    start_bot(name)
                    log_to_file(f"{name} restarted")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nwatchdog stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="harness-bot session manager")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="show status of all bots")

    p_start = sub.add_parser("start", help="start a bot")
    p_start.add_argument("bot", nargs="?", default="all",
                         help=f"bot name or all ({', '.join(BOT_NAMES) or '—'})")

    p_stop = sub.add_parser("stop", help="stop a bot")
    p_stop.add_argument("bot", nargs="?", default="all")

    p_restart = sub.add_parser("restart", help="restart a bot")
    p_restart.add_argument("bot", nargs="?", default="all")

    p_attach = sub.add_parser("attach", help="attach to a bot's tmux session")
    p_attach.add_argument("bot", help="bot name")

    p_watch = sub.add_parser("watch", help="watchdog — auto-restart dead bots")
    p_watch.add_argument("--interval", type=int, default=30, metavar="sec",
                         help="check interval (default: 30s)")

    args = parser.parse_args()
    dispatch = {
        "status": cmd_status,
        "start": cmd_start,
        "stop": cmd_stop,
        "restart": cmd_restart,
        "attach": cmd_attach,
        "watch": cmd_watch,
    }

    if args.command in dispatch:
        dispatch[args.command](args)
    else:
        status_all()
        parser.print_help()


if __name__ == "__main__":
    main()
