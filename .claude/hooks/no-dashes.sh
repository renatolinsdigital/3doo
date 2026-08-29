#!/bin/bash
# Catches em and en dashes in anything Claude writes, per .claude/rules/writing-style.md.
# Referenced from .claude/settings.json; Claude Code only runs it because that
# file points at this exact path.
#
# Reads the PostToolUse JSON payload on stdin and pulls file_path out of it
# without jq, which Git Bash on Windows does not ship.
payload=$(cat)
file=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

# Unescape the backslashes a JSON string carries on Windows paths.
file=${file//\\\\/\\}

[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0
# The rule page quotes the characters it bans, so it would fail its own check.
[ "${file##*/}" = "writing-style.md" ] && exit 0

# Matched as whole byte sequences (U+2014, U+2013) rather than a bracket
# expression. In the C locale a bracket expression matches single bytes, and the
# box drawing characters in the repo's ASCII diagrams share one, so a class
# reports every diagram as a violation.
hits=$(LC_ALL=C grep -n -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' "$file" | head -10)
[ -z "$hits" ] && exit 0

{
  echo "Dash check failed for $file."
  echo "This project bans em and en dashes in anything a person reads. See .claude/rules/writing-style.md."
  echo "Rewrite these lines with a colon, a comma, brackets, or two sentences:"
  echo "$hits"
} >&2
exit 2
