# Releasing 3DOO

How a version of 3DOO is cut and published: the version number, the
changelog, the git tag and the GitHub release with its files. It is written for
whoever cuts the release, a person or an AI assistant, and the steps are the
ones 1.0.0 went out with.

## What a release is

A release names one commit on `master` as a version and publishes it:

| Part | Where | For 1.0.0 |
| --- | --- | --- |
| Version number | `version` in `package.json` and both root `version` fields of `package-lock.json`. The home page shows it | `1.0.0` |
| Changelog section | `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`, with its link at the foot of the file | `## [1.0.0] - 2026-11-13` |
| Git tag | An annotated tag named after the version, with no `v` in front, on the release commit | `1.0.0` |
| GitHub release | The notes, the production build as a zip and its checksum, on that tag | [3DOO 1.0.0](https://github.com/renatolinsdigital/3doo/releases/tag/1.0.0) |

Two things ship on tracks of their own, and a release only records where they
stand:

- **The hosted editor.** [3doo.vercel.app](https://3doo.vercel.app) is
  deployed from `master` on Vercel, released or not. Cutting a release deploys
  nothing: it names what the site serves, and step 7 checks that the two match.
- **The `3doo-mcp` npm package.** It has a version of its own (1.0.6 at 3DOO
  1.0.0) and is published by the steps in [mcp-package.md](mcp-package.md).
  The release notes say which package version goes with the release, and the
  `AUTOMATION_VERSION` both of them speak.

## Choosing the number

`MAJOR.MINOR.PATCH`, by what changed since the last release:

| Bump | When |
| --- | --- |
| MAJOR | Saved scenes, workflows or shortcuts people rely on stop working |
| MINOR | A feature is added and existing behaviour keeps working |
| PATCH | A bug is fixed or something small is corrected |

Read `## [Unreleased]` in `CHANGELOG.md` to decide. The version never changes
without the owner's yes (`.claude/rules/versioning.md`): propose the bump with
a one-line reason and wait for it.

## Before you start

- `gh auth status` shows an account with the `repo` scope that can push to
  `renatolinsdigital/3doo`.
- You are on `master`, the tree is clean and level with GitHub: after
  `git fetch origin`, `git status -sb` prints `## master...origin/master` and
  nothing else.
- Node 22.18 or newer, and Chrome for the GPU check.

## Steps

The commands are for Git Bash on Windows, and run in any Unix shell except
where a line says otherwise. `v` holds the version throughout:

```bash
v=1.0.0
```

### 1. Check the code

Every one of these passes on the commit being released:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:gpu    # real frames on this machine's GPU, needs Chrome
```

`npm run build` warns that a chunk is over 500 kB. That warning is known and
does not hold a release back. Anything else does: fix it first, in a commit of
its own.

### 2. Cut the changelog and the version

- Set the version without letting npm commit or tag:

  ```bash
  npm version "$v" --no-git-tag-version
  ```

  It updates `package.json` and both root fields of `package-lock.json`.
- In `CHANGELOG.md`, move the entries under `## [Unreleased]` into a new
  `## [x.y.z] - YYYY-MM-DD` section just below it, dated the day of the
  release, and leave `## [Unreleased]` empty.
- At the foot of `CHANGELOG.md`, point `[Unreleased]` at a compare from the new
  tag and add a line for the new version, newest first:

  ```markdown
  [Unreleased]: https://github.com/renatolinsdigital/3doo/compare/1.1.0...HEAD
  [1.1.0]: https://github.com/renatolinsdigital/3doo/releases/tag/1.1.0
  [1.0.0]: https://github.com/renatolinsdigital/3doo/releases/tag/1.0.0
  ```

- Add the version to the table under [Releases](#releases) at the end of this
  page.

### 3. Commit, tag and push

```bash
git add -A
git commit -m "releases $v"
git tag -a "$v" -m "3DOO $v"
git push origin master
git push origin "$v"
```

The tag is annotated, so it carries its own date, author and message. The
commit goes up before the tag, so GitHub never holds a tag on a commit it does
not have. A pushed tag is never moved: see [Fixing a release](#fixing-a-release).

### 4. Build the files to attach

Build on the tagged commit, then zip `dist/` inside a folder named after the
version, so it unpacks as `3doo-x.y.z/` rather than spilling into the current
folder:

```bash
git status --short     # prints nothing: what gets built is the tag
npm run build
out="$(mktemp -d)"
cp -R dist "$out/3doo-$v"
(
  cd "$out"
  /c/Windows/System32/tar.exe -a -cf "3doo-$v-web.zip" "3doo-$v"   # Windows
  # zip -qr "3doo-$v-web.zip" "3doo-$v"                            # macOS, Linux
  sha256sum "3doo-$v-web.zip" > SHA256SUMS.txt                     # macOS: shasum -a 256
)
```

On Windows the zip comes from the system's own `tar.exe`: the `tar` that ships
with Git Bash cannot write zips.

The zip holds the static site. It runs from the root of any web server that
answers unknown paths with `index.html`, the way `vercel.json` does, so links
to `/modeling` and `/docs` open. It does not run from a subfolder or straight
off the disk, because the build asks for its files at `/assets/`.

### 5. Write the notes

The notes go in a Markdown file outside the repository, handed to `gh`. They
are written for people who use the editor first and people who build it
second, in the house style (`.claude/rules/writing-style.md`, so no dashes as
punctuation), and hold, in order:

1. A short paragraph on what the release is. The title, `3DOO x.y.z`, comes
   from `gh` in step 6, so the notes need no heading of their own.
2. **What's new**: the changelog section turned into prose people can skim,
   grouped as Added, Changed, Fixed and Removed. A first release lists its
   highlights instead.
3. **Get it**: the hosted editor, `npx -y 3doo-mcp`, running from source, and
   self-hosting the zip.
4. **Compatibility**: whether `.3doo` files, shortcuts and scripts from the
   last release still work, the `3doo-mcp` version and `AUTOMATION_VERSION`
   that go with it, and the browsers and Node version it needs.
5. **Checked**: what passed in step 1, with the counts.
6. **Files**: what each attached file is, and how to check the checksum.
7. Links to the changelog at the tag and to the compare from the last release.

The [1.0.0 notes](https://github.com/renatolinsdigital/3doo/releases/tag/1.0.0)
are the model to copy. An image in the notes needs an absolute link pinned to
the tag, such as
`https://github.com/renatolinsdigital/3doo/raw/1.0.0/docs/images/print.png`:
a relative path does not resolve on the release page.

### 6. Publish

Create the release as a draft, read it on GitHub, then publish it:

```bash
gh release create "$v" "$out/3doo-$v-web.zip" "$out/SHA256SUMS.txt" \
  --verify-tag --draft --title "3DOO $v" --notes-file notes.md
gh release view "$v" --web                       # read it as a visitor will
gh release edit "$v" --draft=false --latest
```

`--verify-tag` stops `gh` when the tag is not on GitHub yet, instead of
quietly making a lightweight tag of its own on whatever `master` points at.

### 7. Verify

- `gh release view "$v"` lists both files and says nothing about a draft.
- The download matches its checksum:

  ```bash
  (cd "$(mktemp -d)" && gh release download "$v" -R renatolinsdigital/3doo && sha256sum -c SHA256SUMS.txt)
  ```

- The hosted editor serves the release. The entry script's name carries a hash
  of the bundle, so the two builds are the same when the names are:

  ```bash
  grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html
  curl -s https://3doo.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
  ```

  The version bump changes the bundle (the home page shows the version), so
  the names match only once Vercel has deployed the release commit. If they
  still differ after the deploy, `master` moved on past the tag: say in the
  notes which build the site serves.

## Fixing a release

| Problem | Fix |
| --- | --- |
| The notes are wrong or incomplete | `gh release edit x.y.z --notes-file notes.md` |
| A file is wrong or missing | `gh release upload x.y.z <file> --clobber` |
| The wrong commit was tagged, minutes ago, before anyone pulled | `gh release delete x.y.z --cleanup-tag --yes` and `git tag -d x.y.z`, then steps 3 to 7 again |
| Anything wrong in a release people have had for a while | Leave it, and cut the next patch with the fix |

A published tag is never moved with `git tag -f` and a force push. Anyone who
fetched it keeps the old commit under the same name, and two people on the
same version would then run different code.

## Releases

| Version | Date | `3doo-mcp` | `AUTOMATION_VERSION` | Summary |
| --- | --- | --- | --- | --- |
| [1.0.0](https://github.com/renatolinsdigital/3doo/releases/tag/1.0.0) | 2026-11-13 | 1.0.6 | 5 | First public release |

### How 1.0.0 came to be

Nothing before 1.0.0 was tagged. The version was first set to 1.0.0 on
2026-10-02, bumped to 1.0.1 within the hour, and reset to 1.0.0 on
2026-10-05, when `CHANGELOG.md` dated 1.0.0 to that day. Work carried on for
107 commits after the reset with the version held at 1.0.0, and the entries
that gathered under `Unreleased` were cleared rather than cut into new
versions. The 2026-10-05 state was never tagged.

On 2026-11-13 the first tag was cut on the state the hosted editor served that
day, which a build of the tagged commit matched hash for hash. So 1.0.0 names
what people actually had in their browsers, and its changelog date moved to the
day of the tag. From 1.0.0 on, every version is cut by the steps above, and
`Unreleased` is cut into a version rather than cleared.
