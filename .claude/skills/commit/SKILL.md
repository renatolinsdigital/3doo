---
description: Stage and commit the current changes with a well-scoped message
disable-model-invocation: true
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *) Bash(git diff *)
---

# Commit

1. Run `git status` and `git diff` to see what changed.
2. Group related changes into one or more commits, don't bundle unrelated work.
3. Write commit messages that explain *why*, not *what* (the diff already shows what).
4. Stage only the files relevant to this commit, then commit.

Never commit files that look like secrets (`.env`, `*.pem`, `*_credentials.json`), warn instead of staging them.
