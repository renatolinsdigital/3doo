# Writing Style

Loaded on every session (no `paths` frontmatter = unconditional, same
priority as CLAUDE.md).

Covers everything a person reads: UI labels, hints, status messages and
dialog text, the docs module, README and `docs/`, code comments and JSDoc,
test names, commit messages, and replies in chat.

## No dashes as punctuation

- Never write an em dash (`—`) or an en dash (`–`). Nothing else marks text
  as machine-written so reliably, and a page of them reads breathless.
- Never write a spaced hyphen (` - `) as a stand-in for one.
- Write the punctuation the sentence actually wants:
  - a colon before an explanation or a list,
  - a comma for a short aside,
  - brackets for a true parenthesis,
  - a full stop, and a second sentence, when the aside is a thought of
    its own.
- A sentence reaching for a third dash wanted to be two sentences. Split it.
- Ranges take a word: `1 to 16`, not `1-16`.

Hyphens inside words stay. `depth-tested`, `x-ray`, `one-click`, `Catmull-Clark`
and `n-gon` are ordinary English, not punctuation, and stripping them makes
the text worse rather than better.

## Examples

| Instead of                                   | Write                                        |
| -------------------------------------------- | -------------------------------------------- |
| `Select an edge — the loop runs across it`   | `Select an edge for the loop to run across`  |
| `Two cuts — one each side — leave three`     | `Two cuts, one each side, leave three`       |
| `It refuses: too big — the tab would die`    | `It refuses when the result is too big.`     |

## Never mention Blender in the app

3DOO is inspired by Blender, but the app never says so. Nothing the user
reads inside the app names Blender: UI labels, hints, tooltips, status
messages, dialog text, the home page and the in-app docs module
(`src/modules/docs/content.ts`) included. Say what the feature does, not
which program it copies. Write `A fresh tab opens on a cube`, not
`A fresh tab opens on a cube, the way Blender does`.

- The lineage belongs in the documentation: `README.md` and `docs/`. Mention
  Blender there where it explains why something works the way it does.
- The one exception inside the app is Blender as an export target: the
  `BLENDER (Y-UP, M)` axis preset and lists of programs that import OBJ or
  FBX. That names a destination for the user's file, not an inspiration.
- Code comments, identifiers and test names are not app text and may name
  Blender when it explains a decision.

The `no-dashes` hook checks every file written or edited and says so when one
gets through. Fix it in the same turn rather than leaving it for later.
