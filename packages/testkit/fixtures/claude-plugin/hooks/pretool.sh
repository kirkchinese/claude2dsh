#!/usr/bin/env bash
# Records every Bash call it sees in ./e2e-plugin-hook.log and denies commands that mention E2E-DENY.
input=$(cat)
printf '%s\n' "$input" >> "${CLAUDE_PROJECT_DIR:-$PWD}/e2e-plugin-hook.log"
case "$input" in
  *E2E-DENY*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by the e2e hook"}}'
    ;;
esac
