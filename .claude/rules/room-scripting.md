---
paths:
  - "src/domain/scripting/**/*"
  - "src/domain/mcp/**/*"
  - "src/app/automation/**/*"
  - "mcp/**/*.ts"
  - "aie2e/**/*.ts"
---

# Room: scripting and MCP

Depth: `docs/scripting.md`, `docs/mcp.md`, `docs/mcp-package.md`,
`docs/how_aie2e_agents_work.md`.

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

## AI end to end

- `aie2e/` runs its agents as `claude -p` sessions on the user's login, with
  `--setting-sources user` and a working directory outside the repository.
  This project's hooks would copy every agent prompt into the user's prompt
  history, and its rules would brief the agents as developers of 3DOO.
- Keep `--strict-mcp-config`: without it a session inherits every MCP server
  the user has.
- Each session starts its own MCP servers, and each server its own empty
  scene. The agents share one through `bridge.ts` into `SceneHub`; the judges'
  port refuses anything that writes.
- Node runs `mcp/` and `aie2e/` by stripping types: no parameter properties,
  enums or namespaces there.
- Given the topology numbers, the style judge raised triangle counts instead
  of judging style: `judgePrompt` keeps them from it.
- Keep the lists in `MODELER_SCHEMA` and `verdictSchema` optional. The model
  folds a list into the string before it (`</summary><parameter name=...>`),
  and a required list made the CLI refuse the answer five times and fail the
  turn; `readModelerReport` and `readVerdict` take it back out.
- Each agent has its own hub port (`AGENT_ROLES`), which is how calls are
  labelled; the judges run at the same time, so nothing may rely on whose
  turn it is.
