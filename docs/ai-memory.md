# AI memory

How an AI assistant working on 3DOO (Claude Code) knows its way round the
project without reading the whole codebase at the start of every task.

## In short

An assistant starts every session knowing nothing about the project, and the
code is large: `Viewport.ts` alone is 5,500 lines. Reading it all to change
one function is slow and costly, and what matters most (why something is the
way it is, which bugs keep coming back) is not in the code at all.

So that knowledge is written down once, in small files that load only when a
task needs them. They are arranged as a palace: a short map that is always
there, and rooms that open on their own when the assistant walks into their
part of the code.

| Layer | Where | Loaded | Holds |
| --- | --- | --- | --- |
| Rules | `.claude/rules/*.md` with no `paths` | Every session | How to work: code style, writing style, versioning, regression tests |
| Map | `.claude/rules/palace.md` | Every session | The rooms, where each kind of task starts, how to read the big files |
| Rooms | `.claude/rules/room-*.md` | When a file in the room's area is read | One area's invariants, traps, bug history and tests |
| Docs | `docs/*.md` | When a room points there and the task needs the depth | The full explanation, for people and assistants alike |
| Personal memory | `~/.claude/projects/<project>/memory/` | Its index every session | One person's machine and preferences. Not in the repo |

The map costs a few hundred words per session. Everything else is paid for
only when it is used.

## The rooms

| Room | Opens when reading | Holds |
| --- | --- | --- |
| `room-kernel.md` | `src/kernel` | BMesh invariants, adding an operator, the fold limit, the most fixed operations |
| `room-store.md` | `src/store` | The slices, `meshVersion`, undo, ids, the one mutation path |
| `room-bridge.md` | `src/bridge` | How dots and wire are kept from showing through surfaces |
| `room-viewport.md` | `src/viewport` | The gizmo's rules, the camera's planes, testing the viewport in jsdom |
| `room-ui.md` | `src/domain`, `src/shared`, `src/app`, `src/modules` | Text rules, the keymap, panels, component tests |
| `room-saving.md` | Autosave and project file code | What is kept where, `dirty`, the bugs that lost work |
| `room-scripting.md` | Scripting, automation, `mcp/` | Checked options, script transactions, adding an MCP tool |
| `room-gpu.md` | `gpu/` | The real-GPU check, how it judges, what it cannot see |

A room opens through the `paths` list at its top. When the assistant reads a
file matching one of them, Claude Code adds the room to what it knows:

```markdown
---
paths:
  - "src/kernel/**/*.ts"
---

# Room: kernel
```

## A task, step by step

Say the gizmo stutters during a drag.

1. The map's task table says gizmo work starts in `Viewport.ts`, by section,
   so the assistant opens with `Rooms: viewport`.
2. Its section markers (`// ---- gizmo`) give the line to start reading at,
   so the assistant reads a hundred lines round `updateGizmo`, not 5,500.
3. Reading that file opens `room-viewport.md`, which says the gizmo must never
   be re-seated mid-drag (the same stutter, fixed before), and how to test
   the viewport without a GPU.
4. The fix lands with a regression test that failed first. If something new
   was learned, it becomes one line in the room.

## Saying which rooms it is in

The assistant tells the person it works with which rooms a task enters, so
it is plain what the work touches and which memory it leans on:

- At the start of a task, the rooms it expects: `Rooms: viewport, store`.
  A task outside every room says `Rooms: none`.
- When a read opens a room it did not expect: `Entering room: bridge`.
- In its last reply, the rooms it actually entered.

The rule sits in the map, so it holds in every session. Like every rule it is
guidance: nothing checks that the line was written.

## What goes in a room

In:

- What the code does not say quickly: why it is built this way, and rules
  that hold across several files.
- Traps, and the bugs that came back, each with where its test lives.
- Where the tests for the area go and how to run them.

Out:

- Anything the code or a doc already says plainly. The room points at it.
- Line numbers, which go stale with the next edit. Rooms name the symbol.
- Anything about one person: that belongs in personal memory.

A room stays short, around fifty lines. A room that grows past that is
holding things the docs should hold.

## Keeping it true

A memory that is wrong is worse than none, because the assistant trusts it.

- A lesson is written down in the same change that taught it, as one line in
  the room it belongs to.
- A line that turns out wrong is deleted, not left beside a correction.
- `src/tests/palace.test.ts` runs with `npm test` and fails when a room or the
  map names a file, a folder or an identifier the code no longer has. It
  checks everything in backticks that looks like a path or like a
  camelCase, PascalCase or CONSTANT name. It cannot tell that a sentence is
  wrong, only that what it points at is gone.

## Adding a room

1. Create `.claude/rules/room-<area>.md` with a `paths` list for its area.
2. Add its row to the room table in `.claude/rules/palace.md`.
3. Run `npm test`, which checks every name it quotes.

## The rest of the setup

| Part | Where | Does |
| --- | --- | --- |
| Dash check | `.claude/hooks/no-dashes.sh` | Flags an em or en dash in any file the assistant writes |
| Activity log | `.claude/hooks/post-edit-log.sh` | Appends every edit to `.claude/activity.log`, which git ignores |
| Code reviewer | `.claude/agents/code-reviewer.md` | Reviews a change; a fix without a regression test is a blocking finding |
| Researcher | `.claude/agents/researcher.md` | Answers a technical question from the web, with sources |
| Changelog | `.claude/commands/changelog.md` | `/changelog` records a change under `Unreleased` |
| Commit | `.claude/skills/commit` | `/commit` stages and commits, only when asked |
| Summary | `.claude/skills/summarize-changes` | Summarises uncommitted changes and flags risk |
| Terse | `.claude/output-styles/terse.md` | An optional answer style: code first, little prose |

The hooks run because `.claude/settings.json` names them.

## Limits

- A room opens when a file in its area is read, not when a task merely
  concerns that area. The map's task table is what sends the assistant there.
- Rules and rooms are guidance the assistant follows. The hooks and the tests
  are the only parts that check anything.
- Personal memory lives on one machine and is not shared through the repo.
  Anything the whole project should know goes in a room instead.
