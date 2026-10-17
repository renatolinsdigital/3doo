---
paths:
  - "src/domain/scripting/**/*"
  - "src/domain/mcp/**/*"
  - "src/app/automation/**/*"
  - "mcp/**/*.ts"
---

# Room: scripting and MCP

Depth: `docs/scripting.md`, `docs/mcp.md`, `docs/mcp-package.md`.

## Scripting

- Operators coerce bad parameters, because panels only send good ones.
  Scripts are checked instead: an unknown option, a wrong type or an out of
  range value throws, naming the nearest real option. Handles are proxies
  that refuse unknown properties.
- `reference.ts` is one catalogue (`API_ENTRIES`, `OPERATOR_SPECS`,
  `MODIFIER_FIELDS`, ...) with five readers: validation, highlighting, hover
  and suggestions, the SCRIPTING docs, and the MCP `scripting_reference`. A
  name without an entry gets none of them, so write the entry first.
  `OPERATOR_SPECS` must list every registered operator; a test enforces it.
- `runScript` runs inside `store.transact`: one undo step, and a throw loads
  the snapshot back, so a failed run leaves the scene as it was.
- The SCENE tab (`sceneScript.ts`) writes the scene on screen as the script
  that builds it, read off the scene each time rather than logged as it was
  made. The old ACTIONS log was removed for that reason.

## MCP

- `mcp/` is a Node stdio server that drives the built app in headless
  Chromium through `window.threedoo` (`src/app/automation`). It forces
  SwiftShader, so it runs on machines with no GPU; the GPU check must not
  copy that.
- Every call has a time limit; past it the page's context is closed and the
  scene is lost with it.
- Change an automation payload's shape and bump `AUTOMATION_VERSION`.
- Adding a tool: `AutomationApi` and its test, the `Engine` interface,
  `TOOLS` in `mcp/tools.ts` and its test, `MCP_TOOLS` in
  `src/domain/mcp/guide.ts` (a test fails until listed), then the AI
  ASSISTANTS docs section.
- `mcp-package/` is published to npm with a version of its own. Ask before
  bumping it, as for the app.
