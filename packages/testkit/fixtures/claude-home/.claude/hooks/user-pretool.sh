#!/usr/bin/env bash
# Records every Bash call it sees in ./e2e-user-hook.log.
cat >> "${CLAUDE_PROJECT_DIR:-$PWD}/e2e-user-hook.log"
