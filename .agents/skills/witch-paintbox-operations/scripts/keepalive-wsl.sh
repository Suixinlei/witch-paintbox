#!/usr/bin/env bash
# Keeps the WSL instance alive, and with it the systemd user manager and witch-paintbox.service.
#
# WSL shuts an instance down once no wsl.exe session is attached, which takes every user service with
# it. The Windows scheduled task "Witch Paintbox Local Service" therefore starts this script at sign-in
# through `wsl.exe --exec`; update-server.mjs copies it to ~/.local/share/witch-paintbox/keepalive.sh.
#
# The loop owns its lifecycle. Stopping the scheduled task only ends the console host that Task
# Scheduler started and leaves this session running, so the loop is stopped through its pidfile
# instead (update-server.mjs does that when it restores the Windows-hosted service).
set -u

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
PIDFILE="$XDG_RUNTIME_DIR/witch-paintbox-keepalive.pid"

# A repeated task start must not add a second session: exit when one already holds the instance up.
previous=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -n "$previous" ] && kill -0 "$previous" 2>/dev/null; then exit 0; fi

echo $$ > "$PIDFILE"
sleeper=''
stop() { [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null; rm -f "$PIDFILE"; exit 0; }
trap stop TERM INT HUP
trap 'rm -f "$PIDFILE"' EXIT

while true; do
    sleep 3600 &
    sleeper=$!
    wait "$sleeper"
    sleeper=''
done
