# The MCP package: publishing `3doo-mcp`

The MCP server ([mcp.md](mcp.md)) is published to npm as `3doo-mcp`, so a user
adds it with `npx -y 3doo-mcp` and never clones the repository. This page is
for the person who publishes it: what is in the package, how to release a new
version, and how to keep it in step with the app.

## What is in it

```text
mcp-package/
  package.json     the published manifest: name, version, bin, dependencies
  README.md        what npm shows on the package page
  dist/server.mjs  the bundle (built, gitignored, the only code that ships)
```

- `npm run build:mcp` (from the repository root) bundles `mcp/server.ts` and its
  one import from `src/app/automation/types.ts` into `dist/server.mjs` with
  esbuild. `playwright-core` is left out of the bundle and listed as a
  dependency, so npm installs it beside the package.
- `files` in `package.json` limits the tarball to `dist/server.mjs` and the
  README. Check what would ship with `npm pack --dry-run` inside `mcp-package/`.
- The bundle has no `dist/index.html` beside it, so it never serves a local
  build. It draws in `THREEDOO_ENGINE_URL` or `THREEDOO_APP_URL`, which is the
  hosted editor in every command the MCP dialog gives.
- The package version is its own. It is not the app's version in the root
  `package.json`, and the two do not have to match.

## One-time setup

1. Create an account at npmjs.com and turn on two-factor authentication. npm
   requires it to publish.
2. Run `npm login` and sign in through the browser.
3. Confirm the name is yours to take: `npm view 3doo-mcp` answers `404` while it
   is free. After the first publish it shows the package.

To rename it, change `name` in `mcp-package/package.json` and `NPM_PACKAGE` in
`src/domain/mcp/guide.ts`, which every command in the MCP dialog and the AI
ASSISTANTS docs is built from.

## Releasing a version

Do these in order. The package ships from your machine, so what you publish is
what is in your working tree.

1. **Check the code.** From the repository root, `npm run typecheck`,
   `npm run lint` and `npm test` must pass.
2. **Decide the bump** by what changed in `mcp/` and in the automation API it
   drives:

   | Change | Bump |
   | --- | --- |
   | A tool or an argument removed or renamed, or a payload that changes shape | major |
   | A new tool, argument or setting that keeps old calls working | minor |
   | A fix, or a wording change in a tool description | patch |

3. **Set the version** inside `mcp-package/`:

   ```bash
   cd mcp-package
   npm version patch --no-git-tag-version   # or minor, or major
   ```

   `--no-git-tag-version` keeps npm from making a git tag and commit on its
   own. Commit the changed `package.json` yourself.
4. **Rebuild**, from the repository root, because `dist/` is gitignored and may
   be stale: `npm run build:mcp`.
5. **Look before you send.** In `mcp-package/`, `npm publish --dry-run` lists
   the files and the version without publishing.
6. **Publish**: `npm publish` in `mcp-package/`. npm asks for a one-time code
   from your authenticator app.
7. **Verify** from anywhere, with a clean cache so you test what the registry
   serves:

   ```bash
   npx -y 3doo-mcp@latest   # waits for a client on stdin; Ctrl+C to stop
   ```

   Or add it to an assistant with the command from the MCP dialog and ask for a
   model.
8. **Record it** under `## [Unreleased]` in `CHANGELOG.md` as a user-facing
   change, such as "The MCP package `3doo-mcp` 1.1.0 adds ...".

A published version cannot be changed or reused. A mistake is fixed by
publishing the next patch. `npm unpublish` is limited, and `npm deprecate
3doo-mcp@1.0.1 "use 1.0.2"` is the usual way to warn people off a bad one.

## Keeping it in step with the app

The server drives whichever 3DOO the user points it at, and the hosted editor
at https://3doo.vercel.app is the one the dialog's commands use. The two
sides agree through `AUTOMATION_VERSION` in `src/app/automation/types.ts`:
the server checks it on its first call and stops with a message when the page
speaks another version.

So a change to the page API needs two releases, in this order:

1. Bump `AUTOMATION_VERSION`, deploy the app on Vercel, and confirm the hosted
   site serves the new build.
2. Run the release steps above, so the published package carries the same
   `AUTOMATION_VERSION`.

Between the two, hosted users on the old package get the "speaks version X and
this server speaks Y" error. Keep that gap short. A change that keeps the page
API as it is needs only the app deploy, or only the package release, whichever
one changed.

Changes that touch neither the API nor `mcp/` (the editor's UI, the mesh
kernel) need no package release at all: the hosted editor updates by itself.

## Checking a build before publishing it

From the repository root, run the bundle by hand against the hosted editor:

```bash
npm run build:mcp
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"me","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_script","arguments":{"script":"scene.add(\"torus\")"}}}' \
  | THREEDOO_APP_URL=https://3doo.vercel.app node mcp-package/dist/server.mjs
```

The bundle looks for a build at `mcp-package/dist/index.html`, which does not
exist, so it never uses the repository's own `dist/`. A reply with `Script ran:
1 object added` means the bundle, the browser and the hosted editor all work.

To try the real tarball before it is public, `npm pack` in `mcp-package/` and
run `npx -y ./3doo-mcp-<version>.tgz`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npx -y 3doo-mcp` answers `404` | Not published yet, or the name is different from `NPM_PACKAGE` |
| `You cannot publish over the previously published versions` | The version was used already. Bump it |
| `EOTP` or `403` on publish | Missing or stale one-time code, or the name belongs to another account |
| The published server runs old code | `dist/server.mjs` was stale. Run `npm run build:mcp` and publish a new version |
| A user sees `speaks version X and this server speaks Y` | The hosted editor and the package are on different `AUTOMATION_VERSION`s. Deploy the app or release the package, see above |
| `There is no 3DOO to drive` | `THREEDOO_APP_URL` was not set. Every dialog command sets it |
| No browser to run 3DOO in | The user has no Chrome, Edge or Chromium. `npx playwright-core install chromium` |
