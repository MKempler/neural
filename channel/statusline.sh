#!/bin/sh
# The status line of a Neural session. Claude Code pipes the session's state to this as JSON whenever it changes;
# it goes to the hub for the usage and context meter, and the hub answers with a short line for the terminal.
# When the user has a status line of their own, that runs on the same JSON and is shown instead.
#   $1  the hub's address for this session's readings
#   $2  a file holding the user's own status line command (optional)
input=$(cat)
line=$(printf '%s' "$input" | curl -s -m 1 -H 'content-type: application/json' --data-binary @- "$1" 2>/dev/null)
if [ -n "$2" ] && [ -s "$2" ]; then
  printf '%s' "$input" | sh "$2"
else
  printf '%s\n' "$line"
fi
