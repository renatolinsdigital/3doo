export interface ScriptExample {
  id: string;
  label: string;
  source: string;
}

/** What the editor holds the first time it is opened. */
export const STARTER_SCRIPT = `// Write JavaScript against the scene, then press RUN (Ctrl+Enter).
// Rest the pointer on a name such as scene or add to read what it does.
// The whole run is one step to undo, and a run that fails changes nothing.

const box = scene.add('cube', { name: 'BOX', position: [0, 0.5, 0] });

box.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.extrude({ offset: 1 });
});
`;

/**
 * Scripts to start from, one for each part of the API.
 *
 * Each one adds to the scene rather than clearing it first: an example is run
 * to see what it does, and wiping the work on screen is not what anyone opening
 * one expects. A test runs every one of them, so none can drift out of date.
 */
export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  {
    id: 'table',
    label: 'TABLE',
    source: `// A table: one top and four legs, gathered into an outliner folder.
const top = scene.add('cube', {
  name: 'TABLE TOP',
  position: [0, 1.05, 0],
  scale: [2, 0.1, 1],
});
top.color = '#b8452f';

const legs = [];
for (const x of [-0.9, 0.9]) {
  for (const z of [-0.4, 0.4]) {
    legs.push(
      scene.add('cylinder', {
        name: 'LEG',
        radius: 0.05,
        height: 1,
        segments: 12,
        position: [x, 0.5, z],
      }),
    );
  }
}

scene.group([top, ...legs], 'TABLE');
view.frameAll();
`,
  },
  {
    id: 'stairs',
    label: 'SPIRAL STAIRS',
    source: `// A spiral staircase: every step turns a little further and climbs a little higher.
const steps = 16;
const rise = 0.2;

for (let i = 0; i < steps; i++) {
  const angle = (i / steps) * 360;
  const radians = (angle * Math.PI) / 180;
  scene.add('cube', {
    name: \`STEP \${i + 1}\`,
    scale: [1.2, 0.08, 0.35],
    rotation: [0, -angle, 0],
    position: [Math.cos(radians) * 0.75, i * rise, Math.sin(radians) * 0.75],
  });
}

scene.add('cylinder', {
  name: 'POLE',
  radius: 0.12,
  height: steps * rise + 0.4,
  position: [0, (steps * rise) / 2 - 0.2, 0],
});

return \`Built \${steps} steps\`;
`,
  },
  {
    id: 'tower',
    label: 'EXTRUDED TOWER',
    source: `// A tower grown from one cube: the top face is extruded and narrowed, floor by floor.
const tower = scene.add('cube', { name: 'TOWER', position: [0, 0.5, 0] });

tower.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);

  for (let floor = 0; floor < 4; floor++) {
    // An extrude leaves its new faces selected, so the next one carries on from there.
    mesh.extrude({ offset: 0.8 });
    mesh.scale({ scale: [0.85, 1, 0.85] });
  }

  // A sunken roof: inset the top, then push it back down.
  mesh.inset({ thickness: 0.08 });
  mesh.extrude({ offset: -0.25 });
});
`,
  },
  {
    id: 'twist',
    label: 'TWISTED BAR',
    source: `// A bar twisted a quarter turn along its height, one vertex at a time.
const bar = scene.add('cube', { name: 'TWIST', position: [0, 1.5, 0], scale: [0.6, 3, 0.6] });

bar.edit((mesh) => {
  // One upright edge names the ring of side faces the loop cuts run around.
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > 0.5 && edge.center.x > 0 && edge.center.z > 0);
  mesh.loopCut({ cuts: 24 });

  mesh.deform((v) => {
    const turn = (v.y + 0.5) * (Math.PI / 2);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    return [v.x * cos - v.z * sin, v.y, v.x * sin + v.z * cos];
  });
});
`,
  },
  {
    id: 'modifiers',
    label: 'MODIFIERS',
    source: `// Modifiers stay live: change them afterwards in the MODIFIERS panel.
const arch = scene.add('cylinder', {
  name: 'ARCH',
  radius: 0.25,
  height: 6,
  segments: 16,
  position: [0, 0, -2],
});
// A bend only moves the vertices there are, so the length needs loops to curve at.
arch.edit((mesh) => {
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > 1);
  mesh.loopCut({ cuts: 32 });
});
arch.addModifier('bend', { angles: { z: 180 } });

const column = scene.add('cube', { name: 'COLUMN', scale: [0.5, 3, 0.5], position: [-2.5, 1.5, -2] });
column.edit((mesh) => {
  mesh.selectEdges((edge) => Math.abs(edge.a.y - edge.b.y) > 0.5);
  mesh.loopCut({ cuts: 32 });
});
column.addModifier('twist', { angles: { y: 90 } });

const tile = scene.add('cube', { name: 'TILES', scale: [0.5, 0.1, 0.5], position: [-2, 0, 1] });
tile.addModifier('array', { count: 8, relativeOffset: [1.1, 0, 0] });
tile.addModifier('mirror', { axes: { z: true } });
`,
  },
];
