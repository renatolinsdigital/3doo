import { DEFAULT_KEYMAP, formatBinding } from '@domain/keymap/keymap';

export type DocsBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'steps'; items: readonly string[] }
  | { kind: 'table'; head: readonly [string, string]; rows: readonly (readonly [string, string])[] }
  | { kind: 'note'; text: string };

export interface DocsSection {
  id: string;
  title: string;
  /** One line under the heading, and the hint in the left menu. */
  blurb: string;
  blocks: readonly DocsBlock[];
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

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    id: 'getting-started',
    title: 'GETTING STARTED',
    blurb: 'From an empty scene to a shape you can export',
    blocks: [
      {
        kind: 'prose',
        text: '3DOO is a mesh editor that runs entirely in the browser tab. Nothing is uploaded and nothing is installed — the modelling kernel, the renderer and your project all live on this machine. If you have used Blender, most of what follows is already in your fingers.',
      },
      {
        kind: 'steps',
        items: [
          'Open the MODELING module from the plate in the top-left corner.',
          'In the ADD panel on the left, click a primitive — BOX is the usual place to start. It drops into the scene already selected.',
          'While it is still freshly added, the PROPERTIES panel lets you change its parameters — size, segments, rings — and the mesh is rebuilt each time.',
          'Press Tab to enter edit mode. The left panels swap to SELECT, OPERATIONS, LOOP OPERATIONS and TOPOLOGY, and the tool rail switches to vertex, edge and face selection.',
          'Select some geometry and run an operation: E extrudes, I insets, Ctrl+R cuts a loop.',
          'Press Ctrl+E to export as OBJ or FBX, or Ctrl+S to save the project as a file you can reopen later.',
        ],
      },
      {
        kind: 'note',
        text: 'Work is autosaved to IndexedDB as you go, so a closed or crashed tab does not cost you the scene. Undo holds the last 64 steps.',
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
            'FILE, PREFS and the project name on the left; then the object/edit mode switch, the proportional, orthographic and smooth-shading flags, the pivot picker, and the SHADING and OVERLAYS menus; the two framing buttons and the shortcut list on the right.',
          ],
          [
            'Tool rail, far left',
            'Select, move, rotate and scale in object mode; vertex, edge and face select in edit mode.',
          ],
          [
            'Left panels',
            'ADD, OBJECT and BOOLEAN in object mode. SELECT, OPERATIONS, LOOP OPERATIONS and TOPOLOGY replace them in edit mode.',
          ],
          [
            'Panel titles',
            'Every panel folds away when its title is clicked. Which ones are folded is saved with the project.',
          ],
          ['Viewport', 'The scene. Orbit, pan and zoom here; right-click places the 3D cursor.'],
          [
            'Right column',
            'OUTLINER for the object list, PROPERTIES for the active object, MODIFIERS for its stack.',
          ],
          [
            'Status bar',
            'Scene and selection counts, the last operation that ran, and the hint line during a modal transform.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Hovering almost any control for a moment raises a one-line hint explaining it. If they get in the way, turn them off under PREFS.',
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
        text: 'Object mode treats each mesh as a single thing you place in the scene. Ten primitives are available — box, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule and torus — and each stays parametric until you touch its geometry, so segments and radius can still be adjusted after adding it.',
      },
      {
        kind: 'table',
        head: ['ACTION', 'HOW'],
        rows: [
          [
            'Move, rotate, scale',
            'G, R and S, or drag the gizmo handles. Type X, Y or Z mid-drag to constrain to an axis.',
          ],
          [
            'Duplicate',
            'Shift+D for an independent copy, Alt+D for a linked one that shares the same mesh data.',
          ],
          ['Join objects', 'Select several and press M to merge them into the active one.'],
          ['Separate', 'P splits the loose parts of a mesh into an object each.'],
          [
            'Apply transform',
            'Ctrl+A bakes rotation and scale into the vertices, leaving the transform clean.',
          ],
          [
            'Rename, hide, lock',
            'All in the OUTLINER, per row, alongside the visibility and lock toggles.',
          ],
          [
            'The row menu',
            'Right-click a row in the OUTLINER for SELECT, RENAME, APPLY TRANSFORMS and DELETE. The first entry reads DESELECT on a row that is already selected, and drops just that row from the selection. Every entry acts on the row it was opened on — the name in the header — and not on whatever else happens to be selected.',
          ],
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
        text: 'Press Tab to enter edit mode, then 1, 2 and 3 to switch between vertex, edge and face selection. Switching modes never loses what you had picked: the selection propagates from the elements you chose to the ones the new mode works with.',
      },
      {
        kind: 'table',
        head: ['SELECTION', 'HOW'],
        rows: [
          ['One element', 'Click it. Shift+click to add to the selection.'],
          [
            'A region of elements',
            'Drag across empty space. The region is a rectangle until you say otherwise: V steps the select tool through SQUARE, CIRCLE — dragged out from its centre, not corner to corner — and LASSO, drawn freehand around what you want. Clicking the tool in the rail offers the same three, and its icon shows which one a drag would draw. In object mode the same drag takes every object it touches, whether it covers the whole thing or clips one corner.',
          ],
          [
            'An edge loop',
            'Alt+click an edge. The loop runs on until it meets a pole. EDGE LOOP, in the TOPOLOGY panel, names one from edges already picked instead: select two that meet and it extends the selection along the whole loop they sit in, one loop per edge that named it.',
          ],
          [
            'A face loop',
            'Alt+click a face, near the edge you want the loop to run across — that edge is what says which of the two loops through the face you meant, so point at the side you are heading for rather than the middle. Shift+Alt+click adds a loop instead of replacing the selection, so bands stack up one click at a time. Alt+L still names one from two faces already picked.',
          ],
          ['Everything / nothing', 'A selects all, Alt+A deselects all, Ctrl+I inverts.'],
          [
            'Out of a selection',
            'Esc clears it — objects in object mode, vertices, edges or faces in edit mode — and puts the transform gizmo away with it. It leaves no undo entry of its own.',
          ],
          [
            'Wider or narrower',
            '] grows the selection to the neighbouring ring, [ shrinks it back from its border.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Selection is stored on the mesh elements themselves, which is where the modelling operators look for it. That is why an operation always acts on exactly what the viewport is highlighting.',
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
        text: 'Every operator below lives in one of the three edit-mode panels: OPERATIONS holds the ones that add geometry — extrude, inset, bevel — LOOP OPERATIONS the ones that run along an edge loop — loop cut, subdivide, relax — and TOPOLOGY the ones that join, weld, clean up or widen the selection. Most have a shortcut. A button is disabled whenever the current selection cannot feed it, and its hint says what to select instead, so the panels double as a guide to what each one needs.',
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
            'Shrinks faces inward, leaving a border ring. DEPTH pushes the inset face along the normal at the same time.',
          ],
          [
            'Bevel (Ctrl+B)',
            'Chamfers the selected edges. More SEGMENTS round the chamfer instead of leaving it flat.',
          ],
          [
            'Loop cut (Ctrl+R)',
            'Inserts edge loops across the quad ring the selected edge passes through. The new loop is left selected, ready to scale or move. Quads are what the ring is made of, so an edge with triangles or an n-gon on both sides — every edge of a cone — has nothing to cut across, and the button stays unavailable until one does.',
          ],
          [
            'Subdivide (Ctrl+D)',
            'In face mode, cuts every edge of the face CUTS times and fills it with the grid that leaves — one cut gives four faces, three gives sixteen — with optional Catmull-Clark smoothing. Every cut then runs on as a loop: through the face across each quad it reaches, and the next, until the loop closes or meets a face that is not a quad. That is what keeps the mesh in quads, and what keeps the faces around the selection cut rather than left carrying a stray vertex nothing can be cut against. In edge mode, adds that many vertices along each selected edge.',
          ],
          [
            'Relax',
            'Pulls the kinks out of a selected loop and evens out its spacing without changing the shape it runs over, the way the relax of LoopTools does in Blender. Each vertex is drawn onto the midpoint of its neighbours, the loop is then spread evenly along the line that leaves, and every vertex is dropped back onto the surface it came from — which is what KEEP SHAPE does, and why a relaxed loop slides across the mesh rather than sinking into it. Where the selection runs out, the vertex it ran out at holds still and the rest are spaced against it. A selection that is not a loop smooths against its whole neighbourhood instead, and an open border keeps its outline: there is no surface past a border to come back to, so its vertices only even out along it. FACTOR is how far each pass travels, ITERATIONS how many passes to take.',
          ],
          [
            'Merge (M) and merge by distance',
            'Welds vertices together — either the selection onto one point, or every pair closer than a threshold, with a live preview count.',
          ],
          [
            'Delete (X) vs dissolve (Del)',
            'Delete removes the geometry and leaves a hole. Dissolve removes it while keeping the surrounding surface intact.',
          ],
          [
            'Fill (F) and bridge',
            'Fill closes a selected boundary loop with a face. Bridge (Alt+B) connects two open loops of matching length with a band of quads.',
          ],
          [
            'Connect (J)',
            'Runs an edge between two selected vertices, splitting the face they share.',
          ],
          [
            'Triangulate (Alt+T) / tris to quads (Alt+J)',
            'Convert the whole mesh either way, with Alt+T and Alt+J. Tris-to-quads merges adjacent, near-coplanar triangle pairs back into quads.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'Normals have their own operations: recalculate outward (Shift+N) and flip. Smooth shading is the ◐ flag in the top bar, next to the orthographic one: it blends the normals across faces rather than faceting them, and in edit mode it applies to the selected faces alone. It belongs to the object, so a REMESH carries it across rather than deciding it. The face-orientation overlay draws backfaces in red, so anywhere red shows you are looking at the inside of the surface — worth checking before an export.',
      },
      {
        kind: 'note',
        text: 'Subdivision multiplies rather than adds: four cuts turn one face into twenty-five, and running it again turns each of those into twenty-five more. A quarter of a million faces is about as much as a browser tab can hold, so SUBDIVIDE says what a heavy run would leave before it takes it, refuses outright past that ceiling, and the SUBDIVISION modifier drops a level rather than take the window down with it.',
      },
      {
        kind: 'note',
        text: 'Proportional editing, at the bottom of the TOPOLOGY panel, spreads a transform into the unselected geometry around it through one of six falloff curves. Turn it on, set a radius, and a single vertex drags the surface with it.',
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
        text: 'A modifier changes what an object looks like without changing the mesh you are editing. The stack is evaluated top to bottom every time the viewport draws, so you keep editing the cage underneath while seeing the result.',
      },
      {
        kind: 'table',
        head: ['MODIFIER', 'WHAT IT DOES'],
        rows: [
          [
            'Mirror',
            'Reflects the mesh across an axis, optionally merging the seam or bisecting what crosses the plane. It can mirror about the 3D cursor rather than the object origin.',
          ],
          [
            'Array',
            'Repeats the mesh at a fixed offset, with the option to weld the joints between copies.',
          ],
          ['Solidify', 'Gives a surface thickness by generating an inner shell and a rim.'],
          [
            'Weld',
            'Merges vertices closer together than a threshold, across the whole evaluated result.',
          ],
          ['Subdivision', 'Catmull-Clark smoothing at a display level you choose.'],
          [
            'Remesh',
            'Rebuilds the topology outright, by one of three methods. VOXEL samples the shape into a signed distance grid and contours an even quad shell back out of it. BLOCKS reads that same grid straight off the lattice with every face axis-aligned — a voxel study of the shape rather than a surface to carry on working. REDUCE rebuilds nothing: it collapses the edges that cost the least to lose, leaving every other vertex exactly where it was, and it is the only one that keeps material slots.',
          ],
        ],
      },
      {
        kind: 'note',
        text: 'Reorder the stack to change the outcome — mirroring after an array is not the same shape as arraying after a mirror. APPLY bakes a modifier into the real mesh when you are ready to commit to it.',
      },
      {
        kind: 'prose',
        text: 'REMESH answers one question: the shape is right but the topology is not — a boolean left a mess of slivers, an import arrived as one dense triangle soup, or a sculpt needs an even cage to work on. Because it throws away the geometry it was handed, it belongs at the end of a stack rather than the middle. Density is the control to reach for first: TARGET FACES names the count you want and solves the voxel size out of it, or turn it off and set VOXEL SIZE — or KEEP, the fraction of triangles REDUCE holds on to — by hand.',
      },
      {
        kind: 'prose',
        text: 'SHARP EDGE is what makes the voxel method usable on a hard surface. A grid has no way to hold an edge that does not run along it, so a cube comes back with every edge chamfered unless it is told otherwise. Set an angle and the edges of the original that turn by more than it are read off as creases: the corners where they meet are pinned, and a vertex may slide along a crease but never off it. Turn it down to zero for organic work, where holding a crease a sculpt is about to move is worse than rounding it off.',
      },
      {
        kind: 'note',
        text: 'The voxel methods always produce a closed solid — an open surface is closed over, and holes finer than the grid disappear. REDUCE is the one that leaves an open mesh open. Apply the object transform first if the object is scaled, so the voxel size means what it says.',
      },
      {
        kind: 'note',
        text: 'REMESH is far and away the dearest thing the stack can run, so its result is held and only rebuilt when the mesh or the settings actually change — selecting, orbiting and switching modes cost nothing. Reach for a coarse density while you are still deciding.',
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
        text: 'The 3D cursor is a movable point in space. Right-click in the viewport and a menu offers to place it on the exact point under the pointer, or to snap it to the nearest vertex, edge midpoint or face centre — whichever the click found.',
      },
      {
        kind: 'table',
        head: ['PIVOT', 'ROTATES AND SCALES AROUND'],
        rows: [
          ['Median', 'The centre of the selection. The default.'],
          ['3D cursor', 'Wherever you placed the cursor. Ctrl+. toggles between this and median.'],
          [
            'Individual origins',
            'Each element on its own centre, so faces scale in place rather than toward each other.',
          ],
          ['Active element', 'The last thing you clicked.'],
        ],
      },
      {
        kind: 'note',
        text: 'The cursor is more than a pivot: Shift+C sends it to the world origin, Ctrl+Shift+C snaps it to the selection, Shift+V snaps the selection to it, and the mirror modifier can use it as its plane.',
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
            'Middle-drag orbits, Shift+middle-drag pans, the wheel zooms. A Maya preset is available if that is the muscle memory you have.',
          ],
          [
            'Frame the selection',
            '. frames what is selected, Home frames the whole scene. Both have a button in the top bar.',
          ],
          [
            'Axis views',
            '7 for top, Ctrl+1 for front, Ctrl+3 for side. 5 toggles orthographic and perspective.',
          ],
        ],
      },
      {
        kind: 'table',
        head: ['SHADING', 'SHOWS'],
        rows: [
          ['Solid', 'Lit surfaces. Solid + wire draws the edge set over the top.'],
          ['Wireframe', 'Edges only.'],
          [
            'X-ray',
            'Transparent surfaces, so box-select reaches the geometry behind what you can see.',
          ],
          ['Matcap', 'Flat, high-contrast shading that reads form without a lighting setup.'],
        ],
      },
      {
        kind: 'note',
        text: 'Shading is picked from the menu in the top bar, and Shift+Z cycles the modes. The grid adapts its spacing as you zoom, and the OVERLAYS menu beside it ticks the grid, axes, cursor, normals, face orientation and statistics independently.',
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
            'Downloads the whole project — objects, transforms, modifiers, materials — as a .3doo file (JSON inside, whatever the suffix says).',
          ],
          ['Open (Ctrl+O)', 'Loads one of those files back, replacing the current scene.'],
          ['Import', 'Reads an OBJ file in as new objects alongside what is already there.'],
          [
            'Export (Ctrl+E)',
            'Writes OBJ with a matching MTL, or ASCII FBX 7.4 — which Unity, Unreal, Blender, Maya and 3ds Max all import.',
          ],
        ],
      },
      {
        kind: 'prose',
        text: 'The export dialog carries axis and unit presets for Unity, Unreal, Blender and Maya, so the model arrives the right way up and the right size without a round of trial and error. The editor models in metres — one unit is one metre. Choose CUSTOM to set the up axis, units and scale yourself.',
      },
      {
        kind: 'note',
        text: 'Modifiers are always applied on the way out. Applying transforms, triangulating, writing per-vertex normals and including UVs are each optional, and SELECTION ONLY exports just what you have picked.',
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
        text: 'PREFS in the top bar holds the settings that belong to you rather than to a scene: whether hint tooltips appear, the viewport background, the scale, colour and opacity of the grid, and how thick and what colour the outline around selected objects is drawn. They are stored on this device and deliberately kept out of project files, so opening a scene someone sent you never repaints your viewport.',
      },
      {
        kind: 'note',
        text: 'EXPORT writes your preferences to a .pref file and IMPORT reads one back, which is how you carry them to another browser or machine. RESET puts everything back to the defaults.',
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
        text: 'The bindings follow Blender defaults, because that is the muscle memory most people arrive with. The same table is available inside the editor at any time with Shift+?.',
      },
      ...shortcutTables(),
    ],
  },
];
