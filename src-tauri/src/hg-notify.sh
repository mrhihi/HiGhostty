#!/bin/sh
# HiGhostty agent hook helper: hg-notify <agent> <waiting|done|resume> [json]
# Reads the hook payload from the last argument or stdin and forwards it to the
# HiGhostty socket. Outside HiGhostty this does nothing.
[ -n "$HIGHOSTTY_SURFACE_ID" ] && [ -S "$HIGHOSTTY_SOCKET" ] || exit 0
agent=$1; event=$2; shift 2 2>/dev/null
if [ $# -gt 0 ]; then
  for last in "$@"; do payload=$last; done
elif [ ! -t 0 ]; then
  payload=$(cat)
fi
case "$payload" in "{"*) ;; *) payload=null ;; esac
printf '{"surface":"%s","agent":"%s","event":"%s","payload":%s}\n' \
  "$HIGHOSTTY_SURFACE_ID" "$agent" "$event" "$payload" | nc -U -w 1 "$HIGHOSTTY_SOCKET" >/dev/null 2>&1
exit 0
