# How the aie2e agents work

`npm run aie2e` asks one question of 3DOO that no unit test can: can someone
make a professional game asset with it? Three AI agents build the brief
**"3D axe, game ready asset, medium poly, stylized"** in the editor and judge
it, while the runner drives the editor's main functions by hand, measures every
round and writes a report saying whether the axe made the bar, and what the
software got in the way of.

The name is AI end to end: an end-to-end test whose user is an AI.

## In short

```text
npm run aie2e
   │
   ▼
aie2e/run.ts ── the runner: plain code, no AI. It decides the stages, measures,
   │            keeps score and writes the report.
   ├─ builds the app, opens the editor in a Chrome window
   ├─ smoke test: Playwright clicks through the main functions, no AI
   ├─ for each stage (blockout, forms, finish), until it passes or runs out of attempts:
   │     modeler ──── claude -p ── bridge ─┐
   │                                       ▼
   │     runner: fixed pictures,      one shared scene (hub.ts),
   │     inspect_mesh, gates   ◀───── headless 3DOO behind the MCP tools
   │                                       ▲
   │     style-critic ─────── claude -p ── bridge ─┤  read only
   │     topology-reviewer ── claude -p ── bridge ─┘  read only
   ├─ exports FBX and OBJ, reads each back, compares the counts
   └─ report.html in ~/3doo-output/aie2e/<time>/
```

- The agents run as headless Claude Code sessions (`claude -p`) on the
  user's own Claude login. No API key is involved.
- The code measures and the agents judge. N-gons, holes, flipped faces and the
  triangle count are counted by `inspectMesh` in the kernel, never by eye. The
  agents decide what numbers cannot: whether the silhouette reads, whether
  the edge flow follows the forms, whether a game would ship it.
- The judges never see the modeller's reasoning, only the model, so an
  explanation cannot talk them into a pass.

## What an agent is

A language model on its own answers a message and stops. An agent is the same
model put in a loop, with a goal, tools it can act with and a rule for when it
is done:

```text
goal ─▶ decide ─▶ act with a tool ─▶ look at the result ─┐
          ▲                                               │
          └─────────────── not done yet ◀─────────────────┘
```

| Part | The modeller's |
| --- | --- |
| Model | Claude, `opus` by default |
| Instructions | `.claude/agents/modeler.md`: the role, the bar, the traps 3DOO sets |
| Tools | `run_script`, `render_views`, `inspect_mesh`, `get_scene`, `scripting_reference` |
| Context | The brief, what the last check measured, the judges' open issues |
| When it stops | It ends its turn with a JSON answer the CLI checks against a schema |

A script follows fixed steps and cannot notice that the blade came out
crooked. A chat answers but touches nothing. An agent acts, looks at what it
did (a picture, an error, a count) and changes course. That is what lets it
use 3DOO the way a person would, and what makes it a fair test of whether
3DOO can be used that way.

Why three agents rather than one: a game studio splits the same work between
a 3D artist, an art director and a technical artist, and for the same reasons.

1. **An independent judge.** A model that grades what it just made tends to
   pass it. The judges see the result, not the intent.
2. **A narrow context.** The art director does not need forty scripts in its
   head to say the head is too small. It reads pictures.
3. **One bar each.** A judge with one set of criteria is stricter on them than
   one juggling everything.

The patterns have names: an orchestrator with workers (the runner hands out
turns and gathers the answers) and a generator with critics (one makes, others
review, and the loop repeats).

| | `npm test` | `npm run test:gpu` | `npm run aie2e` |
| --- | --- | --- | --- |
| Asks | is each function right? | does the screen show the right thing? | can an asset be made to a professional bar? |
| Deterministic | yes | yes | no: every run differs |
| Costs | nothing, seconds | nothing, minutes | Claude usage, tens of minutes |
| Run it | on every change | when marks or pictures change | before a release, or to measure a change |

## Running it

```bash
npm run aie2e                      # the full run: three stages, Opus
npm run aie2e -- --dry-run         # stand-in agents: checks the runner, costs nothing
npm run aie2e -- --stages blockout --attempts 1 --model haiku   # a cheap look
```

| Option | Does |
| --- | --- |
| `--dry-run` | Scripted stand-ins for the three agents that reach the scene the same way, through the bridge. Checks everything but the thinking |
| `--stages <list>` | Stages to run, in order: `blockout,forms,finish` by default |
| `--attempts <n>` | Attempts per stage, instead of each stage's own |
| `--model <name>` | One model for every agent instead of the agent files' `opus` |
| `--effort <level>` | The modeller's effort, `medium` by default. `high` thinks longer before every step and makes a run much slower |
| `--judge-effort <level>` | The judges' effort, `medium` by default |
| `--max-usage <0..1>` | Stop before the next turn once the usage window is this full |
| `--headless` | No editor window; the smoke test runs unseen on software WebGL |
| `--no-build` | Use `dist/` as it is |
| `--no-smoke` | Skip driving the editor by hand |
| `--no-open` | Do not open the report at the end |
| `--out <dir>` | Where the run goes, `~/3doo-output/aie2e/<time>` by default |

It needs the `claude` command installed and logged in, and Chrome or Edge.
A full run takes 20 to 60 minutes and a good share of a five-hour usage
window. The runner watches the usage the CLI reports after every turn and
stops cleanly, report and all, when the limit is reached or when the window is
fuller than `--max-usage`. Ctrl+C also writes the report for what ran.

The exit code is 0 only when the axe passed every stage, the export round trip
held and every smoke step passed.

## What happens in a run

1. **Build.** `vite build` into `dist/`, unless `--no-build`.
2. **The editor window.** Chrome opens `/modeling` on the machine's GPU. It
   follows the agents' scene for the whole run: after every script the
   modeller runs, the runner reloads the scene there, and a strip across the
   top says who is working on what. Close it and it opens again with the
   scene and the strip as they were; it stays shut only after three windows
   in a row die within seconds of opening.
3. **Smoke test.** Playwright drives the editor the way a person does, with no
   AI: the starting cube, the viewport drawing, a primitive from the panel,
   undo and redo, picking in the outliner, extrude and bevel in edit mode, a
   modifier, the shading and view keys, FBX and OBJ from the EXPORT dialog,
   deleting with X, and no errors thrown. Each step says what it saw, and a
   failing step does not stop the rest.
4. **The stages.** See the next sections.
5. **Round trip.** The finished axe goes out as FBX and as OBJ with the Unity
   preset, each is opened into an empty scene, and its faces, triangles and
   n-gons are counted again. What an engine reads has to be what was modelled.
6. **Report.** `report.html` and `report.json` in the run folder.

## The three agents

They are ordinary Claude Code agent files in `.claude/agents/`, so they also
work from an interactive session once the 3doo MCP server is registered under
the name `3doo` (see [mcp.md](mcp.md)): "use the topology-reviewer on this
scene".

| Agent | File | Role | Tools | Hands back |
| --- | --- | --- | --- | --- |
| Modeller | `modeler.md` | The 3D artist. Builds, checks its own work, answers the judges, reports what 3DOO lacked | `scripting_reference`, `run_script`, `render_views`, `get_scene`, `inspect_mesh` | What changed, an answer to each open issue, friction with the software, whether it thinks the stage is met |
| Style critic | `style-critic.md` | The art director. Silhouette, proportions, shape language, bevels, palette, cohesion, appeal | `Read`, `render_views`, `get_scene` | Scores, new issues, a status for each earlier issue, pass or not |
| Topology reviewer | `topology-reviewer.md` | The technical artist. N-gons, edge flow, density, poles, shading setup, budget, game readiness | `Read`, `inspect_mesh`, `render_views`, `get_scene` | The same shape of verdict |

Each answer is JSON checked by the CLI against a schema (`MODELER_SCHEMA` and
`verdictSchema` in `aie2e/rubric.ts`), so the runner never parses prose.

The modeller keeps one session across the whole run (`--session-id`, then
`--resume`), so it remembers its own scripts. The judges start fresh every
round, so last round's opinion does not anchor this one; the issue ledger is
their memory.

## One scene for everyone: the hub and the bridge

An MCP server holds its scene in a browser tab of its own, and every
`claude -p` session starts its own servers. Left like that, each judge would
open an empty scene. So the runner holds the one scene itself:

- `aie2e/hub.ts` keeps one `BrowserEngine` (the MCP server's own engine) and
  answers the MCP protocol on a local port per agent, with the same handlers the
  server uses (`createHandlers` from `mcp/server.ts`).
- `aie2e/bridge.ts` is what each session launches as its 3doo server: a pipe
  from its stdin and stdout to one of those ports.
- The modeller's port has every tool. Each judge's port has an engine that
  refuses scripts, opening files and exports: a judge can look from any angle
  and measure, and cannot touch. The dry run checks that refusal every round.
- Every call goes through one queue, so a judge's picture never lands halfway
  through a script, and every call is logged with the agent whose port it
  came in on.

## How a round works

1. **The modeller's turn.** It gets the brief, the stage, everything the last
   check measured and every open issue, and works until it believes the stage
   is met.
2. **The runner measures.** The same pictures every round, so rounds compare:
   a silhouette sheet, a solid three-quarter view, a matcap from the other
   side, a wireframe sheet and a 128 pixel icon. Then `inspect_mesh`, the
   gates and the game-ready notes. The scene is saved as a `.3doo` beside them.
3. **The judges.** Both at once, since neither can change the scene. Each
   reads the pictures, may render more, and answers. The
   style critic gets the pictures only; the topology reviewer also gets the
   numbers. Given the numbers, the style critic raised triangle counts instead
   of judging style, so it no longer gets them.
4. **The outcome.** The stage passes when its gates hold, every judge passes
   it at the stage's score, and nothing blocking is open. Otherwise the
   modeller gets another attempt, with the reasons.

| Stage | Asks for | Judges | Passes at | Gates | Attempts |
| --- | --- | --- | --- | --- | --- |
| Blockout | The big shapes and their proportions | style | style 6 | not empty | 2 |
| Forms | Secondary forms, shape language, bevels; clean topology as it goes | style, topology | style 7, topology 6 | not empty, manifold, facing | 2 |
| Finish | A game-ready asset | style, topology | style 7.5, topology 8 | all six | 3 |

A stage that runs out of attempts is recorded as failed and the run moves on,
so a weak blockout still shows how far the finish gets.

## The bar

**Gates**, measured by `measureGates` from the `inspect_mesh` totals:

| Gate | Holds when |
| --- | --- |
| `notEmpty` | The scene has faces |
| `manifold` | No edge has three or more faces, and none has only one (no holes) |
| `facing` | No two neighbouring faces disagree on which side is out, and no closed piece is inside out |
| `noNgons` | No face has more than four corners. The brief forbids n-gons outright |
| `clean` | No loose vertices or edges, no stacked vertices, no slivers |
| `budget` | 1,500 to 5,000 triangles, as an engine draws them |

**Game-ready notes** (`gameReadyNotes`) block nothing but go to the topology
reviewer and the report: a believable length of 0.4 to 1.6 m, standing at
y 0, rotation and scale applied, no default names, live modifiers, too many
objects, mostly quads, twisted quads, flat shading everywhere, one colour.

**Judges' calibration**, stated in their files: for style, 5 is a generic
blockout, 7 shippable in an indie game, 8 a good professional prop, 9 a
portfolio piece. For topology, 6 works but is messy, 8 is clean and
professional.

## How they talk to each other

The agents never message each other directly. The runner carries what each
needs through the issue ledger (`IssueLedger` in `aie2e/rubric.ts`):

- A judge raises an issue: where, what is wrong, a fix the modeller can make,
  and a severity (`blocking`, `major`, `minor`). The runner gives it an id,
  `S-3` for the style critic's third, `T-1` for the topology reviewer's first.
- The modeller answers every open issue on its next turn: `fixed`, or
  `disputed` with a reason.
- The judge that raised it rules on it next round: `fixed`, `open`, or
  `withdrawn` when the reason convinced it.
- An issue the modeller disputed and the judge kept open becomes a
  **divergence**. It stops blocking and goes to the report for a person to
  settle, so one disagreement cannot hold the run in a loop.

## What a run leaves behind

```text
~/3doo-output/aie2e/<time>/
  report.html            the report; report.json holds the same data
  smoke/                 viewport.png, smoke.png and the files exported from the dialog
  rounds/01-blockout-1/  scene.3doo, the five pictures, measure.json
  rounds/02-forms-1/     ...
  final/                 axe.3doo, axe.fbx, axe.obj and axe.mtl
  transcripts/           every session, one JSON line per event, pictures left out
  agents/                the system prompts and MCP configurations the sessions ran with
```

The report opens with the verdict and the numbers, then the finished asset,
the stages, the gates and notes, the topology per object, the round trip, the
smoke steps, the findings about the software, every issue with its history,
each round with its pictures and verdicts, and the tool calls that failed.

## Reading the verdict

The report answers two questions apart:

- **Did the asset make the bar?** Every stage passed and the round trip held.
- **Did the software allow it?** The findings: smoke steps that failed, an
  export that changed the model, tools that errored on the modeller, and the
  modeller's own friction log (`missing_feature`, `bug`, `confusing`,
  `workaround`). This is how "the agent was not good enough" is told apart
  from "3DOO would not let it".

One run is one sample. Compare runs, not a single score, before concluding
that a change made 3DOO better or worse.

## Running on a Claude login

Each turn is one `claude -p` process (`runAgent` in `aie2e/claude.ts`), with:

| Flag | Why |
| --- | --- |
| `--system-prompt-file` | The agent file's body, in place of Claude Code's own system prompt |
| `--tools` and `--allowedTools` | Only the built-in tools the agent names (the judges' `Read`), and only its 3doo tools, allowed without asking |
| `--permission-mode dontAsk` | Anything else is refused, never asked about |
| `--mcp-config` with `--strict-mcp-config` | The bridge to the hub and nothing else: without it the sessions inherit every MCP server the user has |
| `--setting-sources user` | Leaves out this project's settings, whose hooks would copy every agent prompt into the user's prompt history |
| `--json-schema` | The answer the turn has to end with. Only the scalars are required: the model sometimes folds a list into the string before it, and a required list made the CLI refuse the answer five times and fail the turn. `readModelerReport` and `readVerdict` take such a list back out |
| `--output-format stream-json` | Every event as it happens: the progress lines, the transcript, tool errors and the usage window |

The sessions also run with the run folder as their working directory, outside
the repository, so the project's `CLAUDE.md` and rules (written for working on
3DOO, not for using it) stay out of the agents' context.

## Limits

- **Every run differs.** It is a benchmark to compare over time, not a gate
  for continuous integration.
- **The judges are models too.** Their scores are calibrated by the scales in
  their files, not against a person. To trust them more, rate a few axes
  yourself and tune the files until the judges agree with you.
- **No UV unwrapping.** 3DOO has none, so the brief is met with colour through
  material slots, the way many stylized games ship props. Textures are out of
  scope.
- **Scripts, not clicks.** The modeller builds through the scripting API,
  which runs the same operators as the panels. The panels, keys and dialogs
  are covered by the smoke test instead.

## Changing it

| To change | Edit |
| --- | --- |
| The brief, the budget, the size range | `BRIEF`, `TRI_BUDGET`, `LENGTH_RANGE` in `aie2e/rubric.ts` |
| A stage's goal, judges, scores, gates or attempts | `STAGES` in `aie2e/rubric.ts` |
| How an agent thinks | Its file in `.claude/agents/` |
| What the agents are told each round | `aie2e/prompts.ts` |
| The pictures | `PICTURES` in `aie2e/measure.ts` |
| The smoke steps | `runSmoke` in `aie2e/editor.ts` |

The pure parts have tests that run with `npm test`: `aie2e/rubric.test.ts`
(gates, notes, the ledger, stage outcomes, reading the answers),
`aie2e/claude.test.ts` (the agent files, the CLI flags, reading the stream),
`aie2e/editor.test.ts` (reopening a closed window) and `aie2e/prompts.test.ts`. After a
change to the runner, `npm run aie2e -- --dry-run` checks the rest without
spending anything.

## What building it found

The run exists to find what is wrong with 3DOO, and building it already did:

- **Pictures had no wireframe.** Every picture `render_views` took, in
  `solidWire` and `wireframe` alike, came out without a single edge, on
  SwiftShader and on a real GPU. The wire shaders read the occlusion map
  through an unsigned integer sampler, the map was left null outside the
  viewport's own frame, and WebGL2 throws away a draw whose sampler meets the
  float texture three binds in its place. `NO_OCCLUSION_MAP` in
  `src/bridge/materials.ts` fixes it, guarded by tests in `materials.test.ts`,
  `Viewport.test.ts` and the GPU check.
- **No way to check topology.** An assistant could count faces but not find a
  hole or a flipped face. `inspectMesh` in the kernel and the `inspect_mesh`
  MCP tool now do, for every assistant that uses the MCP server, not only for
  this run.
