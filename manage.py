#!/usr/bin/env python3
"""Harness Bot — session manager

Usage:
    python3 manage.py status
    python3 manage.py start [bot|all]
    python3 manage.py stop [bot|all]
    python3 manage.py restart [bot|all]
    python3 manage.py watch [--interval 30]
"""
import argparse
import subprocess
import sys
import time
import os
from datetime import datetime

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))

# Add or remove bots here. Each bot needs a directory under bots/ with a start.sh.
BOTS = {
    "engineer":   {"session": "harness-engineer",   "dir": "bots/engineer"},
    "marketer":   {"session": "harness-marketer",   "dir": "bots/marketer"},
    "researcher": {"session": "harness-researcher", "dir": "bots/researcher"},
}

BOT_NAMES = list(BOTS.keys())


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def is_alive(session: str) -> bool:
    result = subprocess.run(
        ["tmux", "has-session", "-t", session],
        capture_output=True,
    )
    return result.returncode == 0


def is_claude_alive(session: str) -> bool:
    """Check if Claude process is still running inside the session."""
    result = subprocess.run(
        ["tmux", "capture-pane", "-t", session, "-p", "-S", "-10"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False

    lines = [l for l in result.stdout.splitlines() if l.strip()]
    if not lines:
        return True  # panel empty = still starting up

    last = lines[-1].strip()

    # shell prompt patterns → Claude has exited
    shell_patterns = ("➜", "❯", "$ ", "% ", "# ", "zsh", "bash")
    if any(last.startswith(p) or last.endswith(p) for p in shell_patterns):
        return False

    return True


def start_bot(name: str) -> bool:
    bot = BOTS[name]
    if is_alive(bot["session"]):
        for _ in range(5):
            time.sleep(1)
            if not is_alive(bot["session"]):
                break
        else:
            print(f"  [{now()}] {name}: already running")
            return False

    script = os.path.join(HARNESS_DIR, bot["dir"], "start.sh")
    result = subprocess.run(
        ["bash", script],
        capture_output=True,
        text=True,
        env={**os.environ},
    )
    if result.returncode != 0:
        print(f"  [{now()}] {name}: failed to start — {result.stderr.strip()}")
        return False

    print(f"  [{now()}] {name}: started")

    # auto-accept MCP server prompts (up to 2)
    session = bot["session"]
    for _ in range(2):
        time.sleep(3)
        subprocess.run(["tmux", "send-keys", "-t", session, "1", ""], capture_output=True)

    return True


def stop_bot(name: str) -> bool:
    bot = BOTS[name]
    if not is_alive(bot["session"]):
        print(f"  [{now()}] {name}: already stopped")
        return False

    # kill only this bot's slack-channel child process
    pane_result = subprocess.run(
        ["tmux", "list-panes", "-t", bot["session"], "-F", "#{pane_pid}"],
        capture_output=True, text=True,
    )
    if pane_result.returncode == 0:
        pane_pid = pane_result.stdout.strip()
        claude_pids = subprocess.run(
            ["pgrep", "-P", pane_pid], capture_output=True, text=True
        ).stdout.strip().split()
        for cpid in claude_pids:
            subprocess.run(["pkill", "-P", cpid, "-f", "slack-channel"], capture_output=True)

    subprocess.run(["tmux", "kill-session", "-t", bot["session"]], capture_output=True)

    print(f"  [{now()}] {name}: stopped")
    return True


def status_all():
    print(f"\n{'bot':<12} {'session':<24} {'status'}")
    print("─" * 52)
    for name, bot in BOTS.items():
        session_ok = is_alive(bot["session"])
        if not session_ok:
            indicator = "○ stopped"
        elif not is_claude_alive(bot["session"]):
            indicator = "⚠ session alive (Claude exited)"
        else:
            indicator = "● running"
        print(f"  {name:<10} {bot['session']:<24} {indicator}")
    print()


def resolve_targets(target: str) -> list[str]:
    if target == "all":
        return BOT_NAMES
    if target not in BOTS:
        print(f"unknown bot: {target}  (choices: {', '.join(BOT_NAMES)}, all)")
        sys.exit(1)
    return [target]


def cmd_status(_args):
    status_all()


def cmd_start(args):
    targets = resolve_targets(args.bot)
    print(f"\n[start] {', '.join(targets)}")
    for name in targets:
        start_bot(name)
    print()


def cmd_stop(args):
    targets = resolve_targets(args.bot)
    print(f"\n[stop] {', '.join(targets)}")
    for name in targets:
        stop_bot(name)
    print()


def cmd_restart(args):
    targets = resolve_targets(args.bot)
    print(f"\n[restart] {', '.join(targets)}")
    for name in targets:
        stop_bot(name)
    time.sleep(3)
    for name in targets:
        start_bot(name)
    print()


def cmd_watch(args):
    interval = args.interval
    print(f"\n[watchdog] monitoring all bots — interval: {interval}s  (Ctrl+C to stop)\n")
    try:
        while True:
            for name, bot in BOTS.items():
                if not is_alive(bot["session"]):
                    print(f"  [{now()}] {name} session gone → restarting...")
                    start_bot(name)
                elif not is_claude_alive(bot["session"]):
                    print(f"  [{now()}] {name} Claude exited → restarting session...")
                    stop_bot(name)
                    time.sleep(1)
                    start_bot(name)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nwatchdog stopped.")


def main():
    parser = argparse.ArgumentParser(description="Harness Bot session manager")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="show status of all bots")

    p_start = sub.add_parser("start", help="start a bot")
    p_start.add_argument("bot", nargs="?", default="all", help=f"bot name or all ({', '.join(BOT_NAMES)})")

    p_stop = sub.add_parser("stop", help="stop a bot")
    p_stop.add_argument("bot", nargs="?", default="all")

    p_restart = sub.add_parser("restart", help="restart a bot")
    p_restart.add_argument("bot", nargs="?", default="all")

    p_watch = sub.add_parser("watch", help="watchdog — auto-restart dead bots")
    p_watch.add_argument("--interval", type=int, default=30, metavar="sec", help="check interval (default: 30s)")

    args = parser.parse_args()

    dispatch = {
        "status": cmd_status,
        "start": cmd_start,
        "stop": cmd_stop,
        "restart": cmd_restart,
        "watch": cmd_watch,
    }

    if args.command in dispatch:
        dispatch[args.command](args)
    else:
        status_all()
        parser.print_help()


if __name__ == "__main__":
    main()
