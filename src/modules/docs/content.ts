import {
  DEFAULT_PRIMITIVE_PARAMS,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_FIELDS,
  type PrimitiveKind,
} from '@kernel/index';
import { DEFAULT_KEYMAP, formatBinding } from '@domain/keymap/keymap';
import {
  MCP_TOOLS,
  REPOSITORY_URL,
  claudeCodeCommand,
  hostedClaudeCodeCommand,
} from '@domain/mcp/guide';
import {
  API_ENTRIES,
  type ApiEntry,
  type ApiOwner,
  type FieldSpec,
  type ValueSpec,
  MODIFIER_FIELDS,
  MODIFIER_TYPES,
  OPERATOR_SPECS,
  PLACEMENT_OPTIONS,
  PRIMITIVE_KINDS,
  PRIMITIVE_OPTIONS,
  describeNeed,
} from '@domain/scripting/reference';

export type DocsBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'steps'; items: readonly string[] }
  | {
      kind: 'table';
      head: readonly [string, string];
      rows: readonly (readonly [string, string])[];
      /**
       * An anchor per row, for a link straight to it: the script editor's
       * balloons link here, one row per name the API has.
       */
      ids?: readonly string[];
    }
  | { kind: 'note'; text: string };

export interface DocsSection {
  id: string;
  title: string;
  /** One line under the heading, and the hint in the left menu. */
  blurb: string;
  blocks: readonly DocsBlock[];
}

export interface DocsResult {
  section: DocsSection;
  /** The blocks that matched, tables and step lists cut down to matching rows. */
  blocks: readonly DocsBlock[];
  /** The query names the section itself, through its title or its blurb. */
  named: boolean;
  /** Rows, steps and paragraphs matched, which is the tally the left menu shows. */
  count: number;
}

/**
 * The shortcut tables, built from the keymap the editor actually runs on.
 *
 * Transcribing them by hand is how documentation starts lying: every rebinding
 * would need finding here too. Grouped the way the in-app overlay groups them,
 * so the two cannot disagree either.
 */
function shortcutTables(): DocsBlock[] {
  const groups = new Map<string, (readonly [string, string])[]>();

  for (const binding of DEFAULT_KEYMAP) {
    const scope = binding.mode ? ` (${binding.mode} mode)` : '';
    const rows = groups.get(binding.group) ?? [];
    rows.push([formatBinding(binding), `${binding.label}${scope}`]);
    groups.set(binding.group, rows);
  }

  return [...groups].map(([group, rows]) => ({
    kind: 'table' as const,
    head: [group.toUpperCase(), 'DOES'] as const,
    rows,
  }));
}

/** One row per API name an owner has, anchored by the name's id. */
function apiTable(head: string, owners: readonly ApiOwner[], skip?: (entry: ApiEntry) => boolean) {
  const entries = API_ENTRIES.filter(
    (entry) => owners.includes(entry.owner) && !(skip?.(entry) ?? false),
  );
  return {
    kind: 'table' as const,
    head: [head, 'DOES'] as const,
    rows: entries.map((entry) => [entry.signature, entry.summary] as const),
    ids: entries.map((entry) => entry.id),
  };
}

/** `"a", "b" or "c"`. */
function either(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length < 2) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/** The form a field is written in, where its description cannot be relied on to say. */
function valueHint(value: ValueSpec): string {
  if (value.kind === 'enum') return ` Takes ${either(value.values)}.`;
  if (value.kind === 'flags') return ' Written { x, y, z } of true and false, such as { x: true }.';
  return '';
}

const fieldText = (fields: readonly FieldSpec[]) =>
  fields.map((field) => `${field.name}: ${field.description}${valueHint(field.value)}`).join(' ');

const OPERATION_NAMES = new Set(OPERATOR_SPECS.map((spec) => spec.name));

/** `radius 0.5, height 1, segments 24`: the shape a kind arrives in when no option is given. */
function primitiveDefaults(kind: PrimitiveKind): string {
  const params = { ...DEFAULT_PRIMITIVE_PARAMS, ...PRIMITIVE_DEFAULT_OVERRIDES[kind] };
  return PRIMITIVE_FIELDS[kind].map((field) => `${field} ${params[field]}`).join(', ');
}

/**
 * The scripting section: how to work in the SCRIPT dialog, then the API.
 *
 * The API half is built from the catalogue the editor itself reads. The same
 * entries feed the editor's balloons, its suggestions and the checks a
 * script's options go through, so this page cannot describe an API the editor
 * does not have.
 */
function scriptingBlocks(): DocsBlock[] {
  return [...scriptEditorBlocks(), ...scriptingApiBlocks()];
}

/** Reaching the SCRIPT dialog and working in it, which only a person at the editor needs. */
function scriptEditorBlocks(): DocsBlock[] {
  return [
    {
      kind: 'prose',
      text: 'The <> button at the right of the top bar opens SCRIPT, in two tabs. ACTIONS writes down what you do in the viewport as the script that would do it. EDITOR is where you build and change the scene with JavaScript. Everything the panels do can be done from a script: add primitives or your own geometry, place and colour objects, select vertices, edges and faces and run any modelling operation on them, give parts of a mesh colours of their own, stack modifiers, cut booleans, fill outliner folders, move the 3D cursor and frame the view.',
    },
    {
      kind: 'steps',
      items: [
        'Click <> in the top bar, then EDITOR. The editor opens on the script you were last writing, or on a short starter the first time.',
        'Write a script, or pick one under EXAMPLE to start from. Rest the pointer on any name the API has, such as scene or extrude, for a balloon that says what it does and links to its row on this page.',
        'Press RUN, or Ctrl+Enter. When the script works, the dialog closes, a toast says what it did, and the result is in the viewport.',
        'When it fails, a toast and the strip under the code say why, the line that failed is marked and the caret is put on it, and the dialog stays open. The scene is left exactly as it was before the run, so you can fix the line and run again.',
      ],
    },
    {
      kind: 'note',
      text: 'A whole run is one step to undo: Ctrl+Z takes back everything it did at once. A script runs in this browser tab, so a loop that never ends freezes the page. Save before running anything long.',
    },
    {
      kind: 'table',
      head: ['IN THE EDITOR', 'DOES'],
      rows: [
        ['Ctrl+Enter', 'Runs the script. Cmd+Enter on a Mac.'],
        [
          'Ctrl+Space',
          'Suggests the names that fit where the caret is. Typing a dot after scene or view, or the first letters of a name, opens the list by itself. Arrow keys pick, Enter or Tab inserts, Esc closes it.',
        ],
        ['Ctrl+/', 'Comments the selected lines out, or back in.'],
        ['Tab, Shift+Tab', 'Indents or outdents the selected lines by two spaces.'],
        [
          'Brackets and quotes',
          'Close themselves as you open them, wrap a selection when typed over one, and are stepped over when typed again. Enter after an opening bracket indents the next line.',
        ],
        [
          'Esc',
          'Closes a suggestion list or a balloon first, then leaves the editor, and then closes the dialog.',
        ],
        [
          'The status line',
          'Shows the line and column of the caret, and the full form of the API name the caret is on.',
        ],
      ],
    },
    {
      kind: 'prose',
      text: "A script tells you what it found in two ways. End it with return and a value, and that value is the toast and the status line when the run finishes: text as it is, anything else as JSON, so return box.bounds shows where the box sits. console.log writes to the browser's own console, which F12 opens in most browsers.",
    },
    {
      kind: 'prose',
      text: 'ACTIONS keeps a log of what you do, as script: adding, moving, selecting, renaming and deleting objects, their materials and modifiers, the 3D cursor and the shading, and every operation in edit mode with the vertices, edges or faces it ran on, the selection moved, turned or scaled by hand included, proportional falloff and all. Dragging a handle or a value writes one line with where it ended, and a move called off with Esc leaves nothing behind. Rest the pointer on a name for its reference, as in the editor. COPY puts the log on the clipboard as a script: paste it into EDITOR and run it, and it clears the scene and builds the one you made again. OPEN IN EDITOR puts that same script in EDITOR to change and run, and CLEAR empties the log.',
    },
    {
      kind: 'note',
      text: 'An edit mode selection is written as the points the vertices stand on, or the middles of the edges or faces, so it still picks the right ones after an undo has rebuilt the mesh. An undo takes its lines off the log and a redo puts them back, so the log always builds the scene on screen. A few things have no script that repeats them, such as importing a file or sliding along edges: the log says so in a comment where they happened, and so does a script you run. COPY warns when the log holds one of these, since a run leaves it out.',
    },
    {
      kind: 'note',
      text: 'An AI assistant can write and run these scripts for you, and hand the model back as a file, pictures or a link. The MCP button beside <> in the top bar says how to connect one, and AI ASSISTANTS below says what to ask it.',
    },
  ];
}

/**
 * The API itself, generated from the catalogue.
 *
 * It is also the body of the reference the MCP server hands an assistant, so
 * it says nothing about the dialog's own keys and buttons.
 */
export function scriptingApiBlocks(): DocsBlock[] {
  return [
    {
      kind: 'prose',
      text: 'A script gets two names to start from: scene, for the objects, and view, for the camera. Every object it adds or finds is handed back as an object you can keep in a variable and change later in the script. Positions are in metres and written [x, y, z] or { x, y, z }; rotations are in degrees.',
    },
    apiTable('NAME', ['global']),
    apiTable('SCENE', ['scene']),
    apiTable('OBJECT', ['object']),
    {
      kind: 'prose',
      text: "A primitive arrives centred on its origin, at the 3D cursor or at the position you give, and sized by the defaults below: a cube is 1 m on a side and a sphere 1 m across. A cylinder, cone or capsule stands along Y, a cone with its point up, a torus lies flat around Y, and a plane, circle or grid lies flat facing up. So scene.add('cylinder', { height: 2 }) runs from y -1 to 1, and stands on the ground at position: [0, 1, 0].",
    },
    {
      kind: 'table',
      head: ['PRIMITIVE', 'SHAPE OPTIONS AND THEIR DEFAULTS'],
      rows: PRIMITIVE_KINDS.map(
        (kind) => [`scene.add('${kind}')`, primitiveDefaults(kind)] as const,
      ),
    },
    {
      kind: 'table',
      head: ['OPTION', 'MEANS'],
      rows: [...PRIMITIVE_OPTIONS, ...PLACEMENT_OPTIONS].map(
        (field) => [field.name, field.description] as const,
      ),
    },
    {
      kind: 'prose',
      text: 'Whatever a script can set, it can read back: positions, rotations, colours, stats, modifier settings and the project name. object.bounds is the one to place parts with, because it says where the shape is drawn in the world, modifiers and all: a lamp stands on a table at table.bounds.max.y.',
    },
    {
      kind: 'prose',
      text: "object.edit((mesh) => { ... }) hands you the mesh of one object. Pick what to work on with selectVerts, selectEdges or selectFaces, then call an operation: each one works on the selection, exactly as its button does in edit mode, and the selection it leaves is what the next one starts from. Coordinates inside edit are in the object's own space, before its position, rotation and scale. If the object is the one you are editing in edit mode, the script starts from what you selected by hand; otherwise it starts with nothing selected.",
    },
    {
      kind: 'prose',
      text: 'A mesh you build with scene.addMesh keeps the order of your lists: in its first edit, mesh.verts[i] is verts[i] and mesh.faces[i] is faces[i], so you can pick parts of it by where they sit in your own lists. Operations put the faces they make or remake at the end, recalculateNormals and flipNormals among them, so pick by index before running any.',
    },
    apiTable('MESH', ['mesh'], (entry) => OPERATION_NAMES.has(entry.name)),
    {
      kind: 'table',
      head: ['OPERATION', 'DOES'],
      rows: OPERATOR_SPECS.map(
        (spec) =>
          [
            API_ENTRIES.find((entry) => entry.id === `mesh.${spec.name}`)?.signature ??
              `mesh.${spec.name}()`,
            [
              spec.summary,
              spec.needs ? `Needs ${describeNeed(spec.needs)} selected.` : '',
              fieldText(spec.params),
            ]
              .filter(Boolean)
              .join(' '),
          ] as const,
      ),
      ids: OPERATOR_SPECS.map((spec) => `mesh.${spec.name}`),
    },
    {
      kind: 'prose',
      text: "object.addModifier('mirror', { axes: { x: true } }) puts a modifier at the bottom of the stack, and modifier.set changes it later. Settings left out keep the values the MODIFIERS panel starts from. A modifier changes what is drawn and exported, not the mesh object.edit works on, until modifier.apply bakes it in.",
    },
    apiTable('MODIFIER', ['modifier']),
    {
      kind: 'table',
      head: ['MODIFIER TYPE', 'SETTINGS'],
      rows: MODIFIER_TYPES.map((type) => [`'${type}'`, fieldText(MODIFIER_FIELDS[type])] as const),
    },
    {
      kind: 'prose',
      text: "Every face wears one of its object's material slots, and an object starts with one, the slot object.color colours. To give part of a mesh a colour of its own, add a slot with object.addMaterial({ name: 'TRIM', color: '#b8452f' }), then inside object.edit select the faces and call mesh.assignMaterial with it. Joining objects keeps each one's colours, as slots of the result, and OBJ and FBX export carry every slot.",
    },
    apiTable('MATERIAL', ['material']),
    apiTable('VIEW', ['view']),
    {
      kind: 'note',
      text: 'Everything a script hands over is checked before it is used. A misspelt option, a value outside the range its panel allows, a property that does not exist or an operation with nothing selected to work on stops the script with the reason and the line, rather than quietly running with a default. Where a name is one letter or two away from a real one, the message suggests it.',
    },
  ];
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    id: 'getting-started',
    title: 'GETTING STARTED',
    blurb: 'From an empty scene to a shape you can export',
    blocks: [
      {
        kind: 'prose',
        text: '3DOO is a mesh editor that runs entirely in your browser tab. Nothing is uploaded and nothing is installed: the modelling kernel, the renderer and your project all stay on this machine. If you have used a desktop 3D package before, most of what follows will feel familiar.',
      },
      {
        kind: 'steps',
        items: [
          'Open the MODELING module from the plate in the top-left corner. A cube is already waiting in the scene.',
          'To add another shape, click one in the PRIMITIVES panel on the left. It appears at the 3D cursor, already selected.',
          'While the shape is freshly added, change its parameters (size, segments, rings) in the PROPERTIES panel. The mesh rebuilds each time.',
          'Press Tab to enter edit mode. The left panels change to SELECT, OPERATIONS, LOOP OPERATIONS and TOPOLOGY, and the knife in the tool rail becomes available.',
          'Select some geometry and run an operation: E extrudes, I insets, Ctrl+R cuts a loop.',
          'Press Ctrl+S to save the project as a file you can reopen, or Ctrl+E to export it as OBJ or FBX.',
        ],
      },
      {
        kind: 'note',
        text: 'The starting cube is an ordinary object: one Ctrl+Z removes it if you would rather start empty. FILE > NEW starts the next project on a cube too.',
      },
      {
        kind: 'note',
        text: 'Undo holds the last 50 steps, or as many as UNDO STEPS in preferences allows. The ▤ button in the top bar lists them, so you can click straight back to any one.',
      },
      {
        kind: 'note',
        text: 'Your work is only kept once it is in a file. Save with Ctrl+S, or turn on AUTOSAVE in preferences: it then writes a numbered .3doo at a regular interval into a 3doo-auto-saves folder, in a location you choose. A closed or crashed tab then costs you at most the changes since the last copy, and FILE > OPEN brings any copy back.',
      },
    ],
  },
  {
    id: 'interface',
    title: 'THE INTERFACE',
    blurb: 'What each region of the screen is for',
    blocks: [
      {
        kind: 'table',
        head: ['REGION', 'HOLDS'],
        rows: [
          [
            'Brand plate, top-left',
            'The current module. Click it to switch between HOME, MODELING and DOCS.',
          ],
          [
            'Top bar',
            'Left: FILE, PREFS and the project name. Middle: the object/edit mode switch; the snap, proportional, auto merge, orthographic and smooth-shading flags; the pivot picker; the SHADING and OVERLAYS menus. Right: the script editor, the MCP server guide (connecting an AI assistant), the history list, the two framing buttons and the shortcut list. On a narrow screen the bar is one row that scrolls sideways: swipe it to reach the rest.',
          ],
          [
            'Tool rail, far left',
            'Select, move, rotate, scale and the knife. The knife cuts mesh faces, so it is greyed out until you enter edit mode. Below the rule, ⊙ moves the origin onto the geometry.',
          ],
          [
            'Left panels',
            'PRIMITIVES, OBJECT and BOOLEAN in object mode. SELECT, OPERATIONS, LOOP OPERATIONS and TOPOLOGY in edit mode.',
          ],
          [
            'Panel titles',
            'Click a title to fold its panel away. Which panels are folded is saved with the project. To remove a panel from the screen altogether, use PANELS VISIBILITY in PREFS.',
          ],
          [
            'Viewport',
            'The scene. Orbit, pan and zoom here; right-click for the 3D cursor menu. The axis widget sits in its top right corner.',
          ],
          [
            'Right column',
            'OUTLINER lists the objects, PROPERTIES shows the active object, MODIFIERS holds its modifier stack.',
          ],
          [
            'Quick bar, bottom',
            'Phones, tablets and narrow windows only. TOOLS and SCENE bring the left panels and the right column out as drawers over the viewport, since there is no room to keep them open beside it. On a touch screen the bar also holds undo, redo, ADD and delete, and during a knife cut it holds CUT, UNDO POINT and CANCEL.',
          ],
          [
            'Status bar',
            'Scene and selection counts, the last operation that ran, and the hint line during a modal transform. A small floppy disk turns once each time autosave writes a copy.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Rest the pointer on almost any control for a moment to see a one-line hint explaining it. On a touch screen, rest a finger on it instead: the hint comes up and lifting the finger does not press the control. If the hints get in the way, turn them off under PREFS.',
      },
    ],
  },
  {
    id: 'objects',
    title: 'OBJECT MODE',
    blurb: 'Adding, arranging and organising whole objects',
    blocks: [
      {
        kind: 'prose',
        text: 'In object mode each mesh is one thing you place in the scene. There are ten primitives: cube, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule and torus. Each stays parametric until you edit its geometry, so you can still change its segments and radius after adding it.',
      },
      {
        kind: 'table',
        head: ['ACTION', 'HOW'],
        rows: [
          [
            'Move, rotate, scale',
            'G picks the move tool: drag the gizmo handles. R and S start a rotate or scale straight away, following the pointer. Press X, Y or Z during a rotate or scale to lock it to that axis.',
          ],
          [
            'Duplicate',
            'Shift+D makes an independent copy. Alt+D makes a linked copy that shares the same mesh data.',
          ],
          ['Join objects', 'Select several and press M to merge them into the active one.'],
          ['Separate', 'P splits the loose parts of a mesh into an object each.'],
          [
            'Apply transform',
            'Ctrl+A bakes rotation and scale into the vertices, leaving the transform clean.',
          ],
          [
            'Origin to geometry',
            'The ⊙ button at the foot of the tool rail moves the origin to the middle of the mesh, and the gizmo with it. Use it whenever an edit has left the origin behind.',
          ],
          ['Rename, hide, lock', "In the OUTLINER, on each object's row."],
          [
            'Group',
            'Ctrl+G puts the selected objects in a folder in the OUTLINER. An object belongs to one folder at a time, so objects already in another folder move across.',
          ],
          [
            'Select from the outliner',
            'Click a row to select it. Shift+click works on the whole run of rows from the active row to the one clicked, like a file list: clicking a row outside the selection adds the run, clicking one inside removes it. Ctrl+click does the same for the clicked row alone, so you can pick rows that are far apart. Rows inside a folded folder are skipped.',
          ],
          [
            'The row menu',
            'Right-click a row in the OUTLINER for SELECT (DESELECT on a row already selected), RENAME, GROUP, APPLY TRANSFORMS and DELETE. A row inside a folder also offers REMOVE FROM GROUP, which takes that one object out and leaves the folder intact. Every entry acts on the row you opened the menu on (named in its header), not on the rest of the selection. GROUP is the exception: it puts the whole selection in a folder, so it is only available when two or more objects are selected and none of them is in a folder.',
          ],
          [
            'The folder menu',
            'Right-click a folder title for RENAME, SELECT ALL, JOIN (merge everything in the folder into one object), UNGROUP (remove the folder and leave its objects loose) and DELETE (the folder and everything in it).',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'A folder acts on all its objects at once. Its row has a visibility and a lock toggle that set every object inside, and its chevron folds it shut to get a finished assembly out of the way. Click the folder title to select everything inside, then move, rotate or scale the group as one. When the last object leaves a folder, or is deleted, the folder goes too.',
      },
      {
        kind: 'prose',
        text: 'Every object has an origin: the point its vertex coordinates are measured from. LOCATION is where the origin is. On the ORIGIN pivot, rotation and scale turn about it, and a mirror modifier reflects across it. A selected object shows its origin as an amber square, drawn on top of the geometry because an origin usually sits inside the mesh. ORIGINS under OVERLAYS hides the square.',
      },
      {
        kind: 'table',
        head: ['ACTION', 'THE ORIGIN'],
        rows: [
          ['Move in object mode', 'Moves with the mesh.'],
          [
            'Move in edit mode',
            'Stays where it is. Geometry dragged across the scene leaves its origin and its amber square behind.',
          ],
          [
            'ORIGIN TO GEOMETRY',
            'Moves to the middle of the mesh. Nothing moves on screen, because the vertices give up exactly what the origin gains. It needs a mesh that is not shared: linked copies share their vertices, so moving one origin would drag every other copy off its own.',
          ],
          [
            'ORIGIN OF SELECTED TO CURSOR',
            'Moves to the 3D cursor, for every selected object. Use it to give a set of parts one shared point to turn about. It is in the viewport right-click menu.',
          ],
          [
            'MERGE, SEPARATE, the booleans',
            'Moves to the middle of the result, as ORIGIN TO GEOMETRY would. The geometry these hand back has no relation to the old origin: a merge spans everything that came in, a separated part is one piece of the old whole, and a cut can remove the corner the origin sat in. Nothing moves on screen; the LOCATION numbers change to say where the shape now is.',
          ],
          [
            'DUPLICATE, LINKED DUPLICATE',
            'Copied from the source, so the copy behaves like the original under a rotation.',
          ],
          [
            'APPLY TRANSFORM',
            'Stays where it is. Rotation and scale are baked into the vertices, and the position is deliberately kept.',
          ],
          ['RECALCULATE NORMALS', 'Stays where it is. It only turns faces around.'],
        ],
      },
    ],
  },
  {
    id: 'selecting',
    title: 'SELECTING GEOMETRY',
    blurb: 'Vertex, edge and face selection, and the loop shortcuts',
    blocks: [
      {
        kind: 'prose',
        text: 'Press Tab to enter edit mode, then 1, 2 or 3 to select vertices, edges or faces. Edit mode always opens with nothing selected. Switching between 1, 2 and 3 keeps your selection: it carries over from the elements you picked to the ones the new mode works with.',
      },
      {
        kind: 'table',
        head: ['SELECTION', 'HOW'],
        rows: [
          [
            'One element',
            'Click it. Shift+click toggles it: an element outside the selection joins it, one already in it drops out. This works the same for a vertex, an edge, a face and, in object mode, a whole object.',
          ],
          [
            'Add to the selection',
            'Hold Shift while you click or drag. A Shift+drag adds everything the region touches. What counts is whether Shift was down when the click or drag began, so you can let go of Shift partway through a CIRCLE drag to free its shape and it still adds.',
          ],
          [
            'Remove from the selection',
            'Shift+click anything already selected. To remove a whole region, drag with Shift+Ctrl: it drops everything the region touches and keeps the rest, whichever region shape you use. On a Mac use Shift+Cmd, because Ctrl+click is a right-click there and opens the cursor menu.',
          ],
          [
            'What the pointer tells you',
            'While Shift is held, the pointer shows what a click would do: a plus over anything a click would add (and over empty space), a minus over anything already selected. It updates the moment a click lands, so it always describes the next click. With Alt held as well, in edge or face select, a ring appears above the sign: the sign says whether the pick adds or removes, the ring says it takes a whole loop.',
          ],
          [
            'Selecting with other tools',
            'Clicks select under MOVE, ROTATE and SCALE just as under SELECT, and the pointer marks follow whichever tool is active. A click on a gizmo handle reaches whatever is under it, so Shift+clicking a selected object where its handles stand drops it from the selection. The knife is the exception: its clicks place the points of a cut, and select nothing.',
          ],
          [
            'A region of elements',
            'Drag across empty space. The region is a rectangle by default. Press V to step the select tool through SQUARE, CIRCLE and LASSO (drawn freehand), or click the tool in the rail for the same three; its icon shows the current shape. A region takes anything it touches, even partly: an edge it reaches the tip of, a face it covers any part of, and in object mode the whole object.',
          ],
          [
            'An oval region',
            'With CIRCLE, the region grows from where the drag began rather than corner to corner. Each of its two radii follows how far the pointer has moved along that axis, so the shape follows the pointer into any oval. Hold Shift for a true circle, with both radii set to the distance to the pointer. A drag straight up, down or across makes no oval, since one radius stays at zero.',
          ],
          [
            'An edge loop',
            'Alt+click an edge. The pointer shows a ring as soon as Alt is held, meaning the click takes the whole loop rather than one edge. The loop runs on until it meets a pole. Shift+Alt+click an unselected edge to add its loop, or a selected edge to remove its whole loop. From edges already selected, EDGE LOOP in the TOPOLOGY panel does the same: select two edges that meet, and it extends the selection along the loop each of them runs in.',
          ],
          [
            'A face loop',
            'Alt+click a face near the edge you want the loop to run across. That edge decides which of the two loops through the face you get, so point at the side you are heading for, not the middle. Shift+Alt+click adds a loop instead of replacing the selection, so you can build up bands one click at a time; on a face already selected, it removes the whole loop. Vertex select has no loops, so Alt shows no ring there. Alt+L selects the loop through two faces already selected.',
          ],
          [
            'What a click would take',
            'In vertex select, the vertex under the pointer is marked with a larger cyan square before you click, and only when a click could actually take it. That tells apart two vertices in the same place, and shows whether the vertex you are aiming at can be reached from where the camera is.',
          ],
          [
            'Which way a selection reaches',
            'A selected vertex shades the edges it owns in the selection colour, strongest at the vertex and fading to nothing at the far end. A dot alone says little about the geometry around it, so the fade makes a growing selection readable at a glance. An edge with both ends selected is selected itself, and is drawn in solid red.',
          ],
          ['Everything / nothing', 'A selects all, Alt+A deselects all, Ctrl+I inverts.'],
          [
            'Clear the selection',
            'Esc clears it (objects in object mode, elements in edit mode) and puts the transform gizmo away. It adds no undo step of its own.',
          ],
          [
            'Wider or narrower',
            '] grows the selection by one ring of neighbours, [ shrinks it back from its border.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Selection is stored on the mesh elements themselves, which is where the modelling operations look for it. So an operation always acts on exactly what the viewport highlights.',
      },
    ],
  },
  {
    id: 'modelling',
    title: 'MODELLING OPERATIONS',
    blurb: 'The operators that change topology',
    blocks: [
      {
        kind: 'prose',
        text: 'The edit-mode operations live in three panels. OPERATIONS adds geometry (extrude, inset, bevel). LOOP OPERATIONS works along edge loops (loop cut, subdivide, relax, circle, space). TOPOLOGY joins, welds, cleans up or widens the selection. Most operations have a shortcut. A button is disabled when the current selection cannot feed it, and its hint says what to select instead.',
      },
      {
        kind: 'table',
        head: ['OPERATION', 'WHAT IT DOES'],
        rows: [
          [
            'Extrude (E)',
            'Pulls the selected faces or edges out into new geometry. INDIVIDUAL extrudes each face along its own normal instead of as one region.',
          ],
          [
            'Inset (I)',
            'Shrinks faces inward, leaving a border ring. DEPTH also pushes the inset face along its normal.',
          ],
          [
            'Bevel (Ctrl+B)',
            'Chamfers the selected edges. More SEGMENTS round the chamfer instead of leaving it flat.',
          ],
          [
            'Loop cut (Ctrl+R)',
            'Adds edge loops across the ring of quads the selected edge runs through, and leaves the new loop selected, ready to move or scale. It needs quads: an edge with a triangle or an n-gon on both sides (every edge of a cone) has nothing to cut across, so the button stays unavailable.',
          ],
          [
            'Knife (K)',
            'Cuts new edges into the mesh along a line you click out point by point, wherever you want them, with no selection needed and no quads required. A vertex goes in at every click and wherever the line crosses an edge. It is a tool in the rail rather than a button: see below.',
          ],
          [
            'Subdivide (Ctrl+D)',
            'In face mode, cuts every edge of the selected faces CUTS times and fills each face with the resulting grid: one cut makes four faces, three make sixteen. SMOOTH adds Catmull-Clark smoothing. Each cut then runs on as a loop through the neighbouring quads, until it closes or meets a face that is not a quad. That keeps the mesh in quads, and leaves no stray vertex on the faces around the selection. In edge mode, adds CUTS vertices along each selected edge.',
          ],
          [
            'Relax',
            'Takes the kinks out of a selected loop and evens its spacing, without changing the shape it lies on. Each pass draws every vertex toward the midpoint of its neighbours, spreads the loop out evenly, and drops each vertex back onto the surface (that last part is KEEP SHAPE). So a relaxed loop slides across the mesh instead of sinking into it. Where the selection ends, the end vertex holds still. A selection that is not a loop is smoothed against its whole neighbourhood. An open border keeps its outline and is only evened out along it. FACTOR sets how far each pass moves, ITERATIONS how many passes run.',
          ],
          [
            'Circle',
            'Rounds the selected loop onto the circle that fits it best. The loop is flattened onto its average plane, and each vertex moves to one shared radius while keeping its direction from the centre, so the vertices stay in order. The circle is fitted to the points rather than centred on the middle of the selection, so half a ring rounds as accurately as a whole one. Each loop in the selection is fitted separately, so both ends of a cylinder round in one go. FACTOR 1 lands on the circle; less goes part of the way.',
          ],
          [
            'Space',
            'Slides the selected vertices along their loop until the gaps between them are even, keeping every bend where it is. Use it when the shape of a loop is right and only the spacing is wrong, where relax would round off the corners. A closed loop is spaced all the way round. An open one is spaced between its two end vertices, which hold still so the loop stays joined to the mesh. Spacing is measured along the loop, so on a coarse loop the gaps can still differ by a few percent: click again to even them. Run CIRCLE, then SPACE, to turn any ring into a regular one.',
          ],
          [
            'Slide (Shift+G)',
            'Moves the selection along the geometry it sits on, adding nothing. In vertex select, each vertex runs down one of its edges. In edge select, the selection runs across the faces on either side, which is how you nudge a loop into place after a loop cut. Face select has no single rail to run along, so switch to 1 or 2 first. For an exact distance, use the SLIDE row of the TOPOLOGY panel.',
          ],
          [
            'Merge and merge by distance (M)',
            'MERGE, in the TOPOLOGY panel, welds the selected vertices onto one point: their centre, the 3D cursor, or the first or last one selected. MERGE BY DISTANCE (M) welds every pair closer than a threshold, with a live count of how many vertices will go.',
          ],
          [
            'Delete menu (Del) and delete (X)',
            'Del opens the DELETE MENU at the pointer, with a delete and a dissolve for each of vertices, edges and faces. Delete removes the geometry and leaves a hole. Dissolve removes it but keeps the surface closed, merging the faces around it into one. Each entry acts on the type it names, whatever the select mode, and an entry with nothing to act on is greyed out: dissolving faces needs two or more that share an edge without closing off a solid, and dissolving edges needs one with a face on each side. Dissolve skips an edge or corner whose faces meet at more than 40°, since merging them would fold the face. When that leaves nothing to dissolve, as on a cube corner, the entry is greyed out too. Otherwise the status bar says how many it skipped. X skips the menu and deletes whatever the select mode targets.',
          ],
          [
            'Fill (F) and bridge',
            'Fill closes a selected boundary loop with a face. Only open edges count, so with the whole mesh selected, F fills its holes and nothing else. Bridge (Alt+B) connects two open loops of matching length with a band of quads.',
          ],
          [
            'Connect (J)',
            'Runs an edge between two selected vertices, splitting the face they share.',
          ],
          [
            'Triangulate (Alt+T) / tris to quads (Alt+J)',
            'Converts the whole mesh one way or the other. Tris to quads merges adjacent, near-coplanar triangle pairs back into quads.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'E, I and Ctrl+B take their distance from the pointer, so you see the shape before you commit to it:',
      },
      {
        kind: 'steps',
        items: [
          'Press the key. A dashed guide appears.',
          'Move the pointer. The mesh follows live, and the status bar shows the distance.',
          'Click or press Enter to confirm, or press Esc to put the mesh back. You can also hold the mouse button down and drag: letting go confirms.',
        ],
      },
      {
        kind: 'table',
        head: ['KEY', 'MOVE THE POINTER'],
        rows: [
          [
            'Extrude (E)',
            'Along the dashed line drawn through the selection. Only travel along that line counts, so the pointer can wander off it. Pull back past the start to sink the region into the surface instead of raising it.',
          ],
          [
            'Inset (I)',
            'In toward the selection. The ring keeps widening as you sweep on past the middle. Pull back the way you came to close it.',
          ],
          [
            'Bevel (Ctrl+B)',
            'Out from the selection, in any direction: the length of the dashed line sets the width. Bring the pointer back in to close it, down to nothing.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Pressing the key and confirming without moving changes nothing and records no undo step, so a stray E or I costs nothing. When you know the exact figure, type it into the OFFSET, THICKNESS, DEPTH, WIDTH or SEGMENTS field of the OPERATIONS panel instead.',
      },
      {
        kind: 'prose',
        text: 'The knife cuts new edges into the mesh wherever you draw them. While it is in hand the pointer turns into a knife, and a cyan square marks where the next click will land:',
      },
      {
        kind: 'steps',
        items: [
          'Press K, or pick the knife in the tool rail. It works in edit mode only.',
          'Click where the cut starts: on a vertex, on an edge, inside a face, or out in empty space beside the mesh to cut in from its edge.',
          'Click again wherever the cut should turn. A cyan line follows the pointer from the last point, with dots where it will cross the edges.',
          'Press Enter or Space to make the cut. The new edges come out selected, ready to move, and the whole cut is one undo step.',
        ],
      },
      {
        kind: 'table',
        head: ['WHILE CUTTING', 'DOES'],
        rows: [
          [
            'Click',
            'Adds a point. Near a vertex it lands on the vertex, near an edge on the edge, and otherwise inside the face under the pointer. Press, drag and let go to place two points in one go.',
          ],
          [
            'Enter or Space',
            'Makes the cut. The two keys do the same thing: every line drawn so far goes into the mesh at once, as one undo step, and the new edges come out selected. The knife stays in hand, ready for the next cut.',
          ],
          ['Backspace or Ctrl+Z', 'Takes the last point back.'],
          [
            'E',
            'Lifts the knife: the next click starts a separate line. Every line is cut at once when you press Enter.',
          ],
          [
            'Shift, held',
            'Lets go of vertices and edges, so a point can go anywhere inside a face, however close to an edge.',
          ],
          ['Ctrl, held', 'Puts the point on the middle of the edge under the pointer.'],
          [
            'Esc or right-click',
            'Calls the cut off. The mesh is left as it was, and no undo step is recorded.',
          ],
          [
            'Click outside the viewport',
            'Makes the cut, the way a click confirms the operations above, then does whatever it was aimed at.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'A face is divided wherever the cut crosses it from one of its edges to another, through any points you placed inside it. A cut that stops inside a face divides nothing, and its edges are left loose on top of the face: carry it on to an edge to divide the face. Where two lines of one cut cross, the face divides along both. Click the first point again to close a cut on itself.',
      },
      {
        kind: 'note',
        text: 'The knife cuts what you can see. In wireframe and x-ray shading it cuts through to the faces behind as well, so one line across a box goes all the way round it. You can orbit, pan and zoom partway through a cut to reach round the model: the part already drawn stays where it was drawn. An image plane keeps its picture lined up where the knife cuts it.',
      },
      {
        kind: 'note',
        text: 'Slide has two ways in. Shift+G runs it from the pointer with no button held, and the mouse carries the distance: move it and the selection slides; click or press Enter to confirm, Esc to cancel. The rails each vertex can travel along are drawn while it runs, and the status bar shows how far it has gone. A vertex slides down the edge that reaches toward the pointer at the moment you press the key, so aim before you press.',
      },
      {
        kind: 'prose',
        text: 'For an exact slide, use the SLIDE row of the TOPOLOGY panel:',
      },
      {
        kind: 'steps',
        items: [
          'Switch ENABLE on.',
          'Pick a DIRECTION: 1, 2 or 3 for a vertex slide, 1 or 2 for an edge slide.',
          'Set TRAVEL in metres. A cyan preview shows where the selection will land, and the track ends where the first selected vertex would reach its neighbour.',
          'Press VERTEX SLIDE or EDGE SLIDE.',
        ],
      },
      {
        kind: 'note',
        text: 'A slide adds nothing and never leaves the surface, which makes it the way to adjust where a loop sits without changing the shape. Slide all the way and the selection lands exactly on the neighbouring vertices. Auto merge then collapses the two. With auto merge off they stay, one on top of the other, and the hover mark shows which one a click would take.',
      },
      {
        kind: 'note',
        text: 'Auto merge, the ⋈ flag in the top bar, welds vertices that a transform has left on top of each other, within the distance set in the AUTO MERGE row of the TOPOLOGY panel. It turns a slide all the way onto the next loop into a collapse of the two, instead of two loops in the same place. Only the vertices that just moved can be welded away, so geometry that was already that close is left alone. The weld shares one undo step with the transform that caused it.',
      },
      {
        kind: 'prose',
        text: 'To give edges an exact length, select them and type the length in metres into SELECTED EDGE(S) in the PROPERTIES panel. The field shows their current length, and the new one applies as soon as you press Enter or leave the field.',
      },
      {
        kind: 'note',
        text: "Each selected edge is set to that length, stretched about its own midpoint, so it keeps its position and direction while the faces around it follow. The length is measured in the world, with the object's scale applied, which is the size an export writes. Drag the LENGTH label to stretch the edges live; the whole drag is one undo step. Edges that share a vertex cannot be sized together, because the second would move a vertex the first had just placed. The field stays unavailable until no two selected edges touch, and its hint says what is holding it back.",
      },
      {
        kind: 'prose',
        text: 'Normals say which way each face points. Recalculate them outward with Shift+N, or flip them. The face-orientation overlay draws backfaces in red: wherever red shows, you are looking at the inside of the surface, which is worth fixing before an export.',
      },
      {
        kind: 'prose',
        text: 'Smooth shading is the ◐ flag in the top bar, next to the orthographic one. It blends normals across faces instead of faceting them. In edit mode it applies to the selected faces only. It belongs to the object, so REMESH keeps whatever it was set to.',
      },
      {
        kind: 'prose',
        text: 'To keep a hard edge on a smooth surface, select the edges and press MARK SHARP in the NORMALS row of the PROPERTIES panel. Shading breaks along them instead of blending across, and edit mode draws them in cyan. CLEAR SHARP removes the mark.',
      },
      {
        kind: 'note',
        text: 'A sharp edge only breaks the shading at a vertex the crease runs through. A single sharp edge in the middle of a surface therefore changes nothing, and a longer crease fades out over its last edge at each end. Run it to the border of an open surface, or all the way round, and it holds right to the end. The mark survives subdivide, loop cut, merge and the modifiers, and an FBX export with per-vertex normals keeps the hard edges.',
      },
      {
        kind: 'note',
        text: 'Subdivision multiplies rather than adds: four cuts turn one face into twenty-five, and running it again turns each of those into twenty-five more. About a quarter of a million faces is as much as a browser tab can hold. So SUBDIVIDE warns you what a heavy run would leave before it runs, refuses outright past that limit, and the LOOP SUBDIVIDE modifier drops a level instead of taking the tab down.',
      },
      {
        kind: 'note',
        text: 'Proportional editing, at the bottom of the TOPOLOGY panel, spreads a transform into the unselected geometry around it, through one of six falloff curves. Turn it on, set a radius, and dragging a single vertex pulls the surface along with it.',
      },
    ],
  },
  {
    id: 'modifiers',
    title: 'MODIFIERS',
    blurb: 'Non-destructive operations stacked on an object',
    blocks: [
      {
        kind: 'prose',
        text: 'A modifier changes what an object looks like without changing the mesh you edit. The stack runs top to bottom every time the viewport draws, so you keep editing the cage underneath while you see the result.',
      },
      {
        kind: 'note',
        text: 'In edit mode you see both. The result is shaded as usual, with its edges drawn faintly behind the cage. The cage keeps the full wireframe, its vertices and its selection, because the cage is what a click picks and what operations run on.',
      },
      {
        kind: 'table',
        head: ['MODIFIER', 'WHAT IT DOES'],
        rows: [
          [
            'Mirror',
            'Reflects the mesh across an axis, optionally merging the seam or bisecting what crosses the plane. It can mirror about the 3D cursor instead of the object origin.',
          ],
          [
            'Array',
            'Repeats the mesh at a fixed offset, with the option to weld the joints between copies.',
          ],
          ['Solidify', 'Gives a surface thickness by generating an inner shell and a rim.'],
          [
            'Bend',
            'Curls the mesh around X, Y and Z at once, applied in that order. Around each axis, the longer of the two sides square to it, as the object is drawn, curls toward the other. The angle is spread along the whole of that length, so 360° closes any length into a ring. It only moves the vertices already there and adds none, so a face curves only where loops cross it: loop cut the length you want curved, or put LOOP SUBDIVIDE above the bend. ORIGIN keeps the mesh at the object origin or the 3D cursor where it is.',
          ],
          [
            'Twist',
            'Turns the mesh about X, Y and Z at once, applied in that order. The further along the axis a part lies, the further it turns, so one end turns the whole angle past the other, up to four full turns. Like bend, it only moves the vertices already there: loop cut the length you want twisted. ORIGIN sets the line it turns about and the level that holds still: the object origin or the 3D cursor.',
          ],
          [
            'Weld',
            'Merges vertices closer together than a threshold, across the whole evaluated result.',
          ],
          [
            'Loop Subdivide',
            'Splits every face into quads, one level at a time, keeping the shape or rounding it off.',
          ],
          [
            'Subdivision Surface',
            'Splits every face into quads for each of up to six SUBDIVISION LEVELS. With CATMULL-CLARK on, each level rounds the mesh toward a smooth surface; off, it only adds faces. In edit mode the original mesh stays drawn as a cage around the smooth result, and the cage is what you select and move. Object mode and Apply show the result alone.',
          ],
          [
            'Remesh',
            'Rebuilds the topology outright, by one of three methods. VOXEL samples the shape into a signed distance grid and builds an even quad shell back out of it. BLOCKS reads the same grid straight off the lattice, every face axis-aligned: a voxel study of the shape rather than a surface to keep working on. REDUCE rebuilds nothing: it collapses the edges that cost least to lose and leaves every other vertex exactly where it was. REDUCE is the only method that keeps material slots.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Order matters: mirroring after an array is not the same shape as arraying after a mirror, so reorder the stack to change the outcome. APPLY bakes a modifier into the real mesh when you are ready to commit to it.',
      },
      {
        kind: 'prose',
        text: 'REMESH is for when the shape is right but the topology is not: a boolean left slivers, an import arrived as one dense triangle soup, or a sculpt needs an even cage to work on. It throws away the geometry it is given, so put it at the end of a stack, not the middle. Set the density first. TARGET FACES names the face count you want and works out the voxel size from it. Turn it off to set VOXEL SIZE by hand, or KEEP, the fraction of triangles REDUCE holds on to.',
      },
      {
        kind: 'prose',
        text: 'SHARP EDGE makes the voxel method usable on hard surfaces. A grid cannot hold an edge that does not run along it, so without it a cube comes back with every edge chamfered. Set an angle, and edges of the original that turn by more than it are kept as creases: the corners where they meet are pinned, and a vertex may slide along a crease but never off it. Set it to zero for organic work, where holding a crease that a sculpt is about to move does more harm than rounding it off.',
      },
      {
        kind: 'note',
        text: 'The voxel methods always produce a closed solid: an open surface is closed over, and holes finer than the grid disappear. REDUCE is the one that leaves an open mesh open. If the object is scaled, apply its transform first, so VOXEL SIZE means what it says.',
      },
      {
        kind: 'note',
        text: 'REMESH is by far the most expensive modifier, so its result is kept and only rebuilt when the mesh or its settings change: selecting, orbiting and switching modes cost nothing. Use a coarse density while you are still deciding.',
      },
    ],
  },
  {
    id: 'cursor',
    title: 'THE 3D CURSOR AND PIVOTS',
    blurb: 'Choosing what a transform turns around',
    blocks: [
      {
        kind: 'prose',
        text: 'The 3D cursor is a point you place in space. New objects appear at it, and it can be the pivot that rotation and scale turn around. Right-click in the viewport for its menu: place it exactly on the surface under the pointer, or snap it to the vertex, edge midpoint or face centre the click found.',
      },
      {
        kind: 'table',
        head: ['PIVOT', 'ROTATES AND SCALES AROUND'],
        rows: [
          [
            'Origin',
            "The object's own origin, so it turns and scales in place. With several objects, the active one's origin (the one you clicked last). In edit mode, the origin of the object being edited.",
          ],
          [
            'Median',
            'The middle of the selection: the selected vertices in edit mode, the shape itself in object mode. If an origin has been left away from its geometry, this one still turns about the shape. This is the default.',
          ],
          ['3D cursor', 'Wherever you placed the cursor.'],
        ],
      },
      {
        kind: 'note',
        text: 'Pick the pivot in the PIVOT box in the top bar, or press Ctrl+. to step through the three in order. The gizmo always sits on the pivot in force, so the point you grab a turn by is the point it turns about.',
      },
      {
        kind: 'table',
        head: ['KEY', 'DOES'],
        rows: [
          ['C', 'Places the cursor on the surface under the pointer.'],
          [
            'Alt+V, Alt+E, Alt+F',
            'Snaps the cursor to the vertex, edge centre or face centre under the pointer.',
          ],
          ['Shift+C', 'Sends the cursor back to the world origin.'],
          [
            'Ctrl+Shift+C',
            'CURSOR TO SELECTION: moves the cursor to the middle of the selected geometry, the shape you see.',
          ],
          [
            'Alt+Shift+C',
            "CURSOR TO SELECTION ORIGIN: moves the cursor to the origin, the amber square. With several objects, the median of their origins; in edit mode, the edited object's own.",
          ],
          [
            'Shift+V',
            'SELECTION TO CURSOR: carries the geometry to the cursor and leaves the origins where they were.',
          ],
          [
            'Alt+Shift+V',
            'ORIGIN OF SELECTED TO CURSOR: brings the origins to the cursor and leaves the geometry where it is. Nothing moves on screen; the LOCATION numbers change to say where the shape now is.',
          ],
          ['Alt+C', 'Hides or shows the cursor.'],
        ],
      },
      {
        kind: 'note',
        text: 'The right-click menu prints each key beside its entry. The keys aim at wherever the pointer is resting, so keep the pointer over the viewport. Placing the cursor is an edit of its own: Ctrl+Z puts the cursor back and leaves the model alone.',
      },
      {
        kind: 'note',
        text: 'CURSOR TO SELECTION and CURSOR TO SELECTION ORIGIN land on the same point until an edit-mode move pulls the geometry away from its origin. After that, the first follows the shape and the second follows the amber square.',
      },
      {
        kind: 'note',
        text: 'The mirror modifier can use the cursor as its mirror plane instead of the object origin, which is how you mirror a part about a point other than its centre. The bend and twist modifiers can use it as the point that stays put, so a column bent or twisted about a cursor at its foot keeps its foot planted.',
      },
    ],
  },
  {
    id: 'viewport',
    title: 'VIEWPORT AND NAVIGATION',
    blurb: 'Getting the camera and the shading where you need them',
    blocks: [
      {
        kind: 'table',
        head: ['NAVIGATION', 'HOW'],
        rows: [
          [
            'Orbit, pan, zoom',
            'Middle-drag orbits, Shift+middle-drag pans, the wheel zooms. A vertical drag can carry the view over the top and down the far side, upside down. Turn on LOCK VERTICAL ORBIT under PREFS to stop at the poles instead.',
          ],
          [
            'Frame the selection',
            '. frames what is selected, Home frames the whole scene. Both also have a button in the top bar.',
          ],
          [
            'Axis views',
            'Shift with an odd number jumps to a straight-on view: Shift+1 front, Shift+3 right, Shift+7 top. Add Ctrl for the opposite view: back, left, bottom. This is the common numpad layout, so the numbers mean what they usually do.',
          ],
          [
            'Orbiting from the keyboard',
            'Shift with an even number turns the camera one step: Shift+4 and Shift+6 orbit left and right, Shift+8 and Shift+2 orbit up and down. Shift+9 looks from the opposite side. Shift+5, like plain 5, toggles orthographic.',
          ],
          [
            'Number row or numpad',
            'All of these work from both. A laptop has no numpad, and a hand already resting on the numpad should not have to reach up to the row. Shift keeps them clear of the select modes on 1, 2 and 3.',
          ],
          [
            'Orbit steps',
            'Each press turns fifteen degrees, so six presses make an exact quarter turn: orbiting up from the front view lands on the top view. The directions name where the camera goes, not which way the scene seems to turn. A run of presses stops at straight up. The next press carries on over the top, unless LOCK VERTICAL ORBIT is on.',
          ],
          [
            'The camera turns, it does not snap',
            'A view takes about a fifth of a second to arrive, easing in and out. A snap only shows where the camera ended up; a turn shows how the new view relates to the old one. That matters most between right and left, which are mirror images: the turn is the only clue to which way round the model went. Grab the camera with the mouse mid-turn and you take over from where it is. A second orbit press adds to the first instead of being lost.',
          ],
          [
            'What a view keeps',
            'Only the direction changes. The point the camera orbits and its distance stay the same, so a view never moves you nearer or further, and a mouse orbit afterwards carries on from there. The status bar names the view you pressed.',
          ],
          [
            'The axis widget',
            'The six coloured ends in the top right corner turn with the camera, so they always show which way the world is facing. Click one to look from that side: the lettered ends are +X, +Y and +Z, and the hollow ones are their negatives. Drag across the widget to orbit, the same as a middle-drag, which is how a finger turns the view over the top.',
          ],
          [
            'On a touch screen',
            'Pinch to zoom, slide two fingers to pan, twist two fingers to turn the scene round like a turntable. One finger does what the left mouse button does. The TOUCH SCREENS section has the rest.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'The widget also shows what a transform will affect. Lock a move, rotation or scale to an axis, or grab one gizmo handle, and the other two axes fade, so the corner shows what is about to move. Only the disc behind the ends takes a drag: one that starts in the corner outside it reaches the viewport as usual.',
      },
      {
        kind: 'table',
        head: ['SHADING', 'SHOWS'],
        rows: [
          ['Solid', 'Lit surfaces. Solid + wire draws the edges on top.'],
          ['Wireframe', 'Edges only.'],
          [
            'X-ray',
            'Transparent surfaces, so a region select reaches the geometry behind what you can see.',
          ],
          ['Matcap', 'Flat, high-contrast shading that shows form without a lighting setup.'],
        ],
      },
      {
        kind: 'note',
        text: 'Pick the shading from the SHADING menu in the top bar, or cycle through the modes with Shift+Z. The grid adapts its spacing as you zoom. The OVERLAYS menu beside it turns the grid, axes, cursor, normals, face orientation and statistics on and off independently.',
      },
    ],
  },
  {
    id: 'touch',
    title: 'TOUCH SCREENS',
    blurb: 'Modelling on a phone or a tablet',
    blocks: [
      {
        kind: 'prose',
        text: 'The editor works with fingers as well as with a mouse and keyboard. One finger is the left button, two fingers are the camera, and a long press is the right button. Every control grows to a size a fingertip can hit, and the gizmo, the vertex dots and the edges are drawn larger, to be seen and aimed at.',
      },
      {
        kind: 'table',
        head: ['GESTURE', 'DOES'],
        rows: [
          ['Tap', 'Selects what it lands on, or empties the selection on empty space.'],
          ['Drag one finger', 'Draws a selection region, or carries a gizmo handle it starts on.'],
          ['Pinch', 'Zooms in and out, about the point between your fingers.'],
          ['Slide two fingers', 'Pans: the scene follows your fingers.'],
          [
            'Twist two fingers',
            'Turns the scene round the vertical, like a turntable. A small twist is ignored, so a pinch does not wobble the view.',
          ],
          ['Drag the axis widget', 'Orbits freely, over the top of the model too.'],
          [
            'Long press',
            'Opens the menu a right-click would: the 3D cursor menu on the viewport, the row menu in the outliner and on a material slot. On any other control it shows the hint.',
          ],
        ],
      },
      {
        kind: 'table',
        head: ['QUICK BAR', 'DOES'],
        rows: [
          ['TOOLS, SCENE', 'Open and close the left panels and the right column.'],
          ['Undo, redo', 'Ctrl+Z and Ctrl+Shift+Z.'],
          [
            'ADD',
            'Holds Shift down for you. While it is on, a tap adds what it lands on and takes back what is already selected, and a region adds everything in it. In the outliner a tap adds or removes one row.',
          ],
          [
            'Delete',
            'Deletes the selected objects in object mode, and opens the delete menu in edit mode.',
          ],
          [
            'CUT, UNDO POINT, CANCEL',
            'Shown while the knife is cutting, in place of Enter, Backspace and Esc. Other modal operations get CONFIRM and CANCEL.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Two fingers always win over one: putting a second finger down drops the selection region or the knife point the first one had just started, and steers the camera instead. The exception is a gizmo handle already in hand, which keeps its finger until it is let go.',
      },
    ],
  },
  {
    id: 'files',
    title: 'FILES AND EXPORT',
    blurb: 'Saving projects and getting meshes out',
    blocks: [
      {
        kind: 'table',
        head: ['ACTION', 'WHAT HAPPENS'],
        rows: [
          [
            'Save (Ctrl+S)',
            "Writes the project straight back over the .3doo it came from, with no dialog. The first time after opening a file, the browser asks permission to write to it. SAVE only writes while the project name in the top bar matches the file's name. If you rename the project, or it has no file yet, SAVE is greyed out and Ctrl+S does a Save as instead; put the old name back to save over the file again. In a browser that cannot write back to files, SAVE stays greyed out and every save is a Save as.",
          ],
          [
            'Save as (Ctrl+Shift+S)',
            'Writes the whole project (objects, transforms, modifiers, materials) to a new .3doo file, which is JSON inside. From then on SAVE writes to that file, and the top bar takes its name. It will not replace a file that already exists.',
          ],
          [
            'Open (Ctrl+O)',
            "Loads a .3doo in place of the current scene, and the top bar takes the file's name. If the current scene has changes in no file, it offers to save them first. The numbered copies in 3doo-auto-saves are not touched.",
          ],
          [
            'New',
            'Clears the scene and starts again on a cube, offering the same save first, since the current scene and its undo steps go. The numbered copies in 3doo-auto-saves are not touched.',
          ],
          [
            'Import mesh',
            'Reads an OBJ or FBX file in as new objects at the 3D cursor, alongside what is already there, all of them selected and one Ctrl+Z from gone. An FBX arrives the right way up and the right size, each object pivoting where it did. Only the geometry comes in: materials and UVs stay behind.',
          ],
          [
            'Import image',
            'Reads a PNG, JPG or BMP in as a plane at the world origin, standing upright and facing the front view, with the picture drawn on it.',
          ],
          [
            'A scene link',
            'Opens the editor on the scene the link carries, in place of the starting cube. AI assistants hand these out: see AI ASSISTANTS. The scene is in no file until you save it.',
          ],
          [
            'Export (Ctrl+E)',
            'Writes OBJ with a matching MTL, or binary FBX 7.4, which Unity, Unreal, Blender, Maya and 3ds Max all import.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'The export dialog has axis and unit presets for Unity, Unreal, Blender and Maya, so the model arrives the right way up and the right size without trial and error. The editor models in metres: one unit is one metre. Choose CUSTOM to set the up axis, units and scale yourself.',
      },
      {
        kind: 'note',
        text: 'Modifiers are always applied on export. APPLY TRANSFORMS, TRIANGULATE and PER-VERTEX NORMALS are optional, and SELECTION ONLY exports just what you have selected. An image plane takes its picture along, mapped the way you see it: an OBJ gets the image file beside its material file, and an FBX carries the picture inside it. Other objects export without UVs, since nothing in the editor unwraps a mesh.',
      },
      {
        kind: 'prose',
        text: "An imported image is an ordinary object: a plane in the image's proportions, one metre along its longer side. Select, move, rotate and scale it like anything else, which makes it a good reference to model against: line it up, then build. It takes modifiers and booleans, and exports with its picture. The shading menu leaves it alone: when the rest of the scene goes to wireframe or x-ray, an image stays solid with its picture showing, since a rectangle of edges is no use as a reference.",
      },
      {
        kind: 'note',
        text: 'With autosave on, your work is written as numbered .3doo files into the 3doo-auto-saves folder of the location you chose, and nowhere else. The browser keeps no copy of the project, so a reload opens a fresh scene, and FILE > OPEN brings back any file you or autosave wrote. Nothing is uploaded. A .3doo carries its images inside it, so a project you send someone opens exactly as you saved it.',
      },
    ],
  },
  {
    id: 'preferences',
    title: 'PREFERENCES',
    blurb: 'Settings that follow you, not the project',
    blocks: [
      {
        kind: 'prose',
        text: "PREFS in the top bar holds the settings that belong to you rather than to a scene: hint tooltips, the viewport background, whether a vertical orbit stops at the poles, the grid's scale, colour and opacity, autosave, and the thickness and colour of the outline around selected objects. They are stored on this device and kept out of project files, so opening a scene someone sent you never changes your viewport.",
      },
      {
        kind: 'prose',
        text: 'PANELS VISIBILITY has a switch for each part of the screen: the tool rail on the far left, each panel on either side, and the status bar along the foot. Turning one off only hides it: everything it holds still works from the keyboard, and the scene does not change. Use it to make room for the model. Folding a panel by its title is the lighter version, and that one is saved with the project rather than with you.',
      },
      {
        kind: 'prose',
        text: 'AUTOSAVE keeps numbered copies of your scene as you work. It is off until you turn it on. To set it up:',
      },
      {
        kind: 'steps',
        items: [
          'Under AUTOSAVE, press CHOOSE next to LOCATION and pick a folder. The browser will not hand over the Desktop, Documents or Downloads themselves, so pick a folder inside one of them, or anywhere else.',
          'Allow the browser to write there when it asks.',
          'Turn AUTOSAVE on. If no location is chosen yet, turning it on asks for one first.',
          'Set EVERY to how often a copy is written: from 30 seconds to 15 minutes, 3 minutes by default. Shorter loses less when a tab dies; longer leaves fewer copies and writes a heavy scene out less often.',
        ],
      },
      {
        kind: 'prose',
        text: 'A 3doo-auto-saves folder is made inside the location you picked, or the folder itself is used if it already has that name. Each write adds a new file there and never overwrites one: NAME_01.3doo, NAME_02.3doo and so on. NAME is the .3doo you saved as or opened, or the project name in the top bar if there is no file yet, so an unnamed project writes untitled_01.3doo. Numbering carries on from the highest number in the folder, so a project reopened tomorrow picks up where it left off.',
      },
      {
        kind: 'prose',
        text: 'Autosave only writes when something has changed: adding, moving, renaming, regrouping or deleting, anything that would be different in the file. Selecting an object and looking around are not changes, and neither is an edit you undo before the next write, because the scene is compared with the last one kept, by autosave or by your own Ctrl+S. So a tab left open on a finished scene stops writing, and one you never touched never writes at all.',
      },
      {
        kind: 'prose',
        text: 'Each write that lands turns a small floppy disk once in the status bar, so you can see the copies being kept. Only a write that fails shows a message. Nothing else is kept: the browser holds no copy of the project, so every new tab opens on a fresh cube, and the newest numbered copy is where the work of a closed or crashed tab comes back from, with FILE > OPEN.',
      },
      {
        kind: 'note',
        text: 'After the browser restarts, it asks once more for permission to write to the location, and nothing is written until you allow it. Where the browser offers to allow it on every visit, choosing that stops the question coming back. Turning autosave off keeps the location for next time.',
      },
      {
        kind: 'note',
        text: 'Autosave needs a browser that can hand a page a folder, which today means Chrome, Edge and the other Chromium browsers. Elsewhere the switch is greyed out, and Ctrl+S is how you keep your work.',
      },
      {
        kind: 'note',
        text: 'FILE > NEW and FILE > OPEN both ask before they run, because either replaces the scene on screen and every undo step behind it. The prompt offers to save a .3doo first, and waits for the file before discarding anything. It only asks when you have something to lose: a scene saved to its file and untouched since goes without a prompt. Neither touches the numbered copies in 3doo-auto-saves, and nothing is ever sent to a server.',
      },
      {
        kind: 'note',
        text: 'EXPORT writes your preferences to a .pref file and IMPORT reads one back, which is how you carry them to another browser or machine. RESET restores every default and forgets the autosave LOCATION, so turning autosave on asks for one again.',
      },
    ],
  },
  {
    id: 'scripting',
    title: 'SCRIPTING',
    blurb: 'Building and editing the scene with code',
    blocks: scriptingBlocks(),
  },
  {
    id: 'assistants',
    title: 'AI ASSISTANTS',
    blurb: 'Asking an assistant to build a model for you',
    blocks: [
      {
        kind: 'prose',
        text: 'An AI assistant such as Claude can build models in 3DOO for you. Describe what you want in your own words, the way you would to a person: "a low poly wooden chair", "a hex nut 2 cm across", "the table from before, with a drawer". The assistant writes a script with the same API as SCRIPT, runs it, looks at pictures of the result, fixes what is off, and hands the model back to you.',
      },
      {
        kind: 'table',
        head: ['ASK FOR', 'WHAT YOU GET'],
        rows: [
          [
            'A project file',
            'A .3doo you open with FILE > OPEN. Every object, modifier and colour arrives editable, exactly as if you had built it yourself.',
          ],
          [
            'An OBJ or FBX',
            'A model ready for a game engine or another 3D program, with modifiers applied. Say which engine it is for and the assistant picks the matching axis and unit preset.',
          ],
          [
            'Pictures',
            'Renders of the model, drawn the way the viewport draws it. One in perspective by default, or any of the straight-on views the camera keys give: front (Shift+1), right (Shift+3), top (Shift+7), back, left and bottom (Ctrl+Shift with the same numbers). Ask to "see it from every side" for all of them.',
          ],
          [
            'A link',
            'A link that opens this editor on the model, ready to keep working on. The whole model travels inside the link, so nothing is uploaded and the link works for anyone you send it to.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'Setting it up takes a few minutes, once. The assistant talks to 3DOO through an MCP server that runs on your computer. It can draw models in this hosted site, with nothing to download, or in a copy of the code you build yourself. The MCP button beside <> in the top bar has every command ready to copy, with this site already filled in as the place links open:',
      },
      {
        kind: 'steps',
        items: [
          'You need Node 22.18 or newer. If you have no Chrome or Edge installed, run npx playwright-core install chromium. The server runs 3DOO in a hidden browser of its own to build and draw the models.',
          `Hosted, with nothing to download: in Claude Code run ${hostedClaudeCodeCommand()}. In Claude Desktop: add a 3doo entry under mcpServers in its configuration file, with npx as the command and -y 3doo-mcp as its arguments. This needs the internet, and links it makes open here for anyone.`,
          `Local, from your own copy: git clone ${REPOSITORY_URL}.git, then in its folder run npm install and npm run build, and add the server with ${claudeCodeCommand('https://your-3doo-address')}, putting the path to mcp/server.ts in its place. It works offline, and a link to localhost opens only while 3DOO is served there.`,
          'That is all you run. The assistant starts the server itself when it needs it, so there is nothing to keep open, and npm run dev is not needed to build models. THREEDOO_APP_URL sets where links open, and is also the 3DOO the server draws in when there is no build.',
          'Ask for a model. "Build a low poly chair in 3DOO, show me the front and side views, then export it as FBX for Unity" is enough.',
        ],
      },
      {
        kind: 'table',
        head: ['TOOL', 'WHAT THE ASSISTANT USES IT FOR'],
        rows: MCP_TOOLS.map(
          (tool) =>
            [
              tool.name,
              `${tool.does} Answers with ${tool.returns[0].toLowerCase()}${tool.returns.slice(1)}`,
            ] as const,
        ),
      },
      {
        kind: 'table',
        head: ['TRY ASKING', 'THE ASSISTANT'],
        rows: [
          [
            'Build a coffee mug and show it to me',
            'Builds it and replies with a picture in perspective.',
          ],
          [
            'Show me the front, side and top views',
            'Replies with three straight-on pictures, drawn flat so proportions can be compared.',
          ],
          [
            'Make the handle thicker',
            'Changes the model it already built, rather than starting again.',
          ],
          [
            'Give me a link to open it in 3DOO',
            'Replies with a link. Open it and the model is in the editor.',
          ],
          [
            'Export it as OBJ for Unreal',
            'Writes the .obj and its .mtl, the right way up and the right size for Unreal, and says where they are.',
          ],
          [
            'Open lamp.3doo and add a shade',
            'Loads your project, adds to it and gives it back as a new file or link.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'A model opened from a link is in no file yet, like a new project: save it with Ctrl+S to keep it. Pasting a link over a tab that has unsaved work in it offers to save that work first.',
      },
      {
        kind: 'note',
        text: 'The assistant works on a copy of 3DOO of its own and never touches the scene in your tab. Its files go to a 3doo-output folder in your home folder unless you or the assistant choose another.',
      },
    ],
  },
  {
    id: 'shortcuts',
    title: 'KEYBOARD SHORTCUTS',
    blurb: 'The full keymap, straight from the editor',
    blocks: [
      {
        kind: 'prose',
        text: 'The bindings follow the conventions of desktop modelling software, because that is the muscle memory most people arrive with. Press Shift+? in the editor to see the same table at any time.',
      },
      {
        kind: 'note',
        text: 'Where a desktop modeller needs the numpad, 3DOO takes either block. The camera keys under VIEW use the usual numpad layout with Shift in front, and each works from the number row and the numpad alike, so a laptop reaches everything a full keyboard does. Grow and shrink selection sit on the bracket keys instead of numpad plus and minus. Keys match the physical key rather than the character it types, so a shifted digit on a non-US layout and a numpad with NumLock off both work.',
      },
      ...shortcutTables(),
    ],
  },
];

/**
 * The words a query is made of.
 *
 * Every one of them has to appear for something to match, so a two-word query
 * narrows rather than widens: the way a reader expects a search box to behave.
 */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function hasEvery(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Searches the documentation, down to the row rather than the page.
 *
 * A table is cut to the rows that matched and a step list to the steps that
 * did, because the sections are long: handing back a whole page because one
 * cell in it mentioned the word is barely better than not searching at all.
 */
export function searchDocs(query: string): DocsResult[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const results: DocsResult[] = [];

  for (const section of DOCS_SECTIONS) {
    const named = hasEvery(`${section.title} ${section.blurb}`, terms);
    const blocks: DocsBlock[] = [];
    let count = named ? 1 : 0;

    for (const block of section.blocks) {
      if (block.kind === 'table') {
        const kept = block.rows.map((row) => hasEvery(row.join(' '), terms));
        const rows = block.rows.filter((_, index) => kept[index]);
        const ids = block.ids?.filter((_, index) => kept[index]);
        if (rows.length > 0) {
          blocks.push({ ...block, rows, ids });
          count += rows.length;
        }
      } else if (block.kind === 'steps') {
        const items = block.items.filter((item) => hasEvery(item, terms));
        if (items.length > 0) {
          blocks.push({ ...block, items });
          count += items.length;
        }
      } else if (hasEvery(block.text, terms)) {
        blocks.push(block);
        count += 1;
      }
    }

    if (count > 0) results.push({ section, blocks, named, count });
  }

  // A section the query names comes first: someone typing "modifiers" wants
  // that section, not the paragraphs elsewhere that happen to mention one.
  // Sort is stable, so within each group the reading order survives.
  return results.sort((a, b) => Number(b.named) - Number(a.named));
}
