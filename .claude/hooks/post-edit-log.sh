#!/bin/bash
# Appends the raw PostToolUse JSON payload (received on stdin) to activity.log.
# Referenced from .claude/settings.json: this file is not auto-discovered,
# Claude Code only runs it because settings.json points at this exact path.
cat >> "${CLAUDE_PROJECT_DIR}/.claude/activity.log"
echo "" >> "${CLAUDE_PROJECT_DIR}/.claude/activity.log"
