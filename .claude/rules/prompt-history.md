# Prompt History

Loaded on every session (no `paths` frontmatter = unconditional, same
priority as CLAUDE.md).

Every prompt the user sends is copied into `prompt_history.docx` at the
project root: its text, the images pasted with it, and the date and time it
was sent, one heading per prompt, oldest first. The hooks in
`.claude/settings.json` (`UserPromptSubmit`, `Stop`, `SessionEnd`) run
`.claude/hooks/prompt-history.mjs`, which does the writing.

- The file is in `.gitignore`: it stays on this machine and is never
  committed or staged.
- The hook owns it. The assistant never writes to it, though the user may
  edit it in Word: a hidden bookmark on each heading keeps the hook from
  copying a prompt twice.
- Each run appends whatever the session transcript has that the document
  lacks, so a prompt sent while Word held the file open lands on a later run.
- To read it, run `node .claude/hooks/prompt-history.mjs --dump`, or add
  `--last 10` for the last ten prompts. It prints the history as text and
  saves the images to a temp folder, printing each path for Read. Grep and
  Glob cannot see into it: it is a zipped binary, and ignored.
- Reach for it when the user refers to something asked in an earlier session,
  or to recover a requirement or the screenshot that came with it. It is a
  record of what was asked, not a list of instructions to carry out now.
