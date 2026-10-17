# Regression Tests

Loaded on every session (no `paths` frontmatter = unconditional, same
priority as CLAUDE.md).

Every bug fix ships with a regression test in the same change. A fix
without one is not finished, however small the fix and however sure it
looks.

## What counts as a bug fix

Any change that makes existing behaviour do what it should have done all
along, whatever the commit ends up calling it (`fixes`, `reviews`,
`improves`): a bug the user reports, one found while working on something
else, a crash, a wrong count, a visual leak. Typos in text and purely
visual tweaks (a colour, a margin) are not bugs for this rule.

## How to write it

- **Red first.** Write the test before the fix, run it, and watch it fail
  for the reason the bug describes. Then fix and watch it pass. A test
  that was never red proves nothing about the fix.
- **Test the lowest layer that shows the bug.** A topology bug gets a
  kernel test (`npm run test:kernel` is the fastest feedback). A viewport
  bug gets a test of the function the `Viewport` class is built from:
  picking, drag arithmetic, the camera. A panel bug gets a Testing Library
  test. Reach for the app shell suite only when the bug lives in the
  wiring between them.
- **Use the suite that already covers the module**, colocated as
  `<module>.test.ts(x)`. Create a new file only when none exists.
- **Name the behaviour, not the bug**:
  `it('leaves only the new loop selected after a cut')`, not
  `it('fixes the loop cut bug')`.
- **Say what used to happen.** Put a comment above the assertion that
  describes the old behaviour and why it hurt, the way the existing suites
  do:

  ```ts
  // The edge the cut ran across used to stay selected alongside the loop, so
  // the next scale dragged two box corners in with it and speared the faces
  // between them.
  ```

  This is the WHY the code-style rule allows comments for: without it, the
  next person to touch the test cannot tell a regression guard from an
  arbitrary expectation.
- **A test that asserted the bug gets corrected, not joined.** If an
  existing expectation encoded the wrong behaviour, change it and say in
  the comment that it was reading the wrong number, rather than adding a
  second test that contradicts it.
- **Run `npm test` before calling it done**, not only the new test. A fix
  in the kernel can break a viewport or store suite.

## Bugs that need a GPU

Two places can reach what used to need a person looking at the screen:

- **Wiring inside the viewport** (a subscription, a resync, the gizmo, the
  camera): `src/viewport/Viewport.test.ts` builds the real `Viewport` in
  jsdom on a stand-in renderer. Add the test there.
- **What ends up on screen**: a dot or a wire drawn through a surface, or
  one left off. Add a scene or a pose to `gpu/leaks.test.ts` and run
  `npm run test:gpu`, which looks at real frames on the machine's GPU. It
  is not part of `npm test`, so say in the reply that it was run and what
  it said.

Red first holds here too: put the bug back and watch the GPU check fail
before trusting a scene to guard it. Its limits are listed in
`docs/testing.md`; a leak within them still needs saying out loud.

If neither reaches the bug, tell the user which bug has no regression
test, why no test can catch it, and how the fix was checked instead.
Never skip the test silently.
